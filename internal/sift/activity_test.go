package sift

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// at formats an instant relative to now, as an agent would send it.
func ago(d time.Duration) string { return time.Now().Add(d).Format(time.RFC3339) }

func session(title string, from, to time.Duration) ActivityEntry {
	return ActivityEntry{Title: title, Start: ago(from), End: ago(to), Category: "code", Source: "GitHub"}
}

func TestActivityEntriesAreValidatedAndNormalized(t *testing.T) {
	kolkata, _ := time.LoadLocation("Asia/Kolkata")
	now := time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC)
	good := ActivityEntry{Title: "  Fixed CI  ", Start: "2026-11-04T09:30", End: "2026-11-04 10:45", Source: " GitHub ", Category: " CODE ", Link: "https://github.com/a/b/pull/1"}
	e, err := cleanActivity(good, kolkata, now)
	if err != nil || e.Title != "Fixed CI" || e.Source != "github" || e.Category != "code" || e.Start != "2026-11-04T04:00:00Z" || e.End != "2026-11-04T05:15:00Z" {
		t.Fatal(e, err)
	}
	if e, err = cleanActivity(ActivityEntry{Title: "Moment", Start: "2026-11-04T09:00:00+05:30", End: "2026-11-04T09:00:00.5+05:30", Link: "mailto:a@b.co"}, kolkata, now); err != nil || e.Category != "other" {
		t.Fatal("a moment with a mail link and no category", e, err)
	}
	for name, edit := range map[string]func(*ActivityEntry){
		"no title":     func(e *ActivityEntry) { e.Title = " " },
		"long title":   func(e *ActivityEntry) { e.Title = strings.Repeat("a", 201) },
		"long summary": func(e *ActivityEntry) { e.Summary = strings.Repeat("a", 4001) },
		"long source":  func(e *ActivityEntry) { e.Source = strings.Repeat("a", 41) },
		"category":     func(e *ActivityEntry) { e.Category = "napping" },
		"link scheme":  func(e *ActivityEntry) { e.Link = "javascript:alert(1)" },
		"link host":    func(e *ActivityEntry) { e.Link = "https://" },
		"link mail":    func(e *ActivityEntry) { e.Link = "mailto:" },
		"link parse":   func(e *ActivityEntry) { e.Link = "https://a b/%zz" },
		"link long":    func(e *ActivityEntry) { e.Link = "https://a.co/" + strings.Repeat("a", 2000) },
		"bad start":    func(e *ActivityEntry) { e.Start = "this morning" },
		"bad end":      func(e *ActivityEntry) { e.End = "" },
		"backwards":    func(e *ActivityEntry) { e.End = "2026-11-04T09:00" },
		"too long":     func(e *ActivityEntry) { e.Start = "2026-11-03T09:00" },
		"future":       func(e *ActivityEntry) { e.End = "2026-11-04T23:00" },
		"ancient":      func(e *ActivityEntry) { e.Start, e.End = "1999-01-01T09:00", "1999-01-01T10:00" },
	} {
		v := good
		edit(&v)
		if _, err := cleanActivity(v, kolkata, now); err == nil {
			t.Fatal(name, "accepted")
		}
	}
}

