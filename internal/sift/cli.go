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
}

func parseArgs(args []string) arguments {
	a := arguments{Flags: map[string]string{}}
	bools := map[string]bool{"today": true, "enabled": true, "json": true, "check": true, "yes": true, "quiet": true, "wait": true}
	for i := 0; i < len(args); i++ {
		v := args[i]
		if strings.HasPrefix(v, "--") {
			key := strings.TrimPrefix(v, "--")
			if k, val, ok := strings.Cut(key, "="); ok {
				a.Flags[k] = val
			} else if bools[key] {
				a.Flags[key] = "true"
			} else if i+1 < len(args) && !strings.HasPrefix(args[i+1], "--") {
				i++
				a.Flags[key] = args[i]
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
tasks add --title TITLE [--today] [--parent ID] [--source-key KEY]
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
jobs run ID --wait                 Start once and follow this run to completion
runs list|get ID|cancel ID         Live run history and control
runs watch ID                      Follow run status and new activity (read-only)
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
			if v, ok := a.Flags["today"]; ok {
				t.Today = v == "true"
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
			var j Job
			b, e := os.ReadFile(a.Flags["file"])
			if e != nil {
				return e
			}
			if e = json.Unmarshal(b, &j); e != nil {
				return e
			}
			if sub == "update" {
				j.ID = get(2)
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
