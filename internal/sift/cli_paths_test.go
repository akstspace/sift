package sift

import (
	"bytes"
	"context"
	"errors"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

type unreadableBody struct{}

func (unreadableBody) Read([]byte) (int, error) { return 0, io.ErrUnexpectedEOF }
func (unreadableBody) Close() error             { return nil }

func cliFixtureConnection(t *testing.T, url string) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "connection.json"), encode(Connection{URL: url, Token: "private-fixture"}), 0600); err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestCLIRejectsMalformedOrNonLocalConnections(t *testing.T) {
	for _, url := range []string{"http://127.0.0.1:80@foreign.example", "http://127.0.0.1:80/path", "http://127.0.0.1:80?query=1", "http://127.0.0.1:80#fragment", "http://127.0.0.1:0", "http://127.0.0.1:65536", "http://127.0.0.1:bad", "http://127.0.0.1", "https://127.0.0.1:80", "http://localhost:80"} {
		dir := cliFixtureConnection(t, url)
		if _, err := clientFor(dir, ""); err == nil {
			t.Fatal("unsafe local connection accepted", url)
		}
	}
	dir := cliFixtureConnection(t, "http://127.0.0.1:57431")
	os.WriteFile(filepath.Join(dir, "connection.json"), encode(Connection{URL: "http://127.0.0.1:57431"}), 0600)
	if _, err := clientFor(dir, ""); err == nil {
		t.Fatal("empty token accepted")
	}
	var out bytes.Buffer
	if err := CLI(context.Background(), []string{"--data", t.TempDir(), "tasks", "list"}, &out); err == nil {
		t.Fatal("missing connection hidden")
	}
	if _, err := serveAddress(map[string]string{"address": "127.0.0.1:65536"}); err == nil {
		t.Fatal("invalid address port accepted")
	}
}

func TestCLITransportAndResponseReadFailuresAreNotSuccess(t *testing.T) {
	c := &localClient{Connection: Connection{URL: "http://127.0.0.1:57431", Token: "fixture"}}
	mockHTTP(t, 0, "", errors.New("fixture disconnected"))
	if _, err := c.request(context.Background(), "GET", "/api/tasks", nil); err == nil || !strings.Contains(err.Error(), "start sift serve") {
		t.Fatal(err)
	}
	if _, err := c.request(context.Background(), "GET", "/api/\n", nil); err == nil {
		t.Fatal("malformed request accepted")
	}
	previous := http.DefaultClient
	http.DefaultClient = &http.Client{Transport: fixtureTransport(func(r *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: unreadableBody{}, Request: r}, nil
	})}
	t.Cleanup(func() { http.DefaultClient = previous })
	if _, err := c.request(context.Background(), "GET", "/api/tasks", nil); !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatal("partial JSON accepted", err)
	}
	dir := cliFixtureConnection(t, c.URL)
	file := filepath.Join(dir, "image.png")
	os.WriteFile(file, []byte("fixture"), 0600)
	if err := CLI(context.Background(), []string{"--data", dir, "images", "upload", file}, io.Discard); !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatal("partial upload response accepted", err)
	}
}

