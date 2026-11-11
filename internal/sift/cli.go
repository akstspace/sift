package sift

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"
)

const DefaultPort = "57431"

func serveAddress(flags map[string]string) (string, error) {
	if flags["address"] != "" && flags["port"] != "" {
		return "", invalid("Use --port or --address, not both")
	}
	if address := flags["address"]; address != "" {
		host, port, err := net.SplitHostPort(address)
		if err != nil || host != "127.0.0.1" {
			return "", invalid("Sift binds only to 127.0.0.1; use --port NUMBER")
		}
		if err = validatePort(port); err != nil {
			return "", err
		}
		return address, nil
	}
	port := flags["port"]
	if port == "" {
		port = os.Getenv("SIFT_PORT")
	}
	if port == "" {
		port = DefaultPort
	}
	if err := validatePort(port); err != nil {
		return "", err
	}
	return net.JoinHostPort("127.0.0.1", port), nil
}

func validatePort(port string) error {
	n, err := strconv.Atoi(port)
	if err != nil || n < 0 || n > 65535 || strconv.Itoa(n) != port {
		return invalid("Port must be 1–65535, or 0 to explicitly request an available port")
	}
	return nil
}

func DataDir() string {
	if v := os.Getenv("SIFT_DATA"); v != "" {
		return v
	}
	d, _ := os.UserConfigDir()
	return filepath.Join(d, "Sift")
}

type arguments struct {
	Pos   []string
	Flags map[string]string
	// Lists keeps every value of a repeatable flag such as --schedule, in order.
	Lists map[string][]string
}

func parseArgs(args []string) arguments {
	a := arguments{Flags: map[string]string{}, Lists: map[string][]string{}}
	bools := map[string]bool{"enabled": true, "json": true, "check": true, "yes": true, "quiet": true, "wait": true, "default-prompt": true, "default-model": true, "pause": true, "resume": true, "fill-today": true}
	for i := 0; i < len(args); i++ {
		v := args[i]
		if strings.HasPrefix(v, "--") {
			key := strings.TrimPrefix(v, "--")
			if k, val, ok := strings.Cut(key, "="); ok {
				a.Flags[k] = val
				a.Lists[k] = append(a.Lists[k], val)
			} else if bools[key] {
				a.Flags[key] = "true"
			} else if i+1 < len(args) && !strings.HasPrefix(args[i+1], "--") {
				i++
				a.Flags[key] = args[i]
				a.Lists[key] = append(a.Lists[key], args[i])
			} else {
				a.Flags[key] = "true"
			}
		} else {
			a.Pos = append(a.Pos, v)
		}
	}
	return a
}

type localClient struct {
	Connection
	Actor string
}

func clientFor(dir, actor string) (*localClient, error) {
	b, err := os.ReadFile(filepath.Join(dir, "connection.json"))
	if err != nil {
		return nil, fmt.Errorf("Sift service is unavailable. Start it with: sift serve --data %q", dir)
	}
	var c Connection
	if json.Unmarshal(b, &c) != nil {
		return nil, fmt.Errorf("Invalid local service connection; restart sift serve")
	}
	u, parseErr := url.Parse(c.URL)
	if parseErr != nil || u.Scheme != "http" || u.Hostname() != "127.0.0.1" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || u.Port() == "0" || validatePort(u.Port()) != nil || c.Token == "" {
		return nil, fmt.Errorf("Invalid local service connection; restart sift serve")
	}
	if actor == "" || actor == "user" {
		actor = "local-agent"
	}
	return &localClient{Connection: c, Actor: actor}, nil
}
func (c *localClient) request(ctx context.Context, method, path string, body any) ([]byte, error) {
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(encode(body))
	}
	req, err := http.NewRequestWithContext(ctx, method, c.URL+path, reader)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	req.Header.Set("X-Sift-Request", "1")
	req.Header.Set("X-Sift-Actor", c.Actor)
	req.Header.Set("Content-Type", "application/json")
	if ctx.Value(progressKey{}) != nil {
		req.Header.Set("Accept", progressMediaType)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("Local Sift service is unavailable; start sift serve: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 400 && strings.Split(resp.Header.Get("Content-Type"), ";")[0] == progressMediaType {
		return readOperation(ctx, resp.Body)
	}
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode >= 400 {
		var e map[string]any
		_ = json.Unmarshal(b, &e)
		return nil, fmt.Errorf("%v", e["error"])
	}
	return b, nil
}
func CLI(ctx context.Context, args []string, out io.Writer) error {
	return CLIWithProgress(ctx, args, out, os.Stderr)
}

