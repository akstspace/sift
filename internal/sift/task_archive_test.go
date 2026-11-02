package sift

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"
)

func TestArchiveDefaultsAndLegacyJSON(t *testing.T) {
	s := testStore(t)
	var cfg Settings
	s.Get("settings", "app", &cfg)
	if cfg.AutoArchiveDays != 7 {
		t.Fatal(cfg)
	}
	for _, tc := range []struct {
		raw  string
		want int
	}{{`{}`, 7}, {`{"autoArchiveDays":0}`, 0}, {`{"autoArchiveDays":14}`, 14}} {
		if err := json.Unmarshal([]byte(tc.raw), &cfg); err != nil || cfg.AutoArchiveDays != tc.want {
			t.Fatal(cfg, err)
		}
	}
	if json.Unmarshal([]byte(`{"autoArchiveDays":"bad"}`), &cfg) == nil {
		t.Fatal("accepted malformed preference")
	}
	var task Task
	if json.Unmarshal([]byte(`{"status":"done","updatedAt":"2026-01-01T00:00:00Z"}`), &task) != nil || task.CompletedAt != task.UpdatedAt {
		t.Fatal(task)
	}
	if json.Unmarshal([]byte(`{"status":false}`), &task) == nil {
		t.Fatal("accepted malformed task")
	}
	for _, days := range []int{-1, 3651, 0, 7, 3650} {
		s.Get("settings", "app", &cfg)
		cfg.AutoArchiveDays = days
		if err := validateSettings(cfg); (err != nil) != (days < 0 || days > 3650) {
			t.Fatal(days, err)
		}
	}
}

