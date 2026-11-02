package sift

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestTaskValidationIsAtomic(t *testing.T) {
	s := testStore(t)
	before := encode(s.Snapshot())
	for _, tc := range []struct {
		name, want string
		edit       func(*Task)
	}{
		{"description", "Description exceeds", func(v *Task) { v.Description = strings.Repeat("x", (1<<20)+1) }},
		{"due date", "Dates must", func(v *Task) { v.DueDate = "2026-02-30" }},
		{"snooze", "Dates must", func(v *Task) { v.SnoozedUntil = "tomorrow" }},
		{"deletion", "Invalid deletion", func(v *Task) { v.DeletedAt = "yesterday" }},
		{"merge field", "explicit merge", func(v *Task) { v.MergedInto = "other" }},
		{"status", "Unknown status", func(v *Task) { v.Status = "missing" }},
		{"priority", "Unknown priority", func(v *Task) { v.Priority = "missing" }},
		{"icon", "Unknown catalog icon", func(v *Task) { v.Icon = "custom" }},
		{"parent", "Parent task does not exist", func(v *Task) { v.ParentID = "missing" }},
		{"project", "Unknown project", func(v *Task) { v.Project = "missing" }},
		{"tag", "Unknown tag", func(v *Task) { v.Tags = []string{"missing"} }},
		{"image", "Unknown attachment", func(v *Task) { v.Attachments = []string{"missing"} }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			v := Task{Title: "Refuse invalid input"}
			tc.edit(&v)
			_, err := s.SaveTask(v, 0, "user", "", "")
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("want %q, got %v", tc.want, err)
			}
			if !bytes.Equal(before, encode(s.Snapshot())) {
				t.Fatal("invalid task changed records/history")
			}
		})
	}
	if _, err := s.SaveTask(Task{ID: "missing", Title: "Stale"}, 1, "user", "", ""); err == nil {
		t.Fatal("stale identity recreated")
	}
	if _, err := s.SaveTask(Task{Title: "Unexplained completion", Status: "done"}, 0, "agent", "", ""); err == nil {
		t.Fatal("unexplained completion accepted")
	}
	p := mustTask(t, s, Task{Title: "Parent"})
	c := mustTask(t, s, Task{Title: "Child", ParentID: p.ID})
	other := mustTask(t, s, Task{Title: "Other parent"})
	p.ParentID = other.ID
	if _, err := s.SaveTask(p, p.Revision, "user", "", ""); err == nil {
		t.Fatal("parent with children became subtask")
	}
	c.Status = "done"
	c = mustTask(t, s, c)
	p.ParentID = ""
	p.Status = "done"
	p = mustTask(t, s, p)
	if _, err := s.SaveTask(Task{Title: "Agent child", ParentID: p.ID}, 0, "agent", "", ""); err == nil {
		t.Fatal("parent reopened without reason")
	}
	if _, err := s.SaveTask(Task{Title: "Agent child", ParentID: p.ID}, 0, "agent", "Explicit reopening", ""); err != nil {
		t.Fatal(err)
	}
}

func TestSourceKeyReplayPersistsNewRequestAndDuplicateEvidence(t *testing.T) {
	s := testStore(t)
	p := Entity{ID: "project", Name: "Project"}
	if err := s.Put("project", p.ID, p, "user", ""); err != nil {
		t.Fatal(err)
	}
	a := mustTask(t, s, Task{Title: "Similar login issue", Project: p.ID, Source: "agent", SourceKey: "issue-1"})
	input := Task{Title: "Different report", Project: p.ID, Source: "agent", SourceKey: "issue-1"}
	for i := 0; i < 2; i++ {
		v, err := s.SaveTask(input, 0, "agent", "same source", "new-replay")
		if err != nil || v.ID != a.ID || v.Revision != a.Revision {
			t.Fatal(v, err)
		}
	}
	if len(s.Tasks()) != 1 {
		t.Fatal("source replay duplicated task")
	}
	matches := s.Duplicates(input)
	if len(matches) != 1 || matches[0].Score != 1 || !strings.Contains(strings.Join(matches[0].Reasons, " "), "Same source key Same project") {
		t.Fatal("missing source/project evidence", matches)
	}
	if len(s.Duplicates(Task{Title: "!"})) != 0 {
		t.Fatal("punctuation generated false positives")
	}
}

