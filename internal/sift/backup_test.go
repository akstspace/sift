package sift

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/png"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func testService(t *testing.T) *Service {
	t.Helper()
	s, e := NewService(t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(s.Close)
	return s
}

func TestBackupRestoreHistoryMemoryLogsAndRequests(t *testing.T) {
	s := testService(t)
	a, e := s.Store.SaveTask(Task{Title: "A real observation", Source: "fixture", SourceKey: "42"}, 0, "fixture", "Observed", "request-42")
	if e != nil {
		t.Fatal(e)
	}
	j, e := s.SaveJob(Job{Name: "Review", Prompt: "Review work", Directory: s.Dir, Schedules: []JobSchedule{{Type: "daily", Schedule: "09:00"}}, Timezone: "UTC", Enabled: true}, 0, "user")
	if e != nil {
		t.Fatal(e)
	}
	session := filepath.Join(s.Dir, "sessions", j.ID, "memory.jsonl")
	if e = os.MkdirAll(filepath.Dir(session), 0700); e != nil {
		t.Fatal(e)
	}
	if e = os.WriteFile(session, []byte("{\"remembered\":true}\n"), 0600); e != nil {
		t.Fatal(e)
	}
	s.Store.AddLog("run-fixture", RunEntry{Type: "text", Text: "Evidence"})
	comment, e := s.Store.AddComment(a.ID, "A retained comment", "user", "comment-backup")
	if e != nil {
		t.Fatal(e)
	}
	before := s.Store.Events(0, a.ID, 100)
	backup, e := s.Backup()
	if e != nil {
		t.Fatal(e)
	}
	archive, e := os.ReadFile(backup)
	if e != nil {
		t.Fatal(e)
	}
	a.Title = "Later change"
	mustTask(t, s.Store, a)
	_ = os.WriteFile(session, []byte("different"), 0600)
	if e = s.RestoreArchive(context.Background(), archive); e != nil {
		t.Fatal(e)
	}
	var restored Task
	if !s.Store.Get("task", a.ID, &restored) || restored.Title != "A real observation" {
		t.Fatal(restored)
	}
	after := s.Store.Events(0, a.ID, 100)
	if !bytes.Equal(encode(before), encode(after)) {
		t.Fatal("history did not survive restore")
	}
	replayed, e := s.Store.AddComment(a.ID, "A retained comment", "user", "comment-backup")
	if e != nil || replayed.ID != comment.ID {
		t.Fatal("comment idempotency lost after restore", replayed, e)
	}
	var job Job
	s.Store.Get("job", j.ID, &job)
	if job.Enabled || job.Pending || job.SessionID != j.SessionID {
		t.Fatal("memory or paused-state lost", job)
	}
	b, _ := os.ReadFile(session)
	if string(b) != "{\"remembered\":true}\n" {
		t.Fatal("session lost", string(b))
	}
	if got := s.Store.Logs("run-fixture"); len(got) != 1 || got[0].Text != "Evidence" {
		t.Fatal(got)
	}
	result, e := s.Store.SaveTask(Task{Title: "A real observation", Source: "fixture", SourceKey: "42"}, 0, "fixture", "Observed", "request-42")
	if e != nil || result.ID != a.ID {
		t.Fatal("idempotency state lost", result, e)
	}
	files, _ := filepath.Glob(filepath.Join(s.Dir, "backups", "*.zip"))
	if len(files) != 2 {
		t.Fatal("restore did not make its own safety backup", files)
	}
}

func TestArchiveRejectsUnsafeDuplicateCorruptAndIncomplete(t *testing.T) {
	s := testService(t)
	mustTask(t, s.Store, Task{Title: "Keep this"})
	for _, names := range [][]string{{"../escape"}, {"manifest.json", "manifest.json"}, {"manifest.json"}, {"sessions/link"}} {
		var b bytes.Buffer
		z := zip.NewWriter(&b)
		for _, name := range names {
			h := &zip.FileHeader{Name: name, Method: zip.Deflate}
			if name == "sessions/link" {
				h.SetMode(os.ModeSymlink | 0700)
			}
			w, _ := z.CreateHeader(h)
			_, _ = w.Write([]byte(`{"format":2}`))
		}
		_ = z.Close()
		if e := s.RestoreArchive(context.Background(), b.Bytes()); e == nil {
			t.Fatal("accepted invalid archive", names)
		}
	}
	if len(s.Store.Tasks()) != 1 {
		t.Fatal("invalid archive mutated workspace")
	}
	p, e := s.Backup()
	if e != nil {
		t.Fatal(e)
	}
	b, _ := os.ReadFile(p)
	files, e := readArchive(b)
	if e != nil {
		t.Fatal(e)
	}
	files["workspace.json"] = []byte("tampered")
	var out bytes.Buffer
	z := zip.NewWriter(&out)
	for n, v := range files {
		w, _ := z.Create(n)
		_, _ = w.Write(v)
	}
	z.Close()
	if e = s.RestoreArchive(context.Background(), out.Bytes()); e == nil {
		t.Fatal("accepted corrupt checksum")
	}
}

