package sift

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestOperationStreamReportsBeforeCompletionAndKeepsJSONClean(t *testing.T) {
	for _, fail := range []bool{false, true} {
		t.Run(fmt.Sprint(fail), func(t *testing.T) {
			observed, release := make(chan struct{}), make(chan struct{})
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Authorization") != "Bearer private-fixture" {
					t.Error("missing local authentication")
				}
				writeOperation(w, r, func(ctx context.Context) (any, error) {
					reportProgress(ctx, "Measured stage", 1, 3, "images")
					<-release
					if fail {
						return nil, invalid("Fixture refusal")
					}
					return map[string]bool{"saved": true}, nil
				})
			}))
			defer server.Close()
			defer func() {
				select {
				case <-release:
				default:
					close(release)
				}
			}()
			c, err := clientFor(cliFixtureConnection(t, server.URL), "fixture")
			if err != nil {
				t.Fatal(err)
			}
			ctx := context.WithValue(context.Background(), progressKey{}, func(p operationProgress) {
				if p.Message != "Measured stage" || p.Current != 1 || p.Total != 3 {
					t.Error(p)
				}
				close(observed)
			})
			type result struct {
				b   []byte
				err error
			}
			done := make(chan result, 1)
			go func() { b, err := c.request(ctx, "POST", "/backup", nil); done <- result{b, err} }()
			select {
			case <-observed:
			case <-time.After(3 * time.Second):
				t.Fatal("progress was buffered until completion")
			}
			select {
			case <-done:
				t.Fatal("finished before operation completed")
			default:
			}
			close(release)
			r := <-done
			if fail {
				if r.err == nil || !strings.Contains(r.err.Error(), "Fixture refusal") {
					t.Fatal(r.err)
				}
			} else if r.err != nil || string(r.b) != `{"saved":true}` {
				t.Fatal(string(r.b), r.err)
			}
		})
	}
}

func TestOperationStreamValidationAndLegacyResponses(t *testing.T) {
	ctx := context.Background()
	for _, stream := range []string{"", "{", `{"type":"other"}`, `{"type":"result"}`, `{"type":"progress"}` + "\n"} {
		if _, err := readOperation(ctx, strings.NewReader(stream)); err == nil {
			t.Fatal("accepted incomplete/unknown stream", stream)
		}
	}
	for _, fail := range []bool{false, true} {
		w := httptest.NewRecorder()
		writeOperation(w, httptest.NewRequest("POST", "/", nil), func(ctx context.Context) (any, error) {
			reportProgress(ctx, "not part of JSON", 0, 0, "")
			if fail {
				return nil, invalid("Refused")
			}
			return map[string]bool{"saved": true}, nil
		})
		if !json.Valid(w.Body.Bytes()) || strings.Contains(w.Body.String(), "not part") {
			t.Fatal(w.Body.String())
		}
		if fail && w.Code != 400 || !fail && w.Code != 200 {
			t.Fatal(w.Code)
		}
	}
	if b, err := readOperation(ctx, strings.NewReader("{\"type\":\"progress\"}\n{\"type\":\"result\",\"result\":{}}")); err != nil || string(b) != "{}" {
		t.Fatal(string(b), err)
	}
}

type progressSink struct {
	mu sync.Mutex
	bytes.Buffer
	lines chan string
}

func (s *progressSink) Write(b []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	select {
	case s.lines <- string(b):
	default:
	}
	return s.Buffer.Write(b)
}
func TestCLIProgressModesHeartbeatAndSafeTerminalText(t *testing.T) {
	for _, mode := range []string{"", "auto", "never", "always"} {
		enabled, err := progressEnabled(mode, false, io.Discard)
		if err != nil || enabled != (mode == "always") {
			t.Fatal(mode, enabled, err)
		}
	}
	if enabled, err := progressEnabled("always", true, io.Discard); err != nil || enabled {
		t.Fatal(enabled, err)
	}
	if _, err := progressEnabled("bad", false, io.Discard); err == nil {
		t.Fatal("invalid progress mode accepted")
	}
	sink := &progressSink{lines: make(chan string, 20)}
	p, ctx := startCLIProgress(context.Background(), sink, "Waiting", time.Millisecond)
	reportProgress(ctx, "Measured\x1b[2J\r\u202e", 10, 20, "bytes")
	reportProgress(ctx, "Unknown total", 10, 0, "bytes")
	deadline := time.NewTimer(3 * time.Second)
	defer deadline.Stop()
	for {
		select {
		case line := <-sink.lines:
			if strings.Contains(line, "elapsed (waiting)") {
				p.finish(errors.New("fixture"))
				goto finished
			}
		case <-deadline.C:
			p.finish(nil)
			t.Fatal("no elapsed waiting feedback")
		}
	}
finished:
	output := sink.String()
	if strings.ContainsAny(output, "\x1b\r\u202e") || !strings.Contains(output, "10/20 bytes") || !strings.Contains(output, "Stopped with an error") {
		t.Fatal(output)
	}
	var quiet bytes.Buffer
	ctx, cancel := context.WithCancel(context.Background())
	q, _ := startCLIProgress(ctx, &quiet, "Waiting", time.Hour)
	cancel()
	q.finish(nil)
	if !strings.Contains(quiet.String(), "Finished") {
		t.Fatal(quiet.String())
	}
}

