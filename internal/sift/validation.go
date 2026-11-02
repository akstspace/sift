package sift

import (
	"encoding/json"
	"sort"
	"strings"
	"time"
)

func validateSettings(in Settings) error {
	if _, err := time.LoadLocation(in.Timezone); err != nil {
		return invalid("Invalid IANA timezone")
	}
	if in.Theme != "system" && in.Theme != "light" && in.Theme != "dark" {
		return invalid("Invalid theme")
	}
	if in.View != "board" && in.View != "list" {
		return invalid("Invalid task view")
	}
	if in.Concurrency < 1 || in.Concurrency > 16 || in.TimeoutMinutes < 1 || in.TimeoutMinutes > 1440 || in.BackupRetention < 1 || in.BackupRetention > 100 || in.LogRetentionDays < 1 || in.LogRetentionDays > 3650 || in.TrashRetentionDays < 1 || in.TrashRetentionDays > 3650 || in.AutoArchiveDays < 0 || in.AutoArchiveDays > 3650 {
		return invalid("Settings limits are outside the supported range")
	}
	return nil
}

// Also used before restoring or undoing data, which must not bypass live task
// invariants just because it originated in an earlier valid workspace.
func validateTaskGraph(tasks map[string]Task, columns map[string]bool) error {
	keys := map[string]string{}
	// Stable diagnostics for the same invalid workspace, independent of Go map
	// iteration or the order records arrived in a backup/SSE snapshot.
	ids := make([]string, 0, len(tasks))
	for id := range tasks {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		t := tasks[id]
		for _, stamp := range []string{t.CompletedAt, t.ArchivedAt} {
			if stamp != "" {
				if _, err := time.Parse(time.RFC3339Nano, stamp); err != nil {
					return invalid("Invalid task lifecycle timestamp")
				}
			}
		}
		if (t.Status != "done" && (t.CompletedAt != "" || t.ArchivedAt != "")) || (t.ArchivedAt != "" && t.CompletedAt == "") {
			return invalid("Only completed tasks can be archived")
		}
		if !columns[t.Status] {
			return invalid("Task %s references an unknown workflow column", id)
		}
		if t.MergedInto != "" {
			target, ok := tasks[t.MergedInto]
			if !ok || target.ID == t.ID {
				return invalid("Invalid merge survivor for %s", id)
			}
			seen := map[string]bool{id: true}
			for target.MergedInto != "" {
				if seen[target.ID] {
					return invalid("Merge cycle")
				}
				seen[target.ID] = true
				var ok bool
				target, ok = tasks[target.MergedInto]
				if !ok {
					return invalid("Missing merge survivor")
				}
			}
		}
		if t.DeletedAt != "" || t.MergedInto != "" {
			continue
		}
		if t.SourceKey != "" {
			key := t.Source + "\x00" + t.SourceKey
			if keys[key] != "" {
				return conflict("Source key already belongs to task " + keys[key])
			}
			keys[key] = id
		}
		if t.ParentID != "" {
			p, ok := tasks[t.ParentID]
			if !ok || p.ID == id || p.ParentID != "" || p.DeletedAt != "" || p.MergedInto != "" {
				return invalid("Invalid parent for task %s", id)
			}
			if p.Status == "done" && t.Status != "done" {
				return conflict("Cannot complete a parent while a subtask is active")
			}
		}
	}
	return nil
}

func validateWorkspace(data map[string][]json.RawMessage) error {
	objects := map[string]map[string]bool{}
	for _, k := range backupKinds {
		objects[k] = map[string]bool{}
		for _, raw := range data[k] {
			v := jsonMap(raw)
			id, ok := v["id"].(string)
			if !ok || id == "" || len(id) > 200 || strings.ContainsAny(id, "/\\\x00") || objects[k][id] {
				return invalid("Invalid or duplicate %s ID", k)
			}
			objects[k][id] = true
		}
	}
	if len(data["settings"]) != 1 || !objects["settings"]["app"] || !objects["column"]["open"] || !objects["column"]["done"] {
		return invalid("Missing required settings or workflow columns")
	}
	var cfg Settings
	if json.Unmarshal(data["settings"][0], &cfg) != nil {
		return invalid("Invalid backup settings")
	}
	if err := validateSettings(cfg); err != nil {
		return err
	}
	tasks := map[string]Task{}
	for _, raw := range data["task"] {
		var t Task
		if json.Unmarshal(raw, &t) != nil || trim(t.Title) == "" || len(t.Title) > 500 || len(t.Description) > 1<<20 || t.Revision < 1 || !validDate(t.DueDate) || !validDate(t.SnoozedUntil) {
			return invalid("Invalid backup task")
		}
		if t.DeletedAt != "" {
			if _, err := time.Parse(time.RFC3339Nano, t.DeletedAt); err != nil {
				return invalid("Invalid deletion timestamp")
			}
		}
		if !strings.Contains("|none|low|medium|high|urgent|", "|"+t.Priority+"|") || (t.Icon != "" && !iconExists(t.Icon)) {
			return invalid("Invalid task priority or icon")
		}
		if t.Project != "" && !objects["project"][t.Project] {
			return invalid("Missing task project")
		}
		for _, id := range t.Tags {
			if !objects["tag"][id] {
				return invalid("Missing task tag")
			}
		}
		for _, id := range t.Attachments {
			if !objects["attachment"][id] {
				return invalid("Missing task attachment")
			}
		}
		tasks[t.ID] = t
	}
	if err := validateTaskGraph(tasks, objects["column"]); err != nil {
		return err
	}
	for _, raw := range data["job"] {
		var j Job
		if json.Unmarshal(raw, &j) != nil || j.Revision < 1 || trim(j.Name) == "" || trim(j.Prompt) == "" || j.SessionID == "" || strings.ContainsAny(j.SessionID, "/\\\x00") || j.TimeoutMinutes < 1 || j.TimeoutMinutes > 1440 {
			return invalid("Invalid backup job")
		}
		if _, err := nextJob(j, time.Now()); err != nil {
			return err
		}
	}
	return nil
}