func CLIWithProgress(ctx context.Context, args []string, out, progressOut io.Writer) (resultErr error) {
	a := parseArgs(args)
	enabled, err := progressEnabled(a.Flags["progress"], a.Flags["quiet"] == "true", progressOut)
	if err != nil {
		return err
	}
	dir := a.Flags["data"]
	if dir == "" {
		dir = DataDir()
	}
	dir, _ = filepath.Abs(dir)
	pos := a.Pos
	if len(pos) == 0 {
		pos = []string{"help"}
	}
	if pos[0] == "version" {
		fmt.Fprintln(out, Version)
		return nil
	}
	if pos[0] == "help" {
		fmt.Fprintln(out, `Sift — your work, in focus.

Usage: sift [--data DIRECTORY] COMMAND [--actor NAME]

serve [--port 57431]               Start loopback service and scheduler
  --port NUMBER overrides SIFT_PORT; default 57431. Use 0 for an available port.
  --address 127.0.0.1:PORT is also supported (mutually exclusive with --port).
tasks list|search QUERY|tree       Inspect tasks (JSON)
tasks get ID                      Task, current revision, history, potential duplicates
tasks comments ID [--after EVENT_ID] Read comments (JSON; up to 1,000 per page)
tasks comment ID --text TEXT       Post a comment [--request-id KEY]
tasks duplicates --title TITLE   Find potential duplicates before creating
tasks add --title TITLE [--parent ID] [--source-key KEY]
          [--due-date YYYY-MM-DD]  Optional deadline (empty value clears it on update)
tasks update ID --revision N [--status STATUS] [--reason REASON]
tasks merge ID --into ID --revision N --target-revision N --reason REASON
  Task options: --description TEXT --priority none|low|medium|high|urgent
    --project ID --tags ID,ID --icon ID --due-date YYYY-MM-DD
    --snoozed-until YYYY-MM-DD --attachment ID --request-id KEY --file JSON
columns list                      Discover user-managed status IDs
projects|tags list|add|update      --name NAME [--id ID] [--color COLOR]
icons search QUERY                Offline searchable icon catalog
images upload PATH                Upload local PNG/JPEG/WebP/GIF (20 MB)
jobs list|add|update|run|reset      Job creation/update uses --file JOB.json
  --schedule SPEC  Repeatable; replaces the job's schedules. It runs at whichever
    comes next: "daily 09:00", "weekdays 17:30 mon,wed,fri" (or mon-fri, 0-6),
    "interval 2h", "cron 0 9 * * 1-5". Times use the job's timezone.
jobs update ID --revision N --schedule SPEC [--schedule SPEC]  Change only schedules
jobs run ID --wait                 Start once and follow this run to completion
runs list|get ID|cancel ID         Live run history and control
runs watch ID                      Follow run status and new activity (read-only)
activity list [--from DATE] [--to DATE] [--task ID]
                                  What the person did: work sessions (JSON);
                                  dates are YYYY-MM-DD or times, default today
activity add --start TIME --end TIME --title TEXT [--summary TEXT]
          [--category KIND] [--source NAME] [--link URL] [--task ID] [--source-key KEY]
activity update ID --revision N [same options]   Change one session
activity delete ID --revision N   Remove a session you recorded
activity check [--from TIME --to TIME]
                                  Run the activity tracker now over the time not
                                  checked yet, or one window of at most a week
activity tracker                  Show activity tracking: prompt, schedules, model,
                                  next check, and the time not checked yet
activity tracker [--revision N] [--prompt TEXT | --prompt-file PATH | --default-prompt]
          [--schedule SPEC]... [--model PROVIDER/MODEL | --default-model]
          [--thinking LEVEL] [--timezone ZONE] [--pause | --resume] [--fill-today]
                                  Set up tracking (--fill-today covers today so far),
                                  or change it with its revision; options left out
                                  stay as they are. Schedules use the jobs forms.
  TIME is RFC 3339 such as 2026-11-04T09:30:00+05:30. KIND is code, review,
  meeting, message, writing, research, admin, or other. A repeated source key
  updates the existing session instead of adding another.
models list                       Discover configured models using local Pi RPC
schema                            JSON schema and task rules
history TASK_ID                   Task activity, including comments and attribution
undo EVENT_ID                     Undo a task change if no newer edits exist
backup                            Create consistent full local backup
update [--check]                   Check/apply stable akstspace/sift release

Progress: --progress auto|always|never (default: auto on a terminal).
  Live status/stages and elapsed waiting go to stderr; stdout stays JSON.
  --quiet suppresses progress. Ctrl+C stops waiting, not an already-started run.

No silent daemon autostart, automatic duplicate merging, or model fallback.`)
		return nil
	}
	if pos[0] == "serve" {
		address, err := serveAddress(a.Flags)
		if err != nil {
			return err
		}
		if err = serve(ctx, dir, address); errors.Is(err, ErrRestart) {
			// Serve has released the port, storage, and data lock. Replace this
			// process with the (possibly updated) executable, keeping its PID so
			// launchd or systemd continue to supervise it.
			fmt.Fprintln(out, "Restarting Sift")
			return restartProcess()
		}
		return err
	}
	c, err := clientFor(dir, a.Flags["actor"])
	if err != nil {
		return err
	}
	path := ""
	method := "GET"
	var body any
	get := func(i int) string {
		if i < len(pos) {
			return pos[i]
		}
		return ""
	}
	sub := get(1)
	if a.Flags["wait"] == "true" && (pos[0] != "jobs" || sub != "run") {
		return invalid("--wait is supported with sift jobs run ID")
	}
	watch := pos[0] == "runs" && sub == "watch"
	if (watch || pos[0] == "jobs" && sub == "run") && get(2) == "" {
		return invalid("A job or run ID is required")
	}
	if enabled {
		label := "Waiting for Sift"
		switch pos[0] {
		case "backup":
			label = "Creating workspace backup"
		case "update":
			label = "Checking Sift release"
		case "models":
			label = "Discovering Pi models (no AI task is run)"
		case "images":
			label = "Uploading local image"
		case "runs":
			label = "Reading run activity"
		case "jobs":
			label = "Submitting job request"
		}
		var progress *cliProgress
		progress, ctx = startCLIProgress(ctx, progressOut, label, time.Second)
		defer func() {
			if progressErr := progress.finish(resultErr); resultErr == nil {
				resultErr = progressErr
			}
		}()
	}
	if watch {
		b, watchErr := c.watchRun(ctx, get(2), 500*time.Millisecond)
		if len(b) != 0 {
			if _, err := fmt.Fprintln(out, string(b)); err != nil {
				return err
			}
		}
		return watchErr
	}
	switch pos[0] {
	case "schema":
		path = "/api/schema"
	case "models":
		path = "/api/pi"
	case "icons":
		path = "/api/icons?q=" + url.QueryEscape(strings.Join(pos[min(2, len(pos)):], " "))
	case "columns":
		path = "/api/columns"
	case "tasks":
		switch sub {
		case "list", "tree":
			path = "/api/tasks"
		case "search":
			path = "/api/tasks?q=" + url.QueryEscape(strings.Join(pos[min(2, len(pos)):], " "))
		case "get":
			path = "/api/tasks/" + url.PathEscape(get(2))
		case "comments", "comment":
			if get(2) == "" {
				return invalid("A task ID is required; use sift tasks comments ID or sift tasks comment ID --text TEXT")
			}
			path = "/api/tasks/" + url.PathEscape(get(2)) + "/comments"
			if sub == "comment" {
				method = "POST"
				body = map[string]string{"text": a.Flags["text"], "requestId": a.Flags["request-id"]}
			} else {
				path += "?after=" + url.QueryEscape(a.Flags["after"])
			}
		case "duplicates":
			path = "/api/tasks/duplicates?title=" + url.QueryEscape(a.Flags["title"]) + "&id=" + url.QueryEscape(a.Flags["id"]) + "&project=" + url.QueryEscape(a.Flags["project"]) + "&sourceKey=" + url.QueryEscape(a.Flags["source-key"]) + "&source=" + url.QueryEscape(a.Flags["source"])
		case "add", "update":
			t := Task{Source: a.Flags["source"], SourceKey: a.Flags["source-key"]}
			if t.Source == "" {
				t.Source = c.Actor
			}
			expected := 0
			if sub == "update" {
				b, e := c.request(ctx, "GET", "/api/tasks/"+url.PathEscape(get(2)), nil)
				if e != nil {
					return e
				}
				var response struct {
					Task Task `json:"task"`
				}
				_ = json.Unmarshal(b, &response)
				t = response.Task
				expected, _ = strconv.Atoi(a.Flags["revision"])
				if expected == 0 {
					return fmt.Errorf("--revision is required; re-read the task before editing")
				}
			}
			if file := a.Flags["file"]; file != "" {
				b, e := os.ReadFile(file)
				if e != nil {
					return e
				}
				if e = json.Unmarshal(b, &t); e != nil {
					return e
				}
			}
			fields := map[string]*string{"title": &t.Title, "description": &t.Description, "status": &t.Status, "priority": &t.Priority, "project": &t.Project, "icon": &t.Icon, "parent": &t.ParentID, "due-date": &t.DueDate, "snoozed-until": &t.SnoozedUntil, "source-key": &t.SourceKey, "source": &t.Source}
			for k, p := range fields {
				if v, ok := a.Flags[k]; ok {
					*p = v
				}
			}
			if v, ok := a.Flags["tags"]; ok {
				t.Tags = []string{}
				if v != "" {
					t.Tags = strings.Split(v, ",")
				}
			}
			if v := a.Flags["attachment"]; v != "" {
				t.Attachments = append(t.Attachments, v)
			}
			method = "POST"
			path = "/api/tasks"
			if sub == "update" {
				method = "PUT"
				path += "/" + url.PathEscape(get(2))
			}
			body = map[string]any{"task": t, "expectedRevision": expected, "reason": a.Flags["reason"], "requestId": a.Flags["request-id"]}
		case "merge":
			path = "/api/tasks/" + url.PathEscape(get(2)) + "/merge"
			method = "POST"
			rev, _ := strconv.Atoi(a.Flags["revision"])
			targetRev, _ := strconv.Atoi(a.Flags["target-revision"])
			body = map[string]any{"target": a.Flags["into"], "revision": rev, "targetRevision": targetRev, "reason": a.Flags["reason"]}
		}
	case "projects", "tags":
		path = "/api/" + pos[0]
		if sub == "add" || sub == "update" {
			method = "POST"
			body = Entity{ID: a.Flags["id"], Name: a.Flags["name"], Color: a.Flags["color"], Icon: a.Flags["icon"]}
		}
	case "jobs":
		path = "/api/jobs"
		if sub == "run" || sub == "reset" {
			path += "/" + url.PathEscape(get(2)) + "/" + sub
			method = "POST"
			body = map[string]any{}
		} else if sub == "add" || sub == "update" {
			j, e := c.jobForSave(ctx, sub, get(2), a)
			if e != nil {
				return e
			}
			method = "POST"
			body = j
		}
	case "runs":
		path = "/api/runs"
		if sub == "get" {
			path += "/" + url.PathEscape(get(2))
		}
		if sub == "cancel" {
			path += "/" + url.PathEscape(get(2)) + "/cancel"
			method = "POST"
			body = map[string]any{}
		}
	case "activity":
		var e error
		method, path, body, e = c.activityRequest(ctx, sub, get(2), a)
		if e != nil {
			return e
		}
	case "history":
		path = "/api/history?entity=" + url.QueryEscape(get(1))
	case "undo":
		path = "/api/undo/" + url.PathEscape(get(1))
		method = "POST"
		body = map[string]any{}
	case "backup":
		path = "/api/backups"
		method = "POST"
		body = map[string]any{}
	case "update":
		path = "/api/update/apply"
		if a.Flags["check"] == "true" {
			path = "/api/update/check"
		}
		method = "POST"
		body = map[string]any{}
	case "images":
		if sub != "upload" {
			return fmt.Errorf("Use sift images upload PATH")
		}
		f, e := os.Open(get(2))
		if e != nil {
			return e
		}
		defer f.Close()
		var buf bytes.Buffer
		writer := multipart.NewWriter(&buf)
		part, _ := writer.CreateFormFile("file", filepath.Base(get(2)))
		if _, e = io.Copy(part, io.LimitReader(f, 21<<20)); e != nil {
			return e
		}
		_ = writer.Close()
		uploadCtx, cancel := context.WithTimeout(ctx, 10*time.Minute)
		defer cancel()
		req, _ := http.NewRequestWithContext(uploadCtx, "POST", c.URL+"/api/images", &buf)
		req.Body = io.NopCloser(&progressReader{reader: bytes.NewReader(buf.Bytes()), ctx: ctx, message: "Uploading image request", total: int64(buf.Len())})
		req.Header.Set("Content-Type", writer.FormDataContentType())
		req.Header.Set("Authorization", "Bearer "+c.Token)
		req.Header.Set("X-Sift-Request", "1")
		req.Header.Set("X-Sift-Actor", c.Actor)
		resp, e := http.DefaultClient.Do(req)
		if e != nil {
			return e
		}
		defer resp.Body.Close()
		b, e := io.ReadAll(resp.Body)
		if e != nil {
			return e
		}
		if resp.StatusCode >= 400 {
			return fmt.Errorf("Upload failed: %s", b)
		}
		_, e = out.Write(b)
		return e
	}
	if path == "" {
		return fmt.Errorf("Unknown command; use sift help")
	}
	timeout := 45 * time.Second
	if pos[0] == "update" || pos[0] == "backup" {
		timeout = 10 * time.Minute
	}
	watchCtx := ctx
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	b, err := c.request(ctx, method, path, body)
	if err != nil {
		return err
	}
	if pos[0] == "jobs" && sub == "run" && a.Flags["wait"] == "true" {
		var run Run
		if err = json.Unmarshal(b, &run); err != nil {
			return err
		}
		if run.ID == "" {
			return invalid("Job response has no run ID; inspect run history before retrying")
		}
		// The submission timeout must not truncate a legitimate long-running job.
		// Follow uses the caller's context, independent of the short request timeout.
		b, err = c.watchRun(watchCtx, run.ID, 500*time.Millisecond)
		if len(b) != 0 {
			if _, writeErr := fmt.Fprintln(out, string(b)); writeErr != nil {
				return writeErr
			}
		}
		return err
	}
	var pretty bytes.Buffer
	if json.Indent(&pretty, b, "", "  ") == nil {
		_, err = fmt.Fprintln(out, pretty.String())
		return err
	}
	_, err = out.Write(b)
	return err
}

