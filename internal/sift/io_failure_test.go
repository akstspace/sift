package sift

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"image"
	"image/png"
	"io"
	"mime/multipart"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"modernc.org/sqlite"
)

func TestImageUploadReadFailureNeverCreatesAttachment(t *testing.T) {
	s := testService(t)
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile("file", "fixture.png")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = part.Write(bytes.Repeat([]byte("x"), 2048)); err != nil {
		t.Fatal(err)
	}
	if err = writer.Close(); err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest("POST", "/api/images", &body)
	r.Header.Set("Content-Type", writer.FormDataContentType())
	// Force the real multipart parser to spill to a disposable file, then make
	// that backing path unreadable as file data without mocking the HTTP route.
	temp := t.TempDir()
	t.Setenv("TMPDIR", temp)
	if err = r.ParseMultipartForm(1); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { r.MultipartForm.RemoveAll() })
	entries, err := os.ReadDir(temp)
	if err != nil || len(entries) != 1 {
		t.Fatal("expected exactly one multipart spool", entries, err)
	}
	path := filepath.Join(temp, entries[0].Name())
	if err = os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err = os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	s.routes().ServeHTTP(w, r)
	if w.Code != 500 || !strings.Contains(w.Body.String(), "directory") || len(listAs[Attachment](s.Store, "attachment")) != 0 {
		t.Fatal("backing-file read failure was hidden or persisted", w.Code, w.Body.String())
	}
}

func TestRestoreUploadFailurePreservesCurrentRecordsAndSessions(t *testing.T) {
	source := testService(t)
	files := backupFiles(t, source)
	var imageBytes bytes.Buffer
	if err := png.Encode(&imageBytes, image.NewRGBA(image.Rect(0, 0, 2, 2))); err != nil {
		t.Fatal(err)
	}
	a, err := inspectImage("restore.png", imageBytes.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	var workspace map[string]any
	if err = json.Unmarshal(files["workspace.json"], &workspace); err != nil {
		t.Fatal(err)
	}
	workspace["attachments"] = []Attachment{a}
	files["workspace.json"] = encode(workspace)
	files["images/"+a.ID] = imageBytes.Bytes()
	files["sessions/memory.jsonl"] = []byte("archived session")
	s := testService(t) // storage intentionally unavailable, with no model work
	current := mustTask(t, s.Store, Task{Title: "Current work survives storage failure"})
	if err = s.RestoreArchive(context.Background(), indexedArchive(t, files)); err == nil || !strings.Contains(err.Error(), "storage is unavailable") {
		t.Fatal("restore claimed success without storing images", err)
	}
	var got Task
	if !s.Store.Get("task", current.ID, &got) || !bytes.Equal(encode(got), encode(current)) {
		t.Fatal("failed image restore replaced current records", got)
	}
	for _, path := range []string{"sessions", "restore.json"} {
		if _, err = os.Stat(filepath.Join(s.Dir, path)); !os.IsNotExist(err) {
			t.Fatal("failed image restore began the session swap", path, err)
		}
	}
	if _, err = s.Store.SaveTask(Task{Title: "Explicit work after refused restore"}, 0, "user", "", ""); err != nil {
		t.Fatal("restore failure leaked the maintenance lock", err)
	}
}

func TestWriteSyncReportsDeviceDurabilityFailure(t *testing.T) {
	// /dev/null accepts a write but cannot fsync. A successful write alone must
	// never be presented as a durable backup/journal/update write.
	if err := writeSync(os.DevNull, []byte("fixture"), 0600); err == nil {
		t.Fatal("non-durable device write reported success")
	}
}

func TestRegisteredNonRasterFormatIsStillRefused(t *testing.T) {
	// Other imports may register additional Go image decoders. A successful
	// DecodeConfig must not widen Sift's explicit PNG/JPEG/WebP/GIF allowlist.
	image.RegisterFormat("sift-test-non-raster", "SIFT-UNSUPPORTED-IMAGE", func(io.Reader) (image.Image, error) {
		return image.NewRGBA(image.Rect(0, 0, 1, 1)), nil
	}, func(io.Reader) (image.Config, error) {
		return image.Config{Width: 1, Height: 1}, nil
	})
	if _, err := inspectImage("not-an-allowed-image", []byte("SIFT-UNSUPPORTED-IMAGE")); err == nil || !strings.Contains(err.Error(), "Unsupported image format") {
		t.Fatal("registered decoder bypassed the image allowlist", err)
	}
}

func TestMaintenanceRunsAgainOnRealMinuteTickAndStops(t *testing.T) {
	s := testService(t)
	var cfg Settings
	s.Store.Get("settings", "app", &cfg)
	cfg.LastBackup, cfg.CheckUpdates = now(), false
	if err := s.SaveSettings(cfg); err != nil {
		t.Fatal(err)
	}
	initial := make(chan struct{}, 1)
	reset := denyQuery(t, s.Store.DB, func(action sqlite.AuthorizerActionCode, table, _ string) bool {
		if action == sqlite.AuthDelete && table == "run_logs" {
			select {
			case initial <- struct{}{}:
			default:
			}
		}
		return false
	})
	done := make(chan struct{})
	go func() { s.maintenanceLoop(); close(done) }()
	defer func() { s.cancel(); <-done }()
	// Wait for the real initial pass, then insert old Trash. Its pruning proves
	// the minute tick actually ran, rather than merely waiting out a timeout.
	select {
	case <-initial:
	case <-time.After(5 * time.Second):
		t.Fatal("maintenance initial pass did not finish")
	}
	reset()
	old := time.Now().AddDate(0, 0, -31).UTC().Format(time.RFC3339Nano)
	task := mustTask(t, s.Store, Task{Title: "Expired Trash", DeletedAt: old})
	timer := time.NewTimer(65 * time.Second)
	defer timer.Stop()
	tick := time.NewTicker(100 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-timer.C:
			t.Fatal("maintenance did not prune expired Trash on its real tick")
		case <-tick.C:
			var got Task
			if !s.Store.Get("task", task.ID, &got) {
				return
			}
		}
	}
}

