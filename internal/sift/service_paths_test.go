package sift

import (
	"bytes"
	"context"
	"database/sql"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestRestartInterruptsRunsWithoutReplayingMissedJob(t *testing.T) {
	dir := t.TempDir()
	s, err := NewService(dir)
	if err != nil {
		t.Fatal(err)
	}
	j := fixtureJob(t, s, "hang")
	j.Enabled = true
	j.Pending = true
	j.NextRun = time.Now().Add(-time.Hour).UTC().Format(time.RFC3339Nano)
	if err = s.Store.Put("job", j.ID, j, "fixture", ""); err != nil {
		t.Fatal(err)
	}
	other := fixtureJob(t, s, "untouched")
	for _, status := range []string{"running", "queued"} {
		if err = s.Store.Put("run", status, Run{ID: status, JobID: j.ID, Status: status}, "fixture", ""); err != nil {
			t.Fatal(err)
		}
	}
	s.Close()
	s, err = NewService(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	for _, run := range listAs[Run](s.Store, "run") {
		if run.Status != "interrupted" || run.EndedAt == "" || !strings.Contains(run.Error, "retry explicitly") {
			t.Fatal(run)
		}
	}
	var got Job
	s.Store.Get("job", j.ID, &got)
	next, e := time.Parse(time.RFC3339Nano, got.NextRun)
	if e != nil || !next.After(time.Now()) || got.Pending || got.SessionID != j.SessionID {
		t.Fatal("restart replayed or lost memory", got, e)
	}
	s.Store.Get("job", other.ID, &got)
	if got.SessionID != other.SessionID || got.Revision != other.Revision {
		t.Fatal("unrelated job changed", got)
	}
	if len(s.active) != 0 {
		t.Fatal("restart launched a prompt")
	}
}

func TestOpenStoreRefusesBrokenSchemaWithoutReplacingDatabase(t *testing.T) {
	for _, schema := range []string{
		`CREATE VIEW metadata AS SELECT 'key' AS key, 'value' AS value`,
		`CREATE VIEW objects AS SELECT 'task' AS kind, 'id' AS id, '{}' AS data`,
		`CREATE TABLE objects(kind TEXT,id TEXT,data BLOB,PRIMARY KEY(kind,id)); CREATE TRIGGER refuse_settings BEFORE INSERT ON objects BEGIN SELECT RAISE(FAIL,'fixture'); END`,
		`CREATE TABLE objects(kind TEXT,id TEXT,data BLOB,PRIMARY KEY(kind,id)); CREATE TRIGGER refuse_columns BEFORE INSERT ON objects WHEN NEW.kind='column' BEGIN SELECT RAISE(FAIL,'fixture'); END`,
	} {
		dir := t.TempDir()
		db, err := OpenStore(dir)
		if err != nil {
			t.Fatal(err)
		}
		db.Close()
		// Deliberately create an inconsistent disposable schema while it is closed.
		conn, err := sql.Open("sqlite", filepath.Join(dir, "sift.db"))
		if err != nil {
			t.Fatal(err)
		}
		if _, err = conn.Exec("DROP TABLE metadata; DROP TABLE objects"); err != nil {
			t.Fatal(err)
		}
		if _, err = conn.Exec(schema); err != nil {
			t.Fatal(err)
		}
		conn.Close()
		if store, err := OpenStore(dir); err == nil {
			store.Close()
			t.Fatalf("broken schema accepted: %s", schema)
		}
		conn, err = sql.Open("sqlite", filepath.Join(dir, "sift.db"))
		if err != nil {
			t.Fatal(err)
		}
		var count int
		if err = conn.QueryRow("SELECT COUNT(*) FROM sqlite_schema WHERE sql=?", strings.Split(schema, ";")[0]).Scan(&count); err != nil || count != 1 {
			conn.Close()
			t.Fatal("startup replaced the broken schema", count, err)
		}
		conn.Close()
	}
}

func TestRetentionNeverOrphansAChildOrPrunesRecentTrash(t *testing.T) {
	s := testStore(t)
	p := mustTask(t, s, Task{Title: "Legacy deleted parent"})
	child := mustTask(t, s, Task{Title: "Active child", ParentID: p.ID})
	recent := mustTask(t, s, Task{Title: "Recent Trash", DeletedAt: now()})
	p.DeletedAt = time.Now().AddDate(0, 0, -31).UTC().Format(time.RFC3339Nano)
	if err := s.Put("task", p.ID, p, "fixture", "legacy state"); err != nil {
		t.Fatal(err)
	}
	s.Prune(Settings{TrashRetentionDays: 30, LogRetentionDays: 30})
	var got Task
	for _, id := range []string{p.ID, child.ID, recent.ID} {
		if !s.Get("task", id, &got) {
			t.Fatal("retention orphaned or removed current work", id)
		}
	}
}

func TestSetupPathFailuresNeverOverwriteOtherData(t *testing.T) {
	for _, action := range []string{"skill", "cli", "startup"} {
		t.Run(action, func(t *testing.T) {
			home := t.TempDir()
			t.Setenv("HOME", home)
			s := testService(t)
			var blocker string
			switch action {
			case "skill":
				blocker = filepath.Join(home, ".agents")
			case "cli":
				blocker = filepath.Join(home, ".local")
			case "startup":
				if runtime.GOOS == "darwin" {
					blocker = filepath.Join(home, "Library")
				} else {
					blocker = filepath.Join(home, ".config")
				}
			}
			if err := os.WriteFile(blocker, []byte("preserve"), 0600); err != nil {
				t.Fatal(err)
			}
			if _, err := s.Setup(action, false); err == nil {
				t.Fatal("invalid setup path hidden")
			}
			b, _ := os.ReadFile(blocker)
			if string(b) != "preserve" {
				t.Fatal("unrelated path overwritten")
			}
		})
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	s := testService(t)
	dir := filepath.Join(home, ".agents/skills/sift")
	os.MkdirAll(dir, 0700)
	os.Mkdir(filepath.Join(dir, "SKILL.md"), 0700)
	if _, err := s.Setup("skill", true); err == nil {
		t.Fatal("directory overwritten with skill")
	}
}

func TestOrganizationAndWorkflowPersistenceFailuresAreAtomic(t *testing.T) {
	for _, operation := range []string{"merge source", "merge target", "move child", "undo", "merge entity task", "merge entity source", "delete column task", "delete column source"} {
		t.Run(operation, func(t *testing.T) {
			s := testStore(t)
			for _, id := range []string{"source", "target"} {
				s.Put("project", id, Entity{ID: id, Name: id}, "user", "")
			}
			a := mustTask(t, s, Task{Title: "A", Status: "progress", Project: "source"})
			b := mustTask(t, s, Task{Title: "B"})
			c := mustTask(t, s, Task{Title: "Child", ParentID: a.ID})
			event := s.Events(0, b.ID, 100)[0]
			id := a.ID
			switch operation {
			case "merge target", "undo":
				id = b.ID
			case "move child":
				id = c.ID
			case "merge entity source":
				id = "source"
			case "delete column source":
				id = "progress"
			}
			if operation == "merge entity task" || operation == "delete column task" {
				id = a.ID
			}
			// Target a real statement failure after preceding transaction work.
			if _, err := s.DB.Exec("CREATE TRIGGER refuse_atomic BEFORE INSERT ON events WHEN NEW.entity_id='" + id + "' BEGIN SELECT RAISE(FAIL,'fixture'); END"); err != nil {
				t.Fatal(err)
			}
			before := encode(s.Snapshot())
			var err error
			switch operation {
			case "merge source", "merge target", "move child":
				err = s.Merge(a.ID, b.ID, a.Revision, b.Revision, "user", "same")
			case "undo":
				err = s.Undo(event.ID, "user")
			case "merge entity task", "merge entity source":
				err = s.MergeEntity("project", "source", "target", "user")
			case "delete column task", "delete column source":
				err = s.DeleteColumn("progress", "open")
			}
			if err == nil {
				t.Fatal("persistence failure hidden", operation)
			}
			if !bytes.Equal(before, encode(s.Snapshot())) {
				t.Fatal("partial mutation", operation)
			}
		})
	}
	s := testService(t)
	s.Store.Close()
	w := httptest.NewRecorder()
	r := httptest.NewRequest("POST", "/api/columns", strings.NewReader(`{"name":"Review"}`))
	s.routes().ServeHTTP(w, r)
	if w.Code != 500 {
		t.Fatal("failed column save reported success", w.Code)
	}
}

func TestJobMaintenanceAndStorageFailuresNeverLaunchPi(t *testing.T) {
	s := testService(t)
	j := fixtureJob(t, s, "success")
	s.maintenance = true
	if _, err := s.RunJob(j.ID); err == nil {
		t.Fatal("maintenance run allowed")
	}
	if err := s.ResetJob(j.ID); err == nil {
		t.Fatal("maintenance reset allowed")
	}
	s.maintenance = false
	s.active[j.ID] = func() {}
	if err := s.ResetJob(j.ID); err == nil {
		t.Fatal("active memory reset allowed")
	}
	delete(s.active, j.ID)
	if err := s.Store.Put("run", "finished", Run{ID: "finished", JobID: j.ID, Status: "succeeded"}, "fixture", ""); err != nil {
		t.Fatal(err)
	}
	if err := s.CancelRun("finished"); err == nil {
		t.Fatal("finished run cancellation accepted")
	}
	bad := j
	bad.Schedule = "bad"
	if _, err := s.startRunLocked(bad); err == nil {
		t.Fatal("invalid persisted schedule ran")
	}
	for _, kind := range []string{"job", "run"} {
		if _, err := s.Store.DB.Exec("CREATE TRIGGER refuse_start BEFORE INSERT ON objects WHEN NEW.kind='" + kind + "' BEGIN SELECT RAISE(FAIL,'fixture disk failure'); END"); err != nil {
			t.Fatal(err)
		}
		if _, err := s.RunJob(j.ID); err == nil {
			t.Fatal("run launched after failed persistence", kind)
		}
		if _, err := s.Store.DB.Exec("DROP TRIGGER refuse_start"); err != nil {
			t.Fatal(err)
		}
	}
	if len(s.active) != 0 || len(listAs[Run](s.Store, "run")) != 1 {
		t.Fatal("failure started unrecorded work")
	}
}

func TestSchedulerRealTickAndCancelledStorageStartup(t *testing.T) {
	// Run the real one-second schedule loop with no enabled jobs, not model work.
	s := testService(t)
	done := make(chan struct{})
	go func() { s.scheduleLoop(); close(done) }()
	timer := time.NewTimer(1100 * time.Millisecond)
	defer timer.Stop()
	<-timer.C
	s.cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("scheduler failed to stop")
	}
	t.Setenv("SIFT_RUSTFS", "/bin/sleep")
	var st Storage
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := st.Start(ctx, t.TempDir()); err == nil {
		t.Fatal("cancelled storage startup reported ready")
	}
	st.Close()
}

func TestStorageStartupPathFailuresAreActionable(t *testing.T) {
	for _, entry := range []string{"runtime", "runtime rename", "rustfs-secret", "objects", "rustfs.log"} {
		t.Run(entry, func(t *testing.T) {
			dir := t.TempDir()
			t.Setenv("SIFT_RUSTFS", "")
			if entry == "runtime" || entry == "objects" {
				os.WriteFile(filepath.Join(dir, entry), []byte("occupied"), 0600)
			} else if entry == "runtime rename" {
				if err := os.MkdirAll(filepath.Join(dir, "runtime", "rustfs-1.0.4", "rustfs-"+runtime.GOOS+"-"+runtime.GOARCH), 0700); err != nil {
					t.Fatal(err)
				}
			} else {
				t.Setenv("SIFT_RUSTFS", "/bin/echo")
				os.Mkdir(filepath.Join(dir, entry), 0700)
			}
			st := Storage{}
			defer st.Close()
			if err := st.Start(context.Background(), dir); err == nil {
				t.Fatal("invalid runtime path hidden")
			}
		})
	}
	peer := filepath.Join(t.TempDir(), "exiting-rustfs")
	if err := os.WriteFile(peer, []byte("#!/bin/sh\nexit 1\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("SIFT_RUSTFS", peer)
	st := Storage{}
	if err := st.Start(context.Background(), t.TempDir()); err == nil || !strings.Contains(err.Error(), "RustFS exited") {
		t.Fatal(err)
	}
	// Both startup and shutdown may observe a completed child. Shutdown must not
	// wait eight seconds because startup already consumed the exit result.
	start := time.Now()
	st.Close()
	if time.Since(start) > time.Second {
		t.Fatal("shutdown waited for an already exited RustFS child")
	}
}

func TestStorageRelativeExecutableUsesOriginalWorkingDirectory(t *testing.T) {
	working, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	executable, err := exec.LookPath("echo")
	if err != nil {
		t.Fatal(err)
	}
	relative, err := filepath.Rel(working, executable)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("SIFT_RUSTFS", relative)
	dir := filepath.Join(t.TempDir(), "Application Support", "Sift 照片")
	s, err := NewService(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	if err = s.Storage.Start(context.Background(), dir); err == nil || !strings.Contains(err.Error(), "RustFS exited") {
		t.Fatal("echo fixture must exit rather than become ready", err)
	}
	if s.Storage.cmd.Path != executable || s.Storage.cmd.Dir != dir || s.Storage.cmd.Args[len(s.Storage.cmd.Args)-1] != "objects" {
		t.Fatal("relative executable or volume was resolved against the wrong directory", s.Storage.cmd.Path, s.Storage.cmd.Dir, s.Storage.cmd.Args)
	}
}
