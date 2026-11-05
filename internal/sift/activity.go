package sift

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"slices"
	"sort"
	"strings"
	"time"
)

// My activity is a timeline of the person's own work. A scheduled Pi check,
// the activity tracker, looks through the tools they already use and records
// work sessions. Sift remembers which stretches of time each successful check
// covered, so the next check starts exactly where the last one ended, and a
// missed or failed check is picked up by the one after it.

const (
	activityKind      = "activity"
	activityCheckKind = "activity-check"
	// trackerKind is the Kind of the one job that records activity.
	trackerKind = "activity"
	trackerName = "My activity"
	// activityLookback bounds how far back an automatic check reaches when
	// Sift was off or checks failed. Older days can be checked on request.
	activityLookback = 7 * 24 * time.Hour
	// minActivityWindow ignores slivers between back-to-back checks.
	minActivityWindow = time.Minute
	maxActivityRange  = 62 * 24 * time.Hour
	activityTime      = "2006-01-02T15:04:05Z"
)

// ActivityCategories are the kinds of work a session can be, in display order.
var ActivityCategories = []string{"code", "review", "meeting", "message", "admin", "research", "writing", "other"}

// DefaultTrackerTimes are the three daily checks offered at setup.
var DefaultTrackerTimes = []string{"12:30", "17:30", "22:00"}

// DefaultActivityPrompt is what the tracker looks at unless the person
// changes it. Sift adds the time windows and recording rules around it.
const DefaultActivityPrompt = `Find out what I worked on, using whatever this computer can reach. Good places to look:

- Code: commits and branches in my git repositories, and pull requests, reviews, issues and comments wherever my code is hosted.
- Conversations: chat messages I sent and threads I replied in; email I sent or answered.
- Meetings: calendar events I attended.
- Everything else: documents I edited, my shell history, and Sift tasks I created, changed or completed.

Use whatever tools you have for each of these: command-line tools, your own skills and extensions, or files on disk. Check what's available before deciding a source is out of reach, and skip it only when nothing reaches it, rather than guessing. Only record what I did myself; something others sent me counts only if I replied or acted on it.`

// ActivityEntry is one work session: what the person did, when, and where
// the evidence is. TaskID links it to the task it moved forward.
type ActivityEntry struct {
	ID       string `json:"id"`
	Start    string `json:"start"`
	End      string `json:"end"`
	Title    string `json:"title"`
	Summary  string `json:"summary"`
	Category string `json:"category"`
	// Source names where the evidence came from: github, git, slack, email,
	// calendar, browser, shell, docs, sift, or another short name.
	Source    string `json:"source"`
	Link      string `json:"link"`
	TaskID    string `json:"taskId"`
	SourceKey string `json:"sourceKey"`
	// Actor recorded the entry. Edited is set once the person changes it;
	// agents leave entries the person recorded or edited alone.
	Actor     string `json:"actor"`
	Edited    bool   `json:"edited,omitempty"`
	CreatedAt string `json:"createdAt"`
	UpdatedAt string `json:"updatedAt"`
	Revision  int    `json:"revision"`
}

// ActivityWindow is a stretch of time, as UTC instants.
type ActivityWindow struct {
	From string `json:"from"`
	To   string `json:"to"`
}

// ActivityCheck records a window a check finished looking through.
type ActivityCheck struct {
	ID    string `json:"id"`
	From  string `json:"from"`
	To    string `json:"to"`
	RunID string `json:"runId"`
	At    string `json:"at"`
}

// stamp writes an instant the way activity is stored: UTC to the second, so
// stored times compare correctly as text.
func stamp(t time.Time) string { return t.UTC().Truncate(time.Second).Format(activityTime) }

// parseWhen reads an instant: RFC 3339 with an offset, or a local date-time
// such as 2026-11-04T09:30 or "2026-11-04 09:30" in the given timezone.
func parseWhen(v string, loc *time.Location) (time.Time, bool) {
	v = trim(v)
	if t, err := time.Parse(time.RFC3339Nano, v); err == nil {
		return t, true
	}
	for _, layout := range []string{"2006-01-02T15:04", "2006-01-02 15:04", "2006-01-02T15:04:05", "2006-01-02 15:04:05"} {
		if t, err := time.ParseInLocation(layout, v, loc); err == nil {
			return t, true
		}
	}
	return time.Time{}, false
}

