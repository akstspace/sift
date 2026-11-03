package sift

import "encoding/json"

// ReviewTask records that the person looked at an agent's status change. It
// clears the review flag without a new revision, so it never conflicts with a
// draft open elsewhere or blocks Undo of the change itself. The activity entry
// names the agent whose change was reviewed.
func (s *Store) ReviewTask(taskID string) (Task, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var t Task
	tx, err := s.DB.Begin()
	if err != nil {
		return t, err
	}
	defer tx.Rollback()
	if json.Unmarshal(rawTx(tx, "task", taskID), &t) != nil {
		return t, &APIError{Status: 404, Message: "Task not found"}
	}
	if t.AgentChange == "" {
		return t, nil
	}
	reviewed := t.AgentChange
	t.AgentChange = ""
	if _, err = tx.Exec("UPDATE objects SET data=? WHERE kind='task' AND id=?", encode(t), t.ID); err != nil {
		return t, err
	}
	if _, err = tx.Exec("INSERT INTO events(kind,entity_id,actor,reason,at,group_id) VALUES(?,?,?,?,?,?)", "review", t.ID, "user", reviewed, now(), ""); err != nil {
		return t, err
	}
	if err = tx.Commit(); err == nil {
		s.signal()
	}
	return t, err
}
