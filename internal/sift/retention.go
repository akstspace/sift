package sift

import "time"

// Keep attribution/history and run summaries indefinitely, but expire trash
// objects and verbose logs. Attachment bytes remain while history references
// them, so undo never silently loses an image.
func (s *Store) Prune(cfg Settings) {
	s.mu.Lock()
	defer s.mu.Unlock()
	cutoff := time.Now().AddDate(0, 0, -cfg.TrashRetentionDays)
	tasks := s.Tasks()
	for _, t := range tasks {
		at, err := time.Parse(time.RFC3339Nano, t.DeletedAt)
		if err != nil || at.After(cutoff) {
			continue
		}
		blocked := false
		for _, c := range tasks {
			if c.ParentID == t.ID && c.DeletedAt == "" && c.MergedInto == "" {
				blocked = true
				break
			}
		}
		if !blocked {
			_, _ = s.DB.Exec("DELETE FROM objects WHERE kind='task' AND id=?", t.ID)
		}
	}
	_, _ = s.DB.Exec("DELETE FROM run_logs WHERE at<?", time.Now().AddDate(0, 0, -cfg.LogRetentionDays).UTC().Format(time.RFC3339Nano))
	s.signal()
}
