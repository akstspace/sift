package sift

import (
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
)

func testStore(t *testing.T) *Store {
	t.Helper()
	s, e := OpenStore(t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { s.Close() })
	return s
}
func mustTask(t *testing.T, s *Store, v Task) Task {
	t.Helper()
	out, e := s.SaveTask(v, v.Revision, "user", "test change", "")
	if e != nil {
		t.Fatal(e)
	}
	return out
}
func TestTaskHierarchyAndLinkedUndo(t *testing.T) {
	s := testStore(t)
	p := mustTask(t, s, Task{Title: "Parent"})
	c := mustTask(t, s, Task{Title: "Child", ParentID: p.ID})
	p.Status = "done"
	if _, e := s.SaveTask(p, p.Revision, "user", "", ""); e == nil {
		t.Fatal("completed active parent")
	}
	if _, e := s.SaveTask(Task{Title: "Grandchild", ParentID: c.ID}, 0, "user", "", ""); e == nil {
		t.Fatal("allowed second subtask level")
	}
	c.Status = "done"
	c = mustTask(t, s, c)
	p = mustTask(t, s, p)
	c.Status = "open"
	c = mustTask(t, s, c)
	s.Get("task", p.ID, &p)
	if p.Status != "open" {
		t.Fatal("parent did not reopen")
	}
	events := s.Events(0, c.ID, 100)
	if e := s.Undo(events[len(events)-1].ID, "user"); e != nil {
		t.Fatal(e)
	}
	s.Get("task", p.ID, &p)
	s.Get("task", c.ID, &c)
	if p.Status != "done" || c.Status != "done" {
		t.Fatalf("linked undo failed: %s %s", p.Status, c.Status)
	}
}
func TestTaskIdempotencyAndSourceKeys(t *testing.T) {
	s := testStore(t)
	v := Task{Title: "One observation", Source: "agent", SourceKey: "issue-42"}
	a, e := s.SaveTask(v, 0, "agent", "found issue", "request-1")
	if e != nil {
		t.Fatal(e)
	}
	b, e := s.SaveTask(v, 0, "agent", "found issue", "request-1")
	if e != nil || a.ID != b.ID || a.Revision != b.Revision {
		t.Fatal("request replay was not idempotent", e)
	}
	v.Title = "Different"
	if _, e = s.SaveTask(v, 0, "agent", "found issue", "request-1"); e == nil {
		t.Fatal("reused request with new body")
	}
	b, e = s.SaveTask(v, 0, "agent", "same observation", "")
	if e != nil || b.ID != a.ID || len(s.Tasks()) != 1 {
		t.Fatal("source lookup duplicated", e)
	}
	v.Revision = a.Revision
	b, e = s.SaveTask(v, a.Revision, "agent", "refresh observation", "")
	if e != nil || b.Title != "Different" || b.ID != a.ID {
		t.Fatal("source upsert failed", e)
	}
}
func TestTaskConflictsAndReasons(t *testing.T) {
	s := testStore(t)
	a := mustTask(t, s, Task{Title: "Manual"})
	stale := a
	a.Title = "New decision"
	a = mustTask(t, s, a)
	if _, e := s.SaveTask(stale, stale.Revision, "agent", "stale", ""); e == nil {
		t.Fatal("stale update won")
	}
	a.Status = "done"
	if _, e := s.SaveTask(a, a.Revision, "agent", "", ""); e == nil {
		t.Fatal("agent completion lacked reason")
	}
	a, e := s.SaveTask(a, a.Revision, "agent", "Verified addressed", "")
	if e != nil {
		t.Fatal(e)
	}
	a.Status = "open"
	if _, e = s.SaveTask(a, a.Revision, "agent", "", ""); e == nil {
		t.Fatal("reopening without reason")
	}
	var wins int
	var mu sync.Mutex
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			v := a
			v.Title = fmt.Sprint(i)
			if _, e := s.SaveTask(v, v.Revision, "user", "", ""); e == nil {
				mu.Lock()
				wins++
				mu.Unlock()
			}
		}(i)
	}
	wg.Wait()
	if wins != 1 {
		t.Fatalf("expected one winner, got %d", wins)
	}
}
func TestDuplicateMergeUndo(t *testing.T) {
	s := testStore(t)
	a := mustTask(t, s, Task{Title: "Fix login redirect", Description: "source context"})
	b := mustTask(t, s, Task{Title: "Fix login redirect", Description: "survivor context"})
	c := mustTask(t, s, Task{Title: "Child", ParentID: a.ID})
	matches := s.Duplicates(a)
	if len(matches) != 1 || matches[0].ID != b.ID || len(matches[0].Reasons) == 0 {
		t.Fatal(matches)
	}
	if e := s.Merge(a.ID, b.ID, a.Revision, b.Revision, "user", "Same issue"); e != nil {
		t.Fatal(e)
	}
	var merged Task
	s.Get("task", a.ID, &merged)
	s.Get("task", c.ID, &c)
	if merged.MergedInto != b.ID || c.ParentID != b.ID {
		t.Fatal("merge lost hierarchy")
	}
	events := s.Events(0, b.ID, 100)
	if e := s.Undo(events[len(events)-1].ID, "user"); e != nil {
		t.Fatal(e)
	}
	s.Get("task", a.ID, &a)
	s.Get("task", b.ID, &b)
	s.Get("task", c.ID, &c)
	if a.MergedInto != "" || c.ParentID != a.ID || strings.Contains(b.Description, "source context") {
		t.Fatal("merge not reversible")
	}
}
func TestUndoRefusesNewerWork(t *testing.T) {
	s := testStore(t)
	a := mustTask(t, s, Task{Title: "First"})
	ev := s.Events(0, a.ID, 100)[0]
	a.Title = "Later"
	mustTask(t, s, a)
	if e := s.Undo(ev.ID, "user"); e == nil {
		t.Fatal("undo overwrote later work")
	}
}
func TestTenThousandTasksSnapshot(t *testing.T) {
	s := testStore(t)
	tx, e := s.DB.Begin()
	if e != nil {
		t.Fatal(e)
	}
	for i := 0; i < 10000; i++ {
		v := Task{ID: fmt.Sprintf("tsk_%06d", i), Title: fmt.Sprintf("Task %d", i), Status: "open", Priority: "none", Tags: []string{}, Attachments: []string{}, Checklist: []ChecklistItem{}}
		if _, e = tx.Exec("INSERT INTO objects VALUES('task',?,?)", v.ID, encode(v)); e != nil {
			t.Fatal(e)
		}
	}
	if e = tx.Commit(); e != nil {
		t.Fatal(e)
	}
	start := time.Now()
	snapshot := s.Snapshot()
	if len(snapshot["tasks"].([]json.RawMessage)) != 10000 {
		t.Fatal("missing tasks")
	}
	if time.Since(start) > 5*time.Second {
		t.Fatal("snapshot exceeded 5 seconds")
	}
	t.Log("10,000-task snapshot:", time.Since(start))
	d := s.Duplicates(Task{Title: "Task 21"})
	if len(d) == 0 {
		t.Fatal("duplicate search failed")
	}
}
