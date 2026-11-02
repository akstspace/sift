package sift

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestServeLifecycleAndPrivateHTTPBoundary(t *testing.T) {
	// Exercise the real listener and background loops without launching Pi or an
	// external service. A missing image runtime must be reported, not hidden.
	t.Setenv("SIFT_RUSTFS", filepath.Join(t.TempDir(), "missing-rustfs"))
	dir := t.TempDir()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- Serve(ctx, dir, "127.0.0.1:0") }()
	t.Cleanup(func() {
		cancel()
		select {
		case err := <-done:
			if err != nil {
				t.Errorf("serve shutdown: %v", err)
			}
		case <-time.After(15 * time.Second):
			t.Error("service did not shut down")
		}
	})
	var connection Connection
	deadline := time.After(5 * time.Second)
	tick := time.NewTicker(10 * time.Millisecond)
	defer tick.Stop()
	for connection.URL == "" {
		select {
		case <-deadline:
			t.Fatal("service did not publish its private connection file")
		case <-tick.C:
			data, err := os.ReadFile(filepath.Join(dir, "connection.json"))
			if err == nil {
				_ = json.Unmarshal(data, &connection)
			}
		}
	}
	info, err := os.Stat(filepath.Join(dir, "connection.json"))
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("connection file must be private")
	}
	client := &http.Client{Timeout: 5 * time.Second}
	request := func(method, path string, headers map[string]string, host string) *http.Response {
		t.Helper()
		req, err := http.NewRequest(method, connection.URL+path, nil)
		if err != nil {
			t.Fatal(err)
		}
		for name, value := range headers {
			req.Header.Set(name, value)
		}
		if host != "" {
			req.Host = host
		}
		r, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { r.Body.Close() })
		return r
	}
	for _, tc := range []struct {
		name, method, path, host string
		headers                  map[string]string
		status                   int
	}{
		{"private API", "GET", "/api/snapshot", "", nil, 401},
		{"foreign host", "GET", "/", "foreign.test", nil, 403},
		{"foreign origin", "GET", "/", "", map[string]string{"Origin": "https://foreign.test"}, 403},
		{"cross site", "GET", "/", "", map[string]string{"Sec-Fetch-Site": "cross-site"}, 403},
		{"missing CSRF header", "POST", "/api/backups", "", map[string]string{"Authorization": "Bearer " + connection.Token}, 403},
		{"authorized read", "GET", "/api/snapshot", "", map[string]string{"Authorization": "Bearer " + connection.Token, "Origin": connection.URL}, 200},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := request(tc.method, tc.path, tc.headers, tc.host)
			if r.StatusCode != tc.status {
				t.Fatalf("HTTP %d, want %d", r.StatusCode, tc.status)
			}
			if r.Header.Get("X-Content-Type-Options") != "nosniff" || r.Header.Get("Content-Security-Policy") == "" {
				t.Fatal("missing security headers")
			}
			if strings.HasPrefix(tc.path, "/api/") && r.Header.Get("Cache-Control") != "no-store" {
				t.Fatal("private API must not be cached")
			}
			r.Body.Close()
		})
	}
	root := request("GET", "/", nil, "")
	cookies := root.Cookies()
	root.Body.Close()
	if len(cookies) != 1 || !cookies[0].HttpOnly || cookies[0].SameSite != http.SameSiteStrictMode {
		t.Fatal("missing private same-site bootstrap cookie")
	}
	r := request("GET", "/api/health", map[string]string{"Cookie": cookies[0].String()}, "")
	if r.StatusCode != 200 {
		t.Fatal("bootstrap cookie did not authorize the local browser")
	}
	r.Body.Close()
	stream := request("GET", "/api/events?after=999999999", map[string]string{"Authorization": "Bearer " + connection.Token}, "")
	reader := bufio.NewReader(stream.Body)
	line, err := reader.ReadString('\n')
	if err != nil || line != "event: reset\n" {
		t.Fatalf("future cursor must reset: %q %v", line, err)
	}
	stream.Body.Close()
	if err := Serve(context.Background(), dir, "127.0.0.1:0"); err == nil || !strings.Contains(err.Error(), "already running") {
		t.Fatal("second writer was not refused", err)
	}
}

func TestServeStartupRefusalsDoNotChangeExistingData(t *testing.T) {
	for _, address := range []string{"localhost:57431", "0.0.0.0:57431", "invalid"} {
		if err := Serve(context.Background(), t.TempDir(), address); err == nil {
			t.Fatal("accepted non-loopback address", address)
		}
	}
	file := filepath.Join(t.TempDir(), "not-a-directory")
	if err := os.WriteFile(file, []byte("preserve"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := Serve(context.Background(), file, "127.0.0.1:0"); err == nil {
		t.Fatal("accepted a file as the data directory")
	}
	if _, err := lockData(filepath.Join(file, "missing")); err == nil {
		t.Fatal("lock accepted an invalid directory")
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	if err := Serve(context.Background(), t.TempDir(), listener.Addr().String()); err == nil || !strings.Contains(err.Error(), "Choose another port") {
		t.Fatal("missing actionable port conflict", err)
	}
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, "connection.json"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := Serve(context.Background(), dir, "127.0.0.1:0"); err == nil {
		t.Fatal("overwrote the connection path")
	}
}

type brokenStream struct {
	header  http.Header
	flushed bool
}

func (w *brokenStream) Header() http.Header       { return w.header }
func (w *brokenStream) WriteHeader(int)           {}
func (w *brokenStream) Write([]byte) (int, error) { return 0, errors.New("disconnected reader") }
func (w *brokenStream) Flush()                    { w.flushed = true }

type noFlush struct {
	header http.Header
	status int
}

func (w *noFlush) Header() http.Header         { return w.header }
func (w *noFlush) WriteHeader(status int)      { w.status = status }
func (w *noFlush) Write(p []byte) (int, error) { return len(p), nil }

func TestStreamEventsHandlesDisconnectAndUnsupportedWriters(t *testing.T) {
	s := testService(t)
	plain := &noFlush{header: make(http.Header)}
	s.streamEvents(plain, httptest.NewRequest("GET", "/api/events", nil))
	if plain.status != 500 {
		t.Fatal("unsupported streaming writer was not reported")
	}
	for _, path := range []string{"/api/events", "/api/events?after=999999999"} {
		broken := &brokenStream{header: make(http.Header)}
		s.streamEvents(broken, httptest.NewRequest("GET", path, nil))
		if broken.flushed {
			t.Fatal("flushed after a failed write")
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/api/events", nil).WithContext(ctx)
	r.Header.Set("Last-Event-ID", "1")
	s.streamEvents(w, r)
	data, _ := io.ReadAll(w.Result().Body)
	if !strings.Contains(string(data), "event: change") || !strings.Contains(string(data), "event: tick") {
		t.Fatal("stream did not publish persisted changes and liveness ticks")
	}
}
