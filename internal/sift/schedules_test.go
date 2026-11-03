package sift

import (
	"bytes"
	"errors"
	"log"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func at(t *testing.T, value string) time.Time {
	t.Helper()
	v, err := time.Parse(time.RFC3339, value)
	if err != nil {
		t.Fatal(err)
	}
	return v
}

func TestJobsRunAtTheEarliestOfSeveralSchedules(t *testing.T) {
	// Monday 2 November 2026 onwards, in UTC.
	job := Job{Timezone: "UTC", Schedules: []JobSchedule{
		{Type: "daily", Schedule: "09:00"},
		{Type: "weekdays", Schedule: "17:30", Weekdays: []int{1, 3}},
		{Type: "cron", Schedule: "0 12 * * 6"},
	}}
	walk := []string{
		"2026-11-02T10:00:00Z", "2026-11-02T17:30:00Z", // Monday's weekday time
		"2026-11-03T09:00:00Z",                         // Tuesday: daily only
		"2026-11-04T09:00:00Z", "2026-11-04T17:30:00Z", // Wednesday: both
		"2026-11-05T09:00:00Z", "2026-11-06T09:00:00Z",
		"2026-11-07T09:00:00Z", "2026-11-07T12:00:00Z", // Saturday: daily, then cron
		"2026-11-08T09:00:00Z",
	}
	after := at(t, walk[0])
	for _, want := range walk[1:] {
		next, err := nextJob(job, after)
		if err != nil || next.Format(time.RFC3339) != want {
			t.Fatalf("after %s: got %v (%v), want %s", after.Format(time.RFC3339), next, err, want)
		}
		after = next
	}

	// Schedules due in the same minute are one occurrence: one run, and the
	// next occurrence is past both.
	same := Job{Timezone: "UTC", Schedules: []JobSchedule{{Type: "daily", Schedule: "09:00"}, {Type: "cron", Schedule: "0 9 * * *"}}}
	next, err := nextJob(same, at(t, "2026-11-02T08:00:00Z"))
	if err != nil || !next.Equal(at(t, "2026-11-02T09:00:00Z")) {
		t.Fatal(next, err)
	}
	if next, err = nextJob(same, next); err != nil || !next.Equal(at(t, "2026-11-03T09:00:00Z")) {
		t.Fatal("same-minute schedules fired twice", next, err)
	}

	if _, err = nextJob(Job{Timezone: "UTC"}, after); err == nil || err.Error() != "Add at least one schedule" {
		t.Fatal("a job without schedules had an occurrence", err)
	}
	broken := Job{Timezone: "UTC", Schedules: []JobSchedule{{Type: "daily", Schedule: "09:00"}, {Type: "cron", Schedule: "0 9 31 2 *"}}}
	if _, err = nextJob(broken, after); err == nil || !strings.HasPrefix(err.Error(), "Schedule 2: ") {
		t.Fatal("an impossible second schedule was not named", err)
	}
}

func TestSavingSchedulesCleansThemAndNamesTheOneThatIsWrong(t *testing.T) {
	s := testService(t)
	base := Job{Name: "Several times", Prompt: "Authorized fixture", Directory: s.Dir, Timezone: "UTC"}
	save := func(list ...JobSchedule) (Job, error) {
		j := base
		j.Schedules = list
		return s.SaveJob(j, 0, "user")
	}
	j, err := save(JobSchedule{Type: " daily ", Schedule: " 08:00 ", Weekdays: []int{1}}, JobSchedule{Type: "weekdays", Schedule: "17:30", Weekdays: []int{5, 1, 3, 1}})
	if err != nil {
		t.Fatal(err)
	}
	want := []JobSchedule{{Type: "daily", Schedule: "08:00"}, {Type: "weekdays", Schedule: "17:30", Weekdays: []int{1, 3, 5}}}
	if !reflect.DeepEqual(j.Schedules, want) {
		t.Fatal("schedules were not stored cleaned", j.Schedules)
	}
	next, _ := nextJob(j, time.Now())
	if j.NextRun != next.UTC().Format(time.RFC3339Nano) {
		t.Fatal("next run is not the earliest schedule", j.NextRun, next)
	}

	daily := JobSchedule{Type: "daily", Schedule: "09:00"}
	many := make([]JobSchedule, maxJobSchedules+1)
	for i := range many {
		many[i] = JobSchedule{Type: "interval", Schedule: (time.Duration(i+1) * time.Hour).String()}
	}
	for _, tc := range []struct {
		list []JobSchedule
		want string
	}{
		{nil, "Add at least one schedule"},
		{[]JobSchedule{{Type: "daily", Schedule: "25:00"}}, "Daily schedule must be HH:MM"},
		{[]JobSchedule{daily, {Type: "daily", Schedule: "25:00"}}, "Schedule 2: Daily schedule must be HH:MM"},
		{[]JobSchedule{daily, {Type: "hourly", Schedule: "1"}}, "Schedule 2: Choose daily, selected weekdays, interval, or cron"},
		{[]JobSchedule{daily, {Type: "weekdays", Schedule: "09:00"}}, "Schedule 2: Choose at least one weekday"},
		{[]JobSchedule{daily, {Type: "weekdays", Schedule: "09:00", Weekdays: []int{-1}}}, "Schedule 2: Invalid weekday"},
		{[]JobSchedule{daily, {Type: "weekdays", Schedule: "09:00", Weekdays: []int{7}}}, "Schedule 2: Invalid weekday"},
		{[]JobSchedule{daily, {Type: "interval", Schedule: "1s"}}, "Schedule 2: Interval must be at least 1m, for example 30m or 2h"},
		{[]JobSchedule{daily, {Type: " daily", Schedule: "09:00 "}}, "Schedule 2 repeats schedule 1"},
		{[]JobSchedule{{Type: "weekdays", Schedule: "09:00", Weekdays: []int{3, 1}}, {Type: "weekdays", Schedule: "09:00", Weekdays: []int{1, 3}}}, "Schedule 2 repeats schedule 1"},
		{many, "A job can have up to 20 schedules"},
	} {
		if _, err := save(tc.list...); err == nil || err.Error() != tc.want {
			t.Fatalf("%v: got %v, want %q", tc.list, err, tc.want)
		}
	}
	if len(listAs[Job](s.Store, "job")) != 1 {
		t.Fatal("an invalid schedule list was saved")
	}
}

func TestAJobWithSeveralSchedulesRunsOnceWhenDue(t *testing.T) {
	fixturePi(t)
	s := testService(t)
	j, err := s.SaveJob(Job{Name: "Morning and evening", Prompt: "scenario:success", Directory: s.Dir, Provider: "fixture", Model: "fixture-model", Timezone: "UTC", Enabled: true,
		Schedules: []JobSchedule{{Type: "daily", Schedule: "09:00"}, {Type: "daily", Schedule: "18:30"}, {Type: "weekdays", Schedule: "12:00", Weekdays: []int{0, 6}}}}, 0, "user")
	if err != nil {
		t.Fatal(err)
	}
	due, _ := time.Parse(time.RFC3339Nano, j.NextRun)
	s.scheduleTick(due.Add(-time.Second))
	if len(listAs[Run](s.Store, "run")) != 0 {
		t.Fatal("a schedule fired early")
	}
	s.scheduleTick(due)
	runs := listAs[Run](s.Store, "run")
	if len(runs) != 1 {
		t.Fatal("a due job did not start exactly one run", runs)
	}
	awaitRun(t, s, runs[0].ID, "succeeded")
	if !reflect.DeepEqual(runs[0].Job.Schedules, j.Schedules) {
		t.Fatal("the run did not record the schedules it ran under", runs[0].Job.Schedules)
	}
}

func TestPeopleCanDeleteAJobAndItsMemoryButKeepItsRuns(t *testing.T) {
	s := testService(t)
	h := s.routes()
	j := fixtureJob(t, s, "success")
	memory := filepath.Join(s.Dir, "sessions", j.ID)
	if err := os.MkdirAll(memory, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(memory, "session.jsonl"), []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := s.Store.Put("run", "earlier", Run{ID: "earlier", JobID: j.ID, JobName: j.Name, Status: "succeeded"}, "fixture", ""); err != nil {
		t.Fatal(err)
	}
	path := "/api/jobs/" + j.ID + "?revision="
	routeRequest(t, h, "DELETE", path+"1", nil, 403, true)
	routeRequest(t, h, "DELETE", "/api/jobs/"+j.ID, nil, 400, false)
	routeRequest(t, h, "DELETE", path+"2", nil, 409, false)
	routeRequest(t, h, "DELETE", "/api/jobs/missing?revision=1", nil, 404, false)
	s.active[j.ID] = func() {}
	routeRequest(t, h, "DELETE", path+"1", nil, 409, false)
	delete(s.active, j.ID)
	s.maintenance = true
	routeRequest(t, h, "DELETE", path+"1", nil, 409, false)
	s.maintenance = false
	s.dataMu.Lock()
	routeRequest(t, h, "DELETE", path+"1", nil, 409, false)
	s.dataMu.Unlock()
	if _, err := s.Store.DB.Exec(`CREATE TRIGGER refuse_delete BEFORE DELETE ON objects BEGIN SELECT RAISE(FAIL,'fixture storage failure'); END`); err != nil {
		t.Fatal(err)
	}
	routeRequest(t, h, "DELETE", path+"1", nil, 500, false)
	if len(listAs[Job](s.Store, "job")) != 1 {
		t.Fatal("a refused delete removed the job")
	}
	if _, err := os.Stat(memory); err != nil {
		t.Fatal("a refused delete removed the job's memory", err)
	}
	if _, err := s.Store.DB.Exec(`DROP TRIGGER refuse_delete`); err != nil {
		t.Fatal(err)
	}

	before := s.Store.Latest()
	routeRequest(t, h, "DELETE", path+"1", nil, 200, false)
	if len(listAs[Job](s.Store, "job")) != 0 {
		t.Fatal("the job was not deleted")
	}
	if _, err := os.Stat(memory); !os.IsNotExist(err) {
		t.Fatal("the job's memory was kept", err)
	}
	if runs := listAs[Run](s.Store, "run"); len(runs) != 1 || runs[0].ID != "earlier" {
		t.Fatal("deleting the job removed its run history", runs)
	}
	events := s.Store.Events(before, j.ID, 10)
	if len(events) != 1 || events[0].Actor != "user" || events[0].Reason != "Deleted scheduled job" || events[0].After != nil {
		t.Fatal("deletion is missing from history", events)
	}
	s.scheduleTick(time.Now().Add(48 * time.Hour))
	if len(listAs[Run](s.Store, "run")) != 1 {
		t.Fatal("a deleted job was scheduled")
	}
}

func TestDeletingAJobSucceedsWhenItsMemoryFolderCannotBeRemoved(t *testing.T) {
	s := testService(t)
	j := fixtureJob(t, s, "success")
	var logs bytes.Buffer
	log.SetOutput(&logs)
	removeAll = func(string) error { return errors.New("fixture folder in use") }
	t.Cleanup(func() { log.SetOutput(os.Stderr); removeAll = os.RemoveAll })
	if err := s.DeleteJob(j.ID, j.Revision); err != nil {
		t.Fatal(err)
	}
	if len(listAs[Job](s.Store, "job")) != 0 || !strings.Contains(logs.String(), "its memory folder remains: fixture folder in use") {
		t.Fatal("a stuck memory folder blocked deletion or went unreported", logs.String())
	}
}
