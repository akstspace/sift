package sift

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestSettingsRejectUnsupportedValues(t *testing.T) {
	s := testService(t)
	var valid Settings
	s.Store.Get("settings", "app", &valid)
	for _, tc := range []struct {
		name string
		edit func(*Settings)
	}{
		{"timezone", func(v *Settings) { v.Timezone = "Not/A_Timezone" }},
		{"theme", func(v *Settings) { v.Theme = "neon" }},
		{"view", func(v *Settings) { v.View = "timeline" }},
		{"concurrency low", func(v *Settings) { v.Concurrency = 0 }},
		{"concurrency high", func(v *Settings) { v.Concurrency = 17 }},
		{"timeout low", func(v *Settings) { v.TimeoutMinutes = 0 }},
		{"timeout high", func(v *Settings) { v.TimeoutMinutes = 1441 }},
		{"backups low", func(v *Settings) { v.BackupRetention = 0 }},
		{"backups high", func(v *Settings) { v.BackupRetention = 101 }},
		{"logs low", func(v *Settings) { v.LogRetentionDays = 0 }},
		{"logs high", func(v *Settings) { v.LogRetentionDays = 3651 }},
		{"trash low", func(v *Settings) { v.TrashRetentionDays = 0 }},
		{"trash high", func(v *Settings) { v.TrashRetentionDays = 3651 }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			bad := valid
			tc.edit(&bad)
			if err := s.SaveSettings(bad); err == nil {
				t.Fatal("invalid settings persisted")
			}
			var after Settings
			s.Store.Get("settings", "app", &after)
			if string(encode(after)) != string(encode(valid)) {
				t.Fatal("invalid settings changed workspace")
			}
		})
	}
}