func TestActivityIsRecordedUpdatedAndProtected(t *testing.T) {
	s := testStore(t)
	task := mustTask(t, s, Task{Title: "Fix staging CI"})
	e, err := s.SaveActivity(ActivityEntry{Title: "Fixed CI", Start: ago(-2 * time.Hour), End: ago(-time.Hour), TaskID: task.ID, SourceKey: "github:pr:1"}, 0, "job:job_1")
	if err != nil || e.ID == "" || e.Revision != 1 || e.Actor != "job:job_1" || e.CreatedAt == "" {
		t.Fatal(e, err)
	}
	// A repeated check with the same source key updates the session.
	again, err := s.SaveActivity(ActivityEntry{Title: "Fixed staging CI", Start: ago(-2 * time.Hour), End: ago(-30 * time.Minute), SourceKey: "github:pr:1"}, 0, "job:job_1")
	if err != nil || again.ID != e.ID || again.Revision != 2 || again.Title != "Fixed staging CI" || again.CreatedAt != e.CreatedAt {
		t.Fatal("source key didn't update", again, err)
	}
	if list := s.TaskActivity(task.ID); len(list) != 0 {
		t.Fatal("unlinked session still linked", list)
	}
	// Updates need the current revision and an existing entry.
	again.TaskID = task.ID
	if _, err = s.SaveActivity(again, 1, "job:job_1"); err == nil {
		t.Fatal("stale revision accepted")
	}
	if _, err = s.SaveActivity(ActivityEntry{ID: "act_missing", Title: "x", Start: ago(-time.Hour), End: ago(-time.Hour)}, 1, "user"); apiStatus(err) != 404 {
		t.Fatal("missing entry", err)
	}
	again.SourceKey = ""
	linked, err := s.SaveActivity(again, 2, "job:job_1")
	if err != nil || linked.SourceKey != "github:pr:1" || linked.Edited {
		t.Fatal("update lost the source key", linked, err)
	}
	if list := s.TaskActivity(task.ID); len(list) != 1 || list[0].ID != e.ID {
		t.Fatal("linked session missing", list)
	}
	// The person's edit wins: agents can no longer change or remove it.
	linked.Title = "Fixed staging CI (with Maya)"
	edited, err := s.SaveActivity(linked, linked.Revision, "user")
	if err != nil || !edited.Edited || edited.Actor != "job:job_1" {
		t.Fatal(edited, err)
	}
	if _, err = s.SaveActivity(ActivityEntry{Title: "Overwrite", Start: ago(-time.Hour), End: ago(-time.Hour), SourceKey: "github:pr:1"}, 0, "job:job_1"); apiStatus(err) != 409 {
		t.Fatal("agent overwrote the person's edit", err)
	}
	if err = s.DeleteActivity(e.ID, edited.Revision, "job:job_1"); apiStatus(err) != 409 {
		t.Fatal("agent deleted the person's edit", err)
	}
	mine, _ := s.SaveActivity(ActivityEntry{Title: "Lunch with the team", Start: ago(-3 * time.Hour), End: ago(-150 * time.Minute)}, 0, "user")
	if mine.Edited || mine.Actor != "user" {
		t.Fatal(mine)
	}
	mine.Title = "Lunch"
	if _, err = s.SaveActivity(mine, mine.Revision, "chat"); apiStatus(err) != 409 {
		t.Fatal("agent changed the person's own session", err)
	}
	// Links must point at a live task.
	for _, id := range []string{"tsk_missing", deletedTask(t, s).ID, mergedTask(t, s).ID} {
		if _, err = s.SaveActivity(ActivityEntry{Title: "x", Start: ago(-time.Hour), End: ago(-time.Hour), TaskID: id}, 0, "user"); err == nil {
			t.Fatal("linked to", id)
		}
	}
	if _, err = s.SaveActivity(ActivityEntry{Title: ""}, 0, "user"); err == nil {
		t.Fatal("invalid entry saved")
	}
	// Deleting needs the revision; the person can delete anything.
	if err = s.DeleteActivity("act_missing", 1, "user"); apiStatus(err) != 404 {
		t.Fatal(err)
	}
	if err = s.DeleteActivity(e.ID, 1, "user"); apiStatus(err) != 409 {
		t.Fatal(err)
	}
	if err = s.DeleteActivity(e.ID, edited.Revision, "user"); err != nil {
		t.Fatal(err)
	}
	agent, _ := s.SaveActivity(session("Agent's own", -time.Hour, -time.Hour/2), 0, "chat")
	if err = s.DeleteActivity(agent.ID, 1, "chat"); err != nil {
		t.Fatal("agent couldn't remove its own session", err)
	}
}

func apiStatus(err error) int {
	if e, ok := err.(*APIError); ok {
		return e.Status
	}
	return 0
}

func deletedTask(t *testing.T, s *Store) Task {
	v := mustTask(t, s, Task{Title: "Gone"})
	v.DeletedAt = now()
	v, err := s.SaveTask(v, v.Revision, "user", "", "")
	if err != nil {
		t.Fatal(err)
	}
	return v
}

