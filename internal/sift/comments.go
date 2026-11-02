package sift

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"unicode/utf8"
)

// Comments are independent activity entries, not task snapshots. They cannot
// overwrite a concurrent edit, change attribution, or invalidate task Undo.
func (s *Store) AddComment(taskID, text, actor, requestID string) (Event, error) {
	text = trim(text)
	var event Event
	if text == "" || utf8.RuneCountInString(text) > 10000 {
		return event, invalid("A comment must contain 1–10,000 characters")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.DB.Begin()
	if err != nil {
		return event, err
	}
	defer tx.Rollback()
	hash := fmt.Sprintf("%x", sha256.Sum256(encode([]string{"comment", taskID, text, actor})))
	if requestID != "" {
		var priorHash string
		var result []byte
		if tx.QueryRow("SELECT hash,result FROM requests WHERE id=?", requestID).Scan(&priorHash, &result) == nil {
			if priorHash != hash {
				return event, conflict("Request ID was already used with different content")
			}
			err = json.Unmarshal(result, &event)
			return event, err
		}
	}
	var task Task
	if json.Unmarshal(rawTx(tx, "task", taskID), &task) != nil {
		return event, &APIError{Status: 404, Message: "Task not found"}
	}
	if task.DeletedAt != "" || task.MergedInto != "" {
		return event, conflict("Restore this task or open its merge survivor before commenting")
	}
	event = Event{Kind: "comment", EntityID: taskID, Actor: actor, Reason: text, At: now()}
	result, err := tx.Exec("INSERT INTO events(kind,entity_id,actor,reason,at,group_id) VALUES(?,?,?,?,?,?)", event.Kind, taskID, actor, text, event.At, "")
	if err != nil {
		return event, err
	}
	if event.ID, err = result.LastInsertId(); err != nil {
		return event, err
	}
	if requestID != "" {
		if _, err = tx.Exec("INSERT INTO requests VALUES(?,?,?)", requestID, hash, encode(event)); err != nil {
			return event, err
		}
	}
	if err = tx.Commit(); err == nil {
		s.signal()
	}
	return event, err
}