// workspaceZone is the person's timezone from settings.
func (s *Store) workspaceZone() *time.Location {
	var cfg Settings
	s.Get("settings", "app", &cfg)
	if loc, err := time.LoadLocation(cfg.Timezone); err == nil {
		return loc
	}
	return time.UTC
}

// overlaps reports whether an entry or window [start, end] falls in [from, to).
// A moment (start equal to end) belongs to the window it starts in.
func overlaps(start, end, from, to string) bool {
	return start < to && (end > from || (start == end && start >= from))
}

// Activity lists entries overlapping [from, to), earliest first.
func (s *Store) Activity(from, to time.Time) []ActivityEntry {
	f, t := stamp(from), stamp(to)
	return s.activityWhere("json_extract(data,'$.start') < ? AND json_extract(data,'$.end') >= ?", []any{t, f}, func(e ActivityEntry) bool { return overlaps(e.Start, e.End, f, t) })
}

// TaskActivity lists the entries linked to a task, earliest first, with those
// on tasks merged into it (at any depth). Each keeps its own task link, so
// undoing a merge gives the sessions back to the task they were recorded on.
func (s *Store) TaskActivity(taskID string) []ActivityEntry {
	return s.activityWhere(`json_extract(data,'$.taskId') IN (
		WITH RECURSIVE merged(id) AS (
			SELECT ?
			UNION SELECT t.id FROM objects t JOIN merged m ON t.kind='task' AND json_extract(t.data,'$.mergedInto') = m.id
		) SELECT id FROM merged)`, []any{taskID}, func(ActivityEntry) bool { return true })
}

func (s *Store) activityWhere(where string, args []any, keep func(ActivityEntry) bool) []ActivityEntry {
	out := []ActivityEntry{}
	rows, err := s.DB.Query("SELECT data FROM objects WHERE kind='"+activityKind+"' AND "+where, args...)
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var b []byte
		var e ActivityEntry
		if rows.Scan(&b) == nil && json.Unmarshal(b, &e) == nil && keep(e) {
			out = append(out, e)
		}
	}
	sortActivity(out)
	return out
}

func sortActivity(list []ActivityEntry) {
	sort.SliceStable(list, func(i, j int) bool {
		if list[i].Start != list[j].Start {
			return list[i].Start < list[j].Start
		}
		return list[i].End < list[j].End
	})
}

// ActivityChecks lists checked windows overlapping [from, to), earliest first.
func (s *Store) ActivityChecks(from, to time.Time) []ActivityCheck {
	f, t := stamp(from), stamp(to)
	out := []ActivityCheck{}
	for _, c := range listAs[ActivityCheck](s, activityCheckKind) {
		if overlaps(c.From, c.To, f, t) {
			out = append(out, c)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].From < out[j].From })
	return out
}

// addChecks records the windows a successful check looked through.
func (s *Store) addChecks(windows []ActivityWindow, runID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, w := range windows {
		c := ActivityCheck{ID: newID("chk_"), From: w.From, To: w.To, RunID: runID, At: now()}
		if err = putTx(tx, activityCheckKind, c.ID, c, "system", "Checked activity", ""); err != nil {
			return err
		}
	}
	if err = tx.Commit(); err == nil {
		s.signal()
	}
	return err
}

// uncovered returns the parts of [from, to) no check has looked through,
// ignoring slivers shorter than minActivityWindow.
func uncovered(from, to time.Time, checks []ActivityCheck) []ActivityWindow {
	type span struct{ from, to time.Time }
	covered := []span{}
	for _, c := range checks {
		f, e1 := time.Parse(time.RFC3339, c.From)
		t, e2 := time.Parse(time.RFC3339, c.To)
		if e1 == nil && e2 == nil && t.After(f) {
			covered = append(covered, span{f, t})
		}
	}
	sort.Slice(covered, func(i, j int) bool { return covered[i].from.Before(covered[j].from) })
	out := []ActivityWindow{}
	add := func(f, t time.Time) {
		if t.Sub(f) >= minActivityWindow {
			out = append(out, ActivityWindow{From: stamp(f), To: stamp(t)})
		}
	}
	cursor := from
	for _, c := range covered {
		if !c.to.After(cursor) {
			continue
		}
		if !c.from.Before(to) {
			break
		}
		if c.from.After(cursor) {
			add(cursor, c.from)
		}
		cursor = c.to
	}
	if to.After(cursor) {
		add(cursor, to)
	}
	return out
}