// jobForSave builds the job sent by jobs add/update: from --file JOB.json, or
// for an update with only --schedule flags, from the stored job. Schedule flags
// replace the job's schedules; --revision overrides the file's revision.
func (c *localClient) jobForSave(ctx context.Context, sub, id string, a arguments) (Job, error) {
	var j Job
	specs := a.Lists["schedule"]
	if sub == "update" && id == "" {
		return j, invalid("A job ID is required: sift jobs update ID")
	}
	switch {
	case a.Flags["file"] != "":
		b, err := os.ReadFile(a.Flags["file"])
		if err != nil {
			return j, err
		}
		if err = json.Unmarshal(b, &j); err != nil {
			return j, err
		}
	case sub == "update" && len(specs) > 0:
		if a.Flags["revision"] == "" {
			return j, invalid("--revision N is required; read the job's current revision with sift jobs list")
		}
		b, err := c.request(ctx, "GET", "/api/jobs", nil)
		if err != nil {
			return j, err
		}
		var jobs []Job
		if err = json.Unmarshal(b, &jobs); err != nil {
			return j, err
		}
		i := slices.IndexFunc(jobs, func(job Job) bool { return job.ID == id })
		if i < 0 {
			return j, invalid("Job not found")
		}
		j = jobs[i]
	case sub == "add":
		return j, invalid("Job creation uses --file JOB.json; add --schedule SPEC to set its schedules")
	default:
		return j, invalid("Use --file JOB.json, or --revision N with --schedule SPEC to change only the schedules")
	}
	if len(specs) > 0 {
		j.Schedules = make([]JobSchedule, 0, len(specs))
		for _, spec := range specs {
			sc, err := parseScheduleSpec(spec)
			if err != nil {
				return j, err
			}
			j.Schedules = append(j.Schedules, sc)
		}
	}
	if r := a.Flags["revision"]; r != "" {
		n, err := strconv.Atoi(r)
		if err != nil || n < 1 {
			return j, invalid("--revision must be a positive number")
		}
		j.Revision = n
	}
	if sub == "update" {
		j.ID = id
	}
	return j, nil
}

