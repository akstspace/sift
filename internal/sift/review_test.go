package sift

import (
	"encoding/json"
	"testing"
)

// fetch reads a task fresh: decoding into a used Task keeps fields the JSON omits.
func fetch(s *Store, id string) Task {
	var v Task
	s.Get("task", id, &v)
	return v
}

func TestAgentStatusChangesAwaitTheirReview(t *testing.T) {
	s := testStore(t)
	task := mustTask(t, s, Task{Title: "Fix staging CI"})
	save := func(v Task, actor, reason string) Task {
		t.Helper()
		out, err := s.SaveTask(v, v.Revision, actor, reason, "")
		if err != nil {
			t.Fatal(err)
		}
		return out
	}
	// An agent creating work or editing other fields leaves nothing to review.
	created, err := s.SaveTask(Task{Title: "Agent found this"}, 0, "job:job_1", "", "")
	if err != nil || created.AgentChange != "" {
		t.Fatal("creation flagged", created, err)
	}
	task.Priority = "high"
	task = save(task, "chat", "Raised after the outage")
	if task.AgentChange != "" {
		t.Fatal("a priority change flagged", task)
	}
	// An agent's status change waits for review; later agent edits keep it.
	task.Status = "done"
	task = save(task, "job:job_1", "CI passed at dc2ea74")
	if task.AgentChange != "job:job_1" {
		t.Fatal("status change not flagged", task)
	}
	task.Priority = "low"
	task.AgentChange = ""
	task = save(task, "chat", "Less urgent now")
	if task.AgentChange != "job:job_1" {
		t.Fatal("an agent cleared or rewrote the flag", task)
	}
	// The person's own save counts as reviewing it, whatever it changes.
	task.Description = "Looked at it"
	task.AgentChange = "spoofed"
	task = save(task, "user", "")
	if task.AgentChange != "" {
		t.Fatal("person's save kept the flag", task)
	}

	// Reopening a completed parent through its child flags the parent too.
	parent := mustTask(t, s, Task{Title: "Parent", Status: "done"})
	child, err := s.SaveTask(Task{Title: "Child", ParentID: parent.ID}, 0, "local-agent", "Found more work", "")
	if err != nil {
		t.Fatal(err)
	}
	reopened := fetch(s, parent.ID)
	if reopened.Status != "open" || reopened.AgentChange != "local-agent" || child.AgentChange != "" {
		t.Fatal("reopened parent not flagged", reopened, child)
	}
}

func TestUndoAndMergeKeepTheReviewFlagHonest(t *testing.T) {
	s := testStore(t)
	task := mustTask(t, s, Task{Title: "Undo me"})
	task.Status = "done"
	task, err := s.SaveTask(task, task.Revision, "chat", "Done per the thread", "")
	if err != nil || task.AgentChange != "chat" {
		t.Fatal(task, err)
	}
	events := s.Events(0, task.ID, 10)
	// The person undoing the agent's change leaves nothing to review.
	if err = s.Undo(events[len(events)-1].ID, "user"); err != nil {
		t.Fatal(err)
	}
	task = fetch(s, task.ID)
	if task.Status != "open" || task.AgentChange != "" {
		t.Fatal("undo kept the flag", task)
	}
	// An agent undoing a status change is itself a status change to review.
	task.Status = "done"
	task, _ = s.SaveTask(task, task.Revision, "user", "", "")
	events = s.Events(0, task.ID, 10)
	if err = s.Undo(events[len(events)-1].ID, "local-agent"); err != nil {
		t.Fatal(err)
	}
	task = fetch(s, task.ID)
	if task.Status != "open" || task.AgentChange != "local-agent" {
		t.Fatal("agent undo not flagged", task)
	}

	// A merge that reopens the survivor (an open subtask moves into a done
	// task) flags it when an agent merged, and clears it when the person did.
	for _, actor := range []string{"chat", "user"} {
		survivor := mustTask(t, s, Task{Title: "Survivor " + actor, Status: "done"})
		source := mustTask(t, s, Task{Title: "Source " + actor})
		mustTask(t, s, Task{Title: "Open child " + actor, ParentID: source.ID})
		source = fetch(s, source.ID)
		if err = s.Merge(source.ID, survivor.ID, source.Revision, survivor.Revision, actor, "Same work"); err != nil {
			t.Fatal(err)
		}
		survivor = fetch(s, survivor.ID)
		want := map[string]string{"chat": "chat", "user": ""}[actor]
		if survivor.Status != "open" || survivor.AgentChange != want {
			t.Fatal(actor, "merge flag", survivor)
		}
	}
}

func TestReviewClearsTheFlagWithoutANewRevision(t *testing.T) {
	s := testService(t)
	task := mustTask(t, s.Store, Task{Title: "Reviewed"})
	task.Status = "done"
	task, err := s.Store.SaveTask(task, task.Revision, "job:job_1", "Shipped", "")
	if err != nil {
		t.Fatal(err)
	}
	h := s.routes()
	path := "/api/tasks/" + task.ID + "/review"
	routeRequest(t, h, "POST", path, nil, 403, true)
	s.maintenance = true
	routeRequest(t, h, "POST", path, nil, 409, false)
	s.maintenance = false
	routeRequest(t, h, "POST", "/api/tasks/missing/review", nil, 404, false)
	var got Task
	json.Unmarshal(routeRequest(t, h, "POST", path, nil, 200, false), &got)
	if got.AgentChange != "" || got.Revision != task.Revision || got.Status != "done" {
		t.Fatal("review changed more than the flag", got)
	}
	events := s.Store.Events(0, task.ID, 10)
	last := events[len(events)-1]
	if last.Kind != "review" || last.Actor != "user" || last.Reason != "job:job_1" {
		t.Fatal("review not recorded", last)
	}
	// Reviewing again is a no-op, and the reviewed change can still be undone.
	json.Unmarshal(routeRequest(t, h, "POST", path, nil, 200, false), &got)
	if n := len(s.Store.Events(0, task.ID, 10)); n != len(events) {
		t.Fatal("repeat review recorded", n)
	}
	if err = s.Store.Undo(events[len(events)-2].ID, "user"); err != nil {
		t.Fatal("review blocked undo", err)
	}
	if err = s.Store.Undo(last.ID, "user"); err == nil {
		t.Fatal("a review was undoable")
	}
}
