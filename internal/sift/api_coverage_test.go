package sift

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func routeRequest(t *testing.T, handler http.Handler, method, path string, body any, status int, agent bool) []byte {
	t.Helper()
	var data []byte
	if raw, ok := body.(string); ok {
		data = []byte(raw)
	} else if body != nil {
		data = encode(body)
	}
	r := httptest.NewRequest(method, path, bytes.NewReader(data))
	if agent {
		r.Header.Set("Authorization", "Bearer fixture")
	}
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	if w.Code != status {
		t.Fatalf("%s %s: got %d: %s, want %d", method, path, w.Code, w.Body.String(), status)
	}
	return w.Body.Bytes()
}

func TestAPITaskOrganizationAndWorkflowPaths(t *testing.T) {
	s := testService(t)
	h := s.routes()
	for _, path := range []string{"/api/snapshot", "/api/schema", "/api/health", "/api/icons", "/api/icons?q=email", "/api/columns", "/api/history", "/api/update", "/api/projects", "/api/tags", "/api/jobs", "/api/runs", "/api/backups"} {
		routeRequest(t, h, "GET", path, nil, 200, false)
	}
	routeRequest(t, h, "GET", "/api/tasks/missing", nil, 404, false)
	for _, path := range []string{"/api/tasks", "/api/projects", "/api/tags", "/api/jobs", "/api/columns", "/api/settings", "/api/tasks/missing/merge", "/api/projects/missing/merge", "/api/setup/unknown"} {
		method := "POST"
		if path == "/api/settings" {
			method = "PUT"
		}
		routeRequest(t, h, method, path, "{", 400, false)
	}
	routeRequest(t, h, "POST", "/api/tasks", map[string]any{"task": Task{Title: ""}}, 400, false)
	var created struct {
		Task Task `json:"task"`
	}
	json.Unmarshal(routeRequest(t, h, "POST", "/api/tasks", map[string]any{"task": Task{Title: "Browser task"}}, 200, false), &created)
	if created.Task.ID == "" {
		t.Fatal("missing stable task ID")
	}
	created.Task.Title = "Updated browser task"
	body := map[string]any{"task": created.Task, "expectedRevision": created.Task.Revision}
	routeRequest(t, h, "PUT", "/api/tasks/"+created.Task.ID, body, 200, false)
	routeRequest(t, h, "PUT", "/api/tasks/"+created.Task.ID, body, 409, false)
	routeRequest(t, h, "GET", "/api/tasks?q=updated", nil, 200, false)
	routeRequest(t, h, "GET", "/api/tasks/duplicates?id="+created.Task.ID, nil, 200, false)
	routeRequest(t, h, "POST", "/api/tasks/missing/merge", map[string]string{"target": "none"}, 400, false)
	source := mustTask(t, s.Store, Task{Title: "Merge source", Description: "Source context"})
	target := mustTask(t, s.Store, Task{Title: "Merge survivor"})
	var mergeResult struct {
		Merged bool `json:"merged"`
		Task   Task `json:"task"`
	}
	if err := json.Unmarshal(routeRequest(t, h, "POST", "/api/tasks/"+source.ID+"/merge", map[string]any{
		"target": target.ID, "revision": source.Revision, "targetRevision": target.Revision, "reason": "Verified same work",
	}, 200, false), &mergeResult); err != nil {
		t.Fatal(err)
	}
	if !mergeResult.Merged || mergeResult.Task.ID != target.ID || mergeResult.Task.Revision != target.Revision+1 || !strings.Contains(mergeResult.Task.Description, source.Description) {
		t.Fatal("merge response must contain the updated survivor", mergeResult)
	}
	routeRequest(t, h, "POST", "/api/undo/999999", map[string]any{}, 400, false)
	for _, kind := range []string{"project", "tag"} {
		path := "/api/" + kind + "s"
		routeRequest(t, h, "POST", path, Entity{}, 400, false)
		var a, b Entity
		json.Unmarshal(routeRequest(t, h, "POST", path, Entity{Name: "Source", Color: "sea"}, 200, false), &a)
		json.Unmarshal(routeRequest(t, h, "POST", path, Entity{Name: "Survivor", Color: "sea"}, 200, false), &b)
		task := Task{Title: "Assigned " + kind}
		if kind == "project" {
			task.Project = a.ID
		} else {
			task.Tags = []string{a.ID, b.ID}
		}
		task = mustTask(t, s.Store, task)
		routeRequest(t, h, "POST", path+"/"+a.ID+"/merge", map[string]string{"target": "missing"}, 400, false)
		routeRequest(t, h, "POST", path+"/"+a.ID+"/merge", map[string]string{"target": b.ID}, 200, false)
		var merged Task
		s.Store.Get("task", task.ID, &merged)
		if merged.Revision != task.Revision+1 || (kind == "project" && merged.Project != b.ID) || (kind == "tag" && (len(merged.Tags) != 1 || merged.Tags[0] != b.ID)) {
			t.Fatal("assignments lost", merged)
		}
	}
	var column Column
	json.Unmarshal(routeRequest(t, h, "POST", "/api/columns", Column{Name: "Review"}, 200, false), &column)
	routeRequest(t, h, "POST", "/api/columns", Column{Name: "Agent forbidden"}, 403, true)
	routeRequest(t, h, "POST", "/api/columns", Column{}, 400, false)
	routeRequest(t, h, "DELETE", "/api/columns/"+column.ID+"?moveTo=open", nil, 403, true)
	routeRequest(t, h, "DELETE", "/api/columns/open?moveTo=done", nil, 400, false)
	routeRequest(t, h, "DELETE", "/api/columns/"+column.ID+"?moveTo=missing", nil, 400, false)
	routeRequest(t, h, "DELETE", "/api/columns/"+column.ID+"?moveTo=open", nil, 200, false)
	var cfg Settings
	s.Store.Get("settings", "app", &cfg)
	routeRequest(t, h, "PUT", "/api/settings", cfg, 200, false)
	cfg.Theme = "invalid"
	routeRequest(t, h, "PUT", "/api/settings", cfg, 400, false)
	s.Notify("Evidence", "Local evidence")
	n := listAs[Notification](s.Store, "notification")[0]
	routeRequest(t, h, "POST", "/api/notifications/"+n.ID+"/read", nil, 200, false)
	routeRequest(t, h, "POST", "/api/notifications/missing/read", nil, 400, false)
	routeRequest(t, h, "GET", "/api/images/invalid", nil, 404, false)
	routeRequest(t, h, "POST", "/api/images", "not multipart", 400, false)
	routeRequest(t, h, "GET", "/api/backups/not-zip", nil, 404, false)
	routeRequest(t, h, "POST", "/api/restore", "not an archive", 400, false)
	routeRequest(t, h, "POST", "/", nil, 405, false)
	s.dataMu.Lock()
	routeRequest(t, h, "POST", "/api/tasks", body, 409, false)
	s.dataMu.Unlock()
	s.runMu.Lock()
	s.maintenance = true
	s.runMu.Unlock()
	routeRequest(t, h, "POST", "/api/tasks", body, 409, false)
	routeRequest(t, h, "POST", "/api/images", nil, 409, false)
	s.runMu.Lock()
	s.maintenance = false
	s.runMu.Unlock()
}