var weekdayNames = map[string]int{"sun": 0, "mon": 1, "tue": 2, "wed": 3, "thu": 4, "fri": 5, "sat": 6, "sunday": 0, "monday": 1, "tuesday": 2, "wednesday": 3, "thursday": 4, "friday": 5, "saturday": 6}

// parseScheduleSpec reads one --schedule value. The service validates the
// time, duration, or cron fields, so this only splits the value apart.
func parseScheduleSpec(spec string) (JobSchedule, error) {
	usage := invalid(`Schedule %q: use "daily 09:00", "weekdays 17:30 mon,wed,fri", "interval 2h", or "cron 0 9 * * 1-5"`, spec)
	fields := strings.Fields(spec)
	if len(fields) < 2 {
		return JobSchedule{}, usage
	}
	switch kind := strings.ToLower(fields[0]); {
	case kind == "cron":
		return JobSchedule{Type: kind, Schedule: strings.Join(fields[1:], " ")}, nil
	case (kind == "daily" || kind == "interval") && len(fields) == 2:
		return JobSchedule{Type: kind, Schedule: fields[1]}, nil
	case kind == "weekdays" && len(fields) == 3:
		days, ok := parseWeekdays(fields[2])
		if !ok {
			return JobSchedule{}, invalid("Schedule %q: days are sun–sat or 0–6, comma-separated, with ranges such as mon-fri", spec)
		}
		return JobSchedule{Type: kind, Schedule: fields[1], Weekdays: days}, nil
	}
	return JobSchedule{}, usage
}

