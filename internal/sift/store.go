package sift

import (
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"fmt"
	_ "modernc.org/sqlite"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"
)

type Store struct {
	DB   *sql.DB
	mu   sync.Mutex
	wake chan struct{}
	dir  string
}

func OpenStore(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	_ = os.Chmod(dir, 0700)
	db, err := sql.Open("sqlite", filepath.Join(dir, "sift.db"))
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	var schema int
	if err = db.QueryRow("PRAGMA user_version").Scan(&schema); err != nil || schema > 1 {
		db.Close()
		if err != nil {
			return nil, err
		}
		return nil, invalid("Workspace uses schema %d; this Sift supports schema 1. Use the newer executable or restore a compatible backup", schema)
	}
	// CREATE TABLE IF NOT EXISTS also accepts an existing view. Refuse those
	// before initialization so startup cannot appear healthy with unwritable
	// workspace tables (notably metadata, which is first written on restore).
	for _, table := range []string{"metadata", "objects", "events", "requests", "run_logs"} {
		var kind string
		err = db.QueryRow("SELECT type FROM sqlite_schema WHERE name=?", table).Scan(&kind)
		if err != nil && err != sql.ErrNoRows {
			db.Close()
			return nil, err
		}
		if err == nil && kind != "table" {
			db.Close()
			return nil, invalid("Workspace schema requires %s to be a table; existing %s was left unchanged", table, kind)
		}
	}
	if _, err = db.Exec("CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL)"); err != nil {
		db.Close()
		return nil, err
	}
	for _, q := range []string{"PRAGMA journal_mode=WAL", "PRAGMA synchronous=FULL", "PRAGMA busy_timeout=5000", `CREATE TABLE IF NOT EXISTS objects(kind TEXT NOT NULL,id TEXT NOT NULL,data BLOB NOT NULL,PRIMARY KEY(kind,id))`, `CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT,entity_id TEXT,actor TEXT,reason TEXT,at TEXT,before_data BLOB,after_data BLOB,group_id TEXT)`, `CREATE INDEX IF NOT EXISTS event_entity ON events(entity_id,id)`, `CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY,hash TEXT NOT NULL,result BLOB NOT NULL)`, `CREATE TABLE IF NOT EXISTS run_logs(run_id TEXT,at TEXT,data BLOB)`, `PRAGMA user_version=1`} {
		if _, err = db.Exec(q); err != nil {
			db.Close()
			return nil, err
		}
	}
	s := &Store{DB: db, wake: make(chan struct{}, 1), dir: dir}
	var settings Settings
	if !s.Get("settings", "app", &settings) {
		settings = Settings{ID: "app", Timezone: time.Now().Location().String(), Theme: "system", View: "board", Concurrency: 3, TimeoutMinutes: 30, CheckUpdates: true, BackupRetention: 14, LogRetentionDays: 30, TrashRetentionDays: 30, AutoArchiveDays: 7}
		if settings.Timezone == "Local" {
			settings.Timezone = "UTC"
		}
		if err = s.Put("settings", "app", settings, "system", "Initialize Sift"); err != nil {
			db.Close()
			return nil, err
		}
	}
	if len(s.ListRaw("column")) == 0 {
		for i, c := range []Column{{ID: "open", Name: "Open", Color: "slate"}, {ID: "progress", Name: "In progress", Color: "blue"}, {ID: "done", Name: "Done", Color: "green"}} {
			c.Order = i
			if err = s.Put("column", c.ID, c, "system", "Default workflow"); err != nil {
				db.Close()
				return nil, err
			}
		}
	}
	return s, nil
}
func (s *Store) Close() error { return s.DB.Close() }
func (s *Store) signal() {
	select {
	case s.wake <- struct{}{}:
	default:
	}
}
func (s *Store) Get(kind, id string, v any) bool {
	var b []byte
	if s.DB.QueryRow("SELECT data FROM objects WHERE kind=? AND id=?", kind, id).Scan(&b) != nil {
		return false
	}
	return json.Unmarshal(b, v) == nil
}
func (s *Store) ListRaw(kind string) []json.RawMessage {
	rows, err := s.DB.Query("SELECT data FROM objects WHERE kind=? ORDER BY id", kind)
	if err != nil {
		return []json.RawMessage{}
	}
	defer rows.Close()
	out := []json.RawMessage{}
	for rows.Next() {
		var b []byte
		if rows.Scan(&b) == nil {
			out = append(out, json.RawMessage(b))
		}
	}
	return out
}
func listAs[T any](s *Store, kind string) []T {
	out := []T{}
	for _, b := range s.ListRaw(kind) {
		var v T
		if json.Unmarshal(b, &v) == nil {
			out = append(out, v)
		}
	}
	return out
}
func rawTx(tx *sql.Tx, kind, id string) []byte {
	var b []byte
	_ = tx.QueryRow("SELECT data FROM objects WHERE kind=? AND id=?", kind, id).Scan(&b)
	return b
}

