package sift

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestScheduleFlagsAreRepeatableAndReadable(t *testing.T) {
	a := parseArgs([]string{"jobs", "add", "--schedule", "daily 09:00", "--schedule=interval 2h", "--file", "job.json"})
	if !reflect.DeepEqual(a.Lists["schedule"], []string{"daily 09:00", "interval 2h"}) || a.Flags["file"] != "job.json" {
		t.Fatal(a)
	}
	for spec, want := range map[string]JobSchedule{
		"daily 09:00":                     {Type: "daily", Schedule: "09:00"},
		"  Daily   07:15 ":                {Type: "daily", Schedule: "07:15"},
		"interval 30m":                    {Type: "interval", Schedule: "30m"},
		"cron */5 9-17 * * 1-5":           {Type: "cron", Schedule: "*/5 9-17 * * 1-5"},
		"weekdays 17:30 MON,Wednesday,5":  {Type: "weekdays", Schedule: "17:30", Weekdays: []int{1, 3, 5}},
		"weekdays 08:00 mon-fri":          {Type: "weekdays", Schedule: "08:00", Weekdays: []int{1, 2, 3, 4, 5}},
		"weekdays 10:00 0-1,sat-saturday": {Type: "weekdays", Schedule: "10:00", Weekdays: []int{0, 1, 6}},
	} {
		got, err := parseScheduleSpec(spec)
		if err != nil || !reflect.DeepEqual(got, want) {
			t.Fatalf("%q: got %+v (%v), want %+v", spec, got, err, want)
		}
	}
	for spec, want := range map[string]string{
		"":                           "use \"daily 09:00\"",
		"daily":                      "use \"daily 09:00\"",
		"daily 09:00 extra":          "use \"daily 09:00\"",
		"hourly 1":                   "use \"daily 09:00\"",
		"weekdays 09:00":             "use \"daily 09:00\"",
		"weekdays 09:00 fri-mon":     "days are sun–sat or 0–6",
		"weekdays 09:00 funday":      "days are sun–sat or 0–6",
		"weekdays 09:00 7":           "days are sun–sat or 0–6",
		"weekdays 09:00 mon-someday": "days are sun–sat or 0–6",
	} {
		if _, err := parseScheduleSpec(spec); err == nil || !strings.Contains(err.Error(), want) {
			t.Fatalf("%q: got %v, want %q", spec, err, want)
		}
	}
}

func TestCLIAddsJobsWithSchedulesAndChangesOnlySchedules(t *testing.T) {
	s := testService(t)
	server := httptest.NewServer(s.routes())
	defer server.Close()
	if err := os.WriteFile(filepath.Join(s.Dir, "connection.json"), encode(Connection{URL: server.URL, Token: "fixture"}), 0600); err != nil {
		t.Fatal(err)
	}
	call := func(wantError bool, args ...string) []byte {
		t.Helper()
		var out bytes.Buffer
		err := CLI(context.Background(), append([]string{"--data", s.Dir, "--progress", "never"}, args...), &out)
		if (err != nil) != wantError {
			t.Fatalf("%v: err %v output %s", args, err, out.String())
		}
		return out.Bytes()
	}
	file := filepath.Join(s.Dir, "job.json")
	if err := os.WriteFile(file, encode(Job{Name: "CLI schedules", Prompt: "Do not run", Directory: s.Dir, Timezone: "UTC", Schedules: []JobSchedule{{Type: "daily", Schedule: "06:00"}}}), 0600); err != nil {
		t.Fatal(err)
	}
	var job Job
	json.Unmarshal(call(false, "jobs", "add", "--file", file, "--schedule", "daily 08:00", "--schedule=weekdays 17:30 mon-wed,fri", "--schedule", "cron 0 12 * * 6"), &job)
	want := []JobSchedule{{Type: "daily", Schedule: "08:00"}, {Type: "weekdays", Schedule: "17:30", Weekdays: []int{1, 2, 3, 5}}, {Type: "cron", Schedule: "0 12 * * 6"}}
	if job.ID == "" || !reflect.DeepEqual(job.Schedules, want) {
		t.Fatal("--schedule did not replace the file's schedules", job.Schedules)
	}

	var updated Job
	json.Unmarshal(call(false, "jobs", "update", job.ID, "--revision", "1", "--schedule", "interval 2h", "--schedule", "daily 21:00"), &updated)
	if updated.Revision != 2 || updated.Name != job.Name || updated.Prompt != job.Prompt || updated.SessionID != job.SessionID ||
		!reflect.DeepEqual(updated.Schedules, []JobSchedule{{Type: "interval", Schedule: "2h"}, {Type: "daily", Schedule: "21:00"}}) {
		t.Fatal("a schedules-only update changed more than the schedules", updated)
	}

	for _, args := range [][]string{
		{"jobs", "update", job.ID, "--revision", "1", "--schedule", "daily 07:00"}, // stale revision
		{"jobs", "update", job.ID, "--schedule", "daily 07:00"},                    // no revision
		{"jobs", "update", job.ID, "--revision", "0", "--schedule", "daily 07:00"},
		{"jobs", "update", job.ID, "--revision", "2"}, // nothing to change
		{"jobs", "update", job.ID, "--revision", "2", "--schedule", "hourly"},
		{"jobs", "update", job.ID, "--revision", "2", "--schedule", "daily 07:00", "--schedule", "daily 07:00"},
		{"jobs", "update", "missing", "--revision", "1", "--schedule", "daily 07:00"},
		{"jobs", "update", "--revision", "2", "--schedule", "daily 07:00"},
		{"jobs", "add", "--schedule", "daily 07:00"},
	} {
		call(true, args...)
	}
	var jobs []Job
	json.Unmarshal(call(false, "jobs", "list"), &jobs)
	if len(jobs) != 1 || jobs[0].Revision != 2 || !reflect.DeepEqual(jobs[0].Schedules, updated.Schedules) {
		t.Fatal("a refused CLI change was saved", jobs)
	}

	// A file update can override its revision; the file's schedules are kept
	// when no --schedule is given.
	stale := updated
	stale.Revision = 99
	if err := os.WriteFile(file, encode(stale), 0600); err != nil {
		t.Fatal(err)
	}
	json.Unmarshal(call(false, "jobs", "update", job.ID, "--file", file, "--revision", "2"), &updated)
	if updated.Revision != 3 || len(updated.Schedules) != 2 {
		t.Fatal("file update with --revision failed", updated)
	}
	var help bytes.Buffer
	if err := CLI(context.Background(), []string{"help"}, &help); err != nil || !strings.Contains(help.String(), `--schedule SPEC`) {
		t.Fatal("help does not explain --schedule", err)
	}
	var schema map[string]any
	json.Unmarshal(call(false, "schema"), &schema)
	if _, ok := schema["jobSchedules"]; !ok {
		t.Fatal("schema does not describe job schedules")
	}
}