func parseWeekdays(list string) ([]int, bool) {
	day := func(v string) (int, bool) {
		if d, ok := weekdayNames[v]; ok {
			return d, true
		}
		n, err := strconv.Atoi(v)
		return n, err == nil && n >= 0 && n <= 6
	}
	var days []int
	for _, part := range strings.Split(strings.ToLower(list), ",") {
		from, to, isRange := strings.Cut(part, "-")
		first, ok := day(from)
		last := first
		if isRange {
			var okLast bool
			last, okLast = day(to)
			ok = ok && okLast && first <= last
		}
		if !ok {
			return nil, false
		}
		for d := first; d <= last; d++ {
			days = append(days, d)
		}
	}
	return days, true
}

// activityRequest builds the request for sift activity SUBCOMMAND.
func (c *localClient) activityRequest(ctx context.Context, sub, id string, a arguments) (method, path string, body any, err error) {
	switch sub {
	case "list", "":
		q := url.Values{}
		for _, k := range []string{"from", "to", "task"} {
			if v := a.Flags[k]; v != "" {
				q.Set(k, v)
			}
		}
		return "GET", "/api/activity?" + q.Encode(), nil, nil
	case "check":
		return "POST", "/api/activity/check", map[string]string{"from": a.Flags["from"], "to": a.Flags["to"]}, nil
	case "tracker":
		return c.trackerRequest(ctx, a)
	case "add", "update", "delete":
	default:
		return "", "", nil, invalid("Use sift activity list, add, update, delete, check, or tracker")
	}
	if sub != "add" && id == "" {
		return "", "", nil, invalid("An activity ID is required: sift activity %s ID --revision N", sub)
	}
	revision := 0
	if sub != "add" {
		if revision, err = strconv.Atoi(a.Flags["revision"]); err != nil || revision < 1 {
			return "", "", nil, invalid("--revision N is required; read the activity with sift activity list")
		}
	}
	if sub == "delete" {
		return "DELETE", "/api/activity/" + url.PathEscape(id) + "?revision=" + strconv.Itoa(revision), nil, nil
	}
	var e ActivityEntry
	if sub == "update" {
		b, err := c.request(ctx, "GET", "/api/activity/"+url.PathEscape(id), nil)
		if err != nil {
			return "", "", nil, err
		}
		_ = json.Unmarshal(b, &e)
	}
	fields := map[string]*string{"start": &e.Start, "end": &e.End, "title": &e.Title, "summary": &e.Summary, "category": &e.Category, "source": &e.Source, "link": &e.Link, "task": &e.TaskID, "source-key": &e.SourceKey}
	for k, p := range fields {
		if v, ok := a.Flags[k]; ok {
			*p = v
		}
	}
	body = map[string]any{"entry": e, "expectedRevision": revision}
	if sub == "add" {
		return "POST", "/api/activity", body, nil
	}
	return "PUT", "/api/activity/" + url.PathEscape(id), body, nil
}

