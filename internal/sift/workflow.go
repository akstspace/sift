package sift

import (
	"database/sql"
	"encoding/json"
)

func taskGraphTx(tx *sql.Tx) (map[string]Task, map[string]bool, error) {
	tasks, columns := map[string]Task{}, map[string]bool{}
	rows, err := tx.Query("SELECT kind,id,data FROM objects WHERE kind IN ('task','column')")
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var kind, id string
		var b []byte
		if err = rows.Scan(&kind, &id, &b); err != nil {
			return nil, nil, err
		}
		if kind == "column" {
			columns[id] = true
		} else {
			var t Task
			if err = json.Unmarshal(b, &t); err != nil {
				return nil, nil, err
			}
			tasks[id] = t
		}
	}
	return tasks, columns, rows.Err()
}

func (s *Store) DeleteColumn(id, target string) error {
	if id == "open" || id == "done" {
		return invalid("Open and Done are required workflow columns")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	tasks, columns, err := taskGraphTx(tx)
	if err != nil {
		return err
	}
	if !columns[id] || !columns[target] || target == id {
		return invalid("Choose an existing source and destination column")
	}
	delete(columns, id)
	changed := []Task{}
	for key, t := range tasks {
		if t.Status == id {
			t.Status = target
			t.Revision++
			t.UpdatedAt = now()
			t.Actor = "user"
			tasks[key] = t
			changed = append(changed, t)
		}
	}
	if err = validateTaskGraph(tasks, columns); err != nil {
		return err
	}
	group := newID("column_")
	for _, t := range changed {
		if err = putTx(tx, "task", t.ID, t, "user", "Move tasks from removed column", group); err != nil {
			return err
		}
	}
	if err = putTx(tx, "column", id, nil, "user", "Remove workflow column", ""); err != nil {
		return err
	}
	if err = tx.Commit(); err == nil {
		s.signal()
	}
	return err
}