func TestCLIImageMultipartAndUpdateRouting(t *testing.T) {
	var seen []string
	var mu sync.Mutex
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		seen = append(seen, r.Method+" "+r.URL.Path)
		if r.Header.Get("Authorization") != "Bearer private-fixture" || r.Header.Get("X-Sift-Request") != "1" || r.Header.Get("X-Sift-Actor") != "cli-test" {
			t.Error("CLI omitted private request headers")
		}
		if r.URL.Path == "/api/images" {
			if err := r.ParseMultipartForm(1024); err != nil {
				t.Error(err)
				return
			}
			defer r.MultipartForm.RemoveAll()
			f, h, err := r.FormFile("file")
			if err != nil {
				t.Error(err)
				return
			}
			defer f.Close()
			b, _ := io.ReadAll(f)
			if h.Filename != "image.png" || string(b) != "local image bytes" {
				t.Error("multipart body lost local file")
			}
		}
		if r.URL.Query().Get("plain") == "1" {
			io.WriteString(w, "plain evidence")
			return
		}
		io.WriteString(w, `{"accepted":true}`)
	}))
	defer server.Close()
	dir := cliFixtureConnection(t, server.URL)
	file := filepath.Join(dir, "image.png")
	os.WriteFile(file, []byte("local image bytes"), 0600)
	for _, args := range [][]string{{"models", "list"}, {"backup"}, {"update", "--check"}, {"update"}, {"images", "upload", file}} {
		var out bytes.Buffer
		if err := CLI(context.Background(), append([]string{"--data", dir, "--actor", "cli-test"}, args...), &out); err != nil || !strings.Contains(out.String(), `"accepted":true`) && !strings.Contains(out.String(), `"accepted": true`) {
			t.Fatal(args, out.String(), err)
		}
	}
	want := []string{"GET /api/pi", "POST /api/backups", "POST /api/update/check", "POST /api/update/apply", "POST /api/images"}
	mu.Lock()
	got := strings.Join(seen, "|")
	mu.Unlock()
	if got != strings.Join(want, "|") {
		t.Fatal(got)
	}
	// Both ordinary output and image output must propagate a broken output pipe.
	if err := CLI(context.Background(), []string{"--data", dir, "--actor", "cli-test", "images", "upload", file}, failingPiInput{}); !errors.Is(err, io.ErrClosedPipe) {
		t.Fatal(err)
	}
	if err := CLI(context.Background(), []string{"--data", dir, "--actor", "cli-test", "schema"}, failingPiInput{}); !errors.Is(err, io.ErrClosedPipe) {
		t.Fatal(err)
	}
}

func TestCLIImageInputAndServerErrors(t *testing.T) {
	dir := cliFixtureConnection(t, "http://127.0.0.1:57431")
	file := filepath.Join(dir, "image.png")
	os.WriteFile(file, []byte("fixture"), 0600)
	mockHTTP(t, 400, `{"error":"invalid image"}`, nil)
	if err := CLI(context.Background(), []string{"--data", dir, "images", "upload", file}, io.Discard); err == nil || !strings.Contains(err.Error(), "invalid image") {
		t.Fatal(err)
	}
	mockHTTP(t, 0, "", errors.New("disconnected"))
	if err := CLI(context.Background(), []string{"--data", dir, "images", "upload", file}, io.Discard); err == nil {
		t.Fatal("transport failure hidden")
	}
	if err := CLI(context.Background(), []string{"--data", dir, "images", "upload", dir}, io.Discard); err == nil {
		t.Fatal("directory uploaded")
	}
}

func TestCLITaskTagsAttachmentsAndMissingUpdate(t *testing.T) {
	s := testService(t)
	server := httptest.NewServer(s.routes())
	defer server.Close()
	if err := os.WriteFile(filepath.Join(s.Dir, "connection.json"), encode(Connection{URL: server.URL, Token: "fixture"}), 0600); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"one", "two"} {
		if err := s.Store.Put("tag", id, Entity{ID: id, Name: id}, "user", ""); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.Store.Put("attachment", "image", Attachment{ID: "image"}, "user", ""); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := CLI(context.Background(), []string{"--data", s.Dir, "tasks", "add", "--title", "Tagged image", "--tags", "one,two", "--attachment", "image"}, &out); err != nil {
		t.Fatal(err)
	}
	tasks := s.Store.Tasks()
	if len(tasks) != 1 || len(tasks[0].Tags) != 2 || len(tasks[0].Attachments) != 1 {
		t.Fatal(tasks)
	}
	if err := CLI(context.Background(), []string{"--data", s.Dir, "tasks", "update", "missing", "--revision", "1"}, io.Discard); err == nil {
		t.Fatal("missing update succeeded")
	}
}

func TestAPIMultipartRequiresFileAndReportsStorageOutage(t *testing.T) {
	s := testService(t)
	for _, file := range []bool{false, true} {
		var body bytes.Buffer
		writer := multipart.NewWriter(&body)
		if file {
			part, _ := writer.CreateFormFile("file", "image.png")
			part.Write([]byte("not an image"))
		} else {
			writer.WriteField("name", "missing file")
		}
		writer.Close()
		r := httptest.NewRequest("POST", "/api/images", &body)
		r.Header.Set("Content-Type", writer.FormDataContentType())
		w := httptest.NewRecorder()
		s.routes().ServeHTTP(w, r)
		if w.Code != 400 {
			t.Fatal(w.Code, w.Body.String())
		}
	}
}
