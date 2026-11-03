package sift

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func fixturePi(t *testing.T) {
	t.Helper()
	src, e := filepath.Abs("testdata/pi-fixture.py")
	if e != nil {
		t.Fatal(e)
	}
	wrapper := filepath.Join(t.TempDir(), "pi")
	if e = os.WriteFile(wrapper, []byte("#!/bin/sh\nexec python3 \""+src+"\" \"$@\"\n"), 0700); e != nil {
		t.Fatal(e)
	}
	t.Setenv("SIFT_PI", wrapper)
}
func fixtureJob(t *testing.T, s *Service, scenario string) Job {
	t.Helper()
	j, e := s.SaveJob(Job{Name: scenario, Prompt: "scenario:" + scenario, Directory: s.Dir, Provider: "fixture", Model: "fixture-model", Timezone: "UTC", Schedules: []JobSchedule{{Type: "daily", Schedule: "09:00"}}}, 0, "user")
	if e != nil {
		t.Fatal(e)
	}
	return j
}
func awaitRun(t *testing.T, s *Service, id, status string) Run {
	t.Helper()
	deadline := time.NewTimer(8 * time.Second)
	defer deadline.Stop()
	tick := time.NewTicker(10 * time.Millisecond)
	defer tick.Stop()
	for {
		var r Run
		s.Store.Get("run", id, &r)
		if r.Status != "running" {
			if r.Status != status {
				t.Fatalf("got %s: %s, want %s", r.Status, r.Error, status)
			}
			return r
		}
		select {
		case <-deadline.C:
			t.Fatal("run did not settle")
		case <-tick.C:
		}
	}
}

func TestPiRPCDiscoveryAndLifecycle(t *testing.T) {
	fixturePi(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	p, e := ProbePi(ctx, "", "")
	if e != nil || p["connected"] != true {
		t.Fatal(p, e)
	}
	for _, scenario := range []struct{ name, status string }{{"success", "succeeded"}, {"handled", "succeeded"}, {"auth", "action-needed"}, {"approval", "action-needed"}} {
		t.Run(scenario.name, func(t *testing.T) {
			s := testService(t)
			j := fixtureJob(t, s, scenario.name)
			r, e := s.RunJob(j.ID)
			if e != nil {
				t.Fatal(e)
			}
			out := awaitRun(t, s, r.ID, scenario.status)
			if scenario.name == "success" && (!strings.Contains(out.Summary, "Fixture evidence") || len(s.Store.Logs(r.ID)) < 2) {
				t.Fatal("streamed evidence lost", out)
			}
		})
	}
}
func TestThreeConcurrentJobsAndOnePending(t *testing.T) {
	fixturePi(t)
	s := testService(t)
	jobs := []Job{}
	runs := []Run{}
	for i := 0; i < 4; i++ {
		j := fixtureJob(t, s, "hang")
		jobs = append(jobs, j)
		r, e := s.RunJob(j.ID)
		if i < 3 {
			if e != nil {
				t.Fatal(e)
			}
			runs = append(runs, r)
		} else if e == nil {
			t.Fatal("fourth run exceeded default limit")
		}
	}
	for i := 0; i < 4; i++ {
		if _, e := s.RunJob(jobs[0].ID); e == nil {
			t.Fatal("same job overlapped")
		}
	}
	s.runMu.Lock()
	n := len(s.active)
	s.runMu.Unlock()
	if n != 3 {
		t.Fatal("want 3 active", n)
	}
	var queued Job
	s.Store.Get("job", jobs[0].ID, &queued)
	if !queued.Pending {
		t.Fatal("missing pending trigger")
	}
	if e := s.CancelRun(runs[0].ID); e != nil {
		t.Fatal(e)
	}
	awaitRun(t, s, runs[0].ID, "cancelled")
	for _, r := range runs[1:] {
		s.CancelRun(r.ID)
		awaitRun(t, s, r.ID, "cancelled")
	}
}
func TestPiModelFailureHasNoFallback(t *testing.T) {
	fixturePi(t)
	s := testService(t)
	j := fixtureJob(t, s, "success")
	j.Model = "missing"
	var e error
	j, e = s.SaveJob(j, j.Revision, "user")
	if e != nil {
		t.Fatal(e)
	}
	r, e := s.RunJob(j.ID)
	if e != nil {
		t.Fatal(e)
	}
	out := awaitRun(t, s, r.ID, "action-needed")
	if !strings.Contains(out.Error, "Model unavailable") {
		t.Fatal(out)
	}
	if len(s.Store.Logs(r.ID)) != 0 {
		t.Fatal("prompt ran despite unavailable model")
	}
}
func TestPiTimeout(t *testing.T) {
	fixturePi(t)
	s := testService(t)
	j := fixtureJob(t, s, "hang")
	r := Run{ID: "run-timeout", JobID: j.ID, JobName: j.Name, Status: "running"}
	s.Store.Put("run", r.ID, r, "system", "")
	ctx, cancel := context.WithTimeout(context.Background(), 250*time.Millisecond)
	defer cancel()
	s.executeRun(ctx, j, r)
	var result Run
	s.Store.Get("run", r.ID, &result)
	if result.Status != "timed-out" {
		t.Fatal(result)
	}
}
func TestCrashRecoveryDoesNotRetry(t *testing.T) {
	dir := t.TempDir()
	s, e := NewService(dir)
	if e != nil {
		t.Fatal(e)
	}
	s.Store.Put("run", "old", Run{ID: "old", Status: "running"}, "system", "")
	s.Close()
	s, e = NewService(dir)
	if e != nil {
		t.Fatal(e)
	}
	defer s.Close()
	var r Run
	s.Store.Get("run", "old", &r)
	if r.Status != "interrupted" || len(s.active) != 0 || len(listAs[Run](s.Store, "run")) != 1 {
		t.Fatal(r)
	}
}