func mergedTask(t *testing.T, s *Store) Task {
	a, b := mustTask(t, s, Task{Title: "Source"}), mustTask(t, s, Task{Title: "Survivor"})
	if err := s.Merge(a.ID, b.ID, a.Revision, b.Revision, "user", "Same"); err != nil {
		t.Fatal(err)
	}
	return a
}

func TestActivityRangesAndCheckedWindows(t *testing.T) {
	s := testStore(t)
	day := time.Now().Add(-48 * time.Hour).UTC().Truncate(24 * time.Hour)
	put := func(title string, from, to time.Duration) {
		t.Helper()
		if _, err := s.SaveActivity(ActivityEntry{Title: title, Start: stamp(day.Add(from)), End: stamp(day.Add(to))}, 0, "user"); err != nil {
			t.Fatal(err)
		}
	}
	put("Before", -2*time.Hour, -time.Hour)
	put("Across midnight", -30*time.Minute, 30*time.Minute)
	put("Morning", 9*time.Hour, 10*time.Hour)
	put("Moment at the start", 0, 0)
	put("Moment at the end", 24*time.Hour, 24*time.Hour)
	put("Earlier the same minute", 9*time.Hour, 9*time.Hour+30*time.Minute)
	var titles []string
	for _, e := range s.Activity(day, day.Add(24*time.Hour)) {
		titles = append(titles, e.Title)
	}
	if strings.Join(titles, "|") != "Across midnight|Moment at the start|Earlier the same minute|Morning" {
		t.Fatal(titles)
	}
	// Checked windows: overlapping, touching and slivers.
	check := func(from, to time.Duration) ActivityCheck {
		return ActivityCheck{From: stamp(day.Add(from)), To: stamp(day.Add(to))}
	}
	got := uncovered(day, day.Add(24*time.Hour), []ActivityCheck{
		check(9*time.Hour, 12*time.Hour), check(-time.Hour, 2*time.Hour), check(11*time.Hour, 13*time.Hour),
		check(13*time.Hour+30*time.Second, 18*time.Hour), {From: "bad", To: "bad"}, check(25*time.Hour, 26*time.Hour), check(5*time.Hour, 5*time.Hour),
	})
	want := []ActivityWindow{{stamp(day.Add(2 * time.Hour)), stamp(day.Add(9 * time.Hour))}, {stamp(day.Add(18 * time.Hour)), stamp(day.Add(24 * time.Hour))}}
	if string(encode(got)) != string(encode(want)) {
		t.Fatal(got)
	}
	if got = uncovered(day, day.Add(time.Hour), []ActivityCheck{check(0, 2*time.Hour)}); len(got) != 0 {
		t.Fatal("covered hour left a gap", got)
	}
	if err := s.addChecks([]ActivityWindow{{stamp(day), stamp(day.Add(time.Hour))}}, "run_1"); err != nil {
		t.Fatal(err)
	}
	if c := s.ActivityChecks(day.Add(-time.Hour), day.Add(2*time.Hour)); len(c) != 1 || c[0].RunID != "run_1" {
		t.Fatal(c)
	}
	// Automatic checks start when tracking started, at most a week back.
	nowAt := time.Now()
	recent := Job{Since: stamp(nowAt.Add(-3 * time.Hour))}
	if gaps := s.trackerGaps(recent, nowAt); len(gaps) != 1 || gaps[0].From != recent.Since {
		t.Fatal(gaps)
	}
	if start := trackerStart(Job{Since: "2020-01-01T00:00:00Z"}, nowAt); start != nowAt.Add(-activityLookback) {
		t.Fatal("lookback not applied", start)
	}
	if start := trackerStart(Job{}, nowAt); start != nowAt.Add(-activityLookback) {
		t.Fatal("no start date", start)
	}
	if gaps := s.trackerGaps(Job{Since: stamp(nowAt.Add(time.Hour))}, nowAt); len(gaps) != 0 {
		t.Fatal("future start has gaps", gaps)
	}
}