func TestMergeRefusalsAndAttachmentUnionAreReversible(t *testing.T) {
	s := testStore(t)
	for _, id := range []string{"img-a", "img-b"} {
		if err := s.Put("attachment", id, Attachment{ID: id}, "user", "fixture"); err != nil {
			t.Fatal(err)
		}
	}
	a := mustTask(t, s, Task{Title: "Source", Attachments: []string{"img-a", "img-b"}})
	b := mustTask(t, s, Task{Title: "Target", Status: "done", Attachments: []string{"img-a"}})
	c := mustTask(t, s, Task{Title: "Active child", ParentID: a.ID})
	for _, tc := range []struct {
		source, target string
		rev, targetRev int
	}{
		{a.ID, "missing", a.Revision, 1}, {a.ID, b.ID, a.Revision + 1, b.Revision}, {a.ID, c.ID, a.Revision, c.Revision},
	} {
		if err := s.Merge(tc.source, tc.target, tc.rev, tc.targetRev, "user", "explicit"); err == nil {
			t.Fatal("unsafe merge accepted", tc)
		}
	}
	other := mustTask(t, s, Task{Title: "Other parent"})
	sub := mustTask(t, s, Task{Title: "Target child", ParentID: other.ID})
	if err := s.Merge(a.ID, sub.ID, a.Revision, sub.Revision, "user", "explicit"); err == nil {
		t.Fatal("parent merged into subtask")
	}
	if err := s.Merge(a.ID, b.ID, a.Revision, b.Revision, "user", "Same issue"); err != nil {
		t.Fatal(err)
	}
	s.Get("task", b.ID, &b)
	s.Get("task", a.ID, &a)
	s.Get("task", c.ID, &c)
	if b.Status != "open" || len(b.Attachments) != 2 || c.ParentID != b.ID {
		t.Fatal("merge lost attachments or active hierarchy", b, c)
	}
	if err := s.Merge(a.ID, other.ID, a.Revision, other.Revision, "user", "again"); err == nil {
		t.Fatal("merged source remerged")
	}
	a.Title = "Edit merged source"
	if _, err := s.SaveTask(a, a.Revision, "user", "", ""); err == nil {
		t.Fatal("merged source editable")
	}
	events := s.Events(0, b.ID, 100)
	if err := s.Undo(events[len(events)-1].ID, "user"); err != nil {
		t.Fatal(err)
	}
	s.Get("task", b.ID, &b)
	if b.Status != "done" || len(b.Attachments) != 1 {
		t.Fatal("merge undo did not restore target", b)
	}
	large := mustTask(t, s, Task{Title: "Large", Description: strings.Repeat("x", 1<<20)})
	if err := s.Merge(other.ID, large.ID, other.Revision, large.Revision, "user", "same"); err == nil {
		t.Fatal("oversized merge accepted")
	}
}

func TestUndoCreateAndChildReopenRespectCurrentHierarchy(t *testing.T) {
	s := testStore(t)
	a := mustTask(t, s, Task{Title: "Undo new task"})
	events := s.Events(0, a.ID, 100)
	if err := s.Undo(events[0].ID, "user"); err != nil {
		t.Fatalf("undo create: %v; current=%s events=%s", err, encode(s.Tasks()), encode(events))
	}
	s.Get("task", a.ID, &a)
	if a.DeletedAt == "" || a.Revision != 2 {
		t.Fatal("undo create was destructive", a)
	}
	if err := s.Undo(s.Events(0, "app", 100)[0].ID, "user"); err == nil {
		t.Fatal("non-task undo accepted")
	}
	p := mustTask(t, s, Task{Title: "Parent"})
	c := mustTask(t, s, Task{Title: "Child", ParentID: p.ID})
	c.Status = "done"
	c = mustTask(t, s, c)
	events = s.Events(0, c.ID, 100)
	p.Status = "done"
	p = mustTask(t, s, p)
	if err := s.Undo(events[len(events)-1].ID, "user"); err != nil {
		t.Fatal(err)
	}
	s.Get("task", p.ID, &p)
	s.Get("task", c.ID, &c)
	if p.Status != "open" || c.Status != "open" {
		t.Fatal("undo left active child under done parent", p, c)
	}
}