// trackerStart is where automatic checks begin: when tracking started, but
// no further back than the lookback.
func trackerStart(j Job, at time.Time) time.Time {
	start := at.Add(-activityLookback)
	if since, err := time.Parse(time.RFC3339, j.Since); err == nil && since.After(start) {
		start = since
	}
	return start
}

// trackerGaps lists what the tracker hasn't checked between trackerStart and at.
func (s *Store) trackerGaps(j Job, at time.Time) []ActivityWindow {
	from := trackerStart(j, at)
	if !at.After(from) {
		return []ActivityWindow{}
	}
	return uncovered(from, at, s.ActivityChecks(from, at))
}

// Tracker returns the activity tracker, if the person has set one up.
func (s *Store) Tracker() (Job, bool) {
	for _, j := range listAs[Job](s, "job") {
		if j.Kind == trackerKind {
			return j, true
		}
	}
	return Job{}, false
}

func validLink(v string) bool {
	if v == "" {
		return true
	}
	u, err := url.Parse(v)
	if err != nil || len(v) > 2000 {
		return false
	}
	return ((u.Scheme == "http" || u.Scheme == "https") && u.Host != "") || (u.Scheme == "mailto" && u.Opaque != "")
}

// cleanActivity trims an entry and checks it can be stored. Times become UTC.
func cleanActivity(e ActivityEntry, loc *time.Location, at time.Time) (ActivityEntry, error) {
	e.Title, e.Summary, e.Link, e.TaskID, e.SourceKey = trim(e.Title), trim(e.Summary), trim(e.Link), trim(e.TaskID), trim(e.SourceKey)
	e.Source, e.Category = strings.ToLower(trim(e.Source)), strings.ToLower(trim(e.Category))
	if e.Category == "" {
		e.Category = "other"
	}
	if e.Title == "" || len(e.Title) > 200 {
		return e, invalid("Activity title must contain 1–200 characters")
	}
	if len(e.Summary) > 4000 || len(e.Source) > 40 || len(e.SourceKey) > 300 {
		return e, invalid("Activity summary, source, or source key is too long")
	}
	if !slices.Contains(ActivityCategories, e.Category) {
		return e, invalid("Category must be one of: %s", strings.Join(ActivityCategories, ", "))
	}
	if !validLink(e.Link) {
		return e, invalid("Link must be an http(s) or mailto address")
	}
	start, ok1 := parseWhen(e.Start, loc)
	end, ok2 := parseWhen(e.End, loc)
	if !ok1 || !ok2 {
		return e, invalid("Start and end must be times such as 2026-11-04T09:30:00+05:30")
	}
	switch {
	case end.Before(start):
		return e, invalid("An activity can't end before it starts")
	case end.Sub(start) > 24*time.Hour:
		return e, invalid("An activity can last at most 24 hours; split longer work into sessions")
	case end.After(at.Add(10 * time.Minute)):
		return e, invalid("An activity can't end in the future")
	case start.Year() < 2000:
		return e, invalid("Activity start is too far in the past")
	}
	e.Start, e.End = stamp(start), stamp(end)
	return e, nil
}