func TestAPIJobAndRunLifecycle(t *testing.T) {
	fixturePi(t)
	s := testService(t)
	h := s.routes()
	routeRequest(t, h, "GET", "/api/pi", nil, 200, false)
	routeRequest(t, h, "POST", "/api/jobs", Job{}, 400, false)
	j := fixtureJob(t, s, "success")
	routeRequest(t, h, "POST", "/api/jobs", j, 200, false)
	routeRequest(t, h, "POST", "/api/jobs/missing/run", nil, 400, false)
	routeRequest(t, h, "POST", "/api/jobs/missing/reset", nil, 400, false)
	var previous Job
	s.Store.Get("job", j.ID, &previous)
	routeRequest(t, h, "POST", "/api/jobs/"+j.ID+"/reset", nil, 200, false)
	var reset Job
	s.Store.Get("job", j.ID, &reset)
	if reset.SessionID == previous.SessionID {
		t.Fatal("reset retained old memory")
	}
	var run Run
	json.Unmarshal(routeRequest(t, h, "POST", "/api/jobs/"+j.ID+"/run", nil, 200, false), &run)
	awaitRun(t, s, run.ID, "succeeded")
	routeRequest(t, h, "GET", "/api/runs/"+run.ID, nil, 200, false)
	routeRequest(t, h, "GET", "/api/runs/missing", nil, 400, false)
	routeRequest(t, h, "POST", "/api/runs/missing/cancel", nil, 400, false)
	j = fixtureJob(t, s, "hang")
	json.Unmarshal(routeRequest(t, h, "POST", "/api/jobs/"+j.ID+"/run", nil, 200, false), &run)
	routeRequest(t, h, "POST", "/api/runs/"+run.ID+"/cancel", nil, 200, false)
	awaitRun(t, s, run.ID, "cancelled")
}