func TestCompletionClockAndArchiveBoundary(t *testing.T) {
	s := testStore(t)
	task := mustTask(t, s, Task{Title: "Deadline", DueDate: "2028-02-29", Status: "done", CompletedAt: "2000-01-01T00:00:00Z"})
	completed, err := time.Parse(time.RFC3339Nano, task.CompletedAt)
	if err != nil || time.Since(completed) > time.Minute {
		t.Fatal("client forged completion", task)
	}
	task.Title = "Edited after completion"
	task.CompletedAt = "1990-01-01T00:00:00Z"
	task = mustTask(t, s, task)
	if task.CompletedAt != completed.Format(time.RFC3339Nano) {
		t.Fatal("edit reset clock", task)
	}
	if err = s.ArchiveCompleted(0, completed.Add(30*24*time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err = s.ArchiveCompleted(7, completed.Add(7*24*time.Hour-time.Nanosecond)); err != nil {
		t.Fatal(err)
	}
	s.Get("task", task.ID, &task)
	if task.ArchivedAt != "" {
		t.Fatal("archived early")
	}
	stale := task
	if err = s.ArchiveCompleted(7, completed.Add(7*24*time.Hour)); err != nil {
		t.Fatal(err)
	}
	s.Get("task", task.ID, &task)
	if task.ArchivedAt == "" || task.Status != "done" || task.DueDate != "2028-02-29" || task.Revision != stale.Revision+1 {
		t.Fatal(task)
	}
	if _, err = s.SaveTask(stale, stale.Revision, "user", "", ""); err == nil {
		t.Fatal("stale edit overwrote archive")
	}
	cursor := s.Latest()
	if err = s.ArchiveCompleted(7, completed.Add(8*24*time.Hour)); err != nil || s.Latest() != cursor {
		t.Fatal("non-idempotent archive", err)
	}
	events := s.Events(0, task.ID, 100)
	if err = s.Undo(events[len(events)-1].ID, "user"); err != nil {
		t.Fatal(err)
	}
	s.Get("task", task.ID, &task)
	if task.ArchivedAt != "" || task.CompletedAt != stale.CompletedAt {
		t.Fatal("undo lost task", task)
	}
	task.Status = "open"
	task = mustTask(t, s, task)
	if task.CompletedAt != "" || task.ArchivedAt != "" {
		t.Fatal(task)
	}
	task.Status = "done"
	task = mustTask(t, s, task)
	if task.CompletedAt == stale.CompletedAt {
		t.Fatal("recompletion did not reset clock")
	}
	bad := task
	bad.ArchivedAt = now()
	if _, err = s.SaveTask(bad, bad.Revision, "user", "", ""); err == nil {
		t.Fatal("client forged archive")
	}
	for _, date := range []string{"2027-02-29", "2028-13-01", "tomorrow"} {
		bad = task
		bad.DueDate = date
		if _, err = s.SaveTask(bad, bad.Revision, "user", "", ""); err == nil {
			t.Fatal("accepted invalid deadline", date)
		}
	}
}

func TestArchiveHierarchyRecoveryAndLegacyTasks(t *testing.T) {
	s := testStore(t)
	p := mustTask(t, s, Task{Title: "Parent"})
	c := mustTask(t, s, Task{Title: "Child", ParentID: p.ID, Status: "done"})
	p.Status = "done"
	p = mustTask(t, s, p)
	at := time.Now().UTC()
	old := at.Add(-8 * 24 * time.Hour).Format(time.RFC3339Nano)
	p.CompletedAt = old
	p.SnoozedUntil = "2099-01-01"
	c.SnoozedUntil = "2099-01-01"
	c.CompletedAt = at.Format(time.RFC3339Nano)
	if err := s.Put("task", p.ID, p, "test", "age"); err != nil {
		t.Fatal(err)
	}
	if err := s.Put("task", c.ID, c, "test", "age"); err != nil {
		t.Fatal(err)
	}
	if err := s.ArchiveCompleted(7, at); err != nil {
		t.Fatal(err)
	}
	s.Get("task", p.ID, &p)
	if p.ArchivedAt != "" {
		t.Fatal("parent hid recent subtask")
	}
	c.CompletedAt = old
	_ = s.Put("task", c.ID, c, "test", "age")
	if err := s.ArchiveCompleted(7, at); err != nil {
		t.Fatal(err)
	}
	s.Get("task", c.ID, &c)
	s.Get("task", p.ID, &p)
	if c.ArchivedAt == "" || p.ArchivedAt == "" {
		t.Fatal("family not archived")
	}
	c.Status = "open"
	c = mustTask(t, s, c)
	s.Get("task", p.ID, &p)
	if c.ArchivedAt != "" || p.ArchivedAt != "" || p.CompletedAt != "" || p.Status != "open" || c.SnoozedUntil != "" || p.SnoozedUntil != "" {
		t.Fatal("family not reopened", p, c)
	}
	events := s.Events(0, c.ID, 100)
	if err := s.Undo(events[len(events)-1].ID, "user"); err != nil {
		t.Fatal(err)
	}
	s.Get("task", c.ID, &c)
	s.Get("task", p.ID, &p)
	if c.ArchivedAt == "" || p.ArchivedAt == "" {
		t.Fatal("linked undo lost archive")
	}
	// Legacy raw JSON is read without destructive migration; deleted/merged/open
	// records are never archived and malformed dates use a safe fresh baseline.
	for id, raw := range map[string]string{
		"legacy":  `{"id":"legacy","title":"Old done","status":"done","revision":1,"updatedAt":"2020-01-01T00:00:00Z"}`,
		"invalid": `{"id":"invalid","status":"done","revision":1,"updatedAt":"invalid"}`,
		"deleted": `{"id":"deleted","status":"done","revision":1,"updatedAt":"2020-01-01T00:00:00Z","deletedAt":"2026-01-01T00:00:00Z"}`,
		"merged":  `{"id":"merged","status":"done","revision":1,"updatedAt":"2020-01-01T00:00:00Z","mergedInto":"legacy"}`,
	} {
		if _, err := s.DB.Exec("INSERT INTO objects VALUES('task',?,?)", id, []byte(raw)); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.ArchiveCompleted(7, at); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"legacy", "invalid", "deleted", "merged"} {
		var task Task
		s.Get("task", id, &task)
		if (task.ArchivedAt != "") != (id == "legacy") {
			t.Fatal(id, task)
		}
	}
}

func TestArchiveBackupAPIAndFailureSafety(t *testing.T) {
	s := testService(t)
	task := mustTask(t, s.Store, Task{Title: "Keep forever", Status: "done", DueDate: "2028-02-29"})
	at := time.Now().Add(8 * 24 * time.Hour)
	if err := s.Store.ArchiveCompleted(7, at); err != nil {
		t.Fatal(err)
	}
	var response struct {
		Task Task `json:"task"`
	}
	if err := json.Unmarshal(routeRequest(t, s.routes(), "GET", "/api/tasks/"+task.ID, nil, 200, false), &response); err != nil || response.Task.ArchivedAt == "" {
		t.Fatal(response, err)
	}
	file, err := s.Backup()
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	if err = s.RestoreArchive(context.Background(), data); err != nil {
		t.Fatal(err)
	}
	s.Store.Get("task", task.ID, &task)
	if task.ArchivedAt == "" || task.DueDate != "2028-02-29" {
		t.Fatal(task)
	}
	// A failed history write rolls back both task and revision.
	other := mustTask(t, s.Store, Task{Title: "Atomic archive", Status: "done"})
	_, err = s.Store.DB.Exec(`CREATE TRIGGER reject_archive BEFORE INSERT ON events WHEN NEW.reason='Automatically archived completed task' BEGIN SELECT RAISE(ABORT,'fixture'); END`)
	if err != nil {
		t.Fatal(err)
	}
	if s.Store.ArchiveCompleted(7, at) == nil {
		t.Fatal("ignored history failure")
	}
	var unchanged Task
	s.Store.Get("task", other.ID, &unchanged)
	if unchanged.ArchivedAt != "" || unchanged.Revision != other.Revision {
		t.Fatal("partial archive")
	}
	_, _ = s.Store.DB.Exec("DROP TRIGGER reject_archive")
	_, _ = s.Store.DB.Exec("INSERT INTO objects VALUES('task','broken',?)", []byte(`{`))
	if s.Store.ArchiveCompleted(7, at) == nil {
		t.Fatal("ignored corrupt task")
	}
	closed := testStore(t)
	_ = closed.Close()
	if closed.ArchiveCompleted(7, at) == nil {
		t.Fatal("ignored closed database")
	}
	for _, task := range []Task{{ID: "bad", Status: "done", CompletedAt: "bad"}, {ID: "bad", Status: "open", ArchivedAt: now()}, {ID: "bad", Status: "done", ArchivedAt: now()}} {
		if validateTaskGraph(map[string]Task{"bad": task}, map[string]bool{"done": true, "open": true}) == nil {
			t.Fatal("invalid lifecycle accepted", task)
		}
	}
}

func TestArchiveMaintenanceAndWorkflowTransitions(t *testing.T) {
	s := testService(t)
	var cfg Settings
	s.Store.Get("settings", "app", &cfg)
	cfg.CheckUpdates = false
	cfg.LastBackup = now()
	if err := s.Store.Put("settings", "app", cfg, "test", ""); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-8 * 24 * time.Hour).UTC().Format(time.RFC3339Nano)
	task := mustTask(t, s.Store, Task{Title: "Maintenance completion", Status: "done"})
	task.CompletedAt = old
	_ = s.Store.Put("task", task.ID, task, "test", "age")
	s.checkMaintenance()
	s.Store.Get("task", task.ID, &task)
	if task.ArchivedAt == "" {
		t.Fatal("maintenance did not archive")
	}
	// Undo completion of an archived child must revive its parent, not leave
	// active work hidden under a completed/archived parent.
	p := mustTask(t, s.Store, Task{Title: "Undo parent"})
	c := mustTask(t, s.Store, Task{Title: "Undo child", ParentID: p.ID})
	c.Status = "done"
	c = mustTask(t, s.Store, c)
	events := s.Store.Events(0, c.ID, 100)
	completionEvent := events[len(events)-1].ID
	p.Status = "done"
	p = mustTask(t, s.Store, p)
	p.ArchivedAt = now()
	_ = s.Store.Put("task", p.ID, p, "test", "archive")
	if err := s.Store.Undo(completionEvent, "user"); err != nil {
		t.Fatal(err)
	}
	s.Store.Get("task", p.ID, &p)
	s.Store.Get("task", c.ID, &c)
	if p.Status != "open" || p.ArchivedAt != "" || p.CompletedAt != "" || c.CompletedAt != "" {
		t.Fatal(p, c)
	}
	// Workflow moves to Done set the clock just like task saves do.
	column := Column{ID: "review", Name: "Review"}
	if err := s.Store.Put("column", column.ID, column, "user", ""); err != nil {
		t.Fatal(err)
	}
	move := mustTask(t, s.Store, Task{Title: "Column completion", Status: column.ID})
	if err := s.Store.DeleteColumn(column.ID, "done"); err != nil {
		t.Fatal(err)
	}
	s.Store.Get("task", move.ID, &move)
	if move.CompletedAt == "" || move.Status != "done" {
		t.Fatal(move)
	}
	// Merging active children into an archived survivor revives that survivor.
	source := mustTask(t, s.Store, Task{Title: "Merge family"})
	mustTask(t, s.Store, Task{Title: "Merge child", ParentID: source.ID})
	if err := s.Store.Merge(source.ID, task.ID, source.Revision, task.Revision, "user", "Combine related work"); err != nil {
		t.Fatal(err)
	}
	s.Store.Get("task", task.ID, &task)
	if task.Status != "open" || task.ArchivedAt != "" || task.CompletedAt != "" {
		t.Fatal(task)
	}
	// Maintenance reports database faults instead of silently succeeding.
	_, _ = s.Store.DB.Exec("INSERT INTO objects VALUES('task','malformed',?)", []byte(`{`))
	s.checkMaintenance()
}
