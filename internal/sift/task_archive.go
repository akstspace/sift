package sift

import "time"

func reopenLifecycle(t *Task) {
	if t.ArchivedAt != "" {
		t.SnoozedUntil = ""
	}
	t.CompletedAt, t.ArchivedAt = "", ""
}

func updateCompletion(t *Task, old Task, stamp string) {
	if t.Status != "done" {
		reopenLifecycle(t)
	} else if old.Status != "done" {
		t.CompletedAt, t.ArchivedAt = stamp, ""
	} else {
		t.CompletedAt = completionTime(old, stamp)
	}
}

// For pre-feature tasks, the last edit is a conservative completion baseline:
// it can delay archiving but cannot archive earlier than their completion.
func completionTime(t Task, fallback string) string {
	if t.CompletedAt != "" {
		return t.CompletedAt
	}
	if _, err := time.Parse(time.RFC3339Nano, t.UpdatedAt); err == nil {
		return t.UpdatedAt
	}
	return fallback
}

// ArchiveCompleted runs at startup and every minute, even with no browser open.
// Each archive is an ordinary revisioned, undoable history entry. No task,
// attachment or history is deleted. A parent waits for its visible children.
func (s *Store) ArchiveCompleted(days int, at time.Time) error {
	if days <= 0 {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	tasks, _, err := taskGraphTx(tx)
	if err != nil {
		return err
	}
	stamp := at.UTC().Format(time.RFC3339Nano)
	cutoff := at.Add(-time.Duration(days) * 24 * time.Hour)
	eligible := map[string]bool{}
	for id, t := range tasks {
		completed, e := time.Parse(time.RFC3339Nano, completionTime(t, stamp))
		eligible[id] = t.Status == "done" && t.DeletedAt == "" && t.MergedInto == "" && t.ArchivedAt == "" && e == nil && !completed.After(cutoff)
	}
	changed := false
	blocked := map[string]bool{}
	for id, c := range tasks {
		if c.ParentID != "" && c.DeletedAt == "" && c.MergedInto == "" && c.ArchivedAt == "" && !eligible[id] {
			blocked[c.ParentID] = true
		}
	}
	for id, t := range tasks {
		if !eligible[id] || blocked[id] {
			continue
		}
		t.CompletedAt = completionTime(t, stamp)
		t.ArchivedAt, t.UpdatedAt, t.Actor = stamp, stamp, "system"
		t.Revision++
		if err = putTx(tx, "task", id, t, "system", "Automatically archived completed task", ""); err != nil {
			return err
		}
		changed = true
	}
	if err = tx.Commit(); err == nil && changed {
		s.signal()
	}
	return err
}
