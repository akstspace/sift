package sift

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"modernc.org/sqlite"
)

// Register once before any SQLite connection is opened. A policy applies only
// to the exact disposable database registered by a test; all other connections
// (including the existing authorizer tests) remain unchanged.
var openingPolicies = struct {
	sync.Mutex
	byPath map[string]sqlite.AuthorizerFn
}{byPath: map[string]sqlite.AuthorizerFn{}}

func init() {
	sqlite.RegisterConnectionHook(func(conn sqlite.ExecQuerierContext, dsn string) error {
		openingPolicies.Lock()
		policy := openingPolicies.byPath[dsn]
		openingPolicies.Unlock()
		if policy != nil {
			return conn.(sqlite.AuthorizerRegisterer).RegisterAuthorizer(policy)
		}
		return nil
	})
}

func TestOpenStoreSchemaReadRefusalClosesConnectionAndAllowsRetry(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "sift.db")
	denials := 0
	openingPolicies.Lock()
	openingPolicies.byPath[path] = func(action sqlite.AuthorizerActionCode, table, column, _, _ string) sqlite.AuthorizerReturnCode {
		if action == sqlite.AuthRead && (table == "sqlite_master" || table == "sqlite_schema") && column == "type" {
			denials++
			return sqlite.AuthorizerDeny
		}
		return sqlite.AuthorizerOK
	}
	openingPolicies.Unlock()
	clearPolicy := func() {
		openingPolicies.Lock()
		delete(openingPolicies.byPath, path)
		openingPolicies.Unlock()
	}
	t.Cleanup(clearPolicy)
	s, err := OpenStore(dir)
	clearPolicy()
	if err == nil || s != nil || denials != 1 {
		if s != nil {
			s.Close()
		}
		t.Fatal("initialization hid the real schema read refusal", err, denials)
	}
	s, err = OpenStore(dir)
	if err != nil {
		t.Fatal("schema read refusal leaked a connection or prevented explicit retry", err)
	}
	defer s.Close()
	if len(s.ListRaw("column")) != 3 {
		t.Fatal("explicit initialization retry did not create the default workflow")
	}
}

func TestCommittedRestoreCleanupFailureRetainsRestoredDataAndRetryJournal(t *testing.T) {
	s := testService(t)
	task := mustTask(t, s.Store, Task{Title: "Archived task"})
	files := backupFiles(t, s)
	files["sessions/memory"] = []byte("archived session")
	task.Title = "Current task"
	task = mustTask(t, s.Store, task)
	beforeEvents := s.Store.Latest()
	var chmodErr error
	cleanupReads := 0
	reset := denyQuery(t, s.Store.DB, func(action sqlite.AuthorizerActionCode, table, column string) bool {
		if action == sqlite.AuthRead && table == "metadata" && column == "value" {
			cleanupReads++
			chmodErr = os.Chmod(s.Dir, 0500)
		}
		return false
	})
	t.Cleanup(func() { os.Chmod(s.Dir, 0700) })
	err := s.RestoreArchive(context.Background(), indexedArchive(t, files))
	reset()
	if err == nil || chmodErr != nil || cleanupReads != 1 {
		t.Fatal("committed restore did not report its actual cleanup failure", err, chmodErr, cleanupReads)
	}
	var restored Task
	if !s.Store.Get("task", task.ID, &restored) || restored.Title != "Archived task" {
		t.Fatal("cleanup failure rolled back committed records", restored)
	}
	if s.Store.Latest() >= beforeEvents {
		t.Fatal("restore did not replace current history")
	}
	if data, err := os.ReadFile(filepath.Join(s.Dir, "sessions", "memory")); err != nil || string(data) != "archived session" {
		t.Fatal("cleanup failure lost the committed session", err)
	}
	journalPath := filepath.Join(s.Dir, "restore.json")
	journal, err := os.ReadFile(journalPath)
	if err != nil {
		t.Fatal("cleanup failure lost the explicit-retry journal", err)
	}
	var j restoreJournal
	if err = json.Unmarshal(journal, &j); err != nil {
		t.Fatal(err)
	}
	var generation string
	if err = s.Store.DB.QueryRow("SELECT value FROM metadata WHERE key='restore_generation'").Scan(&generation); err != nil || generation != j.ID {
		t.Fatal("cleanup failure lost its committed generation", generation, err)
	}
	if err = os.Chmod(s.Dir, 0700); err != nil {
		t.Fatal(err)
	}
	if err = s.recoverRestore(); err != nil {
		t.Fatal("explicit cleanup retry failed", err)
	}
	if _, err = os.Stat(journalPath); !os.IsNotExist(err) {
		t.Fatal("successful cleanup retry left the journal", err)
	}
	if !s.Store.Get("task", task.ID, &restored) || restored.Title != "Archived task" {
		t.Fatal("cleanup retry changed committed records", restored)
	}
}

