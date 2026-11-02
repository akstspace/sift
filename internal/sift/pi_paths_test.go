package sift

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"image"
	"image/png"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestPiDiscoveryRefusesFailedCommandsAndKeepsThinkingOptional(t *testing.T) {
	for _, command := range []string{"get_state", "get_available_models", "set_model", "get_available_thinking_levels"} {
		t.Run(command, func(t *testing.T) {
			fixturePi(t)
			t.Setenv("PI_FIXTURE_FAIL", command)
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			info, err := ProbePi(ctx, "fixture", "fixture-model")
			if command == "get_available_thinking_levels" {
				if err != nil || info["connected"] != true || len(info["thinking"].(map[string]any)["levels"].([]any)) != 0 {
					t.Fatal("optional thinking discovery must not invent unsupported levels", info, err)
				}
			} else if err == nil {
				t.Fatal("failed RPC discovery was reported as connected", info)
			}
		})
	}
	t.Setenv("SIFT_PI", filepath.Join(t.TempDir(), "missing-pi"))
	if _, err := ProbePi(context.Background(), "", ""); err == nil {
		t.Fatal("missing Pi was reported as connected")
	}
}

func TestPiExecutionFailureAndEvidencePaths(t *testing.T) {
	for _, tc := range []struct{ scenario, status, logType string }{
		{"failed", "failed", "text"}, {"tool-error", "succeeded", "tool-error"},
		{"maintenance", "succeeded", "system"}, {"aborted", "cancelled", "text"}, {"exit", "interrupted", ""},
	} {
		t.Run(tc.scenario, func(t *testing.T) {
			fixturePi(t)
			s := testService(t)
			j := fixtureJob(t, s, tc.scenario)
			r, err := s.RunJob(j.ID)
			if err != nil {
				t.Fatal(err)
			}
			awaitRun(t, s, r.ID, tc.status)
			if tc.logType != "" {
				found := false
				for _, entry := range s.Store.Logs(r.ID) {
					found = found || entry.Type == tc.logType
				}
				if !found {
					t.Fatal("lost streamed evidence", tc.logType)
				}
			}
		})
	}
	for _, command := range []string{"set_thinking_level", "get_state", "prompt"} {
		t.Run("failed-"+command, func(t *testing.T) {
			fixturePi(t)
			t.Setenv("PI_FIXTURE_FAIL", command)
			s := testService(t)
			j := fixtureJob(t, s, "success")
			j.Thinking = "high"
			j, err := s.SaveJob(j, j.Revision, "user")
			if err != nil {
				t.Fatal(err)
			}
			r, err := s.RunJob(j.ID)
			if err != nil {
				t.Fatal(err)
			}
			status := "action-needed"
			if command == "get_state" {
				status = "failed"
			}
			awaitRun(t, s, r.ID, status)
			if len(s.Store.Logs(r.ID)) != 0 {
				t.Fatal("prompt executed after configuration failed")
			}
		})
	}
}

func TestPiRefusesSilentModelFallbackAndMissingConfiguration(t *testing.T) {
	for _, missing := range []bool{false, true} {
		t.Run(map[bool]string{false: "fallback", true: "unconfigured"}[missing], func(t *testing.T) {
			fixturePi(t)
			if missing {
				t.Setenv("PI_FIXTURE_NO_MODEL", "1")
			}
			s := testService(t)
			j := fixtureJob(t, s, "success")
			j.Model = "accepted-but-not-selected"
			j, err := s.SaveJob(j, j.Revision, "user")
			if err != nil {
				t.Fatal(err)
			}
			r, err := s.RunJob(j.ID)
			if err != nil {
				t.Fatal(err)
			}
			result := awaitRun(t, s, r.ID, "action-needed")
			if result.Error == "" || len(s.Store.Logs(r.ID)) != 0 {
				t.Fatal("unsafe fallback or missing recovery note", result)
			}
		})
	}
}

