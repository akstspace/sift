package sift

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Retried downloads wait a moment between attempts; tests need not.
func init() { releaseRetryDelay = time.Millisecond }

// stubExecutable points the service at a disposable "installed" executable: a
// script that prints version and records every time it is run.
func stubExecutable(t *testing.T, version string) (exe, runs string) {
	t.Helper()
	dir := t.TempDir()
	exe, runs = filepath.Join(dir, "sift"), filepath.Join(dir, "runs")
	writeStub(t, exe, runs, version)
	previous := executablePath
	executablePath = func() (string, error) { return exe, nil }
	t.Cleanup(func() { executablePath = previous })
	return exe, runs
}

// writeStub replaces the file the way an installer does: a new file renamed
// over the old path.
func writeStub(t *testing.T, exe, runs, version string) {
	t.Helper()
	staged := exe + ".staged"
	script := "#!/bin/sh\necho run >> '" + runs + "'\necho " + version + "\n"
	if err := os.WriteFile(staged, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(staged, exe); err != nil {
		t.Fatal(err)
	}
}

func applyRequest(h http.Handler, stream bool) *httptest.ResponseRecorder {
	req := httptest.NewRequest("POST", "/api/update/apply", strings.NewReader("{}"))
	if stream {
		req.Header.Set("Accept", progressMediaType)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestReleaseDownloadRetriesOnlyTransientFailures(t *testing.T) {
	url := "https://github.com/akstspace/sift/releases/download/v1/fixture"
	serve := func(t *testing.T, responses ...func(*http.Request) (*http.Response, error)) *int {
		requests := 0
		previous := http.DefaultClient
		http.DefaultClient = &http.Client{Transport: fixtureTransport(func(r *http.Request) (*http.Response, error) {
			next := responses[min(requests, len(responses)-1)]
			requests++
			return next(r)
		})}
		t.Cleanup(func() { http.DefaultClient = previous })
		return &requests
	}
	status := func(code int, body string) func(*http.Request) (*http.Response, error) {
		return func(r *http.Request) (*http.Response, error) {
			return &http.Response{StatusCode: code, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body)), Request: r}, nil
		}
	}
	offline := func(*http.Request) (*http.Response, error) { return nil, errors.New("connection reset by peer") }
	interrupted := func(r *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: unreadableBody{}, Request: r}, nil
	}
	upstreamStatus := func(t *testing.T, err error) {
		t.Helper()
		var e *APIError
		if !errors.As(err, &e) || e.Status != 502 {
			t.Fatal("a GitHub failure must be reported as 502, not a Sift fault", err)
		}
	}

	t.Run("recovers from a GitHub error, a dropped connection and a cut-off body", func(t *testing.T) {
		requests := serve(t, status(503, ""), offline, status(200, "verified"))
		if b, err := downloadRelease(context.Background(), url, 20); err != nil || string(b) != "verified" || *requests != 3 {
			t.Fatal(string(b), err, *requests)
		}
		requests = serve(t, interrupted, status(200, "verified"))
		if b, err := downloadRelease(context.Background(), url, 20); err != nil || string(b) != "verified" || *requests != 2 {
			t.Fatal(string(b), err, *requests)
		}
	})
	t.Run("gives up after three attempts with the cause", func(t *testing.T) {
		requests := serve(t, status(503, ""))
		_, err := downloadRelease(context.Background(), url, 20)
		if *requests != releaseAttempts || err == nil || !strings.Contains(err.Error(), "HTTP 503") {
			t.Fatal(err, *requests)
		}
		upstreamStatus(t, err)
		serve(t, interrupted)
		_, err = downloadRelease(context.Background(), url, 20)
		if !errors.Is(err, io.ErrUnexpectedEOF) {
			t.Fatal("the interrupted read must stay inspectable", err)
		}
		upstreamStatus(t, err)
	})
	t.Run("does not retry a missing asset or an oversized one", func(t *testing.T) {
		requests := serve(t, status(404, ""))
		_, err := downloadRelease(context.Background(), url, 20)
		if *requests != 1 {
			t.Fatal("a missing asset was retried", *requests)
		}
		upstreamStatus(t, err)
		requests = serve(t, status(200, strings.Repeat("x", 40)))
		if _, err = downloadRelease(context.Background(), url, 20); err == nil || *requests != 1 {
			t.Fatal("an oversized asset was retried or accepted", err, *requests)
		}
	})
	t.Run("stops waiting when the request is cancelled", func(t *testing.T) {
		previous := releaseRetryDelay
		releaseRetryDelay = time.Hour
		t.Cleanup(func() { releaseRetryDelay = previous })
		requests := serve(t, offline)
		ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
		defer cancel()
		if _, err := downloadRelease(ctx, url, 20); !errors.Is(err, context.DeadlineExceeded) || *requests != 1 {
			t.Fatal(err, *requests)
		}
		ctx, cancel = context.WithCancel(context.Background())
		cancel()
		requests = serve(t, offline)
		if _, err := downloadRelease(ctx, url, 20); err == nil || *requests > 1 {
			t.Fatal("a cancelled download was retried", err, *requests)
		}
	})
}