// SaveActivity records or changes an entry. A new entry whose source key
// matches an existing one updates it instead, so a repeated check doesn't
// duplicate work. Agents can't change what the person recorded or edited.
func (s *Store) SaveActivity(in ActivityEntry, expected int, actor string) (ActivityEntry, error) {
	e, err := cleanActivity(in, s.workspaceZone(), time.Now())
	if err != nil {
		return e, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.DB.Begin()
	if err != nil {
		return e, err
	}
	defer tx.Rollback()
	var old ActivityEntry
	exists := false
	if e.ID != "" {
		if json.Unmarshal(rawTx(tx, activityKind, e.ID), &old) != nil {
			return e, &APIError{Status: 404, Message: "Activity not found"}
		}
		if old.Revision != expected {
			return e, conflict("This activity changed; read it again before saving")
		}
		exists = true
	} else if e.SourceKey != "" {
		var b []byte
		if tx.QueryRow("SELECT data FROM objects WHERE kind='"+activityKind+"' AND json_extract(data,'$.sourceKey')=? LIMIT 1", e.SourceKey).Scan(&b) == nil && json.Unmarshal(b, &old) == nil {
			exists = true
		}
	}
	if exists && actor != "user" && (old.Actor == "user" || old.Edited) {
		return old, conflict("The person recorded or edited this activity; leave it as it is")
	}
	// A new link must be to a live task. A session can keep the link it has
	// when that task was merged or deleted since, so it can still be edited.
	if e.TaskID != "" && (!exists || e.TaskID != old.TaskID) {
		var t Task
		if json.Unmarshal(rawTx(tx, "task", e.TaskID), &t) != nil || t.DeletedAt != "" || t.MergedInto != "" {
			return e, invalid("Linked task not found")
		}
	}
	at := now()
	e.UpdatedAt = at
	if exists {
		e.ID, e.CreatedAt, e.Actor, e.Revision = old.ID, old.CreatedAt, old.Actor, old.Revision+1
		e.Edited = old.Edited || (actor == "user" && old.Actor != "user")
		if e.SourceKey == "" {
			e.SourceKey = old.SourceKey
		}
	} else {
		e.ID, e.CreatedAt, e.Actor, e.Revision, e.Edited = newID("act_"), at, actor, 1, false
	}
	reason := "Recorded activity"
	if exists {
		reason = "Updated activity"
	}
	if err = putTx(tx, activityKind, e.ID, e, actor, reason, ""); err != nil {
		return e, err
	}
	if err = tx.Commit(); err == nil {
		s.signal()
	}
	return e, err
}

// DeleteActivity removes an entry. Agents can't remove what the person
// recorded or edited.
func (s *Store) DeleteActivity(id string, expected int, actor string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var old ActivityEntry
	if json.Unmarshal(rawTx(tx, activityKind, id), &old) != nil {
		return &APIError{Status: 404, Message: "Activity not found"}
	}
	if old.Revision != expected {
		return conflict("This activity changed; read it again before deleting")
	}
	if actor != "user" && (old.Actor == "user" || old.Edited) {
		return conflict("The person recorded or edited this activity; leave it as it is")
	}
	if err = putTx(tx, activityKind, id, nil, actor, "Deleted activity", ""); err != nil {
		return err
	}
	if err = tx.Commit(); err == nil {
		s.signal()
	}
	return err
}

// TrackerInput is what the person chooses when setting up the tracker.
type TrackerInput struct {
	Prompt    string        `json:"prompt"`
	Schedules []JobSchedule `json:"schedules"`
	Provider  string        `json:"provider"`
	Model     string        `json:"model"`
	Thinking  string        `json:"thinking"`
	Timezone  string        `json:"timezone"`
	Enabled   bool          `json:"enabled"`
	// Backfill, when the tracker is first set up, starts tracking at the
	// beginning of today instead of now.
	Backfill bool `json:"backfill"`
	Revision int  `json:"revision"`
}

// SaveTracker sets up or changes the activity tracker, for the person in the
// app or an agent through sift activity tracker.
func (s *Service) SaveTracker(in TrackerInput, actor string) (Job, error) {
	if trim(in.Prompt) == "" {
		in.Prompt = DefaultActivityPrompt
	}
	j, exists := s.Store.Tracker()
	if exists && j.Revision != in.Revision {
		return j, conflict("Activity tracking changed; refresh before saving")
	}
	if !exists {
		home, _ := os.UserHomeDir()
		j = Job{Name: trackerName, Kind: trackerKind, Directory: home}
	}
	j.Prompt, j.Schedules, j.Provider, j.Model, j.Thinking, j.Enabled = in.Prompt, in.Schedules, in.Provider, in.Model, in.Thinking, in.Enabled
	if in.Timezone != "" {
		j.Timezone = in.Timezone
	}
	if !exists {
		loc := s.Store.workspaceZone()
		if l, err := time.LoadLocation(j.Timezone); j.Timezone != "" && err == nil {
			loc = l
		}
		since := time.Now()
		if in.Backfill {
			y, m, d := since.In(loc).Date()
			since = time.Date(y, m, d, 0, 0, 0, 0, loc)
		}
		j.Since = stamp(since)
	}
	return s.saveJob(j, j.Revision, actor, true)
}

// CheckActivity starts a tracker check now: of everything not yet checked,
// or of one window (an older day, say) when given.
func (s *Service) CheckActivity(window *ActivityWindow) (Run, error) {
	j, ok := s.Store.Tracker()
	if !ok {
		return Run{}, &APIError{Status: 404, Message: "Set up activity tracking first"}
	}
	var windows []ActivityWindow
	if window != nil {
		at := time.Now()
		from, e1 := time.Parse(time.RFC3339, window.From)
		to, e2 := time.Parse(time.RFC3339, window.To)
		if e1 != nil || e2 != nil || !to.After(from) {
			return Run{}, invalid("Choose a window with a start before its end")
		}
		if to.After(at) {
			to = at
		}
		if to.Sub(from) > activityLookback+24*time.Hour {
			return Run{}, invalid("Check at most a week at a time")
		}
		windows = uncovered(from, to, s.Store.ActivityChecks(from, to))
		if len(windows) == 0 {
			return Run{}, conflict("That time has already been checked")
		}
	}
	s.runMu.Lock()
	defer s.runMu.Unlock()
	if s.maintenance || s.restarting {
		return Run{}, conflict("Sift is paused for backup or update")
	}
	if _, busy := s.active[j.ID]; busy {
		return Run{}, conflict("A check is already running")
	}
	var cfg Settings
	s.Store.Get("settings", "app", &cfg)
	if len(s.active) >= cfg.Concurrency {
		return Run{}, conflict("Other agents are using every run slot; try again when one finishes")
	}
	return s.startRunLocked(j, windows)
}

// windowLabel describes a window in the tracker's timezone for its guide.
func windowLabel(w ActivityWindow, loc *time.Location) string {
	from, _ := time.Parse(time.RFC3339, w.From)
	to, _ := time.Parse(time.RFC3339, w.To)
	from, to = from.In(loc), to.In(loc)
	end := to.Format("15:04")
	if from.Format("2006-01-02") != to.Format("2006-01-02") {
		end = to.Format("Mon 2 Jan 15:04")
	}
	return fmt.Sprintf("- %s – %s (from %s to %s)", from.Format("Mon 2 Jan 15:04"), end, w.From, w.To)
}

// trackerGuide tells a tracker check exactly what to cover and how to record it.
func trackerGuide(j Job, run Run, exe, dir string) string {
	loc, err := time.LoadLocation(j.Timezone)
	if err != nil {
		loc = time.UTC
	}
	lines := make([]string, 0, len(run.Windows))
	for _, w := range run.Windows {
		lines = append(lines, windowLabel(w, loc))
	}
	cli := fmt.Sprintf("%q --data %q", exe, dir)
	return fmt.Sprintf(`This run is the person's activity tracker. Write down what they did in these windows (their timezone is %s):
%s

Record work sessions, not single events: group related commits, messages, reviews and edits on the same piece of work into one entry with a start and end. Keep separate pieces of work separate; a meeting, a code review or a conversation is its own entry. A busy day is usually 5–20 entries.

Before recording, read what's already there: %s activity list --from %s --to %s. Extend or correct an existing entry with %s activity update ID --revision N rather than adding a near-duplicate, especially at the edges of a window.

Record each session with:
%s activity add --start TIME --end TIME --title TITLE --summary TEXT --category CATEGORY --source SOURCE --link URL --task TASK_ID --source-key KEY --actor %q
- TIME is RFC 3339 with an offset, such as 2026-11-04T09:30:00+05:30, from the evidence's own timestamps. Never invent times.
- TITLE says what they did in under 80 characters, in the past tense: "Fixed the flaky checkout test", "Planning call with the design team".
- TEXT is one to three short markdown lines about the work itself, with specifics: PR numbers, repositories, channels, people. Leave out how you found or timed it. Don't paste message contents, secrets, or tokens.
- CATEGORY is one of: %s.
- SOURCE names where the evidence came from in one word, such as git, github, gitlab, slack, chat, email, calendar, browser, shell, docs or sift.
- URL is the best single link back to the evidence, if there is one.
- --task links the session to the task it moved forward: read active tasks with %s tasks list and link only when the match is clear.
- KEY identifies the evidence so a repeated check updates instead of duplicating, for example git:REPOSITORY:COMMIT, pr:OWNER/REPO#NUMBER or calendar:EVENT_ID.

When a session shows a linked task finished, started or is waiting on someone, keep that task's status current as described above. If a window has no activity, record nothing; Sift marks these windows checked when you finish. Finish with a one-paragraph summary of the day so far.

`, loc.String(), strings.Join(lines, "\n"), cli, run.Windows[0].From, run.Windows[len(run.Windows)-1].To, cli, cli, "job:"+j.ID, strings.Join(ActivityCategories, ", "), cli)
}