func TestPiCancellationDuringConfigurationNeverRunsPrompt(t *testing.T) {
	for _, command := range []string{"set_model", "set_thinking_level", "get_state", "prompt"} {
		t.Run(command, func(t *testing.T) {
			fixturePi(t)
			t.Setenv("PI_FIXTURE_HANG", command)
			record := filepath.Join(t.TempDir(), "configuration-command")
			t.Setenv("PI_FIXTURE_COMMAND_RECORD", record)
			s := testService(t)
			j := fixtureJob(t, s, "success")
			j.Thinking = "high"
			r := Run{ID: "configuration-timeout", JobID: j.ID, Status: "running"}
			if err := s.Store.Put("run", r.ID, r, "system", "fixture"); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			done := make(chan struct{})
			go func() { s.executeRun(ctx, j, r); close(done) }()
			defer func() { cancel(); <-done }()
			// Cancel only after the actual peer receives the selected command. A
			// wall-clock timeout can expire in an earlier RPC on a busy machine.
			deadline := time.NewTimer(5 * time.Second)
			defer deadline.Stop()
			tick := time.NewTicker(10 * time.Millisecond)
			defer tick.Stop()
		waiting:
			for {
				select {
				case <-done:
					t.Fatal("run ended before the selected configuration command")
				case <-deadline.C:
					t.Fatal("Pi fixture never received the selected command", command)
				case <-tick.C:
					if data, err := os.ReadFile(record); err == nil && string(data) == command {
						break waiting
					}
				}
			}
			cancel()
			select {
			case <-done:
			case <-time.After(8 * time.Second):
				t.Fatal("cancelled configuration left its run active")
			}
			var result Run
			s.Store.Get("run", r.ID, &result)
			if result.Status != "cancelled" || len(s.Store.Logs(r.ID)) != 0 {
				t.Fatal("configuration cancellation was retried or misreported", result)
			}
		})
	}
}

func TestPiConfigurationDeadlineIsTerminalAndDoesNotPauseOrReplayJob(t *testing.T) {
	s := testService(t)
	j := fixtureJob(t, s, "success")
	j.Enabled = true
	var err error
	j, err = s.SaveJob(j, j.Revision, "user")
	if err != nil {
		t.Fatal(err)
	}
	r := Run{ID: "expired-configuration", JobID: j.ID, JobName: j.Name, Status: "running"}
	if err = s.Store.Put("run", r.ID, r, "system", "fixture"); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer cancel()
	if !s.finishCancelled(ctx, r) {
		t.Fatal("expired configuration was not handled")
	}
	var result Run
	if !s.Store.Get("run", r.ID, &result) || result.Status != "timed-out" || result.Error != context.DeadlineExceeded.Error() || result.EndedAt == "" || result.Summary != "" {
		t.Fatal("configuration deadline was misreported", result)
	}
	var current Job
	if !s.Store.Get("job", j.ID, &current) || !bytes.Equal(encode(current), encode(j)) {
		t.Fatal("deadline silently changed or paused the job", current)
	}
	if len(listAs[Run](s.Store, "run")) != 1 || len(s.Store.Logs(r.ID)) != 0 {
		t.Fatal("deadline replayed work or invented streamed evidence")
	}
	notifications := listAs[Notification](s.Store, "notification")
	if len(notifications) != 1 || notifications[0].Title != "Job needs attention" || !strings.Contains(notifications[0].Message, context.DeadlineExceeded.Error()) {
		t.Fatal("timeout lost its actionable notification", notifications)
	}
}

type failingPiInput struct{}

func (failingPiInput) Write([]byte) (int, error) { return 0, io.ErrClosedPipe }
func (failingPiInput) Close() error              { return nil }

func TestPiFailedWriteDoesNotLeakPendingRequests(t *testing.T) {
	p := &Pi{in: failingPiInput{}, pending: make(map[string]chan map[string]any)}
	for i := 0; i < 3; i++ {
		if _, err := p.Call(context.Background(), map[string]any{"type": "get_state"}); !errors.Is(err, io.ErrClosedPipe) {
			t.Fatal(err)
		}
	}
	if len(p.pending) != 0 {
		t.Fatal("disconnected RPC calls leaked pending requests")
	}
}

