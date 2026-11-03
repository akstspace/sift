package sift

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

// Loading the page checks GitHub only when update checks are on, and reuses a
// recent answer so reloads don't spend GitHub's anonymous rate limit.
func TestPageLoadRefreshesUpdatesAtMostEveryFewMinutes(t *testing.T) {
	requests := 0
	previous := http.DefaultClient
	http.DefaultClient = &http.Client{Transport: fixtureTransport(func(r *http.Request) (*http.Response, error) {
		requests++
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"tag_name":"v99.0.0","html_url":"https://github.com/akstspace/sift/releases/tag/v99.0.0"}`)), Request: r}, nil
	})}
	t.Cleanup(func() { http.DefaultClient = previous })
	s := testService(t)
	h := s.routes()
	var cfg Settings
	s.Store.Get("settings", "app", &cfg)
	cfg.CheckUpdates = false
	if err := s.SaveSettings(cfg); err != nil {
		t.Fatal(err)
	}
	if info := s.RefreshUpdate(context.Background()); requests != 0 || info.Latest != "" {
		t.Fatal("a page load contacted GitHub with update checks off", requests, info)
	}
	cfg.CheckUpdates = true
	if err := s.SaveSettings(cfg); err != nil {
		t.Fatal(err)
	}
	routeRequest(t, h, "POST", "/api/update/refresh", map[string]any{}, 200, false)
	if info := s.RefreshUpdate(context.Background()); requests != 1 || info.Latest != "v99.0.0" || !info.Available {
		t.Fatal("a fresh check was not reused, or the release was missed", requests, info)
	}
	// Maintenance never blocks reading the update status.
	s.dataMu.Lock()
	routeRequest(t, h, "POST", "/api/update/refresh", map[string]any{}, 200, false)
	s.dataMu.Unlock()
	previousInterval := updateRefreshInterval
	updateRefreshInterval = time.Nanosecond
	t.Cleanup(func() { updateRefreshInterval = previousInterval })
	time.Sleep(time.Millisecond)
	if s.RefreshUpdate(context.Background()); requests != 2 {
		t.Fatal("a stale answer was not refreshed", requests)
	}
}
