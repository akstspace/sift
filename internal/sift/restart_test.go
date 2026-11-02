package sift

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestRestartEndpointRefusesDuringWorkAndAcceptsWhenIdle(t *testing.T) {
	s := testService(t)
	h := s.routes()
	post := func() *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest("POST", "/api/restart", nil))
		return rec
	}
	if rec := post(); rec.Code != 400 || !strings.Contains(rec.Body.String(), "only while Sift is serving") {
		t.Fatal("restart outside Serve must be refused", rec.Code, rec.Body.String())
	}
	requested := 0
	s.restart = func() { requested++ }
	s.runMu.Lock()
	s.active["run_fixture"] = func() {}
	s.runMu.Unlock()
	if rec := post(); rec.Code != 409 || !strings.Contains(rec.Body.String(), "running agents") || requested != 0 {
		t.Fatal("restart must wait for running agents", rec.Code, rec.Body.String(), requested)
	}
	s.runMu.Lock()
	delete(s.active, "run_fixture")
	s.maintenance = true
	s.runMu.Unlock()
	if rec := post(); rec.Code != 409 || requested != 0 {
		t.Fatal("restart must wait for maintenance", rec.Code)
	}
	s.runMu.Lock()
	s.maintenance = false
	s.runMu.Unlock()
	rec := post()
	if rec.Code != 202 || strings.TrimSpace(rec.Body.String()) != `{"restarting":true}` || requested != 1 {
		t.Fatal("idle restart was not accepted", rec.Code, rec.Body.String(), requested)
	}
}

// A restart must not wait out the graceful-shutdown timeout because a browser
// holds a live event stream, and it must release everything before reporting.
func TestServeRestartEndsStreamsAndReleasesResourcesFirst(t *testing.T) {
	dir := t.TempDir()
	done := make(chan error, 1)
	go func() { done <- Serve(context.Background(), dir, "127.0.0.1:0") }()
	var connection Connection
	deadline := time.Now().Add(5 * time.Second)
	for connection.URL == "" && time.Now().Before(deadline) {
		if data, err := os.ReadFile(filepath.Join(dir, "connection.json")); err == nil {
			_ = json.Unmarshal(data, &connection)
		}
		time.Sleep(10 * time.Millisecond)
	}
	if connection.URL == "" {
		t.Fatal("service did not start")
	}
	request := func(method, path string) *http.Response {
		req, _ := http.NewRequest(method, connection.URL+path, nil)
		req.Header.Set("Authorization", "Bearer "+connection.Token)
		req.Header.Set("X-Sift-Request", "1")
		r, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return r
	}
	stream := request("GET", "/api/events")
	defer stream.Body.Close()
	if _, err := bufio.NewReader(stream.Body).ReadString('\n'); err != nil {
		t.Fatal("event stream did not open", err)
	}
	// Startup maintenance (such as the daily backup) correctly defers a restart;
	// retry until the workspace is idle, as the UI does after a conflict.
	var started time.Time
	for attempt := 0; ; attempt++ {
		started = time.Now()
		restart := request("POST", "/api/restart")
		body := new(bytes.Buffer)
		_, _ = body.ReadFrom(restart.Body)
		restart.Body.Close()
		if restart.StatusCode == 202 {
			break
		}
		if restart.StatusCode != 409 || attempt > 100 {
			t.Fatal("restart was not accepted", restart.StatusCode, body.String())
		}
		time.Sleep(50 * time.Millisecond)
	}
	select {
	case err := <-done:
		if !errors.Is(err, ErrRestart) {
			t.Fatal("Serve must report the requested restart", err)
		}
	case <-time.After(8 * time.Second):
		t.Fatal("an open event stream held the restart open")
	}
	if elapsed := time.Since(started); elapsed > 5*time.Second {
		t.Fatal("restart waited for the shutdown timeout", elapsed)
	}
	if _, err := os.Stat(filepath.Join(dir, "connection.json")); !os.IsNotExist(err) {
		t.Fatal("connection file must be removed before restart", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	again := make(chan error, 1)
	go func() { again <- Serve(ctx, dir, "127.0.0.1:0") }()
	time.Sleep(200 * time.Millisecond)
	cancel()
	if err := <-again; err != nil {
		t.Fatal("the data lock was not released for the restarted process", err)
	}
}

func TestServeCommandReexecutesOnlyAfterARequestedRestart(t *testing.T) {
	previousServe, previousRestart := serve, restartProcess
	t.Cleanup(func() { serve, restartProcess = previousServe, previousRestart })
	outcome := ErrRestart
	serve = func(context.Context, string, string) error { return outcome }
	restarted := 0
	restartProcess = func() error { restarted++; return errors.New("exec refused") }
	var out bytes.Buffer
	args := []string{"--data", t.TempDir(), "serve", "--port", "0"}
	if err := CLI(context.Background(), args, &out); err == nil || err.Error() != "exec refused" || restarted != 1 || !strings.Contains(out.String(), "Restarting Sift") {
		t.Fatal("restart did not re-execute", err, restarted, out.String())
	}
	outcome = nil
	if err := CLI(context.Background(), args, &out); err != nil || restarted != 1 {
		t.Fatal("ordinary shutdown must not re-execute", err, restarted)
	}
}

func TestShutdownDuringStorageStartupIsNotReportedAsAFailure(t *testing.T) {
	pending := filepath.Join(t.TempDir(), "rustfs-never-ready")
	if err := os.WriteFile(pending, []byte("#!/bin/sh\nexec sleep 30\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("SIFT_RUSTFS", pending) // runs, never becomes ready
	s := testService(t)
	s.Start()
	time.Sleep(150 * time.Millisecond)
	s.cancel()
	s.wg.Wait()
	for _, n := range listAs[Notification](s.Store, "notification") {
		if n.Title == "Image storage needs attention" {
			t.Fatal("a deliberate shutdown was reported as a storage failure:", n.Message)
		}
	}
	if status := s.Storage.Status(); status["error"] != "" {
		t.Fatal("shutdown recorded a storage error", status["error"])
	}
}