// agentChange is who changed a task's status without the person's review yet:
// the person's own changes clear it, and an agent's status change sets it.
func agentChange(actor, previous string, statusChanged bool) string {
	if actor == "user" {
		return ""
	}
	if statusChanged {
		return actor
	}
	return previous
}

func putTx(tx *sql.Tx, kind, id string, v any, actor, reason, group string) error {
	before := rawTx(tx, kind, id)
	after := encode(v)
	if v == nil {
		after = nil
		_, err := tx.Exec("DELETE FROM objects WHERE kind=? AND id=?", kind, id)
		if err != nil {
			return err
		}
	} else {
		if _, err := tx.Exec("INSERT INTO objects(kind,id,data) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data", kind, id, after); err != nil {
			return err
		}
	}
	_, err := tx.Exec("INSERT INTO events(kind,entity_id,actor,reason,at,before_data,after_data,group_id) VALUES(?,?,?,?,?,?,?,?)", kind, id, actor, reason, now(), before, after, group)
	return err
}
func (s *Store) Put(kind, id string, v any, actor, reason string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err = putTx(tx, kind, id, v, actor, reason, ""); err != nil {
		return err
	}
	if err = tx.Commit(); err == nil {
		s.signal()
	}
	return err
}
func (s *Store) Latest() int64 {
	var id int64
	_ = s.DB.QueryRow("SELECT COALESCE(MAX(id),0) FROM events").Scan(&id)
	return id
}
func (s *Store) Events(after int64, entity string, limit int) []Event {
	return s.events(after, entity, limit, "")
}
func (s *Store) events(after int64, entity string, limit int, kind string) []Event {
	q := "SELECT id,kind,entity_id,actor,reason,at,before_data,after_data,group_id FROM events WHERE id>?"
	args := []any{after}
	if entity != "" {
		q += " AND entity_id=?"
		args = append(args, entity)
	}
	if kind != "" {
		q += " AND kind=?"
		args = append(args, kind)
	}
	q += " ORDER BY id LIMIT ?"
	args = append(args, limit)
	rows, err := s.DB.Query(q, args...)
	if err != nil {
		return []Event{}
	}
	defer rows.Close()
	out := []Event{}
	for rows.Next() {
		var e Event
		var b, a []byte
		if rows.Scan(&e.ID, &e.Kind, &e.EntityID, &e.Actor, &e.Reason, &e.At, &b, &a, &e.Group) == nil {
			e.Before = b
			e.After = a
			out = append(out, e)
		}
	}
	return out
}
func (s *Store) Snapshot() map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := map[string]any{"cursor": s.Latest(), "version": Version}
	for _, k := range []string{"task", "column", "project", "tag", "job", "run", "attachment", "notification"} {
		out[k+"s"] = s.ListRaw(k)
	}
	var cfg Settings
	s.Get("settings", "app", &cfg)
	out["settings"] = cfg
	return out
}
func (s *Store) Tasks() []Task { return listAs[Task](s, "task") }
func validDate(v string) bool {
	if v == "" {
		return true
	}
	_, err := time.Parse("2006-01-02", v)
	return err == nil
}
func (s *Store) SaveTask(t Task, expected int, actor, reason, requestID string) (Task, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.DB.Begin()
	if err != nil {
		return t, err
	}
	defer tx.Rollback()
	group := newID("edit_")
	requestHash := fmt.Sprintf("%x", sha256.Sum256(encode(map[string]any{"task": t, "expected": expected, "actor": actor, "reason": reason})))
	if requestID != "" {
		var h string
		var b []byte
		if tx.QueryRow("SELECT hash,result FROM requests WHERE id=?", requestID).Scan(&h, &b) == nil {
			if h != requestHash {
				return t, conflict("Request ID was already used with different content")
			}
			_ = json.Unmarshal(b, &t)
			return t, nil
		}
	}
	if trim(t.Title) == "" || len(t.Title) > 500 {
		return t, invalid("Task title must contain 1–500 characters")
	}
	if len(t.Description) > 1<<20 {
		return t, invalid("Description exceeds 1 MB")
	}
	if !validDate(t.DueDate) || !validDate(t.SnoozedUntil) {
		return t, invalid("Dates must use YYYY-MM-DD")
	}
	if t.DeletedAt != "" {
		if _, e := time.Parse(time.RFC3339Nano, t.DeletedAt); e != nil {
			return t, invalid("Invalid deletion timestamp")
		}
	}
	if t.MergedInto != "" {
		return t, invalid("Use the explicit merge command instead of setting mergedInto")
	}
	if t.Status == "" {
		t.Status = "open"
	}
	if len(rawTx(tx, "column", t.Status)) == 0 {
		return t, invalid("Unknown status; discover available columns first")
	}
	if t.Priority == "" {
		t.Priority = "none"
	}
	if !strings.Contains("|none|low|medium|high|urgent|", "|"+t.Priority+"|") {
		return t, invalid("Unknown priority")
	}
	if t.Icon != "" && !iconExists(t.Icon) {
		return t, invalid("Unknown catalog icon; use sift icons search")
	}
	if t.ID == "" && t.SourceKey != "" {
		rows, e := tx.Query("SELECT data FROM objects WHERE kind='task'")
		if e != nil {
			return t, e
		}
		for rows.Next() {
			var b []byte
			var old Task
			_ = rows.Scan(&b)
			_ = json.Unmarshal(b, &old)
			if old.Source == t.Source && old.SourceKey == t.SourceKey && old.DeletedAt == "" && old.MergedInto == "" {
				rows.Close()
				if expected == 0 {
					if requestID != "" {
						if _, err = tx.Exec("INSERT INTO requests VALUES(?,?,?)", requestID, requestHash, encode(old)); err != nil {
							return t, err
						}
						if err = tx.Commit(); err != nil {
							return t, err
						}
					}
					return old, nil
				}
				t.ID = old.ID
				break
			}
		}
		rows.Close()
	}
	var old Task
	before := rawTx(tx, "task", t.ID)
	if before != nil {
		_ = json.Unmarshal(before, &old)
		if old.Revision != expected {
			return t, conflict("Task changed; re-read its current revision before editing")
		}
		if old.MergedInto != "" {
			return t, conflict("Task has been merged; use its survivor or undo the merge")
		}
		if actor != "user" && (old.Status != t.Status && (t.Status == "done" || old.Status == "done") || old.Actor == "user") && trim(reason) == "" {
			return t, invalid("An agent must provide a reason for completing/reopening or revising a manual decision")
		}
		t.CreatedAt = old.CreatedAt
		t.Revision = old.Revision + 1
	} else {
		if expected != 0 {
			return t, conflict("Task does not exist")
		}
		if actor != "user" && t.Status == "done" && trim(reason) == "" {
			return t, invalid("An agent must explain completion")
		}
		t.ID = newID("tsk_")
		t.CreatedAt = now()
		t.Revision = 1
	}
	if t.ParentID != "" {
		var p Task
		if json.Unmarshal(rawTx(tx, "task", t.ParentID), &p) != nil || p.DeletedAt != "" || p.MergedInto != "" {
			return t, invalid("Parent task does not exist")
		}
		if p.ParentID != "" || p.ID == t.ID {
			return t, invalid("Only one subtask level is supported")
		}
		rows, e := tx.Query("SELECT data FROM objects WHERE kind='task'")
		if e != nil {
			return t, e
		}
		hasChildren := false
		for rows.Next() {
			var b []byte
			var child Task
			_ = rows.Scan(&b)
			_ = json.Unmarshal(b, &child)
			if child.ParentID == t.ID && child.DeletedAt == "" && child.MergedInto == "" {
				hasChildren = true
			}
		}
		rows.Close()
		if hasChildren {
			return t, invalid("A task with children cannot become a subtask")
		}
		if t.Project == "" {
			t.Project = p.Project
		}
		if p.Status == "done" && t.Status != "done" && t.DeletedAt == "" {
			p.Status = "open"
			reopenLifecycle(&p)
			p.Revision++
			p.UpdatedAt = now()
			p.Actor = actor
			p.AgentChange = agentChange(actor, p.AgentChange, true)
			if actor != "user" && trim(reason) == "" {
				return t, invalid("Reopening a completed parent requires a reason")
			}
			if err = putTx(tx, "task", p.ID, p, actor, "Reopened because subtask is active: "+reason, group); err != nil {
				return t, err
			}
		}
	}
	if t.Status == "done" || t.DeletedAt != "" {
		rows, e := tx.Query("SELECT data FROM objects WHERE kind='task'")
		if e != nil {
			return t, e
		}
		blocked := false
		for rows.Next() {
			var b []byte
			var child Task
			_ = rows.Scan(&b)
			_ = json.Unmarshal(b, &child)
			if child.ParentID == t.ID && child.DeletedAt == "" && child.MergedInto == "" && (t.DeletedAt != "" || child.Status != "done") {
				blocked = true
			}
		}
		rows.Close()
		if blocked {
			return t, invalid("Move or finish active subtasks before completing; move subtasks before deleting the parent")
		}
	}
	if t.Project != "" && len(rawTx(tx, "project", t.Project)) == 0 {
		return t, invalid("Unknown project")
	}
	for _, id := range t.Tags {
		if len(rawTx(tx, "tag", id)) == 0 {
			return t, invalid("Unknown tag %s", id)
		}
	}
	for _, id := range t.Attachments {
		if len(rawTx(tx, "attachment", id)) == 0 {
			return t, invalid("Unknown attachment")
		}
	}
	if t.Tags == nil {
		t.Tags = []string{}
	}
	if t.Checklist == nil {
		t.Checklist = []ChecklistItem{}
	}
	if t.Attachments == nil {
		t.Attachments = []string{}
	}
	// Completion time is server-owned. Editing a completed task must not delay
	// archiving, and reopening must start a fresh lifecycle (including parents).
	t.UpdatedAt = now()
	if t.ArchivedAt != old.ArchivedAt {
		return t, invalid("Archive state is managed automatically; reopen an archived task to restore it")
	}
	updateCompletion(&t, old, t.UpdatedAt)
	t.Actor = actor
	t.AgentChange = agentChange(actor, old.AgentChange, before != nil && old.Status != t.Status)
	tasks, columns, err := taskGraphTx(tx)
	if err != nil {
		return t, err
	}
	tasks[t.ID] = t
	if err = validateTaskGraph(tasks, columns); err != nil {
		return t, err
	}
	if err = putTx(tx, "task", t.ID, t, actor, reason, group); err != nil {
		return t, err
	}
	if requestID != "" {
		if _, err = tx.Exec("INSERT INTO requests VALUES(?,?,?)", requestID, requestHash, encode(t)); err != nil {
			return t, err
		}
	}
	if err = tx.Commit(); err != nil {
		return t, err
	}
	s.signal()
	return t, nil
}
func tokens(v string) map[string]bool {
	out := map[string]bool{}
	for _, w := range strings.FieldsFunc(strings.ToLower(v), func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) }) {
		if len(w) > 1 {
			out[w] = true
		}
	}
	return out
}
func (s *Store) Duplicates(t Task) []Duplicate {
	a := tokens(t.Title)
	out := []Duplicate{}
	if len(a) == 0 {
		return out
	}
	for _, v := range s.Tasks() {
		if v.ID == t.ID || v.DeletedAt != "" || v.MergedInto != "" {
			continue
		}
		b := tokens(v.Title)
		common := 0
		for k := range a {
			if b[k] {
				common++
			}
		}
		union := len(a) + len(b) - common
		score := float64(common) / float64(max(1, union))
		reasons := []string{}
		if strings.EqualFold(trim(v.Title), trim(t.Title)) {
			score = 1
			reasons = append(reasons, "Same title")
		} else if score >= .38 {
			reasons = append(reasons, "Similar title terms")
		}
		if t.SourceKey != "" && v.SourceKey == t.SourceKey && v.Source == t.Source {
			score = 1
			reasons = append(reasons, "Same source key")
		}
		if score < .38 {
			continue
		}
		if t.Project != "" && v.Project == t.Project {
			score = min(1, score+.08)
			reasons = append(reasons, "Same project")
		}
		out = append(out, Duplicate{ID: v.ID, Title: v.Title, Status: v.Status, Score: score, Reasons: reasons})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Score > out[j].Score })
	if len(out) > 8 {
		out = out[:8]
	}
	return out
}
func (s *Store) Undo(eventID int64, actor string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var kind, id, group string
	var before, after []byte
	if err = tx.QueryRow("SELECT kind,entity_id,before_data,after_data,group_id FROM events WHERE id=?", eventID).Scan(&kind, &id, &before, &after, &group); err != nil {
		return invalid("History entry not found")
	}
	if kind != "task" {
		return invalid("Only task changes can be undone")
	}
	events := []Event{{Kind: kind, EntityID: id, Before: before, After: after}}
	if group != "" {
		events = nil
		rows, e := tx.Query("SELECT entity_id,before_data,after_data FROM events WHERE group_id=? ORDER BY id DESC", group)
		if e != nil {
			return e
		}
		for rows.Next() {
			var x Event
			// A newly-created task has SQL NULL before_data. Scan nullable
			// blobs before converting to RawMessage so grouped creation undo
			// does not silently lose after_data and report a false conflict.
			var before, after []byte
			if err = rows.Scan(&x.EntityID, &before, &after); err != nil {
				rows.Close()
				return err
			}
			x.Before, x.After = before, after
			x.Kind = "task"
			events = append(events, x)
		}
		rows.Close()
	}
	for _, e := range events {
		var current Task
		var atChange Task
		_ = json.Unmarshal(rawTx(tx, "task", e.EntityID), &current)
		_ = json.Unmarshal(e.After, &atChange)
		if current.Revision != atChange.Revision || current.ID == "" {
			return conflict("Task changed since this action; inspect current history instead of undoing over newer work")
		}
	}
	tasks, columns, err := taskGraphTx(tx)
	if err != nil {
		return err
	}
	changed := map[string]bool{}
	for _, e := range events {
		var t, current Task
		_ = json.Unmarshal(rawTx(tx, "task", e.EntityID), &current)
		if len(e.Before) == 0 {
			t = current
			t.DeletedAt = now()
		} else {
			_ = json.Unmarshal(e.Before, &t)
		}
		t.Revision = current.Revision + 1
		t.UpdatedAt = now()
		t.Actor = actor
		t.AgentChange = agentChange(actor, t.AgentChange, t.Status != current.Status)
		tasks[t.ID] = t
		changed[t.ID] = true
	}
	for _, t := range tasks {
		if t.ParentID == "" || t.Status == "done" || t.DeletedAt != "" || t.MergedInto != "" {
			continue
		}
		p, ok := tasks[t.ParentID]
		if ok && p.Status == "done" && !changed[p.ID] {
			p.Status = "open"
			reopenLifecycle(&p)
			p.Revision++
			p.UpdatedAt = now()
			p.Actor = actor
			p.AgentChange = agentChange(actor, p.AgentChange, true)
			tasks[p.ID] = p
			changed[p.ID] = true
		}
	}
	if err = validateTaskGraph(tasks, columns); err != nil {
		return conflict("Undo would violate current task relationships: " + err.Error())
	}
	undoGroup := newID("undo_")
	for id := range changed {
		if err = putTx(tx, "task", id, tasks[id], actor, fmt.Sprintf("Undo history entry %d", eventID), undoGroup); err != nil {
			return err
		}
	}
	if err = tx.Commit(); err == nil {
		s.signal()
	}
	return err
}
func (s *Store) Merge(source, target string, sourceRev, targetRev int, actor, reason string) error {
	if source == target || trim(reason) == "" {
		return invalid("Choose different tasks and provide a merge reason")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var a, b Task
	if json.Unmarshal(rawTx(tx, "task", source), &a) != nil || json.Unmarshal(rawTx(tx, "task", target), &b) != nil {
		return invalid("Task not found")
	}
	if a.Revision != sourceRev || b.Revision != targetRev {
		return conflict("Re-read both task revisions before merging")
	}
	if a.DeletedAt != "" || b.DeletedAt != "" || a.MergedInto != "" || b.MergedInto != "" {
		return invalid("Merged/deleted tasks cannot be merged again")
	}
	if a.ParentID == target || b.ParentID == source {
		return invalid("Cannot merge a parent with its own child")
	}
	rows, err := tx.Query("SELECT data FROM objects WHERE kind='task'")
	if err != nil {
		return err
	}
	children := []Task{}
	for rows.Next() {
		var raw []byte
		var c Task
		_ = rows.Scan(&raw)
		_ = json.Unmarshal(raw, &c)
		if c.ParentID == a.ID && c.DeletedAt == "" && c.MergedInto == "" {
			children = append(children, c)
		}
	}
	rows.Close()
	if len(children) > 0 && b.ParentID != "" {
		return invalid("Cannot merge a parent into a subtask")
	}
	group := newID("merge_")
	survivorStatus := b.Status
	for _, c := range children {
		c.ParentID = b.ID
		c.Revision++
		c.UpdatedAt = now()
		if c.Status != "done" && b.Status == "done" {
			b.Status = "open"
			reopenLifecycle(&b)
		}
		if err = putTx(tx, "task", c.ID, c, actor, reason, group); err != nil {
			return err
		}
	}
	for _, id := range a.Attachments {
		found := false
		for _, v := range b.Attachments {
			if v == id {
				found = true
			}
		}
		if !found {
			b.Attachments = append(b.Attachments, id)
		}
	}
	b.Description += "\n\n---\nMerged from **" + a.Title + "** (`" + a.ID + "`)\n\n" + a.Description
	if len(b.Description) > 1<<20 {
		return invalid("Merged description exceeds 1 MB; shorten it before merging")
	}
	b.Checklist = append(b.Checklist, a.Checklist...)
	b.Revision++
	b.UpdatedAt = now()
	b.Actor = actor
	b.AgentChange = agentChange(actor, b.AgentChange, b.Status != survivorStatus)
	a.MergedInto = b.ID
	a.Revision++
	a.UpdatedAt = now()
	a.Actor = actor
	if err = putTx(tx, "task", a.ID, a, actor, reason, group); err != nil {
		return err
	}
	if err = putTx(tx, "task", b.ID, b, actor, reason, group); err != nil {
		return err
	}
	tasks, columns, err := taskGraphTx(tx)
	if err != nil {
		return err
	}
	if err = validateTaskGraph(tasks, columns); err != nil {
		return err
	}
	if err = tx.Commit(); err == nil {
		s.signal()
	}
	return err
}
func (s *Store) AddLog(runID string, e RunEntry) {
	e.At = now()
	_, _ = s.DB.Exec("INSERT INTO run_logs(run_id,at,data) VALUES(?,?,?)", runID, e.At, encode(e))
	s.signal()
}
func (s *Store) Logs(id string) []RunEntry {
	out := []RunEntry{}
	rows, err := s.DB.Query("SELECT data FROM run_logs WHERE run_id=? ORDER BY rowid LIMIT 20000", id)
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var b []byte
		var e RunEntry
		_ = rows.Scan(&b)
		if json.Unmarshal(b, &e) == nil {
			out = append(out, e)
		}
	}
	return out
}

// Cursor-based activity avoids reprinting or truncating a long run's transcript.
func (s *Store) RunActivity(id string, after int64) ([]runLogEntry, error) {
	rows, err := s.DB.Query("SELECT rowid,data FROM run_logs WHERE run_id=? AND rowid>? ORDER BY rowid LIMIT 500", id, after)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []runLogEntry{}
	for rows.Next() {
		var entry runLogEntry
		var data []byte
		if err := rows.Scan(&entry.ID, &data); err != nil {
			return nil, err
		}
		if err := json.Unmarshal(data, &entry.RunEntry); err != nil {
			return nil, err
		}
		out = append(out, entry)
	}
	return out, rows.Err()
}