func TestDatabaseWriteFailuresDoNotLeavePartialHistory(t *testing.T) {
	for _, table := range []string{"objects", "events", "requests"} {
		t.Run(table, func(t *testing.T) {
			s := testStore(t)
			a := mustTask(t, s, Task{Title: "Before write failure"})
			before := encode(s.Snapshot())
			if _, err := s.DB.Exec("CREATE TRIGGER refuse_write BEFORE INSERT ON " + table + " BEGIN SELECT RAISE(FAIL,'fixture failure'); END"); err != nil {
				t.Fatal(err)
			}
			a.Title = "Must roll back"
			if _, err := s.SaveTask(a, a.Revision, "user", "fixture", "atomic-request"); err == nil {
				t.Fatal("write failure hidden")
			}
			if !bytes.Equal(before, encode(s.Snapshot())) {
				t.Fatal("failed write partially changed task or history")
			}
			if table != "requests" && s.Put("tag", "tag", Entity{ID: "tag", Name: "Tag"}, "user", "") == nil {
				t.Fatal("Put hid write failure")
			}
		})
	}
	s := testStore(t)
	if _, err := s.DB.Exec(`CREATE TRIGGER refuse_delete BEFORE DELETE ON objects BEGIN SELECT RAISE(FAIL,'fixture failure'); END`); err != nil {
		t.Fatal(err)
	}
	if err := s.Put("column", "open", nil, "user", ""); err == nil {
		t.Fatal("delete failure hidden")
	}
}

func TestClosedDatabaseAndInvalidWorkspacePathsFailSafely(t *testing.T) {
	s := testStore(t)
	s.Close()
	if err := s.Put("tag", "tag", Entity{}, "user", ""); err == nil {
		t.Fatal("closed Put succeeded")
	}
	if _, err := s.SaveTask(Task{Title: "Closed"}, 0, "user", "", ""); err == nil {
		t.Fatal("closed SaveTask succeeded")
	}
	if err := s.Undo(1, "user"); err == nil {
		t.Fatal("closed Undo succeeded")
	}
	if err := s.Merge("a", "b", 1, 1, "user", "fixture"); err == nil {
		t.Fatal("closed Merge succeeded")
	}
	if len(s.ListRaw("task")) != 0 || len(s.Events(0, "", 1)) != 0 || len(s.Logs("run")) != 0 {
		t.Fatal("closed reads fabricated records")
	}
	file := filepath.Join(t.TempDir(), "file")
	os.WriteFile(file, []byte("preserve"), 0600)
	if store, err := OpenStore(file); err == nil {
		store.Close()
		t.Fatal("file accepted as workspace")
	}
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "sift.db"), []byte("not sqlite"), 0600)
	if service, err := NewService(dir); err == nil {
		service.Close()
		t.Fatal("corrupt database accepted")
	}
	var v map[string]json.RawMessage
	if s.Get("task", "missing", &v) {
		t.Fatal("closed database returned a task")
	}
}

func TestDeferredCommitFailuresRollBackTasksHistoryAndRequests(t *testing.T) {
	for _, operation := range []string{"put", "save", "source replay", "undo", "merge"} {
		t.Run(operation, func(t *testing.T) {
			s := testStore(t)
			a := mustTask(t, s, Task{Title: "Source", Source: "fixture", SourceKey: "stable"})
			b := mustTask(t, s, Task{Title: "Target"})
			event := s.Events(0, b.ID, 100)[0]
			if _, err := s.DB.Exec(`PRAGMA foreign_keys=ON;
CREATE TABLE commit_parent(id INTEGER PRIMARY KEY);
CREATE TABLE commit_child(parent INTEGER REFERENCES commit_parent(id) DEFERRABLE INITIALLY DEFERRED);`); err != nil {
				t.Fatal(err)
			}
			table := "events"
			if operation == "source replay" {
				table = "requests"
			}
			if _, err := s.DB.Exec("CREATE TRIGGER fail_commit AFTER INSERT ON " + table + " BEGIN INSERT INTO commit_child VALUES(1); END"); err != nil {
				t.Fatal(err)
			}
			before := encode(s.Snapshot())
			var err error
			switch operation {
			case "put":
				err = s.Put("tag", "tag", Entity{ID: "tag", Name: "Tag"}, "user", "fixture")
			case "save":
				a.Title = "Changed"
				_, err = s.SaveTask(a, a.Revision, "user", "fixture", "commit-request")
			case "source replay":
				_, err = s.SaveTask(Task{Title: "Replay", Source: "fixture", SourceKey: "stable"}, 0, "user", "fixture", "commit-request")
			case "undo":
				err = s.Undo(event.ID, "user")
			case "merge":
				err = s.Merge(a.ID, b.ID, a.Revision, b.Revision, "user", "Same evidence")
			}
			if err == nil || !strings.Contains(err.Error(), "FOREIGN KEY") {
				t.Fatal("deferred commit failure hidden", err)
			}
			if !bytes.Equal(before, encode(s.Snapshot())) {
				t.Fatal("failed commit leaked records or history")
			}
			var requests int
			if err := s.DB.QueryRow("SELECT COUNT(*) FROM requests").Scan(&requests); err != nil || requests != 0 {
				t.Fatal("failed commit retained a request", requests, err)
			}
		})
	}
}