func TestStorageCancellationWhileWaitingForReadiness(t *testing.T) {
	peer := filepath.Join(t.TempDir(), "unready-storage")
	// This local deterministic process does not bind a port or use a model.
	if err := os.WriteFile(peer, []byte("#!/usr/bin/env python3\nimport signal\nsignal.pause()\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("SIFT_RUSTFS", peer)
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()
	var storage Storage
	defer storage.Close()
	if err := storage.Start(ctx, t.TempDir()); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal("cancelled readiness wait reported healthy", err)
	}
	if storage.Status()["ready"] != false {
		t.Fatal("unready process became healthy after cancellation")
	}
}

func TestStorageReadinessTimeoutAndForcedShutdownAreReported(t *testing.T) {
	peer := filepath.Join(t.TempDir(), "unresponsive-storage")
	// Ignores graceful interruption so the test observes the real eight-second
	// kill fallback. Neither host services nor a real RustFS instance is touched.
	if err := os.WriteFile(peer, []byte("#!/usr/bin/env python3\nimport signal\nsignal.signal(signal.SIGINT, signal.SIG_IGN)\nsignal.pause()\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("SIFT_RUSTFS", peer)
	var storage Storage
	defer storage.Close()
	start := time.Now()
	if err := storage.Start(context.Background(), t.TempDir()); err == nil || !strings.Contains(err.Error(), "did not become ready") {
		t.Fatal("unresponsive storage did not report its readiness deadline", err)
	}
	if time.Since(start) < 45*time.Second || storage.Status()["ready"] != false {
		t.Fatal("readiness timeout was bypassed")
	}
	storage.Close()
	select {
	case err := <-storage.wait:
		var exit *exec.ExitError
		if !errors.As(err, &exit) {
			t.Fatal("unresponsive fixture was not killed", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("forced storage shutdown leaked its child process")
	}
}