func TestTrackerSetupAndJobRules(t *testing.T) {
	s := testService(t)
	daily := []JobSchedule{{Type: "daily", Schedule: "12:30"}, {Type: "daily", Schedule: "17:30"}, {Type: "daily", Schedule: "22:00"}}
	j, err := s.SaveTracker(TrackerInput{Schedules: daily, Timezone: "Asia/Kolkata", Enabled: true, Backfill: true})
	if err != nil {
		t.Fatal(err)
	}
	kolkata, _ := time.LoadLocation("Asia/Kolkata")
	since, _ := time.Parse(time.RFC3339, j.Since)
	if j.Kind != trackerKind || j.Name != trackerName || j.Prompt != DefaultActivityPrompt || len(j.Schedules) != 3 || since.In(kolkata).Format("15:04") != "00:00" || time.Since(since) > 24*time.Hour {
		t.Fatal(j)
	}
	if got, ok := s.Store.Tracker(); !ok || got.ID != j.ID {
		t.Fatal("tracker not found")
	}
	// Changing it keeps when tracking started, and needs the revision.
	j2, err := s.SaveTracker(TrackerInput{Prompt: "Only GitHub", Schedules: daily[:1], Revision: j.Revision})
	if err != nil || j2.Prompt != "Only GitHub" || j2.Since != j.Since || j2.Timezone != "Asia/Kolkata" || j2.Enabled {
		t.Fatal(j2, err)
	}
	if _, err = s.SaveTracker(TrackerInput{Schedules: daily, Revision: j.Revision}); apiStatus(err) != 409 {
		t.Fatal("stale tracker saved", err)
	}
	// Ordinary job saves can't make or retarget a tracker, and agents can't change it.
	other, err := s.SaveJob(Job{Name: "Other", Prompt: "x", Kind: trackerKind, Since: "2020-01-01T00:00:00Z", Schedules: daily[:1], Timezone: "UTC"}, 0, "user")
	if err != nil || other.Kind != "" || other.Since != "" {
		t.Fatal("job save set kind", other, err)
	}
	j2.Prompt = "Read everything"
	if _, err = s.SaveJob(j2, j2.Revision, "local-agent"); apiStatus(err) != 403 {
		t.Fatal("agent changed the tracker", err)
	}
	j2.Name = "Renamed"
	if saved, err := s.SaveJob(j2, j2.Revision, "user"); err != nil || saved.Kind != trackerKind || saved.Since != j.Since {
		t.Fatal("person's job save lost tracking", saved, err)
	}
	if _, err = s.saveJob(Job{Name: "Second", Prompt: "x", Kind: trackerKind, Schedules: daily[:1], Timezone: "UTC"}, 0, "user", true); apiStatus(err) != 409 {
		t.Fatal("second tracker", err)
	}

	// Without backfill, tracking starts now; an invalid timezone falls back to the workspace's.
	s2 := testService(t)
	fresh, err := s2.SaveTracker(TrackerInput{Schedules: daily, Timezone: "Mars/Olympus"})
	if err == nil {
		t.Fatal("invalid timezone saved", fresh)
	}
	fresh, err = s2.SaveTracker(TrackerInput{Schedules: daily})
	since, _ = time.Parse(time.RFC3339, fresh.Since)
	if err != nil || time.Since(since) > time.Minute {
		t.Fatal(fresh, err)
	}
}