// Use SQLite's real connection authorizer, rather than a mock Store, to deny
// one statement preparation after prerequisite reads have succeeded. The store
// uses one physical connection; remove the policy before assertions/cleanup.
func denyQuery(t *testing.T, db *sql.DB, denied func(sqlite.AuthorizerActionCode, string, string) bool) func() {
	t.Helper()
	set := func(fn sqlite.AuthorizerFn) {
		t.Helper()
		conn, err := db.Conn(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		defer conn.Close()
		if err = conn.Raw(func(raw any) error { return raw.(sqlite.AuthorizerRegisterer).RegisterAuthorizer(fn) }); err != nil {
			t.Fatal(err)
		}
	}
	set(func(action sqlite.AuthorizerActionCode, table, column, _, _ string) sqlite.AuthorizerReturnCode {
		if denied(action, table, column) {
			return sqlite.AuthorizerDeny
		}
		return sqlite.AuthorizerOK
	})
	reset := func() { set(nil) }
	t.Cleanup(reset)
	return reset
}

func TestRestoreBeginRefusalRecoversOriginalSessionsAndRecords(t *testing.T) {
	s := testService(t)
	task := mustTask(t, s.Store, Task{Title: "Archived task"})
	files := backupFiles(t, s)
	files["sessions/memory"] = []byte("archived session")
	task.Title = "Keep current task"
	task = mustTask(t, s.Store, task)
	root := filepath.Join(s.Dir, "sessions")
	if err := os.Mkdir(root, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "memory"), []byte("current session"), 0600); err != nil {
		t.Fatal(err)
	}
	denied := 0
	reset := denyQuery(t, s.Store.DB, func(action sqlite.AuthorizerActionCode, operation, _ string) bool {
		if action == sqlite.AuthTransaction && operation == "BEGIN" {
			denied++
			return true
		}
		return false
	})
	err := s.RestoreArchive(context.Background(), indexedArchive(t, files))
	reset()
	if err == nil || denied != 1 {
		t.Fatal("restore did not propagate its actual transaction refusal", err, denied)
	}
	var current Task
	if !s.Store.Get("task", task.ID, &current) || !bytes.Equal(encode(current), encode(task)) {
		t.Fatal("refused transaction changed current records", current)
	}
	if data, err := os.ReadFile(filepath.Join(root, "memory")); err != nil || string(data) != "current session" {
		t.Fatal("refused transaction did not recover original memory", err)
	}
	if _, err := os.Stat(filepath.Join(s.Dir, "restore.json")); !os.IsNotExist(err) {
		t.Fatal("refused transaction left its journal", err)
	}
	if err := s.RestoreArchive(context.Background(), indexedArchive(t, files)); err != nil {
		t.Fatal("explicit restore retry failed", err)
	}
	if !s.Store.Get("task", task.ID, &current) || current.Title != "Archived task" {
		t.Fatal("explicit restore retry did not restore archive records", current)
	}
	if data, err := os.ReadFile(filepath.Join(root, "memory")); err != nil || string(data) != "archived session" {
		t.Fatal("explicit restore retry did not restore archived memory", err)
	}
}

func TestTaskQueryFailuresAreAtomicAndPermitExplicitRetry(t *testing.T) {
	for _, operation := range []string{"source key lookup", "source key collision", "parent completion", "subtask validation", "merge", "organization", "grouped undo"} {
		t.Run(operation, func(t *testing.T) {
			s := testStore(t)
			parent := mustTask(t, s, Task{Title: "Parent"})
			child := mustTask(t, s, Task{Title: "Child", ParentID: parent.ID})
			other := mustTask(t, s, Task{Title: "Independent"})
			entity := Entity{ID: "project-source", Name: "Source"}
			if err := s.Put("project", entity.ID, entity, "fixture", ""); err != nil {
				t.Fatal(err)
			}
			entity.ID = "project-target"
			if err := s.Put("project", entity.ID, entity, "fixture", ""); err != nil {
				t.Fatal(err)
			}
			child.Status = "done"
			child = mustTask(t, s, child)
			parent.Status = "done"
			parent = mustTask(t, s, parent)
			child.Status = "open"
			child = mustTask(t, s, child) // reopens parent with a linked group
			s.Get("task", parent.ID, &parent)
			events := s.Events(0, child.ID, 100)
			event := events[len(events)-1]
			if event.Group == "" {
				t.Fatal("fixture did not select linked undo")
			}
			before, history := encode(s.Snapshot()), encode(s.Events(0, "", 1000))
			run := func() error {
				switch operation {
				case "source key lookup":
					_, err := s.SaveTask(Task{Title: "Import", SourceKey: "fixture/new"}, 0, "user", "", "new-request")
					return err
				case "source key collision":
					other.SourceKey = "fixture/edit"
					_, err := s.SaveTask(other, other.Revision, "user", "", "edit-request")
					return err
				case "parent completion":
					parent.Status = "done"
					_, err := s.SaveTask(parent, parent.Revision, "user", "Verified parent outcome", "complete-request")
					return err
				case "subtask validation":
					_, err := s.SaveTask(child, child.Revision, "user", "", "child-request")
					return err
				case "merge":
					return s.Merge(child.ID, other.ID, child.Revision, other.Revision, "user", "explicit merge")
				case "organization":
					return s.MergeEntity("project", "project-source", "project-target", "user")
				default:
					return s.Undo(event.ID, "user")
				}
			}
			reads, deniedAt := 0, 3
			if operation == "source key lookup" || operation == "grouped undo" {
				deniedAt = 2
			}
			if operation == "subtask validation" {
				deniedAt = 4 // workflow, child, parent, then the child-graph scan
			}
			reset := denyQuery(t, s.DB, func(action sqlite.AuthorizerActionCode, table, column string) bool {
				if operation == "grouped undo" {
					if action == sqlite.AuthRead && table == "events" && column == "group_id" {
						reads++
						return reads == deniedAt
					}
					return false
				}
				if action == sqlite.AuthRead && table == "objects" && column == "data" {
					reads++
					return reads == deniedAt
				}
				return false
			})
			err := run()
			reset()
			if err == nil || reads != deniedAt || !strings.Contains(err.Error(), "prohibited") {
				t.Fatal("target query denial was not reported", reads, err)
			}
			if !bytes.Equal(before, encode(s.Snapshot())) || !bytes.Equal(history, encode(s.Events(0, "", 1000))) {
				t.Fatal("query failure changed records or history", err)
			}
			if operation != "parent completion" {
				if err := run(); err != nil {
					t.Fatal("explicit retry after restoring query access failed", err)
				}
			}
		})
	}
}
