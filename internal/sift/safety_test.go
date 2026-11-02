package sift

import "testing"

func TestSourceKeyUpdatesCannotCollide(t *testing.T) {
	s := testStore(t)
	a := mustTask(t, s, Task{Title: "One", Source: "agent", SourceKey: "one"})
	b := mustTask(t, s, Task{Title: "Two", Source: "agent", SourceKey: "two"})
	b.SourceKey = a.SourceKey
	if _, e := s.SaveTask(b, b.Revision, "user", "", ""); e == nil {
		t.Fatal("source-key collision accepted")
	}
}
func TestUndoCannotOrphanLaterChild(t *testing.T) {
	s := testStore(t)
	p := mustTask(t, s, Task{Title: "Parent"})
	ev := s.Events(0, p.ID, 100)[0]
	mustTask(t, s, Task{Title: "Later child", ParentID: p.ID})
	if e := s.Undo(ev.ID, "user"); e == nil {
		t.Fatal("undo deleted parent with later child")
	}
}
func TestColumnRemovalIsAtomic(t *testing.T) {
	s := testStore(t)
	p := mustTask(t, s, Task{Title: "Parent", Status: "progress"})
	mustTask(t, s, Task{Title: "Child", ParentID: p.ID})
	if e := s.DeleteColumn("progress", "done"); e == nil {
		t.Fatal("invalid completion accepted")
	}
	var c Column
	var got Task
	if !s.Get("column", "progress", &c) || !s.Get("task", p.ID, &got) || got.Status != "progress" {
		t.Fatal("partial column removal")
	}
	if e := s.DeleteColumn("progress", "open"); e != nil {
		t.Fatal(e)
	}
	if s.Get("column", "progress", &c) {
		t.Fatal("column not removed")
	}
}