func TestTrackerChecksCoverTheMissingWindows(t *testing.T) {
	fixturePi(t)
	record := filepath.Join(t.TempDir(), "prompt.json")
	t.Setenv("PI_FIXTURE_PROMPT_RECORD", record)
	s := testService(t)
	if _, err := s.CheckActivity(nil); apiStatus(err) != 404 {
		t.Fatal("check without a tracker", err)
	}
	j, err := s.SaveTracker(TrackerInput{Prompt: "scenario:failed", Schedules: []JobSchedule{{Type: "daily", Schedule: "12:30"}}, Timezone: "UTC", Provider: "fixture", Model: "fixture-model", Backfill: true})
	if err != nil {
		t.Fatal(err)
	}
	// A failed check leaves its window to the next one.
	r, err := s.CheckActivity(nil)
	if err != nil || len(r.Windows) != 1 || r.Windows[0].From != j.Since {
		t.Fatal(r, err)
	}
	awaitRun(t, s, r.ID, "failed")
	waitIdle(t, s)
	if gaps := s.Store.trackerGaps(j, time.Now()); len(gaps) != 1 || gaps[0].From != j.Since {
		t.Fatal("failed check covered time", gaps)
	}
	b, _ := os.ReadFile(record)
	var prompt struct{ Message string }
	json.Unmarshal(b, &prompt)
	for _, want := range []string{"activity tracker", r.Windows[0].From, r.Windows[0].To, "activity add --start TIME", "--actor \"job:" + j.ID, "Sift marks these windows checked", "What to look at, in the person's words:\n\nscenario:failed"} {
		if !strings.Contains(prompt.Message, want) {
			t.Fatal("guide missing", want, prompt.Message)
		}
	}
	// A successful check covers its window, so the next one has nothing to do.
	j, _ = s.Store.Tracker()
	j, err = s.SaveTracker(TrackerInput{Prompt: "scenario:success", Schedules: j.Schedules, Provider: "fixture", Model: "fixture-model", Revision: j.Revision})
	if err != nil {
		t.Fatal(err)
	}
	r, err = s.CheckActivity(nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.CheckActivity(nil); apiStatus(err) != 409 {
		t.Fatal("second check while busy", err)
	}
	awaitRun(t, s, r.ID, "succeeded")
	waitIdle(t, s)
	if c := s.Store.ActivityChecks(time.Now().Add(-48*time.Hour), time.Now().Add(time.Hour)); len(c) != 1 || c[0].RunID != r.ID || c[0].To != r.Windows[0].To {
		t.Fatal("check not recorded", c)
	}
	// With nothing new, a run is skipped and the schedule moves on.
	j, _ = s.Store.Tracker()
	j.NextRun = "2000-01-01T00:00:00Z"
	s.Store.Put("job", j.ID, j, "system", "Due")
	s.runMu.Lock()
	_, err = s.startRunLocked(j, nil)
	s.runMu.Unlock()
	j, _ = s.Store.Tracker()
	if apiStatus(err) != 409 || j.NextRun == "2000-01-01T00:00:00Z" || j.Pending {
		t.Fatal("empty check ran", err, j)
	}

	// An explicit window checks an older stretch, minus what's covered.
	day := time.Now().Add(-10 * 24 * time.Hour).UTC().Truncate(24 * time.Hour)
	for _, bad := range []*ActivityWindow{{From: "x", To: "y"}, {From: stamp(day), To: stamp(day)}, {From: stamp(day), To: stamp(day.Add(9 * 24 * time.Hour))}} {
		if _, err = s.CheckActivity(bad); apiStatus(err) != 400 {
			t.Fatal("bad window", bad, err)
		}
	}
	s.Store.addChecks([]ActivityWindow{{stamp(day), stamp(day.Add(12 * time.Hour))}}, "run_old")
	r, err = s.CheckActivity(&ActivityWindow{From: stamp(day), To: stamp(day.Add(24 * time.Hour))})
	if err != nil || len(r.Windows) != 1 || r.Windows[0].From != stamp(day.Add(12*time.Hour)) {
		t.Fatal(r, err)
	}
	awaitRun(t, s, r.ID, "succeeded")
	waitIdle(t, s)
	if _, err = s.CheckActivity(&ActivityWindow{From: stamp(day), To: stamp(day.Add(24 * time.Hour))}); apiStatus(err) != 409 {
		t.Fatal("checked day again", err)
	}
	// The end of a window never passes now.
	r, err = s.CheckActivity(&ActivityWindow{From: stamp(time.Now().Add(-2 * time.Hour)), To: stamp(time.Now().Add(5 * time.Hour))})
	if err == nil {
		to, _ := time.Parse(time.RFC3339, r.Windows[len(r.Windows)-1].To)
		if to.After(time.Now()) {
			t.Fatal("window ends in the future", r.Windows)
		}
		awaitRun(t, s, r.ID, "succeeded")
		waitIdle(t, s)
	} else if apiStatus(err) != 409 {
		t.Fatal(err)
	}
	// Maintenance and a full concurrency limit refuse a manual check.
	waitIdle(t, s)
	s.runMu.Lock()
	s.maintenance = true
	s.runMu.Unlock()
	if _, err = s.CheckActivity(&ActivityWindow{From: stamp(day.Add(-24 * time.Hour)), To: stamp(day)}); apiStatus(err) != 409 {
		t.Fatal("maintenance", err)
	}
	s.runMu.Lock()
	s.maintenance = false
	s.active["job_other"] = func() {}
	s.runMu.Unlock()
	var cfg Settings
	s.Store.Get("settings", "app", &cfg)
	cfg.Concurrency = 1
	s.Store.Put("settings", "app", cfg, "user", "One slot")
	if _, err = s.CheckActivity(&ActivityWindow{From: stamp(day.Add(-24 * time.Hour)), To: stamp(day)}); err == nil || !strings.Contains(err.Error(), "run slot") {
		t.Fatal("concurrency", err)
	}
	s.runMu.Lock()
	delete(s.active, "job_other")
	s.runMu.Unlock()
}

func TestTrackerCheckThatCannotRecordItsWindowFails(t *testing.T) {
	fixturePi(t)
	s := testService(t)
	if _, err := s.SaveTracker(TrackerInput{Prompt: "scenario:success", Schedules: []JobSchedule{{Type: "daily", Schedule: "12:30"}}, Timezone: "UTC", Provider: "fixture", Model: "fixture-model", Backfill: true}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Store.DB.Exec(`CREATE TRIGGER refuse_checks BEFORE INSERT ON objects WHEN NEW.kind='activity-check' BEGIN SELECT RAISE(ABORT,'disk full'); END`); err != nil {
		t.Fatal(err)
	}
	r, err := s.CheckActivity(nil)
	if err != nil {
		t.Fatal(err)
	}
	if out := awaitRun(t, s, r.ID, "failed"); !strings.Contains(out.Error, "Couldn't record the checked time") {
		t.Fatal(out)
	}
	if err = s.Store.addChecks([]ActivityWindow{{From: "a", To: "b"}}, "run"); err == nil {
		t.Fatal("refused insert succeeded")
	}
}

func TestWindowLabelsAndGuideUseTheTrackersTimezone(t *testing.T) {
	kolkata, _ := time.LoadLocation("Asia/Kolkata")
	same := windowLabel(ActivityWindow{From: "2026-11-04T07:00:00Z", To: "2026-11-04T12:00:00Z"}, kolkata)
	across := windowLabel(ActivityWindow{From: "2026-11-04T07:00:00Z", To: "2026-11-04T20:00:00Z"}, kolkata)
	if same != "- Wed 4 Nov 12:30 – 17:30 (from 2026-11-04T07:00:00Z to 2026-11-04T12:00:00Z)" || !strings.Contains(across, "– Thu 5 Nov 01:30") {
		t.Fatal(same, across)
	}
	guide := trackerGuide(Job{ID: "job_1", Timezone: "Nowhere/Else"}, Run{Windows: []ActivityWindow{{From: "2026-11-04T07:00:00Z", To: "2026-11-04T12:00:00Z"}}}, "/bin/sift", "/data")
	if !strings.Contains(guide, "their timezone is UTC") || !strings.Contains(guide, `"/bin/sift" --data "/data" activity list --from 2026-11-04T07:00:00Z --to 2026-11-04T12:00:00Z`) {
		t.Fatal(guide)
	}
}

func TestActivityAPI(t *testing.T) {
	s := testService(t)
	h := s.routes()
	task := mustTask(t, s.Store, Task{Title: "Fix staging CI"})
	var page activityPage
	json.Unmarshal(routeRequest(t, h, "GET", "/api/activity", nil, 200, false), &page)
	if page.Tracker != nil || page.DefaultPrompt != DefaultActivityPrompt || len(page.DefaultTimes) != 3 || len(page.Categories) != 8 || page.LookbackDays != 7 || page.Entries == nil {
		t.Fatal(page)
	}
	for _, q := range []string{"?from=nope", "?from=2026-11-05&to=2026-11-04", "?from=2026-01-01&to=2026-06-01"} {
		routeRequest(t, h, "GET", "/api/activity"+q, nil, 400, false)
	}
	// Agents record sessions; the person can't be impersonated.
	var e ActivityEntry
	json.Unmarshal(routeRequest(t, h, "POST", "/api/activity", map[string]any{"entry": session("Reviewed PR", -2*time.Hour, -time.Hour)}, 200, true), &e)
	if e.Actor != "local-agent" || e.Source != "github" {
		t.Fatal(e)
	}
	routeRequest(t, h, "POST", "/api/activity", map[string]any{"entry": ActivityEntry{Title: ""}}, 400, true)
	routeRequest(t, h, "POST", "/api/activity", "{", 400, true)
	var one ActivityEntry
	json.Unmarshal(routeRequest(t, h, "GET", "/api/activity/"+e.ID, nil, 200, false), &one)
	if one.ID != e.ID {
		t.Fatal(one)
	}
	routeRequest(t, h, "GET", "/api/activity/act_missing", nil, 404, false)
	e.TaskID = task.ID
	json.Unmarshal(routeRequest(t, h, "PUT", "/api/activity/"+e.ID, map[string]any{"entry": e, "expectedRevision": 1}, 200, false), &e)
	if e.TaskID != task.ID || !e.Edited {
		t.Fatal(e)
	}
	day := time.Now().In(s.Store.workspaceZone()).Format("2006-01-02")
	json.Unmarshal(routeRequest(t, h, "GET", "/api/activity?from="+day+"&to="+day, nil, 200, false), &page)
	if len(page.Entries) != 1 {
		t.Fatal(page.Entries)
	}
	json.Unmarshal(routeRequest(t, h, "GET", "/api/activity?from="+url.QueryEscape(ago(-3*time.Hour))+"&to="+strings.ReplaceAll(ago(-90*time.Minute), "+", "%20"), nil, 200, false), &page)
	if len(page.Entries) != 1 {
		t.Fatal("instants", page.Entries)
	}
	json.Unmarshal(routeRequest(t, h, "GET", "/api/activity?task="+task.ID, nil, 200, false), &page)
	if len(page.Entries) != 1 || page.Entries[0].ID != e.ID {
		t.Fatal(page.Entries)
	}
	routeRequest(t, h, "DELETE", "/api/activity/"+e.ID, nil, 400, false)
	routeRequest(t, h, "DELETE", "/api/activity/"+e.ID+"?revision=2", nil, 409, true)
	routeRequest(t, h, "DELETE", "/api/activity/"+e.ID+"?revision=2", nil, 200, false)

	// Only the person sets up tracking; checks report what's wrong.
	daily := []JobSchedule{{Type: "daily", Schedule: "12:30"}}
	routeRequest(t, h, "PUT", "/api/activity/tracker", TrackerInput{Schedules: daily}, 403, true)
	routeRequest(t, h, "PUT", "/api/activity/tracker", "{", 400, false)
	routeRequest(t, h, "PUT", "/api/activity/tracker", TrackerInput{}, 400, false)
	routeRequest(t, h, "POST", "/api/activity/check", map[string]string{}, 404, false)
	var tracker Job
	json.Unmarshal(routeRequest(t, h, "PUT", "/api/activity/tracker", TrackerInput{Schedules: daily, Timezone: "UTC"}, 200, false), &tracker)
	if tracker.Kind != trackerKind {
		t.Fatal(tracker)
	}
	json.Unmarshal(routeRequest(t, h, "GET", "/api/activity", nil, 200, false), &page)
	if page.Tracker == nil || page.Tracker.ID != tracker.ID {
		t.Fatal(page.Tracker)
	}
	routeRequest(t, h, "POST", "/api/activity/check", "{", 400, false)
	routeRequest(t, h, "POST", "/api/activity/check", map[string]string{"from": "x"}, 400, false)
	s.runMu.Lock()
	s.maintenance = true
	s.runMu.Unlock()
	routeRequest(t, h, "POST", "/api/activity/check", map[string]string{}, 409, false)
}

func TestActivityCLI(t *testing.T) {
	s := testService(t)
	server := httptest.NewServer(s.routes())
	defer server.Close()
	dir := cliFixtureConnection(t, server.URL)
	cli := func(args ...string) (string, error) {
		var out bytes.Buffer
		err := CLI(context.Background(), append([]string{"--data", dir, "--progress", "never", "--actor", "job:job_1"}, args...), &out)
		return out.String(), err
	}
	task := mustTask(t, s.Store, Task{Title: "Fix staging CI"})
	out, err := cli("activity", "add", "--start", ago(-2*time.Hour), "--end", ago(-time.Hour), "--title", "Fixed CI", "--summary", "PR #412", "--category", "code", "--source", "github", "--link", "https://github.com/a/b/pull/412", "--task", task.ID, "--source-key", "github:412")
	var e ActivityEntry
	if err != nil || json.Unmarshal([]byte(out), &e) != nil || e.TaskID != task.ID || e.Actor != "job:job_1" {
		t.Fatal(out, err)
	}
	if out, err = cli("activity", "update", e.ID, "--revision", "1", "--title", "Fixed staging CI", "--task", ""); err != nil || !strings.Contains(out, `"title": "Fixed staging CI"`) || !strings.Contains(out, `"taskId": ""`) {
		t.Fatal(out, err)
	}
	if out, err = cli("activity", "list", "--from", ago(-3*time.Hour), "--to", ago(0)); err != nil || !strings.Contains(out, "Fixed staging CI") {
		t.Fatal(out, err)
	}
	if out, err = cli("activity"); err != nil || !strings.Contains(out, `"entries"`) {
		t.Fatal(out, err)
	}
	if out, err = cli("activity", "list", "--task", task.ID); err != nil || strings.Contains(out, "Fixed staging CI") {
		t.Fatal("unlinked session listed for the task", out, err)
	}
	if _, err = cli("activity", "check"); err == nil || !strings.Contains(err.Error(), "Set up activity tracking") {
		t.Fatal(err)
	}
	if _, err = cli("activity", "delete", e.ID, "--revision", "2"); err != nil {
		t.Fatal(err)
	}
	for _, bad := range [][]string{{"activity", "nap"}, {"activity", "update"}, {"activity", "delete", e.ID}, {"activity", "update", e.ID, "--revision", "x"}, {"activity", "update", "act_missing", "--revision", "1"}} {
		if _, err = cli(bad...); err == nil {
			t.Fatal("accepted", bad)
		}
	}
}

func TestBackupsCarryActivityAndOlderBackupsRestore(t *testing.T) {
	s := testService(t)
	e, err := s.Store.SaveActivity(session("Fixed CI", -2*time.Hour, -time.Hour), 0, "user")
	if err != nil {
		t.Fatal(err)
	}
	s.Store.addChecks([]ActivityWindow{{stamp(time.Now().Add(-3 * time.Hour)), stamp(time.Now())}}, "run_1")
	snapshot := s.Store.SnapshotUnlocked()
	if n := len(snapshot["activitys"].([]json.RawMessage)); n != 1 {
		t.Fatal("backup lacks activity", n)
	}
	data := map[string][]json.RawMessage{}
	for _, k := range backupKinds {
		data[k] = s.Store.ListRaw(k)
	}
	if err = validateWorkspace(data); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{`{"id":"act_1","title":"","revision":1}`, `{"id":"act_1","title":"x","revision":0}`, `{"id":"act_1","title":"x","revision":1,"start":"b","end":"a"}`, `{"id":"act_1","title":5}`} {
		data[activityKind] = []json.RawMessage{json.RawMessage(bad)}
		if err = validateWorkspace(data); err == nil {
			t.Fatal("accepted", bad)
		}
	}
	// A backup from before activity existed has no activity records at all.
	files := backupFiles(t, s)
	var workspace map[string]json.RawMessage
	json.Unmarshal(files["workspace.json"], &workspace)
	delete(workspace, "activitys")
	delete(workspace, "activity-checks")
	files["workspace.json"] = encode(workspace)
	if err = s.RestoreArchive(context.Background(), indexedArchive(t, files)); err != nil {
		t.Fatal("older backup refused", err)
	}
	if s.Store.Get(activityKind, e.ID, &ActivityEntry{}) {
		t.Fatal("restored workspace kept activity the backup didn't have")
	}
}

// waitIdle waits for finished runs to leave the active set.
func waitIdle(t *testing.T, s *Service) {
	t.Helper()
	for i := 0; i < 500; i++ {
		s.runMu.Lock()
		n := len(s.active)
		s.runMu.Unlock()
		if n == 0 {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("runs still active")
}
