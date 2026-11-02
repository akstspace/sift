package sift

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Re-index changed records so restore tests reach semantic validation rather
// than stopping at the archive checksum. This never edits a real workspace.
func indexedArchive(t *testing.T, files map[string][]byte) []byte {
	t.Helper()
	m := archiveManifest{Format: 2, Version: Version, Files: map[string]string{}}
	for name, data := range files {
		if name != "manifest.json" {
			sum := sha256.Sum256(data)
			m.Files[name] = hex.EncodeToString(sum[:])
		}
	}
	files["manifest.json"] = encode(m)
	var b bytes.Buffer
	z := zip.NewWriter(&b)
	for name, data := range files {
		w, err := z.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = w.Write(data); err != nil {
			t.Fatal(err)
		}
	}
	if err := z.Close(); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func backupFiles(t *testing.T, s *Service) map[string][]byte {
	t.Helper()
	p, err := s.Backup()
	if err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	files, err := readArchive(b)
	if err != nil {
		t.Fatal(err)
	}
	return files
}

func TestRestoreRefusesInvalidRecordsWithoutTouchingWorkspace(t *testing.T) {
	s := testService(t)
	task := mustTask(t, s.Store, Task{Title: "Preserved current work"})
	base := backupFiles(t, s)
	before := encode(s.Store.Snapshot())
	for _, tc := range []struct {
		name, want string
		edit       func(map[string][]byte)
	}{
		{"workspace syntax", "Invalid workspace", func(f map[string][]byte) { f["workspace.json"] = []byte("{") }},
		{"missing task array", "Invalid task records", func(f map[string][]byte) {
			var w map[string]json.RawMessage
			json.Unmarshal(f["workspace.json"], &w)
			delete(w, "tasks")
			f["workspace.json"] = encode(w)
		}},
		{"broken references", "unknown workflow", func(f map[string][]byte) {
			var w map[string]json.RawMessage
			json.Unmarshal(f["workspace.json"], &w)
			bad := task
			bad.Status = "missing"
			w["tasks"] = encode([]Task{bad})
			f["workspace.json"] = encode(w)
		}},
		{"history syntax", "Invalid backup history", func(f map[string][]byte) { f["history.json"] = []byte("{") }},
		{"requests syntax", "Invalid backup history", func(f map[string][]byte) { f["requests.json"] = []byte("{") }},
		{"logs syntax", "Invalid backup history", func(f map[string][]byte) { f["logs.json"] = []byte("{") }},
		{"history order", "Invalid history ordering", func(f map[string][]byte) {
			f["history.json"] = encode([]Event{{ID: 2, Kind: "task", EntityID: task.ID}, {ID: 1, Kind: "task", EntityID: task.ID}})
		}},
		{"empty history kind", "Invalid history ordering", func(f map[string][]byte) { f["history.json"] = encode([]Event{{ID: 1, EntityID: task.ID}}) }},
		{"request identity", "Invalid idempotency", func(f map[string][]byte) {
			f["requests.json"] = encode([]requestRecord{{ID: "", Hash: strings.Repeat("a", 64), Result: json.RawMessage(`{}`)}})
		}},
		{"request hash", "Invalid idempotency", func(f map[string][]byte) {
			f["requests.json"] = encode([]requestRecord{{ID: "request", Hash: "short", Result: json.RawMessage(`{}`)}})
		}},
		{"log identity", "Invalid run log", func(f map[string][]byte) { f["logs.json"] = encode([]logRecord{{Data: json.RawMessage(`{}`)}}) }},
		{"log type", "Invalid run log", func(f map[string][]byte) {
			f["logs.json"] = encode([]logRecord{{RunID: "run", Data: json.RawMessage(`{"type":2}`)}})
		}},
		{"missing image", "Invalid or missing backup image", func(f map[string][]byte) {
			var w map[string]json.RawMessage
			json.Unmarshal(f["workspace.json"], &w)
			w["attachments"] = encode([]Attachment{{ID: "img_" + strings.Repeat("a", 32), Name: "missing.png"}})
			f["workspace.json"] = encode(w)
		}},
		{"unknown entry", "Unknown backup entry", func(f map[string][]byte) { f["credentials.txt"] = []byte("not permitted") }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			files := map[string][]byte{}
			for name, b := range base {
				files[name] = bytes.Clone(b)
			}
			tc.edit(files)
			err := s.RestoreArchive(context.Background(), indexedArchive(t, files))
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("want %q, got %v", tc.want, err)
			}
			if !bytes.Equal(before, encode(s.Store.Snapshot())) {
				t.Fatal("refused restore changed current records")
			}
		})
	}
}

