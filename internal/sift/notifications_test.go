package sift

import (
	"encoding/json"
	"sort"
	"testing"
)

func notificationIDs(s *Service) []string {
	ids := []string{}
	for _, n := range listAs[Notification](s.Store, "notification") {
		ids = append(ids, n.ID)
	}
	sort.Strings(ids)
	return ids
}

func TestPeopleCanClearOneOrAllNotificationsTheySaw(t *testing.T) {
	s := testService(t)
	h := s.routes()
	for _, title := range []string{"First", "Second", "Third"} {
		s.Notify(title, "Local evidence")
	}
	ids := notificationIDs(s)

	var out map[string]int
	before := s.Store.Latest()
	json.Unmarshal(routeRequest(t, h, "POST", "/api/notifications/clear", map[string]any{"ids": []string{ids[0]}}, 200, false), &out)
	if out["cleared"] != 1 || len(notificationIDs(s)) != 2 {
		t.Fatal("clearing one notification removed the wrong count", out, notificationIDs(s))
	}
	if s.Store.Latest() == before {
		t.Fatal("clearing a notification did not reach live clients")
	}

	// "Clear all" sends only what the person saw: one that arrives meanwhile
	// stays, the already-cleared ID and a repeat are skipped.
	s.Notify("Arrived while clicking", "Still unseen")
	before = s.Store.Latest()
	json.Unmarshal(routeRequest(t, h, "POST", "/api/notifications/clear", map[string]any{"ids": []string{ids[0], ids[1], ids[2], ids[2]}}, 200, false), &out)
	if out["cleared"] != 2 {
		t.Fatal("clear all did not report the notifications it removed", out)
	}
	left := listAs[Notification](s.Store, "notification")
	if len(left) != 1 || left[0].Title != "Arrived while clicking" {
		t.Fatal("clear all removed a notification the person had not seen", left)
	}
	events := s.Store.Events(before, "", 100)
	if len(events) != 2 || events[0].Group == "" || events[0].Group != events[1].Group {
		t.Fatal("clear all was not recorded as one history group", events)
	}
	for _, e := range events {
		if e.Kind != "notification" || e.Actor != "user" || e.Reason != "Cleared notification" || e.After != nil || e.Before == nil {
			t.Fatal("cleared notification history is incomplete", e)
		}
	}

	// Clearing something already gone (another window got there first) is a
	// harmless no-op that does not wake live clients.
	before = s.Store.Latest()
	json.Unmarshal(routeRequest(t, h, "POST", "/api/notifications/clear", map[string]any{"ids": []string{ids[1], "missing"}}, 200, false), &out)
	if out["cleared"] != 0 || s.Store.Latest() != before {
		t.Fatal("clearing missing notifications changed the workspace", out)
	}
}

func TestOnlyPeopleCanClearNotificationsAndRequestsAreChecked(t *testing.T) {
	s := testService(t)
	h := s.routes()
	s.Notify("Job needs attention", "Daily review: timed out")
	ids := notificationIDs(s)
	routeRequest(t, h, "POST", "/api/notifications/clear", map[string]any{"ids": ids}, 403, true)
	routeRequest(t, h, "POST", "/api/notifications/clear", map[string]any{"ids": []string{}}, 400, false)
	routeRequest(t, h, "POST", "/api/notifications/clear", map[string]any{}, 400, false)
	routeRequest(t, h, "POST", "/api/notifications/clear", "not json", 400, false)
	s.dataMu.Lock()
	routeRequest(t, h, "POST", "/api/notifications/clear", map[string]any{"ids": ids}, 409, false)
	s.dataMu.Unlock()
	if _, err := s.Store.DB.Exec(`CREATE TRIGGER refuse_clear BEFORE DELETE ON objects BEGIN SELECT RAISE(FAIL,'fixture storage failure'); END`); err != nil {
		t.Fatal(err)
	}
	routeRequest(t, h, "POST", "/api/notifications/clear", map[string]any{"ids": ids}, 500, false)
	if len(notificationIDs(s)) != 1 {
		t.Fatal("refused or failed clears removed a notification")
	}
}

func TestClearingNotificationsReportsStorageFailures(t *testing.T) {
	s := testService(t)
	s.Notify("Evidence", "Local evidence")
	ids := notificationIDs(s)
	if _, err := s.Store.DB.Exec(`CREATE TRIGGER refuse_history BEFORE INSERT ON events BEGIN SELECT RAISE(FAIL,'fixture history failure'); END`); err != nil {
		t.Fatal(err)
	}
	if n, err := s.Store.ClearNotifications(ids, "user"); err == nil || n != 0 {
		t.Fatal("history failure reported a successful clear", n, err)
	}
	if len(notificationIDs(s)) != 1 {
		t.Fatal("failed clear removed a notification without history")
	}
	s.Store.Close()
	if _, err := s.Store.ClearNotifications(ids, "user"); err == nil {
		t.Fatal("closed store reported a successful clear")
	}
}