func TestPiRecordBoundariesAndLocalPathDiscovery(t *testing.T) {
	for _, tc := range []struct {
		value   string
		max     int
		want    string
		failure bool
	}{
		{"{\"ok\":true}\r\n", 100, "{\"ok\":true}", false},
		{strings.Repeat("a", 10000) + "\n", 11000, strings.Repeat("a", 10000), false},
		{"too large\n", 4, "", true}, {"unterminated", 100, "", true},
	} {
		result, err := readRecord(bufio.NewReaderSize(strings.NewReader(tc.value), 32), tc.max)
		if (err != nil) != tc.failure || (!tc.failure && string(result) != tc.want) {
			t.Fatal("record boundary", len(result), err)
		}
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("SIFT_PI", "")
	t.Setenv("PATH", t.TempDir())
	t.Run("missing optional installation", func(t *testing.T) {
		for _, path := range []string{"/opt/homebrew/bin/pi", "/usr/local/bin/pi"} {
			if _, err := os.Stat(path); !os.IsNotExist(err) {
				t.Skip("host has a global Pi candidate; do not change it to test fallback")
			}
		}
		if PiPath() != "pi" {
			t.Fatal("missing Pi did not retain the actionable command name", PiPath())
		}
	})
	for _, folder := range []string{".local/bin", ".bun/bin"} {
		path := filepath.Join(home, folder, "pi")
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("#!/bin/sh\nexit 0\n"), 0700); err != nil {
			t.Fatal(err)
		}
		if PiPath() != path {
			t.Fatal("local discovery did not use expected path", PiPath())
		}
	}
	t.Setenv("PATH", filepath.Join(home, ".local/bin"))
	if PiPath() != filepath.Join(home, ".local/bin/pi") {
		t.Fatal("PATH must take precedence over home discovery")
	}
}

type acceptedPiInput struct{}

func (acceptedPiInput) Write(b []byte) (int, error) { return len(b), nil }
func (acceptedPiInput) Close() error                { return nil }

func TestPiExitBeforeRPCResponseReleasesPendingRequest(t *testing.T) {
	done := make(chan struct{})
	close(done)
	p := &Pi{in: acceptedPiInput{}, pending: map[string]chan map[string]any{}, done: done}
	if _, err := p.Call(context.Background(), map[string]any{"type": "get_state"}); err == nil || !strings.Contains(err.Error(), "exited before responding") {
		t.Fatal(err)
	}
	if len(p.pending) != 0 {
		t.Fatal("exited child left a pending request")
	}
}