func TestBackupFailuresRemovePartialFilesAndReleaseMaintenance(t *testing.T) {
	for _, kind := range []string{"symlink", "oversized", "missing-image", "database"} {
		t.Run(kind, func(t *testing.T) {
			s := testService(t)
			mustTask(t, s.Store, Task{Title: "Keep on export failure"})
			root := filepath.Join(s.Dir, "sessions")
			if err := os.Mkdir(root, 0700); err != nil {
				t.Fatal(err)
			}
			switch kind {
			case "symlink":
				if err := os.Symlink(t.TempDir(), filepath.Join(root, "link")); err != nil {
					t.Fatal(err)
				}
			case "oversized":
				f, err := os.Create(filepath.Join(root, "large"))
				if err != nil {
					t.Fatal(err)
				}
				err = f.Truncate((64 << 20) + 1)
				f.Close()
				if err != nil {
					t.Fatal(err)
				}
			case "missing-image":
				if err := s.Store.Put("attachment", "missing", Attachment{ID: "missing"}, "user", "fixture"); err != nil {
					t.Fatal(err)
				}
			case "database":
				if _, err := s.Store.DB.Exec("DROP TABLE requests"); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := s.Backup(); err == nil {
				t.Fatal("failed export reported success")
			}
			entries, err := os.ReadDir(filepath.Join(s.Dir, "backups"))
			if err != nil || len(entries) != 0 {
				t.Fatal("failed export left an archive or partial", entries, err)
			}
			if _, err := s.Store.SaveTask(Task{Title: "Write after failed export"}, 0, "user", "", ""); err != nil {
				t.Fatal("maintenance lock leaked", err)
			}
		})
	}
}

func TestRestoreMaintenanceAndPreflightFailuresAreNonDestructive(t *testing.T) {
	s := testService(t)
	task := mustTask(t, s.Store, Task{Title: "Unchanged on failed restore"})
	archive := indexedArchive(t, backupFiles(t, s))
	s.dataMu.Lock()
	if err := s.RestoreArchive(context.Background(), archive); err == nil {
		t.Fatal("restore ignored an active workspace write")
	}
	if _, err := s.Backup(); err == nil {
		t.Fatal("backup ignored an active workspace write")
	}
	s.dataMu.Unlock()
	if err := os.Rename(filepath.Join(s.Dir, "backups"), filepath.Join(s.Dir, "saved-backups")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(s.Dir, "backups"), []byte("occupied"), 0600); err != nil {
		t.Fatal(err)
	}
	err := s.RestoreArchive(context.Background(), archive)
	if err == nil || !strings.Contains(err.Error(), "Pre-restore backup failed; workspace unchanged") {
		t.Fatal(err)
	}
	var after Task
	if !s.Store.Get("task", task.ID, &after) || !bytes.Equal(encode(after), encode(task)) {
		t.Fatal("preflight failure modified task", after)
	}
}

func TestRestoreSQLFailureRollsBackRecordsAndSessions(t *testing.T) {
	s := testService(t)
	task := mustTask(t, s.Store, Task{Title: "Original backup"})
	root := filepath.Join(s.Dir, "sessions")
	if err := os.Mkdir(root, 0700); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(root, "memory.jsonl")
	if err := os.WriteFile(file, []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	archive := indexedArchive(t, backupFiles(t, s))
	task.Title = "Current workspace must survive"
	task = mustTask(t, s.Store, task)
	if err := os.WriteFile(file, []byte("current"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Store.DB.Exec(`CREATE TRIGGER refuse_restore BEFORE DELETE ON objects BEGIN SELECT RAISE(FAIL,'fixture disk failure'); END`); err != nil {
		t.Fatal(err)
	}
	if err := s.RestoreArchive(context.Background(), archive); err == nil {
		t.Fatal("failed transaction reported restored")
	}
	var after Task
	if !s.Store.Get("task", task.ID, &after) || !bytes.Equal(encode(after), encode(task)) {
		t.Fatal("failed restore lost records", after)
	}
	b, err := os.ReadFile(file)
	if err != nil || string(b) != "current" {
		t.Fatal("failed restore lost current memory", string(b), err)
	}
	if _, err := os.Stat(filepath.Join(s.Dir, "restore.json")); !os.IsNotExist(err) {
		t.Fatal("rollback left recovery journal", err)
	}
}

func TestBackupRetentionAndRestoredInFlightRunSafety(t *testing.T) {
	s := testService(t)
	var cfg Settings
	s.Store.Get("settings", "app", &cfg)
	cfg.BackupRetention = 1
	if err := s.SaveSettings(cfg); err != nil {
		t.Fatal(err)
	}
	if err := s.Store.Put("run", "running", Run{ID: "running", Status: "running"}, "system", "fixture"); err != nil {
		t.Fatal(err)
	}
	files := backupFiles(t, s)
	if _, err := s.Backup(); err != nil {
		t.Fatal(err)
	}
	entries, _ := filepath.Glob(filepath.Join(s.Dir, "backups", "*.zip"))
	if len(entries) != 1 {
		t.Fatal("retention not enforced", entries)
	}
	if err := s.RestoreArchive(context.Background(), indexedArchive(t, files)); err != nil {
		t.Fatal(err)
	}
	var run Run
	s.Store.Get("run", "running", &run)
	if run.Status != "interrupted" || !strings.Contains(run.Error, "inspect side effects") {
		t.Fatal("restore replayed or hid in-flight run", run)
	}
}

func TestRecoveryJournalRefusalsAndPreSwapRecovery(t *testing.T) {
	for _, data := range []string{"{", `{"ID":"../restore_escape","Stage":"../restore_escape-new","Old":"../restore_escape-old"}`, `{"ID":"restore_safe","Stage":"wrong","Old":"restore_safe-old"}`} {
		dir := t.TempDir()
		p := filepath.Join(dir, "restore.json")
		if err := os.WriteFile(p, []byte(data), 0600); err != nil {
			t.Fatal(err)
		}
		if s, err := NewService(dir); err == nil {
			s.Close()
			t.Fatal("unsafe journal opened")
		}
		b, _ := os.ReadFile(p)
		if string(b) != data {
			t.Fatal("unsafe journal destroyed")
		}
	}
	for _, had := range []bool{false, true} {
		s := testService(t)
		j := restoreJournal{ID: "restore_fixture", Stage: "restore_fixture-new", Old: "restore_fixture-old", HadSessions: had}
		root := filepath.Join(s.Dir, "sessions")
		os.Mkdir(root, 0700)
		os.WriteFile(filepath.Join(root, "current"), []byte("current"), 0600)
		os.Mkdir(filepath.Join(s.Dir, j.Stage), 0700)
		os.WriteFile(filepath.Join(s.Dir, "restore.json"), encode(j), 0600)
		if err := s.recoverRestore(); err != nil {
			t.Fatal(err)
		}
		_, err := os.Stat(root)
		if had && err != nil || !had && !os.IsNotExist(err) {
			t.Fatal("wrong pre-swap recovery", had, err)
		}
	}
	s := testService(t)
	if err := os.Mkdir(filepath.Join(s.Dir, "restore.json"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := s.recoverRestore(); err == nil {
		t.Fatal("unreadable journal ignored")
	}
	if err := writeSync(t.TempDir(), []byte("no"), 0600); err == nil {
		t.Fatal("write to directory succeeded")
	}
	if err := syncDir(filepath.Join(t.TempDir(), "missing")); err == nil {
		t.Fatal("missing directory sync succeeded")
	}
}

func TestBackupFilesystemFailuresRetainRecoverableEvidence(t *testing.T) {
	for _, scenario := range []string{"archive creation", "session read", "session directory read", "settings update", "retention removal"} {
		t.Run(scenario, func(t *testing.T) {
			s := testService(t)
			mustTask(t, s.Store, Task{Title: "Keep current work"})
			backups := filepath.Join(s.Dir, "backups")
			if err := os.Mkdir(backups, 0700); err != nil {
				t.Fatal(err)
			}
			switch scenario {
			case "archive creation":
				if err := os.Chmod(backups, 0500); err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { os.Chmod(backups, 0700) })
			case "session read":
				root := filepath.Join(s.Dir, "sessions")
				if err := os.Mkdir(root, 0700); err != nil {
					t.Fatal(err)
				}
				file := filepath.Join(root, "private-memory")
				if err := os.WriteFile(file, []byte("private"), 0000); err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { os.Chmod(file, 0600) })
			case "session directory read":
				root := filepath.Join(s.Dir, "sessions")
				if err := os.Mkdir(root, 0000); err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { os.Chmod(root, 0700) })
			case "settings update":
				if _, err := s.Store.DB.Exec(`CREATE TRIGGER refuse_backup_status BEFORE UPDATE ON objects WHEN NEW.kind='settings' BEGIN SELECT RAISE(FAIL,'fixture status failure'); END`); err != nil {
					t.Fatal(err)
				}
			case "retention removal":
				var cfg Settings
				s.Store.Get("settings", "app", &cfg)
				cfg.BackupRetention = 1
				if err := s.SaveSettings(cfg); err != nil {
					t.Fatal(err)
				}
				old := filepath.Join(backups, "sift-00000000.zip")
				if err := os.Mkdir(old, 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(old, "preserve"), []byte("not an archive"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			_, err := s.Backup()
			if err == nil {
				t.Fatal("filesystem failure reported a successful backup")
			}
			entries, err := os.ReadDir(backups)
			if err != nil {
				t.Fatal(err)
			}
			archives := 0
			for _, entry := range entries {
				if strings.HasSuffix(entry.Name(), ".partial") {
					t.Fatal("failed backup left partial bytes")
				}
				if entry.IsDir() {
					continue
				}
				data, err := os.ReadFile(filepath.Join(backups, entry.Name()))
				if err != nil {
					t.Fatal(err)
				}
				if _, err := readArchive(data); err != nil {
					t.Fatal("completed archive lost integrity", err)
				}
				archives++
			}
			want := 0
			if scenario == "settings update" || scenario == "retention removal" {
				want = 1
			}
			if archives != want {
				t.Fatal("wrong recoverable archive count", archives, want)
			}
		})
	}
}

func TestRestoreStagingFailuresLeaveRecordsAndMemoryUntouched(t *testing.T) {
	for _, scenario := range []string{"staging directory", "session file conflict", "session size", "journal write"} {
		t.Run(scenario, func(t *testing.T) {
			s := testService(t)
			task := mustTask(t, s.Store, Task{Title: "Restore snapshot"})
			files := backupFiles(t, s)
			task.Title = "Keep current work"
			task = mustTask(t, s.Store, task)
			root := filepath.Join(s.Dir, "sessions")
			if err := os.Mkdir(root, 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(root, "memory"), []byte("current"), 0600); err != nil {
				t.Fatal(err)
			}
			switch scenario {
			case "staging directory":
				if err := os.Chmod(s.Dir, 0500); err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { os.Chmod(s.Dir, 0700) })
			case "session file conflict":
				files["sessions/job"] = []byte("file, not directory")
				files["sessions/job/memory"] = []byte("cannot coexist")
			case "session size":
				files["sessions/oversized.jsonl"] = bytes.Repeat([]byte("x"), (64<<20)+1)
			case "journal write":
				if err := os.Mkdir(filepath.Join(s.Dir, "restore.json"), 0700); err != nil {
					t.Fatal(err)
				}
			}
			if err := s.RestoreArchive(context.Background(), indexedArchive(t, files)); err == nil {
				t.Fatal("staging failure hidden")
			}
			var after Task
			if !s.Store.Get("task", task.ID, &after) || !bytes.Equal(encode(task), encode(after)) {
				t.Fatal("failed staging modified task")
			}
			data, err := os.ReadFile(filepath.Join(root, "memory"))
			if err != nil || string(data) != "current" {
				t.Fatal("failed staging modified memory", err)
			}
			stages, err := filepath.Glob(filepath.Join(s.Dir, "restore_*-new"))
			if err != nil || len(stages) != 0 {
				t.Fatal("failed staging left private session copies", stages, err)
			}
		})
	}
}

func TestRestoreDeferredCommitFailureRecoversCurrentSessions(t *testing.T) {
	s := testService(t)
	task := mustTask(t, s.Store, Task{Title: "Backup task"})
	archive := indexedArchive(t, backupFiles(t, s))
	task.Title = "Keep current work"
	task = mustTask(t, s.Store, task)
	root := filepath.Join(s.Dir, "sessions")
	if err := os.Mkdir(root, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "memory"), []byte("current"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Store.DB.Exec(`PRAGMA foreign_keys=ON;
CREATE TABLE commit_parent(id INTEGER PRIMARY KEY);
CREATE TABLE commit_child(parent INTEGER REFERENCES commit_parent(id) DEFERRABLE INITIALLY DEFERRED);
CREATE TRIGGER refuse_restore_commit AFTER INSERT ON metadata BEGIN INSERT INTO commit_child VALUES(1); END;`); err != nil {
		t.Fatal(err)
	}
	if err := s.RestoreArchive(context.Background(), archive); err == nil || !strings.Contains(err.Error(), "FOREIGN KEY") {
		t.Fatal("restore commit failure hidden", err)
	}
	var after Task
	if !s.Store.Get("task", task.ID, &after) || !bytes.Equal(encode(task), encode(after)) {
		t.Fatal("failed restore commit modified current task")
	}
	data, err := os.ReadFile(filepath.Join(root, "memory"))
	if err != nil || string(data) != "current" {
		t.Fatal("failed restore commit lost current memory", err)
	}
	if _, err := os.Stat(filepath.Join(s.Dir, "restore.json")); !os.IsNotExist(err) {
		t.Fatal("failed restore commit left a journal", err)
	}
}

func TestRecoveryFilesystemFailuresKeepJournalForExplicitRetry(t *testing.T) {
	for _, scenario := range []string{"remove swapped sessions", "remove staging", "remove journal"} {
		t.Run(scenario, func(t *testing.T) {
			s := testService(t)
			journal := restoreJournal{ID: "restore_fixture", Stage: "restore_fixture-new", Old: "restore_fixture-old", HadSessions: true}
			root, stage, old := filepath.Join(s.Dir, "sessions"), filepath.Join(s.Dir, journal.Stage), filepath.Join(s.Dir, journal.Old)
			if err := os.Mkdir(root, 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(root, "memory"), []byte("current"), 0600); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(s.Dir, "restore.json"), encode(journal), 0600); err != nil {
				t.Fatal(err)
			}
			switch scenario {
			case "remove swapped sessions":
				if err := os.Mkdir(old, 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(old, "memory"), []byte("original"), 0600); err != nil {
					t.Fatal(err)
				}
				if err := os.Chmod(root, 0500); err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { os.Chmod(root, 0700) })
			case "remove staging":
				if err := os.Mkdir(stage, 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(stage, "memory"), []byte("staged"), 0600); err != nil {
					t.Fatal(err)
				}
				if err := os.Chmod(stage, 0500); err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { os.Chmod(stage, 0700) })
			case "remove journal":
				if err := os.Chmod(s.Dir, 0500); err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { os.Chmod(s.Dir, 0700) })
			}
			if err := s.recoverRestore(); err == nil {
				t.Fatal("failed recovery silently discarded journal")
			}
			data, err := os.ReadFile(filepath.Join(s.Dir, "restore.json"))
			if err != nil || !bytes.Equal(data, encode(journal)) {
				t.Fatal("failed recovery lost its retry journal", err)
			}
			for _, path := range []string{s.Dir, root, stage} {
				if err := os.Chmod(path, 0700); err != nil && !os.IsNotExist(err) {
					t.Fatal(err)
				}
			}
			if err := s.recoverRestore(); err != nil {
				t.Fatal("recovery could not be retried after restoring access", err)
			}
			data, err = os.ReadFile(filepath.Join(root, "memory"))
			want := "current"
			if scenario == "remove swapped sessions" {
				want = "original"
			}
			if err != nil || string(data) != want {
				t.Fatal("recovery lost original memory", string(data), err)
			}
		})
	}
}

func TestRecoveryCannotRenameOriginalSessionsWithoutWorkspaceWriteAccess(t *testing.T) {
	s := testService(t)
	j := restoreJournal{ID: "restore_fixture", Stage: "restore_fixture-new", Old: "restore_fixture-old", HadSessions: true}
	old, root := filepath.Join(s.Dir, j.Old), filepath.Join(s.Dir, "sessions")
	if err := os.Mkdir(old, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(old, "memory"), []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	journal := filepath.Join(s.Dir, "restore.json")
	if err := os.WriteFile(journal, encode(j), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(s.Dir, 0500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(s.Dir, 0700) })
	if err := s.recoverRestore(); err == nil {
		t.Fatal("failed session rename reported successful recovery")
	}
	if data, err := os.ReadFile(journal); err != nil || !bytes.Equal(data, encode(j)) {
		t.Fatal("failed session rename lost the retry journal", err)
	}
	if data, err := os.ReadFile(filepath.Join(old, "memory")); err != nil || string(data) != "original" {
		t.Fatal("failed session rename lost original memory", err)
	}
	if err := os.Chmod(s.Dir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := s.recoverRestore(); err != nil {
		t.Fatal("recovery could not retry its rename", err)
	}
	if data, err := os.ReadFile(filepath.Join(root, "memory")); err != nil || string(data) != "original" {
		t.Fatal("retry did not restore original memory", err)
	}
}

func TestRecoveryWithoutOriginalSessionsPreservesJournalOnRemovalFailure(t *testing.T) {
	s := testService(t)
	j := restoreJournal{ID: "restore_fixture", Stage: "restore_fixture-new", Old: "restore_fixture-old", HadSessions: false}
	root := filepath.Join(s.Dir, "sessions")
	if err := os.Mkdir(root, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "staged"), []byte("uncommitted"), 0600); err != nil {
		t.Fatal(err)
	}
	journal := filepath.Join(s.Dir, "restore.json")
	if err := os.WriteFile(journal, encode(j), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(root, 0500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(root, 0700) })
	if err := s.recoverRestore(); err == nil {
		t.Fatal("failed uncommitted session removal reported success")
	}
	if data, err := os.ReadFile(journal); err != nil || !bytes.Equal(data, encode(j)) {
		t.Fatal("failed session removal discarded its journal", err)
	}
	if err := os.Chmod(root, 0700); err != nil {
		t.Fatal(err)
	}
	if err := s.recoverRestore(); err != nil {
		t.Fatal("session removal could not be retried", err)
	}
	for _, path := range []string{root, journal} {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatal("uncommitted session retry left data or its journal", path, err)
		}
	}
}