func TestRestoreCrashRecovery(t *testing.T) {
	for _, commit := range []bool{false, true} {
		t.Run(map[bool]string{true: "after-commit", false: "before-commit"}[commit], func(t *testing.T) {
			s := testService(t)
			root := filepath.Join(s.Dir, "sessions")
			old := filepath.Join(s.Dir, "restore_fixture-old")
			stage := filepath.Join(s.Dir, "restore_fixture-new")
			os.Mkdir(root, 0700)
			os.WriteFile(filepath.Join(root, "new"), []byte("new"), 0600)
			os.Mkdir(old, 0700)
			os.WriteFile(filepath.Join(old, "old"), []byte("old"), 0600)
			j := restoreJournal{ID: "restore_fixture", Stage: filepath.Base(stage), Old: filepath.Base(old), HadSessions: true}
			os.WriteFile(filepath.Join(s.Dir, "restore.json"), encode(j), 0600)
			if commit {
				s.Store.DB.Exec("INSERT INTO metadata VALUES('restore_generation',?)", j.ID)
			}
			if e := s.recoverRestore(); e != nil {
				t.Fatal(e)
			}
			want := "old"
			if commit {
				want = "new"
			}
			if _, e := os.Stat(filepath.Join(root, want)); e != nil {
				t.Fatal(e)
			}
		})
	}
}

func TestFutureSchemaRefused(t *testing.T) {
	dir := t.TempDir()
	s, e := OpenStore(dir)
	if e != nil {
		t.Fatal(e)
	}
	s.DB.Exec("PRAGMA user_version=999")
	s.Close()
	if s, e = OpenStore(dir); e == nil {
		s.Close()
		t.Fatal("old binary opened newer schema")
	}
}

func TestRetentionKeepsHistoryAndSummaries(t *testing.T) {
	s := testStore(t)
	a := mustTask(t, s, Task{Title: "Old trash", DeletedAt: time.Now().AddDate(0, 0, -31).UTC().Format(time.RFC3339Nano)})
	s.AddLog("run", RunEntry{Type: "text", Text: "old"})
	s.DB.Exec("UPDATE run_logs SET at=?", time.Now().AddDate(0, 0, -31).UTC().Format(time.RFC3339Nano))
	s.Put("run", "run", Run{ID: "run", Summary: "Keep summary"}, "system", "")
	s.Prune(Settings{TrashRetentionDays: 30, LogRetentionDays: 30})
	if len(s.Tasks()) != 0 || len(s.Logs("run")) != 0 || len(s.Events(0, a.ID, 100)) == 0 {
		t.Fatal("bad retention")
	}
	var r Run
	if !s.Get("run", "run", &r) || r.Summary != "Keep summary" {
		t.Fatal("summary lost")
	}
}

func TestRustFSImagesBackupRestoreIntegration(t *testing.T) {
	if os.Getenv("SIFT_INTEGRATION") != "1" {
		t.Skip("Set SIFT_INTEGRATION=1 to launch bundled RustFS")
	}
	// Exercise the platform-default macOS shape, including whitespace and
	// Unicode. Upload, backup, and restore must retain this exact objects volume.
	dir := filepath.Join(t.TempDir(), "Application Support", "Sift 照片")
	s, err := NewService(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	if e := s.Storage.Start(ctx, s.Dir); e != nil {
		t.Fatal(e)
	}
	var b bytes.Buffer
	png.Encode(&b, image.NewRGBA(image.Rect(0, 0, 2, 2)))
	a, e := s.Storage.Upload(ctx, "tiny.png", b.Bytes())
	if e != nil {
		t.Fatal(e)
	}
	if e = s.Store.Put("attachment", a.ID, a, "user", "Image"); e != nil {
		t.Fatal(e)
	}
	mustTask(t, s.Store, Task{Title: "Image task", Attachments: []string{a.ID}})
	p, e := s.Backup()
	if e != nil {
		t.Fatal(e)
	}
	data, _ := os.ReadFile(p)
	if e = s.RestoreArchive(ctx, data); e != nil {
		t.Fatal(e)
	}
	got, e := s.Storage.Read(ctx, a.ID)
	if e != nil || !bytes.Equal(got, b.Bytes()) {
		t.Fatal("image round trip failed", e)
	}
	encoded, e := s.Storage.ReadBase64(ctx, a.ID)
	if e != nil || encoded != base64.StdEncoding.EncodeToString(b.Bytes()) {
		t.Fatal("model-consented image encoding failed", e)
	}
	if _, e := s.Storage.ReadBase64(ctx, "../outside"); e == nil {
		t.Fatal("unsafe model image reference accepted")
	}
	var manifest map[string]json.RawMessage
	files, _ := readArchive(data)
	json.Unmarshal(files["manifest.json"], &manifest)
	if len(manifest) == 0 {
		t.Fatal("missing manifest")
	}
}
