package sift

import "encoding/json"

func (s *Store) MergeEntity(kind, source, target, actor string) error {
	if (kind != "project" && kind != "tag") || source == target {
		return invalid("Choose different valid organizational entities")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var a, b Entity
	if json.Unmarshal(rawTx(tx, kind, source), &a) != nil || json.Unmarshal(rawTx(tx, kind, target), &b) != nil || b.Archived {
		return invalid("Choose an existing, unarchived survivor")
	}
	rows, err := tx.Query("SELECT data FROM objects WHERE kind='task'")
	if err != nil {
		return err
	}
	tasks := []Task{}
	for rows.Next() {
		var raw []byte
		var t Task
		if rows.Scan(&raw) == nil && json.Unmarshal(raw, &t) == nil {
			tasks = append(tasks, t)
		}
	}
	rows.Close()
	for _, t := range tasks {
		changed := false
		if kind == "project" && t.Project == source {
			t.Project = target
			changed = true
		}
		if kind == "tag" {
			tags := []string{}
			seen := map[string]bool{}
			for _, id := range t.Tags {
				if id == source {
					id = target
					changed = true
				}
				if !seen[id] {
					tags = append(tags, id)
					seen[id] = true
				}
			}
			t.Tags = tags
		}
		if changed {
			t.Revision++
			t.UpdatedAt = now()
			t.Actor = actor
			if err = putTx(tx, "task", t.ID, t, actor, "Merged "+kind+" "+a.Name+" into "+b.Name, ""); err != nil {
				return err
			}
		}
	}
	a.Archived = true
	if err = putTx(tx, kind, a.ID, a, actor, "Merged assignments into "+b.ID, ""); err != nil {
		return err
	}
	if err = tx.Commit(); err == nil {
		s.signal()
	}
	return err
}
