package sift

import (
	"bytes"
	"context"
	"database/sql"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestInvalidOrganizationAndWorkflowTargetsPreserveWorkspace(t *testing.T) {
	s := testStore(t)
	before := encode(s.Snapshot())
	for _, args := range [][3]string{{"task", "a", "b"}, {"tag", "a", "a"}} {
		if err := s.MergeEntity(args[0], args[1], args[2], "user"); err == nil {
			t.Fatal("invalid organizational merge accepted", args)
		}
	}
	for _, args := range [][2]string{{"open", "progress"}, {"done", "open"}, {"missing", "open"}, {"progress", "missing"}, {"progress", "progress"}} {
		if err := s.DeleteColumn(args[0], args[1]); err == nil {
			t.Fatal("invalid workflow removal accepted", args)
		}
	}
	if !bytes.Equal(before, encode(s.Snapshot())) {
		t.Fatal("invalid organizational/workflow operation changed records")
	}
}

func TestCorruptGraphScanAndMergeAreRefusedAtomically(t *testing.T) {
	t.Run("invalid stored identity", func(t *testing.T) {
		s := testStore(t)
		if _, err := s.DB.Exec(`ALTER TABLE objects RENAME TO legacy_objects;
CREATE TABLE objects(kind TEXT,id TEXT,data BLOB);
INSERT INTO objects SELECT * FROM legacy_objects;
INSERT INTO objects VALUES('task',NULL,'{}')`); err != nil {
			t.Fatal(err)
		}
		before := encode(s.Snapshot())
		if err := s.DeleteColumn("progress", "open"); err == nil {
			t.Fatal("workflow change accepted undecodable task identity")
		}
		if !bytes.Equal(before, encode(s.Snapshot())) {
			t.Fatal("failed graph scan changed records")
		}
	})
	t.Run("unrelated orphan", func(t *testing.T) {
		s := testStore(t)
		a := mustTask(t, s, Task{Title: "Source"})
		b := mustTask(t, s, Task{Title: "Survivor"})
		if err := s.Put("task", "orphan", Task{ID: "orphan", Title: "Legacy orphan", ParentID: "missing", Status: "open"}, "fixture", "legacy import"); err != nil {
			t.Fatal(err)
		}
		before := encode(s.Snapshot())
		if err := s.Merge(a.ID, b.ID, a.Revision, b.Revision, "user", "same issue"); err == nil {
			t.Fatal("merge committed an invalid relationship graph")
		}
		if !bytes.Equal(before, encode(s.Snapshot())) {
			t.Fatal("refused merge leaked survivor or source changes")
		}
	})
}

func TestStartupDDLConflictsPreserveExistingSchema(t *testing.T) {
	for _, statement := range []string{"CREATE INDEX metadata ON objects(id)", "CREATE INDEX events ON objects(id)"} {
		t.Run(statement, func(t *testing.T) {
			dir := t.TempDir()
			conn, err := sql.Open("sqlite", filepath.Join(dir, "sift.db"))
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()
			if _, err = conn.Exec("CREATE TABLE objects(kind TEXT,id TEXT,data BLOB); " + statement); err != nil {
				t.Fatal(err)
			}
			if store, err := OpenStore(dir); err == nil {
				store.Close()
				t.Fatal("conflicting database object silently replaced")
			}
			var found int
			if err := conn.QueryRow("SELECT COUNT(*) FROM sqlite_schema WHERE sql=?", statement).Scan(&found); err != nil || found != 1 {
				t.Fatal("startup altered conflicting schema", found, err)
			}
			if err := Serve(context.Background(), dir, "127.0.0.1:0"); err == nil {
				t.Fatal("server started on an invalid workspace")
			}
		})
	}
}

func TestStartupRejectsMalformedHistoryTableWithoutReplacingIt(t *testing.T) {
	dir := t.TempDir()
	db, err := sql.Open("sqlite", filepath.Join(dir, "sift.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec("CREATE TABLE events(legacy_data TEXT); INSERT INTO events VALUES('preserve original history')"); err != nil {
		t.Fatal(err)
	}
	if store, err := OpenStore(dir); err == nil {
		store.Close()
		t.Fatal("startup accepted an incompatible history schema")
	}
	var value string
	if err := db.QueryRow("SELECT legacy_data FROM events").Scan(&value); err != nil || value != "preserve original history" {
		t.Fatal("failed initialization replaced existing history", value, err)
	}
}

func TestStartupRefusesReadOnlyDatabaseWithoutChangingItsRecords(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "sift.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("CREATE TABLE legacy_records(value TEXT); INSERT INTO legacy_records VALUES('keep original')"); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0400); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(path, 0600) })
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if store, err := OpenStore(dir); err == nil {
		store.Close()
		t.Fatal("read-only workspace appeared writable")
	}
	after, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(before, after) {
		t.Fatal("failed read-only startup changed the original database", err)
	}
}

func TestCLIStartsAndStopsRealServiceAndPreservesRawOutput(t *testing.T) {
	t.Setenv("SIFT_RUSTFS", filepath.Join(t.TempDir(), "missing-runtime"))
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := CLI(ctx, []string{"serve", "--data", t.TempDir(), "--port", "0"}, io.Discard); err != nil {
		t.Fatal("cancelled CLI service failed to stop cleanly", err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, "plain diagnostic response")
	}))
	defer server.Close()
	dir := cliFixtureConnection(t, server.URL)
	var out bytes.Buffer
	if err := CLI(context.Background(), []string{"--data", dir, "schema"}, &out); err != nil || out.String() != "plain diagnostic response" {
		t.Fatal("raw diagnostic output changed", out.String(), err)
	}
	if err := CLI(context.Background(), []string{"--data", dir, "schema"}, failingPiInput{}); err == nil {
		t.Fatal("raw output hid a broken pipe")
	}
}

func TestEventStreamSendsIdleHeartbeatAndStopsOnCancellation(t *testing.T) {
	s := testService(t)
	ctx, cancel := context.WithTimeout(context.Background(), 16*time.Second)
	defer cancel()
	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/api/events?after="+jsonNumber(s.Store.Latest()), nil).WithContext(ctx)
	s.streamEvents(w, r)
	if !strings.Contains(w.Body.String(), ": heartbeat\n\n") || !strings.Contains(w.Body.String(), "event: tick") {
		t.Fatal("idle stream lost its heartbeat or liveness events")
	}
}