// After an update is installed, Sift restarts itself, so the new version is
// never left on disk behind the old process (where Apply would install again).
func TestInstalledUpdateRestartsSiftWhileServingAndIdle(t *testing.T) {
	archive := updateArchive(t, "sift", "#!/bin/sh\necho 99.0.0\n")
	for _, stream := range []bool{false, true} {
		t.Run(map[bool]string{false: "browser", true: "cli"}[stream], func(t *testing.T) {
			updateHTTP(t, archive, archiveChecksum(archive), 200, 200)
			exe, _ := stubExecutable(t, "1.0.0")
			s := testService(t)
			requested := 0
			s.restart = func() { requested++ }
			rec := applyRequest(s.routes(), stream)
			if rec.Code != 200 || requested != 1 {
				t.Fatal("install did not restart Sift", rec.Code, rec.Body.String(), requested)
			}
			if !strings.Contains(rec.Body.String(), `"restarting":true`) || !strings.Contains(rec.Body.String(), `"installed":"v99.0.0"`) {
				t.Fatal("the response must say Sift is restarting", rec.Body.String())
			}
			if data, _ := os.ReadFile(exe); !bytes.Contains(data, []byte("99.0.0")) {
				t.Fatal("update was not installed", string(data))
			}
			// Nothing new may start in the moment before the process re-executes.
			if _, err := s.RunJob("job_any"); err == nil || !strings.Contains(err.Error(), "paused") {
				t.Fatal("a run started while a restart was pending", err)
			}
			if _, err := s.beginMaintenance(); err == nil {
				t.Fatal("maintenance started while a restart was pending")
			}
		})
	}
	t.Run("not serving", func(t *testing.T) {
		updateHTTP(t, archive, archiveChecksum(archive), 200, 200)
		stubExecutable(t, "1.0.0")
		s := testService(t)
		rec := applyRequest(s.routes(), false)
		if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"restarting":false`) || s.restarting {
			t.Fatal("without a server to restart, the update waits for a manual restart", rec.Code, rec.Body.String())
		}
	})
}

func TestScheduledRunsWaitWhileARestartIsPending(t *testing.T) {
	s := testService(t)
	j, err := s.SaveJob(Job{Name: "Due now", Prompt: "check", Directory: s.Dir, ScheduleType: "daily", Schedule: "09:00", Timezone: "UTC", Enabled: true, TimeoutMinutes: 1}, 0, "user")
	if err != nil {
		t.Fatal(err)
	}
	s.restart = func() {}
	if err = s.reserveRestart(false); err != nil {
		t.Fatal(err)
	}
	s.scheduleTick(time.Now().Add(24 * time.Hour))
	s.runMu.Lock()
	active := len(s.active)
	s.runMu.Unlock()
	if active != 0 || len(listAs[Run](s.Store, "run")) != 0 {
		t.Fatal("a scheduled run started while a restart was pending", j.ID)
	}
}

// An update already written over the executable (by an older Sift, the CLI, or
// an installer) needs only a restart: it is recognized, not downloaded again.
func TestUpdateAlreadyOnDiskIsRecognizedAndOnlyRestarts(t *testing.T) {
	updateHTTP(t, nil, "", 500, 500) // any download attempt fails the apply
	exe, runs := stubExecutable(t, "1.0.0")
	s := testService(t)
	if info := s.CheckUpdate(context.Background()); info.RestartRequired || info.Installed != "" {
		t.Fatal("an unchanged executable was reported as updated", info)
	}
	if _, err := os.Stat(runs); !os.IsNotExist(err) {
		t.Fatal("checking for updates ran the unchanged executable", err)
	}
	writeStub(t, exe, runs, "99.0.0")
	info := s.CheckUpdate(context.Background())
	if !info.RestartRequired || info.Installed != "v99.0.0" || !info.Available {
		t.Fatal("the installed update was not recognized", info)
	}
	requested := 0
	s.restart = func() { requested++ }
	rec := applyRequest(s.routes(), false)
	if rec.Code != 200 || requested != 1 || !strings.Contains(rec.Body.String(), `"restarting":true`) {
		t.Fatal("applying an installed update must only restart", rec.Code, rec.Body.String(), requested)
	}
	if entries, _ := os.ReadDir(filepath.Join(s.Dir, "backups")); len(entries) != 0 {
		t.Fatal("restarting into an installed update must not take another backup", len(entries))
	}

	t.Run("a different version on disk is not mistaken for the update", func(t *testing.T) {
		exe, runs := stubExecutable(t, "1.0.0")
		s := testService(t)
		writeStub(t, exe, runs, "42.0.0")
		if info := s.CheckUpdate(context.Background()); info.RestartRequired {
			t.Fatal(info)
		}
	})
	t.Run("an unreadable executable is ignored", func(t *testing.T) {
		exe, _ := stubExecutable(t, "1.0.0")
		s := testService(t)
		if err := os.Remove(exe); err != nil {
			t.Fatal(err)
		}
		if info := s.CheckUpdate(context.Background()); info.RestartRequired {
			t.Fatal(info)
		}
		executablePath = func() (string, error) { return "", errors.New("unknown") }
		if s.replacedExecutableVersion(context.Background()) != "" {
			t.Fatal("an unknown executable path must be ignored")
		}
		s.startedFrom = nil
		if s.replacedExecutableVersion(context.Background()) != "" {
			t.Fatal("an unknown start identity must be ignored")
		}
	})
	t.Run("a restart is refused while an agent runs", func(t *testing.T) {
		s.runMu.Lock()
		s.restarting = false
		s.active["job_fixture"] = func() {}
		s.runMu.Unlock()
		rec := applyRequest(s.routes(), false)
		if rec.Code != 409 || requested != 1 {
			t.Fatal("an installed update restarted over a running agent", rec.Code, rec.Body.String(), requested)
		}
	})
}

// A browser shows only a status code, so every server-side failure also leaves
// its reason in the service log, for both plain and streamed responses.
func TestServerFailuresAreLoggedWithTheirCause(t *testing.T) {
	var logged bytes.Buffer
	log.SetOutput(&logged)
	t.Cleanup(func() { log.SetOutput(os.Stderr) })
	updateHTTP(t, nil, "", 503, 503)
	stubExecutable(t, "1.0.0")
	s := testService(t)
	rec := applyRequest(s.routes(), false)
	var body map[string]string
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	if rec.Code != 502 || !strings.Contains(body["error"], "GitHub returned HTTP 503") {
		t.Fatal("a GitHub outage must be a 502 with its cause", rec.Code, rec.Body.String())
	}
	if !strings.Contains(logged.String(), "Request failed (502): GitHub returned HTTP 503") {
		t.Fatal("the failure was not logged", logged.String())
	}
	logged.Reset()
	if rec = applyRequest(s.routes(), true); !strings.Contains(rec.Body.String(), `"type":"error"`) || !strings.Contains(logged.String(), "Request failed (502)") {
		t.Fatal("a streamed failure was not logged", rec.Body.String(), logged.String())
	}
	logged.Reset()
	apiError(httptest.NewRecorder(), invalid("Bad input"))
	if logged.Len() != 0 {
		t.Fatal("a client error is not a server failure", logged.String())
	}
}