// trackerRequest builds sift activity tracker. With no options it shows the
// tracker; with options it sets tracking up from Sift's defaults, or changes
// the tracker at --revision N, keeping whatever the options leave out.
func (c *localClient) trackerRequest(ctx context.Context, a arguments) (method, path string, body any, err error) {
	options := []string{"prompt", "prompt-file", "default-prompt", "schedule", "model", "default-model", "thinking", "timezone", "pause", "resume", "fill-today"}
	if !slices.ContainsFunc(options, func(k string) bool { _, ok := a.Flags[k]; return ok }) {
		return "GET", "/api/activity/tracker", nil, nil
	}
	b, err := c.request(ctx, "GET", "/api/activity/tracker", nil)
	if err != nil {
		return "", "", nil, err
	}
	var view trackerView
	if err = json.Unmarshal(b, &view); err != nil {
		return "", "", nil, err
	}
	in := TrackerInput{Prompt: view.DefaultPrompt, Enabled: true, Backfill: a.Flags["fill-today"] != ""}
	for _, at := range view.DefaultTimes {
		in.Schedules = append(in.Schedules, JobSchedule{Type: "daily", Schedule: at})
	}
	if j := view.Tracker; j != nil {
		if in.Revision, err = strconv.Atoi(a.Flags["revision"]); err != nil || in.Revision < 1 {
			return "", "", nil, invalid("--revision N is required to change tracking; read it with sift activity tracker")
		}
		if in.Backfill {
			return "", "", nil, invalid("--fill-today only applies when setting up tracking; use sift activity check --from TIME --to TIME for earlier time")
		}
		in.Prompt, in.Schedules, in.Provider, in.Model, in.Thinking, in.Timezone, in.Enabled = j.Prompt, j.Schedules, j.Provider, j.Model, j.Thinking, j.Timezone, j.Enabled
	}
	switch {
	case a.Flags["prompt-file"] != "":
		text, err := os.ReadFile(a.Flags["prompt-file"])
		if err != nil {
			return "", "", nil, err
		}
		in.Prompt = string(text)
	case a.Flags["default-prompt"] != "":
		in.Prompt = view.DefaultPrompt
	case a.Flags["prompt"] != "":
		in.Prompt = a.Flags["prompt"]
	}
	if specs := a.Lists["schedule"]; len(specs) > 0 {
		in.Schedules = nil
		for _, spec := range specs {
			sc, err := parseScheduleSpec(spec)
			if err != nil {
				return "", "", nil, err
			}
			in.Schedules = append(in.Schedules, sc)
		}
	}
	if v := a.Flags["model"]; v != "" {
		provider, model, ok := strings.Cut(v, "/")
		if !ok || provider == "" || model == "" {
			return "", "", nil, invalid("Use --model PROVIDER/MODEL, as sift models list shows, or --default-model for Pi's default")
		}
		in.Provider, in.Model = provider, model
	} else if a.Flags["default-model"] != "" {
		in.Provider, in.Model, in.Thinking = "", "", ""
	}
	if v, ok := a.Flags["thinking"]; ok {
		in.Thinking = v
	}
	if v := a.Flags["timezone"]; v != "" {
		in.Timezone = v
	}
	if a.Flags["pause"] != "" && a.Flags["resume"] != "" {
		return "", "", nil, invalid("Use --pause or --resume, not both")
	}
	if a.Flags["pause"] != "" || a.Flags["resume"] != "" {
		in.Enabled = a.Flags["resume"] != ""
	}
	return "PUT", "/api/activity/tracker", in, nil
}