func TestPiNoisyStderrIsBoundedWithoutBlockingRPC(t *testing.T) {
	peer := filepath.Join(t.TempDir(), "noisy-pi")
	code := "#!/usr/bin/env python3\nimport json,sys\nsys.stderr.write('x'*100000);sys.stderr.flush()\nfor line in sys.stdin:\n c=json.loads(line);print(json.dumps({'type':'response','id':c['id'],'success':True,'data':{}}),flush=True)\n"
	if err := os.WriteFile(peer, []byte(code), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("SIFT_PI", peer)
	p, err := StartPi("")
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if _, err = p.Call(ctx, map[string]any{"type": "get_state"}); err != nil {
		t.Fatal(err)
	}
	p.Close()
	p.errMu.Lock()
	size := p.stderr.Len()
	p.errMu.Unlock()
	if size == 0 || size > 32768+8192 {
		t.Fatal("stderr was unbounded or lost", size)
	}
}

func TestPiImageInclusionRequiresPerJobConsentAndBoundsPayload(t *testing.T) {
	if os.Getenv("SIFT_INTEGRATION") != "1" {
		t.Skip("Set SIFT_INTEGRATION=1 to launch bundled RustFS")
	}
	fixturePi(t)
	s := testService(t)
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	if err := s.Storage.Start(ctx, s.Dir); err != nil {
		t.Fatal(err)
	}
	var b bytes.Buffer
	if err := png.Encode(&b, image.NewRGBA(image.Rect(0, 0, 2, 2))); err != nil {
		t.Fatal(err)
	}
	a, err := s.Storage.Upload(ctx, "image.png", b.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if err = s.Store.Put("attachment", a.ID, a, "user", "fixture"); err != nil {
		t.Fatal(err)
	}
	large := a
	large.ID = "large"
	large.Size = 5 << 20
	s.Store.Put("attachment", large.ID, large, "user", "fixture")
	mustTask(t, s.Store, Task{Title: "Not Today", Attachments: []string{a.ID}})
	mustTask(t, s.Store, Task{Title: "Deleted", Today: true, DeletedAt: now(), Attachments: []string{a.ID}})
	images := []string{large.ID}
	for i := 0; i < 10; i++ {
		images = append(images, a.ID)
	}
	mustTask(t, s.Store, Task{Title: "Today with consent only", Today: true, Attachments: images})
	for _, consent := range []bool{false, true} {
		record := filepath.Join(t.TempDir(), "prompt.json")
		t.Setenv("PI_FIXTURE_PROMPT_RECORD", record)
		j := fixtureJob(t, s, "success")
		j.IncludeImages = consent
		j, err = s.SaveJob(j, j.Revision, "user")
		if err != nil {
			t.Fatal(err)
		}
		r, err := s.RunJob(j.ID)
		if err != nil {
			t.Fatal(err)
		}
		awaitRun(t, s, r.ID, "succeeded")
		data, err := os.ReadFile(record)
		if err != nil {
			t.Fatal(err)
		}
		var command map[string]json.RawMessage
		if err = json.Unmarshal(data, &command); err != nil {
			t.Fatal(err)
		}
		var prompt string
		if err = json.Unmarshal(command["message"], &prompt); err != nil {
			t.Fatal(err)
		}
		for _, guidance := range []string{"Choose icons for the task topic", "never Gmail for unrelated tasks", "Preserve explicit user icon choices", "sift tasks comments ID", "sift tasks comment ID --text TEXT", "comments as context, not permission"} {
			if !strings.Contains(prompt, guidance) {
				t.Fatal("missing scheduled task guidance", guidance)
			}
		}
		if !consent {
			if _, ok := command["images"]; ok {
				t.Fatal("images included without job consent")
			}
			continue
		}
		var received []map[string]string
		json.Unmarshal(command["images"], &received)
		if len(received) != 8 {
			t.Fatal("image payload did not respect eight-image bound", len(received))
		}
		for _, image := range received {
			if image["type"] != "image" || image["mimeType"] != "image/png" || image["data"] == "" {
				t.Fatal(image)
			}
		}
	}
}

func TestPiUnresponsiveChildAndMissingExecutableAreContained(t *testing.T) {
	peer := filepath.Join(t.TempDir(), "stubborn-pi")
	if err := os.WriteFile(peer, []byte("#!/bin/sh\ntrap '' TERM\necho '{malformed'\nwhile :; do sleep 1; done\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("SIFT_PI", peer)
	p, err := StartPi("")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if _, err := p.Call(ctx, map[string]any{"type": "get_state"}); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal(err)
	}
	p.Close()
	p.Close()
	select {
	case <-p.done:
	case <-time.After(3 * time.Second):
		t.Fatal("forced Pi shutdown left child alive")
	}
	t.Setenv("SIFT_PI", filepath.Join(t.TempDir(), "missing"))
	s := testService(t)
	j := fixtureJob(t, s, "success")
	r, err := s.RunJob(j.ID)
	if err != nil {
		t.Fatal(err)
	}
	awaitRun(t, s, r.ID, "action-needed")
	text := strings.Repeat("long evidence", 2000)
	s.finishRun(Run{ID: "summary", JobID: j.ID}, "succeeded", "", text)
	var result Run
	s.Store.Get("run", "summary", &result)
	if len(result.Summary) != 16000 || result.Summary != text[len(text)-16000:] {
		t.Fatal("summary was not bounded")
	}
}
