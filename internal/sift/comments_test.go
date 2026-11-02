package sift

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestCommentsAreIndependentDurableIdempotentActivity(t *testing.T) {
	s := testStore(t)
	task := mustTask(t, s, Task{Title: "Task edits survive comments"})
	event, err := s.AddComment(task.ID, "  First update\nwith context  ", "user", "comment-1")
	if err != nil || event.Kind != "comment" || event.Reason != "First update\nwith context" || event.Actor != "user" || event.ID == 0 || event.At == "" {
		t.Fatal(event, err)
	}
	retry, err := s.AddComment(task.ID, "First update\nwith context", "user", "comment-1")
	if err != nil || retry.ID != event.ID {
		t.Fatal(retry, err)
	}
	if _, err = s.AddComment(task.ID, "Other content", "user", "comment-1"); err == nil {
		t.Fatal("request reused")
	}
	var got Task
	s.Get("task", task.ID, &got)
	if !bytes.Equal(encode(got), encode(task)) {
		t.Fatal("comment modified task", got)
	}
	task.Title = "Edit after comment"
	task = mustTask(t, s, task)
	edits := s.Events(0, task.ID, 100)
	edit := edits[len(edits)-1]
	if _, err = s.AddComment(task.ID, "Agent update", "agent", ""); err != nil {
		t.Fatal(err)
	}
	if err = s.Undo(edit.ID, "user"); err != nil {
		t.Fatal("comment invalidated task undo", err)
	}
	if err = s.Undo(event.ID, "user"); err == nil {
		t.Fatal("comment offered task undo")
	}
	if len(s.Events(0, task.ID, 100)) != 5 {
		t.Fatal("missing or duplicate activity")
	}
	if _, err = s.AddComment(task.ID, strings.Repeat("界", 10000), "user", ""); err != nil {
		t.Fatal(err)
	}
}

func TestCommentValidationAndConcurrentPosts(t *testing.T) {
	s := testStore(t)
	task := mustTask(t, s, Task{Title: "Concurrent comments"})
	for _, text := range []string{"", " \n\t", strings.Repeat("x", 10001)} {
		if _, err := s.AddComment(task.ID, text, "user", ""); err == nil {
			t.Fatal("accepted invalid comment")
		}
	}
	if _, err := s.AddComment("missing", "context", "user", ""); err == nil {
		t.Fatal("missing task accepted")
	}
	for _, task := range []Task{mustTask(t, s, Task{Title: "Deleted", DeletedAt: now()}), mustTask(t, s, Task{Title: "Merged source"})} {
		if task.DeletedAt == "" {
			task.MergedInto = "survivor"
			if err := s.Put("task", task.ID, task, "user", "fixture"); err != nil {
				t.Fatal(err)
			}
		}
		if _, err := s.AddComment(task.ID, "context", "user", ""); err == nil {
			t.Fatal("inactive task accepted")
		}
	}
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			if _, err := s.AddComment(task.ID, fmt.Sprint("Update ", i), "user", fmt.Sprint("request-", i)); err != nil {
				t.Error(err)
			}
		}(i)
	}
	wg.Wait()
	if len(s.Events(0, task.ID, 100)) != 9 {
		t.Fatal("lost concurrent comments")
	}
}

func TestCommentsAPIAndCompletionReasons(t *testing.T) {
	s := testService(t)
	task := mustTask(t, s.Store, Task{Title: "Comment API"})
	h := s.routes()
	path := "/api/tasks/" + task.ID
	var event Event
	json.Unmarshal(routeRequest(t, h, "POST", path+"/comments", map[string]string{"text": "User update", "requestId": "api-1"}, 200, false), &event)
	if event.Actor != "user" || event.Kind != "comment" {
		t.Fatal(event)
	}
	json.Unmarshal(routeRequest(t, h, "POST", path+"/comments", map[string]string{"text": "Agent update"}, 200, true), &event)
	if event.Actor == "user" {
		t.Fatal("agent attributed to user")
	}
	routeRequest(t, h, "POST", path+"/comments", "{", 400, false)
	routeRequest(t, h, "POST", path+"/comments", map[string]string{"text": " "}, 400, false)
	routeRequest(t, h, "POST", "/api/tasks/missing/comments", map[string]string{"text": "No task"}, 404, false)
	s.maintenance = true
	routeRequest(t, h, "POST", path+"/comments", map[string]string{"text": "Paused"}, 409, false)
	s.maintenance = false
	body := routeRequest(t, h, "GET", path, nil, 200, false)
	if !bytes.Contains(body, []byte(`"kind":"comment"`)) {
		t.Fatal("comment missing in history")
	}
	task.Status = "done"
	for _, actor := range []string{"user", "agent"} {
		if _, err := s.Store.SaveTask(task, task.Revision, actor, " \n", ""); err == nil {
			t.Fatal("completion without reason")
		}
		if _, err := s.Store.SaveTask(Task{Title: "Already finished", Status: "done"}, 0, actor, "", ""); err == nil {
			t.Fatal("created done without reason")
		}
	}
	task, err := s.Store.SaveTask(task, task.Revision, "user", "Verified the requested change", "")
	if err != nil {
		t.Fatal(err)
	}
	task.Description = "Editing completed work should not prompt again"
	if _, err = s.Store.SaveTask(task, task.Revision, "user", "", ""); err != nil {
		t.Fatal(err)
	}
}