func TestCLIBackupProgressQuietFallbackAndNoReplay(t *testing.T) {
	s := testService(t)
	server := httptest.NewServer(s.routes())
	defer server.Close()
	dir := cliFixtureConnection(t, server.URL)
	for _, options := range [][]string{{"--progress", "always"}, {"--progress=always", "--quiet"}, {"--progress=never"}, {"--progress=auto"}} {
		var out, progress bytes.Buffer
		if err := CLIWithProgress(context.Background(), append([]string{"--data", dir, "backup"}, options...), &out, &progress); err != nil {
			t.Fatal(err)
		}
		if !json.Valid(out.Bytes()) {
			t.Fatal("stdout polluted", out.String())
		}
		if options[0] == "--progress" && !strings.Contains(progress.String(), "Finalizing and syncing backup") {
			t.Fatal(progress.String())
		}
		if options[0] != "--progress" && progress.Len() != 0 {
			t.Fatal("quiet/nonterminal progress", progress.String())
		}
	}
	var calls int
	broken := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.Header().Set("Content-Type", progressMediaType)
		io.WriteString(w, "{\"type\":\"progress\",\"progress\":{\"message\":\"Started\"}}\n")
	}))
	defer broken.Close()
	var out, progress bytes.Buffer
	err := CLIWithProgress(context.Background(), []string{"--data", cliFixtureConnection(t, broken.URL), "backup", "--progress=always"}, &out, &progress)
	if err == nil || calls != 1 || out.Len() != 0 || !strings.Contains(err.Error(), "inspect its effects") {
		t.Fatal(err, calls, out.String())
	}
	if err := CLIWithProgress(context.Background(), []string{"--progress=wrong"}, io.Discard, io.Discard); err == nil {
		t.Fatal("bad mode")
	}
}

func TestRunActivityPaginationAndRefusals(t *testing.T) {
	s := testService(t)
	run := Run{ID: "fixture-run", Status: "succeeded"}
	if err := s.Store.Put("run", run.ID, run, "fixture", ""); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 1001; i++ {
		s.Store.AddLog(run.ID, RunEntry{Type: "text", Text: fmt.Sprint(i)})
	}
	s.Store.AddLog("unrelated", RunEntry{Type: "text", Text: "not this run"})
	var activity runActivity
	json.Unmarshal(routeRequest(t, s.routes(), "GET", "/api/runs/fixture-run/activity", nil, 200, true), &activity)
	if len(activity.Entries) != 500 || activity.Entries[0].Text != "0" {
		t.Fatal(len(activity.Entries))
	}
	var cursor int64
	count := 0
	for {
		entries, err := s.Store.RunActivity(run.ID, cursor)
		if err != nil {
			t.Fatal(err)
		}
		if len(entries) == 0 {
			break
		}
		count += len(entries)
		cursor = entries[len(entries)-1].ID
	}
	if count != 1001 {
		t.Fatal("truncated activity", count)
	}
	for _, value := range []string{"bad", "-1"} {
		routeRequest(t, s.routes(), "GET", "/api/runs/fixture-run/activity?after="+value, nil, 400, true)
	}
	routeRequest(t, s.routes(), "GET", "/api/runs/missing/activity", nil, 404, true)
	if _, err := s.Store.DB.Exec("INSERT INTO run_logs VALUES(?,?,?)", run.ID, now(), []byte("{")); err != nil {
		t.Fatal(err)
	}
	routeRequest(t, s.routes(), "GET", fmt.Sprintf("/api/runs/fixture-run/activity?after=%d", cursor), nil, 500, true)
	s.Store.Close()
	if _, err := s.Store.RunActivity(run.ID, 0); err == nil {
		t.Fatal("closed store accepted")
	}
}

