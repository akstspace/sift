package sift

import (
	"net/http"
	"strconv"
	"strings"
	"time"
)

// activityPage is what My activity shows for a range of days.
type activityPage struct {
	Entries []ActivityEntry  `json:"entries"`
	Checks  []ActivityCheck  `json:"checks"`
	Gaps    []ActivityWindow `json:"gaps"`
	Tracker *Job             `json:"tracker"`
	// DefaultPrompt and DefaultTimes are offered at setup and on "Restore default".
	DefaultPrompt string   `json:"defaultPrompt"`
	DefaultTimes  []string `json:"defaultTimes"`
	Categories    []string `json:"categories"`
	LookbackDays  int      `json:"lookbackDays"`
}

// activityRange reads from and to: RFC 3339 instants or YYYY-MM-DD days in
// the person's timezone (to includes that whole day). Both default to today.
func (s *Service) activityRange(r *http.Request) (time.Time, time.Time, error) {
	loc := s.Store.workspaceZone()
	day := func(v string, end bool) (time.Time, bool) {
		if v == "" {
			y, m, d := time.Now().In(loc).Date()
			v = time.Date(y, m, d, 0, 0, 0, 0, loc).Format("2006-01-02")
		}
		if t, err := time.ParseInLocation("2006-01-02", v, loc); err == nil {
			if end {
				t = t.AddDate(0, 0, 1)
			}
			return t, true
		}
		if t, ok := parseWhen(v, loc); ok {
			return t, true
		}
		// An unescaped "+" in a query arrives as a space.
		return parseWhen(strings.Replace(v, " ", "+", 1), loc)
	}
	from, ok1 := day(r.URL.Query().Get("from"), false)
	to, ok2 := day(r.URL.Query().Get("to"), true)
	if !ok1 || !ok2 || !to.After(from) {
		return from, to, invalid("from and to must be dates (YYYY-MM-DD) or times, with from first")
	}
	if to.Sub(from) > maxActivityRange {
		return from, to, invalid("Read at most 62 days of activity at a time")
	}
	return from, to, nil
}

func (s *Service) activityRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/activity", func(w http.ResponseWriter, r *http.Request) {
		page := activityPage{DefaultPrompt: DefaultActivityPrompt, DefaultTimes: DefaultTrackerTimes, Categories: ActivityCategories, LookbackDays: int(activityLookback.Hours() / 24), Checks: []ActivityCheck{}, Gaps: []ActivityWindow{}}
		if j, ok := s.Store.Tracker(); ok {
			page.Tracker = &j
			page.Gaps = s.Store.trackerGaps(j, time.Now())
		}
		if task := r.URL.Query().Get("task"); task != "" {
			page.Entries = s.Store.TaskActivity(task)
			writeJSON(w, 200, page)
			return
		}
		from, to, err := s.activityRange(r)
		if err != nil {
			apiError(w, err)
			return
		}
		page.Entries, page.Checks = s.Store.Activity(from, to), s.Store.ActivityChecks(from, to)
		writeJSON(w, 200, page)
	})
	mux.HandleFunc("GET /api/activity/{id}", func(w http.ResponseWriter, r *http.Request) {
		var e ActivityEntry
		if !s.Store.Get(activityKind, r.PathValue("id"), &e) {
			apiError(w, &APIError{Status: 404, Message: "Activity not found"})
			return
		}
		writeJSON(w, 200, e)
	})
	save := func(w http.ResponseWriter, r *http.Request, id string) {
		var in struct {
			Entry            ActivityEntry `json:"entry"`
			ExpectedRevision int           `json:"expectedRevision"`
		}
		if !decodeBody(w, r, &in) {
			return
		}
		in.Entry.ID = id
		out, err := s.Store.SaveActivity(in.Entry, in.ExpectedRevision, actorOf(r))
		if err != nil {
			apiError(w, err)
			return
		}
		writeJSON(w, 200, out)
	}
	mux.HandleFunc("POST /api/activity", func(w http.ResponseWriter, r *http.Request) { save(w, r, "") })
	mux.HandleFunc("PUT /api/activity/{id}", func(w http.ResponseWriter, r *http.Request) { save(w, r, r.PathValue("id")) })
	mux.HandleFunc("DELETE /api/activity/{id}", func(w http.ResponseWriter, r *http.Request) {
		revision, err := strconv.Atoi(r.URL.Query().Get("revision"))
		if err != nil {
			apiError(w, invalid("Include the activity's current revision"))
			return
		}
		if err = s.Store.DeleteActivity(r.PathValue("id"), revision, actorOf(r)); err != nil {
			apiError(w, err)
			return
		}
		writeJSON(w, 200, map[string]bool{"deleted": true})
	})
	mux.HandleFunc("PUT /api/activity/tracker", func(w http.ResponseWriter, r *http.Request) {
		if actorOf(r) != "user" {
			apiError(w, &APIError{Status: 403, Message: "Only the person using Sift can set up activity tracking"})
			return
		}
		var in TrackerInput
		if !decodeBody(w, r, &in) {
			return
		}
		out, err := s.SaveTracker(in)
		if err != nil {
			apiError(w, err)
			return
		}
		writeJSON(w, 200, out)
	})
	mux.HandleFunc("POST /api/activity/check", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			From string `json:"from"`
			To   string `json:"to"`
		}
		if !decodeBody(w, r, &in) {
			return
		}
		var window *ActivityWindow
		if in.From != "" || in.To != "" {
			window = &ActivityWindow{From: in.From, To: in.To}
		}
		run, err := s.CheckActivity(window)
		if err != nil {
			apiError(w, err)
			return
		}
		writeJSON(w, 200, run)
	})
}
