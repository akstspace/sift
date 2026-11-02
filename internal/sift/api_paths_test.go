package sift

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/png"
	"mime/multipart"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestAPIMaintenanceBackupRestoreAndSetup(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	s := testService(t)
	h := s.routes()
	var health struct {
		Platform string `json:"platform"`
	}
	json.Unmarshal(routeRequest(t, h, "GET", "/api/health", nil, 200, false), &health)
	if health.Platform != runtime.GOOS {
		t.Fatal("health reported build environment rather than runtime OS", health)
	}
	task := mustTask(t, s.Store, Task{Title: "Before API restore"})
	var backup struct {
		Name string `json:"name"`
	}
	json.Unmarshal(routeRequest(t, h, "POST", "/api/backups", nil, 200, false), &backup)
	if backup.Name == "" {
		t.Fatal("missing downloadable backup")
	}
	listing := routeRequest(t, h, "GET", "/api/backups", nil, 200, false)
	if !bytes.Contains(listing, []byte(backup.Name)) {
		t.Fatal("backup not discoverable")
	}
	archive := routeRequest(t, h, "GET", "/api/backups/"+backup.Name, nil, 200, false)
	if _, err := readArchive(archive); err != nil {
		t.Fatal(err)
	}
	task.Title = "Later edit"
	mustTask(t, s.Store, task)
	response := routeRequest(t, h, "POST", "/api/restore", string(archive), 200, false)
	if !bytes.Contains(response, []byte(`"jobsPaused":true`)) {
		t.Fatal(string(response))
	}
	s.Store.Get("task", task.ID, &task)
	if task.Title != "Before API restore" {
		t.Fatal(task)
	}
	for _, action := range []string{"skill", "cli"} {
		routeRequest(t, h, "POST", "/api/setup/"+action, map[string]bool{}, 200, false)
	}
	routeRequest(t, h, "POST", "/api/setup/unknown", map[string]bool{}, 400, false)
	events := s.Store.Events(0, task.ID, 100)
	routeRequest(t, h, "POST", "/api/undo/"+jsonNumber(events[0].ID), nil, 200, false)
	s.dataMu.Lock()
	routeRequest(t, h, "POST", "/api/backups", nil, 409, false)
	s.dataMu.Unlock()
	for _, path := range []string{"/sw.js", "/route-that-uses-spa-fallback"} {
		routeRequest(t, h, "GET", path, nil, 200, false)
	}
	// A directory cannot be served as a frontend file.
	routeRequest(t, h, "GET", "/assets", nil, 404, false)
	fixturePi(t)
	routeRequest(t, h, "GET", "/api/pi", nil, 200, false)
	t.Setenv("SIFT_PI", filepath.Join(t.TempDir(), "missing"))
	routeRequest(t, h, "GET", "/api/pi", nil, 503, false)
	mockHTTP(t, 404, "", nil)
	routeRequest(t, h, "POST", "/api/update/check", nil, 200, false)
	routeRequest(t, h, "POST", "/api/update/apply", nil, 400, false)
}

func jsonNumber(value int64) string { return string(encode(value)) }

func TestAPIFailedWritesAreNotReportedAsSuccessful(t *testing.T) {
	s := testService(t)
	if err := s.Store.Put("notification", "notice", Notification{ID: "notice"}, "system", "fixture"); err != nil {
		t.Fatal(err)
	}
	if err := s.Store.Put("column", "review", Column{ID: "review", Name: "Review"}, "user", "fixture"); err != nil {
		t.Fatal(err)
	}
	task := mustTask(t, s.Store, Task{Title: "Keep workflow on failed move", Status: "review"})
	if _, err := s.Store.DB.Exec(`CREATE TRIGGER refuse_api_insert BEFORE INSERT ON objects BEGIN SELECT RAISE(FAIL,'fixture storage failure'); END`); err != nil {
		t.Fatal(err)
	}
	h := s.routes()
	for _, path := range []string{"/api/projects", "/api/tags"} {
		routeRequest(t, h, "POST", path, map[string]string{"name": "Not persisted"}, 500, false)
	}
	if _, err := s.Store.DB.Exec(`CREATE TRIGGER refuse_api_update BEFORE UPDATE ON objects BEGIN SELECT RAISE(FAIL,'fixture storage failure'); END`); err != nil {
		t.Fatal(err)
	}
	routeRequest(t, h, "POST", "/api/notifications/notice/read", nil, 500, false)
	routeRequest(t, h, "DELETE", "/api/columns/review?moveTo=open", nil, 500, false)
	var notice Notification
	if !s.Store.Get("notification", "notice", &notice) || notice.Read {
		t.Fatal("failed acknowledgement changed unread state")
	}
	var after Task
	if !s.Store.Get("task", task.ID, &after) || after.Status != "review" {
		t.Fatal("failed workflow removal moved a task")
	}
	var column Column
	if !s.Store.Get("column", "review", &column) {
		t.Fatal("failed workflow removal lost its column")
	}
}