func TestCLIAgainstLocalRoutes(t *testing.T) {
	s := testService(t)
	server := httptest.NewServer(s.routes())
	defer server.Close()
	if err := os.WriteFile(filepath.Join(s.Dir, "connection.json"), encode(Connection{URL: server.URL, Token: "fixture"}), 0600); err != nil {
		t.Fatal(err)
	}
	call := func(wantError bool, args ...string) []byte {
		t.Helper()
		var out bytes.Buffer
		err := CLI(context.Background(), append([]string{"--data", s.Dir}, args...), &out)
		if (err != nil) != wantError {
			t.Fatalf("%v: err %v output %s", args, err, out.String())
		}
		return out.Bytes()
	}
	for _, args := range [][]string{{"help"}, {"version"}, {"schema"}, {"columns", "list"}, {"icons", "search", "email"}, {"tasks", "list"}, {"tasks", "tree"}, {"tasks", "search", "notes"}, {"tasks", "duplicates", "--title", "notes"}, {"projects", "list"}, {"tags", "list"}, {"jobs", "list"}, {"runs", "list"}, {"history", "missing"}} {
		call(false, args...)
	}
	var result struct {
		Task Task `json:"task"`
	}
	json.Unmarshal(call(false, "tasks", "add", "--title", "CLI route task", "--today", "--tags=", "--priority", "high"), &result)
	id := result.Task.ID
	if id == "" {
		t.Fatal("no CLI task")
	}
	call(false, "tasks", "get", id)
	call(true, "tasks", "update", id, "--title", "missing revision")
	call(false, "tasks", "update", id, "--revision", "1", "--title", "Updated CLI", "--today=false", "--reason", "reviewed")
	call(false, "projects", "add", "--name", "CLI project")
	call(false, "tags", "add", "--name", "CLI tag")
	file := filepath.Join(s.Dir, "task.json")
	os.WriteFile(file, encode(Task{Title: "Task from file"}), 0600)
	call(false, "tasks", "add", "--file", file)
	os.WriteFile(file, []byte("{"), 0600)
	call(true, "tasks", "add", "--file", file)
	call(true, "tasks", "add", "--file", file+"missing")
	for _, args := range [][]string{{"unknown"}, {"tasks", "unknown"}, {"images", "list"}, {"images", "upload", file + "missing"}, {"jobs", "add", "--file", file}, {"jobs", "update", "missing", "--file", file + "missing"}, {"jobs", "reset", "missing"}, {"jobs", "run", "missing"}, {"runs", "get", "missing"}, {"runs", "cancel", "missing"}, {"undo", "99999"}, {"tasks", "merge", id, "--into", "missing"}} {
		call(true, args...)
	}
	os.WriteFile(file, encode(Job{Name: "CLI paused", Prompt: "Do not run", Directory: s.Dir, Schedules: []JobSchedule{{Type: "daily", Schedule: "09:00"}}, Timezone: "UTC"}), 0600)
	var job Job
	json.Unmarshal(call(false, "jobs", "add", "--file", file), &job)
	os.WriteFile(file, encode(job), 0600)
	call(false, "jobs", "update", job.ID, "--file", file)
	call(false, "jobs", "reset", job.ID)
	var out bytes.Buffer
	t.Setenv("SIFT_DATA", s.Dir)
	if err := CLI(context.Background(), nil, &out); err != nil {
		t.Fatal(err)
	}
	if err := CLI(context.Background(), []string{"serve", "--address", "0.0.0.0:1"}, &out); err == nil {
		t.Fatal("LAN serve allowed")
	}
	if _, err := clientFor(t.TempDir(), ""); err == nil {
		t.Fatal("missing connection allowed")
	}
	for _, bad := range []string{"{", `{"url":"https://evil.example"}`} {
		os.WriteFile(filepath.Join(s.Dir, "connection.json"), []byte(bad), 0600)
		if _, err := clientFor(s.Dir, ""); err == nil {
			t.Fatal("bad connection allowed")
		}
	}
}

func TestCLIParsingActorAndDefaults(t *testing.T) {
	a := parseArgs([]string{"tasks", "add", "--title=hello", "--today", "--missing", "--priority", "high"})
	if len(a.Pos) != 2 || a.Flags["title"] != "hello" || a.Flags["today"] != "true" || a.Flags["missing"] != "true" || a.Flags["priority"] != "high" {
		t.Fatal(a)
	}
	t.Setenv("SIFT_DATA", "/fixture")
	if DataDir() != "/fixture" {
		t.Fatal(DataDir())
	}
	t.Setenv("SIFT_DATA", "")
	if !strings.HasSuffix(DataDir(), "Sift") {
		t.Fatal(DataDir())
	}
	for _, v := range []struct{ auth, actor, want string }{{"", "", "user"}, {"Bearer x", "", "local-agent"}, {"Bearer x", "user", "local-agent"}, {"Bearer x", "fixture", "fixture"}} {
		r := httptest.NewRequest("GET", "/", nil)
		r.Header.Set("Authorization", v.auth)
		r.Header.Set("X-Sift-Actor", v.actor)
		if got := actorOf(r); got != v.want {
			t.Fatal(got, v.want)
		}
	}
	w := httptest.NewRecorder()
	apiError(w, fmt.Errorf("ordinary failure"))
	if w.Code != 500 {
		t.Fatal(w.Code)
	}
	if !iconExists("circle-check") || iconExists("unknown-icon") || iconExists("task") {
		t.Fatal("catalog mismatch")
	}
}