func TestGroupedUndoRefusesUndecodableCompanionAndKeepsCurrentTask(t *testing.T) {
	s := testStore(t)
	task := mustTask(t, s, Task{Title: "Preserve on corrupt grouped history"})
	event := s.Events(0, task.ID, 100)[0]
	if _, err := s.DB.Exec("INSERT INTO events(kind,entity_id,actor,reason,at,group_id) VALUES('task',NULL,'fixture','fixture',?,?)", now(), event.Group); err != nil {
		t.Fatal(err)
	}
	if err := s.Undo(event.ID, "user"); err == nil {
		t.Fatal("corrupt grouped history accepted")
	}
	var after Task
	if !s.Get("task", task.ID, &after) || !bytes.Equal(encode(task), encode(after)) {
		t.Fatal("failed grouped undo changed current task")
	}
}

func TestSourceReplayAndLinkedReopenPersistenceFailuresStayAtomic(t *testing.T) {
	t.Run("source replay request", func(t *testing.T) {
		s := testStore(t)
		a := mustTask(t, s, Task{Title: "Same source", Source: "fixture", SourceKey: "stable"})
		if _, err := s.DB.Exec(`CREATE TRIGGER refuse_replay BEFORE INSERT ON requests BEGIN SELECT RAISE(FAIL,'fixture'); END`); err != nil {
			t.Fatal(err)
		}
		if _, err := s.SaveTask(Task{Title: "Replay", Source: "fixture", SourceKey: "stable"}, 0, "user", "fixture", "request"); err == nil {
			t.Fatal("source replay hid request persistence failure")
		}
		var after Task
		if !s.Get("task", a.ID, &after) || !bytes.Equal(encode(a), encode(after)) {
			t.Fatal("failed replay changed source")
		}
	})
	t.Run("linked reopen", func(t *testing.T) {
		s := testStore(t)
		p := mustTask(t, s, Task{Title: "Done parent", Status: "done"})
		if _, err := s.DB.Exec(`CREATE TRIGGER refuse_parent BEFORE INSERT ON events WHEN NEW.entity_id='` + p.ID + `' BEGIN SELECT RAISE(FAIL,'fixture'); END`); err != nil {
			t.Fatal(err)
		}
		if _, err := s.SaveTask(Task{Title: "Active child", ParentID: p.ID}, 0, "user", "fixture", ""); err == nil {
			t.Fatal("failed linked reopen succeeded")
		}
		var after Task
		if !s.Get("task", p.ID, &after) || !bytes.Equal(encode(p), encode(after)) || len(s.Tasks()) != 1 {
			t.Fatal("failed linked reopen left partial work")
		}
	})
	t.Run("merged survivor edit", func(t *testing.T) {
		s := testStore(t)
		a := mustTask(t, s, Task{Title: "Source"})
		b := mustTask(t, s, Task{Title: "Target"})
		if err := s.Merge(a.ID, b.ID, a.Revision, b.Revision, "user", "Same issue"); err != nil {
			t.Fatal(err)
		}
		s.Get("task", a.ID, &a)
		a.MergedInto = "" // Omitting the protected field still cannot edit the source.
		if _, err := s.SaveTask(a, a.Revision, "user", "fixture", ""); err == nil {
			t.Fatal("merged source editable by omitting mergedInto")
		}
	})
}