func TestCLIWaitAndWatchFollowOnlyOneRunAndReportFailures(t *testing.T) {
	for _, status := range []string{"succeeded", "failed", "cancelled", "action-needed"} {
		t.Run(status, func(t *testing.T) {
			var submissions, reads int
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/api/jobs/job-fixture/run" {
					submissions++
					writeJSON(w, 200, Run{ID: "run-fixture", Status: "queued"})
					return
				}
				if r.Method != "GET" || r.URL.Path != "/api/runs/run-fixture/activity" {
					t.Error("unexpected operation", r.Method, r.URL.Path)
				}
				reads++
				if reads == 1 {
					writeJSON(w, 200, runActivity{Run: Run{ID: "run-fixture", Status: "running"}, Entries: []runLogEntry{{ID: 1, RunEntry: RunEntry{Type: "tool", Text: "Running fixture"}}}})
					return
				}
				if reads == 2 && r.URL.Query().Get("after") != "1" || reads == 3 && r.URL.Query().Get("after") != "0" {
					t.Error("missing cursor")
				}
				writeJSON(w, 200, runActivity{Run: Run{ID: "run-fixture", Status: status, Error: "Fixture evidence"}, Entries: []runLogEntry{{ID: 2, RunEntry: RunEntry{Type: "text", Text: "Finished fixture"}}}})
			}))
			defer server.Close()
			dir := cliFixtureConnection(t, server.URL)
			var out, progress bytes.Buffer
			err := CLIWithProgress(context.Background(), []string{"--data", dir, "jobs", "run", "job-fixture", "--wait", "--progress=always"}, &out, &progress)
			if (err != nil) != (status != "succeeded") || submissions != 1 || reads != 2 || !json.Valid(out.Bytes()) {
				t.Fatal(err, submissions, reads, out.String())
			}
			if strings.Count(progress.String(), "tool: Running fixture") != 1 || !strings.Contains(progress.String(), "text: Finished fixture") {
				t.Fatal(progress.String())
			}
			out.Reset()
			progress.Reset()
			err = CLIWithProgress(context.Background(), []string{"--data", dir, "runs", "watch", "run-fixture", "--quiet"}, &out, &progress)
			if (err != nil) != (status != "succeeded") || submissions != 1 || progress.Len() != 0 {
				t.Fatal(err, submissions, progress.String())
			}
		})
	}
}

func TestWatchCancellationDoesNotCancelRunAndUploadsReportBytes(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	var calls int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		writeJSON(w, 200, runActivity{Run: Run{ID: "r", Status: "running"}})
	}))
	defer server.Close()
	c, err := clientFor(cliFixtureConnection(t, server.URL), "fixture")
	if err != nil {
		t.Fatal(err)
	}
	ctx = context.WithValue(ctx, progressKey{}, func(operationProgress) { cancel() })
	if _, err := c.watchRun(ctx, "r", time.Hour); !errors.Is(err, context.Canceled) || calls != 1 {
		t.Fatal(err, calls)
	}
	var measured []operationProgress
	ctx = context.WithValue(context.Background(), progressKey{}, func(p operationProgress) { measured = append(measured, p) })
	reader := &progressReader{ctx: ctx, reader: strings.NewReader("data"), total: 4, message: "bytes"}
	if b, err := io.ReadAll(reader); err != nil || string(b) != "data" || measured[len(measured)-1].Current != 4 {
		t.Fatal(string(b), err, measured)
	}
	dir := cliFixtureConnection(t, server.URL)
	file := filepath.Join(dir, "image.png")
	os.WriteFile(file, []byte("fixture bytes"), 0600)
	var out, progress bytes.Buffer
	if err := CLIWithProgress(context.Background(), []string{"--data", dir, "images", "upload", file, "--progress=always"}, &out, &progress); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(progress.String(), "Uploading image request") || !strings.Contains(progress.String(), "bytes") || !json.Valid(out.Bytes()) {
		t.Fatal(progress.String(), out.String())
	}
	for _, args := range [][]string{{"runs", "watch"}, {"jobs", "run"}, {"tasks", "list", "--wait"}} {
		if err := CLIWithProgress(context.Background(), append([]string{"--data", dir}, args...), io.Discard, io.Discard); err == nil {
			t.Fatal(args)
		}
	}
}

type failedProgressResponse struct{ *httptest.ResponseRecorder }

func (failedProgressResponse) Write([]byte) (int, error) { return 0, io.ErrClosedPipe }