func TestRestoreValidationRejectsBrokenReferences(t *testing.T) {
	s := testService(t)
	task := mustTask(t, s.Store, Task{Title: "Restore evidence"})
	base := map[string][]json.RawMessage{}
	for _, k := range backupKinds {
		base[k] = s.Store.ListRaw(k)
	}
	clone := func() map[string][]json.RawMessage {
		out := map[string][]json.RawMessage{}
		for k, values := range base {
			out[k] = append([]json.RawMessage{}, values...)
		}
		return out
	}
	if err := validateWorkspace(base); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name, want string
		edit       func(map[string][]json.RawMessage)
	}{
		{"missing settings", "Missing required", func(v map[string][]json.RawMessage) { delete(v, "settings") }},
		{"invalid settings type", "Invalid backup settings", func(v map[string][]json.RawMessage) {
			v["settings"] = []json.RawMessage{json.RawMessage(`{"id":"app","concurrency":"bad"}`)}
		}},
		{"invalid settings values", "Invalid theme", func(v map[string][]json.RawMessage) {
			var cfg Settings
			json.Unmarshal(v["settings"][0], &cfg)
			cfg.Theme = "invalid"
			v["settings"][0] = encode(cfg)
		}},
		{"duplicate IDs", "duplicate task ID", func(v map[string][]json.RawMessage) { v["task"] = append(v["task"], v["task"][0]) }},
		{"unsafe ID", "Invalid or duplicate", func(v map[string][]json.RawMessage) {
			v["tag"] = []json.RawMessage{json.RawMessage(`{"id":"../outside"}`)}
		}},
		{"missing ID", "Invalid or duplicate", func(v map[string][]json.RawMessage) { v["tag"] = []json.RawMessage{json.RawMessage(`{}`)} }},
		{"long ID", "Invalid or duplicate", func(v map[string][]json.RawMessage) {
			v["tag"] = []json.RawMessage{encode(map[string]string{"id": strings.Repeat("x", 201)})}
		}},
		{"job identity", "Invalid backup job", func(v map[string][]json.RawMessage) {
			v["job"] = []json.RawMessage{encode(Job{ID: "job", Name: "Invalid"})}
		}},
		{"job schedule", "Unknown schedule type", func(v map[string][]json.RawMessage) {
			v["job"] = []json.RawMessage{encode(Job{ID: "job", Name: "Job", Prompt: "Local fixture", Revision: 1, SessionID: "session", TimeoutMinutes: 30, Timezone: "UTC", ScheduleType: "unknown"})}
		}},
		{"valid job", "", func(v map[string][]json.RawMessage) {
			v["job"] = []json.RawMessage{encode(Job{ID: "job", Name: "Job", Prompt: "Local fixture", Revision: 1, SessionID: "session", TimeoutMinutes: 30, Timezone: "UTC", ScheduleType: "daily", Schedule: "09:00"})}
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			data := clone()
			tc.edit(data)
			err := validateWorkspace(data)
			if tc.want == "" {
				if err != nil {
					t.Fatal(err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("want %s, got %v", tc.want, err)
			}
		})
	}
	for _, tc := range []struct {
		name, want string
		edit       func(*Task)
	}{
		{"blank title", "Invalid backup task", func(v *Task) { v.Title = " " }},
		{"long title", "Invalid backup task", func(v *Task) { v.Title = strings.Repeat("x", 501) }},
		{"long description", "Invalid backup task", func(v *Task) { v.Description = strings.Repeat("x", (1<<20)+1) }},
		{"zero revision", "Invalid backup task", func(v *Task) { v.Revision = 0 }},
		{"due date", "Invalid backup task", func(v *Task) { v.DueDate = "2026-02-30" }},
		{"snooze date", "Invalid backup task", func(v *Task) { v.SnoozedUntil = "tomorrow" }},
		{"deleted timestamp", "Invalid deletion timestamp", func(v *Task) { v.DeletedAt = "yesterday" }},
		{"valid deleted timestamp", "", func(v *Task) { v.DeletedAt = time.Now().UTC().Format(time.RFC3339Nano) }},
		{"priority", "Invalid task priority or icon", func(v *Task) { v.Priority = "unknown" }},
		{"icon", "Invalid task priority or icon", func(v *Task) { v.Icon = "untrusted-upload" }},
		{"project", "Missing task project", func(v *Task) { v.Project = "missing" }},
		{"tag", "Missing task tag", func(v *Task) { v.Tags = []string{"missing"} }},
		{"attachment", "Missing task attachment", func(v *Task) { v.Attachments = []string{"missing"} }},
		{"status", "unknown workflow column", func(v *Task) { v.Status = "missing" }},
		{"parent", "Invalid parent", func(v *Task) { v.ParentID = "missing" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			data := clone()
			value := task
			tc.edit(&value)
			data["task"][0] = encode(value)
			err := validateWorkspace(data)
			if tc.want == "" {
				if err != nil {
					t.Fatal(err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("want %s, got %v", tc.want, err)
			}
		})
	}
}

func TestGraphValidationMergeChainsAndParents(t *testing.T) {
	columns := map[string]bool{"open": true, "done": true}
	for _, tc := range []struct {
		name, want string
		tasks      []Task
	}{
		{"missing survivor", "Invalid merge survivor", []Task{{ID: "a", Status: "open", MergedInto: "missing"}}},
		{"self survivor", "Invalid merge survivor", []Task{{ID: "a", Status: "open", MergedInto: "a"}}},
		{"missing chain", "Missing merge survivor", []Task{{ID: "a", Status: "open", MergedInto: "b"}, {ID: "b", Status: "open", MergedInto: "missing"}}},
		{"cycle", "Merge cycle", []Task{{ID: "a", Status: "open", MergedInto: "b"}, {ID: "b", Status: "open", MergedInto: "a"}}},
		{"valid chain", "", []Task{{ID: "a", Status: "open", MergedInto: "b"}, {ID: "b", Status: "open", MergedInto: "c"}, {ID: "c", Status: "open"}}},
		{"source collision", "Source key already", []Task{{ID: "a", Status: "open", Source: "fixture", SourceKey: "same"}, {ID: "b", Status: "open", Source: "fixture", SourceKey: "same"}}},
		{"deleted source does not collide", "", []Task{{ID: "a", Status: "open", Source: "fixture", SourceKey: "same", DeletedAt: "fixture"}, {ID: "b", Status: "open", Source: "fixture", SourceKey: "same"}}},
		{"active child under done parent", "Cannot complete a parent", []Task{{ID: "a", Status: "done"}, {ID: "b", Status: "open", ParentID: "a"}}},
		{"completed child under done parent", "", []Task{{ID: "a", Status: "done"}, {ID: "b", Status: "done", ParentID: "a"}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tasks := map[string]Task{}
			for _, task := range tc.tasks {
				tasks[task.ID] = task
			}
			err := validateTaskGraph(tasks, columns)
			if tc.want == "" {
				if err != nil {
					t.Fatal(err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("want %s, got %v", tc.want, err)
			}
		})
	}
}

func TestGraphValidationDiagnosticsDoNotDependOnInsertionOrder(t *testing.T) {
	columns := map[string]bool{"open": true, "done": true}
	for i := 0; i < 100; i++ {
		tasks := map[string]Task{}
		a := Task{ID: "a", Status: "open", MergedInto: "b"}
		b := Task{ID: "b", Status: "open", MergedInto: "missing"}
		if i%2 == 0 {
			tasks[a.ID], tasks[b.ID] = a, b
		} else {
			tasks[b.ID], tasks[a.ID] = b, a
		}
		before := string(encode(tasks))
		err := validateTaskGraph(tasks, columns)
		if err == nil || err.Error() != "Missing merge survivor" {
			t.Fatal("graph diagnostic changed with map iteration", i, err)
		}
		if string(encode(tasks)) != before {
			t.Fatal("validation modified an invalid graph")
		}
	}
}

func TestJobValidationNeverStartsOrPartiallySaves(t *testing.T) {
	s := testService(t)
	base := Job{Name: "Local schedule", Prompt: "Authorized fixture", Directory: s.Dir, Timezone: "UTC", ScheduleType: "daily", Schedule: "09:00"}
	for _, tc := range []struct {
		name string
		edit func(*Job)
	}{
		{"empty name", func(v *Job) { v.Name = "" }}, {"empty prompt", func(v *Job) { v.Prompt = "" }},
		{"relative directory", func(v *Job) { v.Directory = "relative" }}, {"missing directory", func(v *Job) { v.Directory = s.Dir + "/missing" }},
		{"provider only", func(v *Job) { v.Provider = "fixture" }}, {"model only", func(v *Job) { v.Model = "fixture" }},
		{"name length", func(v *Job) { v.Name = strings.Repeat("x", 201) }}, {"prompt length", func(v *Job) { v.Prompt = strings.Repeat("x", (1<<20)+1) }},
		{"timeout low", func(v *Job) { v.TimeoutMinutes = -1 }}, {"timeout high", func(v *Job) { v.TimeoutMinutes = 1441 }},
		{"unknown schedule", func(v *Job) { v.ScheduleType = "unknown" }}, {"no weekdays", func(v *Job) { v.ScheduleType = "weekdays" }},
		{"invalid weekday", func(v *Job) { v.ScheduleType = "weekdays"; v.Weekdays = []int{7} }}, {"timezone", func(v *Job) { v.Timezone = "Unknown/Zone" }},
		{"short interval", func(v *Job) { v.ScheduleType = "interval"; v.Schedule = "1s" }}, {"clock", func(v *Job) { v.Schedule = "25:00" }},
		{"cron", func(v *Job) { v.ScheduleType = "cron"; v.Schedule = "invalid" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			value := base
			tc.edit(&value)
			if _, err := s.SaveJob(value, 0, "user"); err == nil {
				t.Fatal("invalid job saved")
			}
			if len(listAs[Job](s.Store, "job")) != 0 || len(listAs[Run](s.Store, "run")) != 0 {
				t.Fatal("invalid job had side effects")
			}
		})
	}
	base.Directory, base.Timezone = "", ""
	saved, err := s.SaveJob(base, 0, "user")
	if err != nil || saved.Directory == "" || saved.Timezone == "" {
		t.Fatal("defaults not resolved", saved, err)
	}
	if _, err := s.SaveJob(saved, saved.Revision+1, "user"); err == nil {
		t.Fatal("stale revision accepted")
	}
	s.maintenance = true
	if _, err := s.SaveJob(saved, saved.Revision, "user"); err == nil {
		t.Fatal("maintenance edit accepted")
	}
	s.maintenance = false
	s.active[saved.ID] = func() {}
	if _, err := s.SaveJob(saved, saved.Revision, "user"); err == nil {
		t.Fatal("running job edit accepted")
	}
	delete(s.active, saved.ID)
	saved.ID = "missing"
	if _, err := s.SaveJob(saved, 1, "user"); err == nil {
		t.Fatal("deleted job recreated with stale revision")
	}
}