func TestAPIPiUpdateUsesOnlyDisposableFixtureAndMaintenance(t *testing.T) {
	for _, fail := range []bool{false, true} {
		t.Run(map[bool]string{false: "success", true: "failure"}[fail], func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "pi-fixture")
			code := "#!/bin/sh\n[ \"$1\" = update ] || exit 2\necho local fixture only\n"
			status := 200
			if fail {
				code += "exit 1\n"
				status = 500
			}
			if err := os.WriteFile(path, []byte(code), 0700); err != nil {
				t.Fatal(err)
			}
			t.Setenv("SIFT_PI", path)
			s := testService(t)
			h := s.routes()
			routeRequest(t, h, "POST", "/api/pi/update", nil, status, false)
			s.dataMu.Lock()
			routeRequest(t, h, "POST", "/api/pi/update", nil, 409, false)
			s.dataMu.Unlock()
		})
	}
}

func TestAPIRealImageUploadReadAndPersistenceFailures(t *testing.T) {
	if os.Getenv("SIFT_INTEGRATION") != "1" {
		t.Skip("Set SIFT_INTEGRATION=1 to launch bundled RustFS")
	}
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
	upload := func(status int) []byte {
		t.Helper()
		var body bytes.Buffer
		writer := multipart.NewWriter(&body)
		part, err := writer.CreateFormFile("file", "tiny.png")
		if err != nil {
			t.Fatal(err)
		}
		part.Write(b.Bytes())
		writer.Close()
		r := httptest.NewRequest("POST", "/api/images", &body)
		r.Header.Set("Content-Type", writer.FormDataContentType())
		w := httptest.NewRecorder()
		s.routes().ServeHTTP(w, r)
		if w.Code != status {
			t.Fatal(w.Code, w.Body.String())
		}
		return w.Body.Bytes()
	}
	var response struct {
		Attachment Attachment `json:"attachment"`
		URL        string     `json:"url"`
	}
	json.Unmarshal(upload(200), &response)
	got := routeRequest(t, s.routes(), "GET", response.URL, nil, 200, false)
	if !bytes.Equal(got, b.Bytes()) {
		t.Fatal("image bytes changed")
	}
	if _, err := s.Store.DB.Exec(`CREATE TRIGGER refuse_image BEFORE INSERT ON objects WHEN NEW.kind='attachment' BEGIN SELECT RAISE(FAIL,'fixture failure'); END`); err != nil {
		t.Fatal(err)
	}
	upload(500)
	s.Storage.mu.Lock()
	client := s.Storage.Client
	s.Storage.Client = nil
	s.Storage.Ready = false
	s.Storage.mu.Unlock()
	upload(503)
	routeRequest(t, s.routes(), "GET", response.URL, nil, 503, false)
	s.Storage.mu.Lock()
	s.Storage.Client = client
	s.Storage.Ready = true
	s.Storage.mu.Unlock()
	// A content hash mismatch must refuse the complete export, not omit the image.
	response.Attachment.Hash = strings.Repeat("0", 64)
	s.Store.DB.Exec("DROP TRIGGER refuse_image")
	if err := s.Store.Put("attachment", response.Attachment.ID, response.Attachment, "fixture", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Backup(); err == nil || !strings.Contains(err.Error(), "Image checksum mismatch") {
		t.Fatal(err)
	}
}