func TestOperationWriteFailureCancelsAndBackupDoesNotCommit(t *testing.T) {
	w := failedProgressResponse{httptest.NewRecorder()}
	r := httptest.NewRequest("POST", "/", nil)
	r.Header.Set("Accept", progressMediaType)
	writeOperation(w, r, func(ctx context.Context) (any, error) {
		reportProgress(ctx, "Will fail to send", 0, 0, "")
		if !errors.Is(ctx.Err(), context.Canceled) {
			t.Fatal("client write failure did not cancel operation", ctx.Err())
		}
		return nil, ctx.Err()
	})
	s := testService(t)
	ctx, cancel := context.WithCancel(context.Background())
	ctx = context.WithValue(ctx, progressKey{}, func(p operationProgress) {
		if strings.Contains(p.Message, "Finalizing") {
			cancel()
		}
	})
	if _, err := s.backupContext(ctx); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(filepath.Join(s.Dir, "backups"))
	if err != nil || len(entries) != 0 {
		t.Fatal("cancelled backup left files", entries, err)
	}
	if _, err := s.Backup(); err != nil {
		t.Fatal("maintenance remained locked", err)
	}
	reader := &progressReader{ctx: ctx, reader: strings.NewReader("must not transfer")}
	if _, err := io.ReadAll(reader); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
}

func TestCLIWatchPaginationProtocolErrorsAndOutputFailures(t *testing.T) {
	s := testService(t)
	run := Run{ID: "many", Status: "succeeded"}
	if err := s.Store.Put("run", run.ID, run, "fixture", ""); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 1001; i++ {
		s.Store.AddLog(run.ID, RunEntry{Type: "text", Text: fmt.Sprintf("entry-%04d", i)})
	}
	server := httptest.NewServer(s.routes())
	defer server.Close()
	dir := cliFixtureConnection(t, server.URL)
	var out, progress bytes.Buffer
	args := []string{"--data", dir, "runs", "watch", run.ID, "--progress=always"}
	if err := CLIWithProgress(context.Background(), args, &out, &progress); err != nil {
		t.Fatal(err)
	}
	if !json.Valid(out.Bytes()) || strings.Count(progress.String(), "text: entry-") != 1001 || !strings.Contains(progress.String(), "entry-1000") {
		t.Fatal("lost or repeated activity")
	}
	if err := CLIWithProgress(context.Background(), args, failingPiInput{}, io.Discard); !errors.Is(err, io.ErrClosedPipe) {
		t.Fatal(err)
	}
	out.Reset()
	if err := CLIWithProgress(context.Background(), args, &out, failingPiInput{}); !errors.Is(err, io.ErrClosedPipe) || !json.Valid(out.Bytes()) {
		t.Fatal("progress pipe hid result or error", err, out.String())
	}
	for _, body := range []string{"{", `{"run":{"id":"other","status":"running"}}`, `{"run":{"id":"many","status":"running"},"entries":[{"id":1},{"id":1}]}`} {
		t.Run(body, func(t *testing.T) {
			mockHTTP(t, 200, body, nil)
			c, err := clientFor(dir, "fixture")
			if err != nil {
				t.Fatal(err)
			}
			if _, err := c.watchRun(context.Background(), run.ID, time.Millisecond); err == nil {
				t.Fatal("invalid response accepted")
			}
		})
	}
}

func TestWatchCancellationDuringRequestAndJobWaitOutputFailures(t *testing.T) {
	for _, response := range []string{"{", `{}`, `{"id":"r","status":"queued"}`} {
		t.Run(response, func(t *testing.T) {
			var submissions int
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == "POST" {
					submissions++
					io.WriteString(w, response)
					return
				}
				writeJSON(w, 200, runActivity{Run: Run{ID: "r", Status: "succeeded"}})
			}))
			defer server.Close()
			dir := cliFixtureConnection(t, server.URL)
			err := CLIWithProgress(context.Background(), []string{"--data", dir, "jobs", "run", "j", "--wait"}, failingPiInput{}, io.Discard)
			if err == nil || submissions != 1 {
				t.Fatal(err, submissions)
			}
			if strings.Contains(response, `"id"`) && !errors.Is(err, io.ErrClosedPipe) {
				t.Fatal(err)
			}
		})
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { cancel(); <-r.Context().Done() }))
	defer server.Close()
	c, err := clientFor(cliFixtureConnection(t, server.URL), "fixture")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.watchRun(ctx, "r", time.Hour); !errors.Is(err, context.Canceled) || !strings.Contains(err.Error(), "not cancelled") {
		t.Fatal(err)
	}
}