func TestCommentWriteFailuresRollBack(t *testing.T) {
	for _, name := range []string{"events", "requests"} {
		t.Run(name, func(t *testing.T) {
			s := testStore(t)
			task := mustTask(t, s, Task{Title: "Keep atomic activity"})
			before := s.Latest()
			var err error
			if name == "events" {
				_, err = s.DB.Exec("CREATE TRIGGER refuse_comment BEFORE INSERT ON events BEGIN SELECT RAISE(FAIL,'fixture failure'); END")
			} else {
				_, err = s.DB.Exec("CREATE TRIGGER refuse_comment BEFORE INSERT ON requests BEGIN SELECT RAISE(FAIL,'fixture failure'); END")
			}
			if err != nil {
				t.Fatal(err)
			}
			if _, err := s.AddComment(task.ID, "Not persisted", "user", "request"); err == nil {
				t.Fatal("claimed success")
			}
			if s.Latest() != before {
				t.Fatal("partial comment persisted")
			}
		})
	}
	s := testStore(t)
	s.Close()
	if _, err := s.AddComment("missing", "context", "user", ""); err == nil {
		t.Fatal("closed store accepted comment")
	}
}

func TestAgentsReadAndPostSharedCommentsThroughCLI(t *testing.T) {
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
			t.Fatalf("%v: %v", args, err)
		}
		return out.Bytes()
	}
	task := mustTask(t, s.Store, Task{Title: "Shared context"})
	user, err := s.Store.AddComment(task.ID, "Please verify the edge cases", "user", "")
	if err != nil {
		t.Fatal(err)
	}
	var agent Event
	json.Unmarshal(call(false, "tasks", "comment", task.ID, "--text", "  Verified with tests  ", "--actor", "test-agent", "--request-id", "agent-comment"), &agent)
	if agent.Actor != "test-agent" || agent.Kind != "comment" || agent.Reason != "Verified with tests" || agent.At == "" {
		t.Fatal(agent)
	}
	var replay Event
	json.Unmarshal(call(false, "tasks", "comment", task.ID, "--text", "Verified with tests", "--actor", "test-agent", "--request-id", "agent-comment"), &replay)
	if replay.ID != agent.ID {
		t.Fatal("retry duplicated comment", replay)
	}
	call(true, "tasks", "comment", task.ID, "--text", "Different", "--actor", "test-agent", "--request-id", "agent-comment")
	var comments []Event
	json.Unmarshal(call(false, "tasks", "comments", task.ID), &comments)
	if len(comments) != 2 || comments[0].ID != user.ID || comments[1].ID != agent.ID {
		t.Fatal("agent could not read both authors", comments)
	}
	json.Unmarshal(call(false, "tasks", "comments", task.ID, "--after", strconv.FormatInt(user.ID, 10)), &comments)
	if len(comments) != 1 || comments[0].ID != agent.ID {
		t.Fatal("cursor lost comment", comments)
	}
	json.Unmarshal(call(false, "tasks", "comments", task.ID, "--after", strconv.FormatInt(agent.ID, 10)), &comments)
	if len(comments) != 0 {
		t.Fatal("cursor repeated comment")
	}
	for _, args := range [][]string{
		{"tasks", "comments"}, {"tasks", "comment"}, {"tasks", "comment", task.ID, "--text", " "},
		{"tasks", "comments", "missing"}, {"tasks", "comment", "missing", "--text", "Context"},
		{"tasks", "comments", task.ID, "--after", "-1"}, {"tasks", "comments", task.ID, "--after", "bad"},
	} {
		call(true, args...)
	}
	var fallback Event
	json.Unmarshal(call(false, "tasks", "comment", task.ID, "--text", "Agent, not user", "--actor", "user"), &fallback)
	if fallback.Actor != "local-agent" {
		t.Fatal("agent impersonated user", fallback)
	}
	for _, args := range [][]string{{"tasks", "get", task.ID}, {"history", task.ID}} {
		if !bytes.Contains(call(false, args...), []byte("Please verify the edge cases")) {
			t.Fatal("missing comment in task/history", args)
		}
	}
	var unchanged Task
	s.Store.Get("task", task.ID, &unchanged)
	if !bytes.Equal(encode(task), encode(unchanged)) {
		t.Fatal("agent comment edited task")
	}
}

func TestCommentsReadPaginationAndArchivedAccess(t *testing.T) {
	s := testService(t)
	task := mustTask(t, s.Store, Task{Title: "Long-lived task", Status: "done"})
	if err := s.Store.ArchiveCompleted(7, time.Now().Add(8*24*time.Hour)); err != nil {
		t.Fatal(err)
	}
	s.Store.Get("task", task.ID, &task)
	if task.ArchivedAt == "" {
		t.Fatal("fixture was not archived")
	}
	other := mustTask(t, s.Store, Task{Title: "Other task"})
	if _, err := s.Store.AddComment(other.ID, "Unrelated context", "user", ""); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 1001; i++ {
		if _, err := s.Store.AddComment(task.ID, fmt.Sprint("Context ", i), "user", ""); err != nil {
			t.Fatal(err)
		}
	}
	h := s.routes()
	path := "/api/tasks/" + task.ID + "/comments"
	var page []Event
	json.Unmarshal(routeRequest(t, h, "GET", path, nil, 200, true), &page)
	if len(page) != 1000 || page[0].Reason != "Context 0" || page[999].Reason != "Context 999" {
		t.Fatal("incorrect first comment page")
	}
	json.Unmarshal(routeRequest(t, h, "GET", path+"?after="+strconv.FormatInt(page[999].ID, 10), nil, 200, true), &page)
	if len(page) != 1 || page[0].Reason != "Context 1000" {
		t.Fatal("later comments inaccessible", page)
	}
}
