package sift

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

type fixtureTransport func(*http.Request) (*http.Response, error)

func (f fixtureTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func mockHTTP(t *testing.T, status int, body string, failure error) {
	t.Helper()
	previous := http.DefaultClient
	http.DefaultClient = &http.Client{Transport: fixtureTransport(func(r *http.Request) (*http.Response, error) {
		if failure != nil {
			return nil, failure
		}
		return &http.Response{StatusCode: status, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body)), Request: r}, nil
	})}
	t.Cleanup(func() { http.DefaultClient = previous })
}

func TestStableUpdateDiscoveryAndDownloadRefusals(t *testing.T) {
	for _, tc := range []struct {
		name      string
		status    int
		body      string
		failure   error
		available bool
		errorText string
	}{
		{"unreachable", 0, "", errors.New("offline fixture"), false, "Cannot reach GitHub"},
		{"unpublished", 404, "", nil, false, "No public Sift release"},
		{"rate-limited", 429, "", nil, false, "GitHub returned 429"},
		{"malformed", 200, "{", nil, false, "EOF"},
		{"prerelease", 200, `{"tag_name":"v99.0.0","prerelease":true}`, nil, false, ""},
		{"stable", 200, `{"tag_name":"v99.0.0","html_url":"https://github.com/akstspace/sift/releases/tag/v99.0.0","assets":[]}`, nil, true, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			mockHTTP(t, tc.status, tc.body, tc.failure)
			s := testService(t)
			info := s.CheckUpdate(context.Background())
			if info.Available != tc.available || !strings.Contains(info.Error, tc.errorText) || info.CheckedAt.IsZero() || info.Current != Version {
				t.Fatal(info)
			}
			if !tc.available {
				if _, err := s.ApplyUpdate(context.Background()); err == nil {
					t.Fatal("unavailable update accepted")
				}
			} else if _, err := s.ApplyUpdate(context.Background()); err == nil || !strings.Contains(err.Error(), "lacks") {
				t.Fatal("missing platform/checksum accepted", err)
			}
		})
	}
	for _, tc := range []struct {
		a, b string
		want bool
	}{{"v1.1.0", "1.0.0", true}, {"1.0.1", "1.0.0", true}, {"2.0.0", "1.9.9", true}, {"1.0.0", "1.0.0", false}, {"1.0.0", "1.0.0-dev", true}, {"1.0.0", "2.0.0", false}, {"invalid", "1.0.0", false}, {"1.0.0", "invalid", false},
		{"99.0.0-rc.1", "1.0.0", false}, {"99.0.0-dev", "1.0.0", false}, {"99.0.0.1", "1.0.0", false}, {"99.0.0 trailing", "1.0.0", false}, {"099.0.0", "1.0.0", false}, {"-1.0.0", "1.0.0", false}, {"1.-1.0", "1.0.0", false}, {"1.0.-1", "1.0.0", false},
		{"99.0.0", "-1.0.0", false}, {"99.0.0", "1.-1.0", false}, {"99.0.0", "1.0.-1", false}, {"99.0.0", "1.0.0-rc.1", false}} {
		if newerVersion(tc.a, tc.b) != tc.want {
			t.Fatalf("newerVersion(%q,%q)", tc.a, tc.b)
		}
	}
	for _, url := range []string{"http://github.com/akstspace/sift/releases/download/v1/a", "https://github.com/evil/sift/releases/download/v1/a", "https://evil.example/a"} {
		if _, err := downloadRelease(context.Background(), url, 10); err == nil {
			t.Fatal("foreign asset accepted")
		}
	}
	for _, tc := range []struct {
		status    int
		body      string
		failure   error
		wantError bool
	}{{200, "valid", nil, false}, {200, "too many bytes", nil, true}, {500, "", nil, true}, {0, "", errors.New("offline"), true}} {
		t.Run("download-"+tc.body, func(t *testing.T) {
			mockHTTP(t, tc.status, tc.body, tc.failure)
			data, err := downloadRelease(context.Background(), "https://github.com/akstspace/sift/releases/download/v1/fixture", 8)
			if (err != nil) != tc.wantError || (!tc.wantError && string(data) != tc.body) {
				t.Fatal(string(data), err)
			}
		})
	}
}

func TestReleaseRedirectsAreCheckedBeforeFollowingEveryHop(t *testing.T) {
	base := "https://github.com/akstspace/sift/releases/download/v1.0.0/sift.tar.gz"
	for _, target := range []string{
		"http://github.com/a", "https://evil.example/a", "file:///etc/passwd",
		"https://github.com:8443/a", "https://user:password@github.com/a",
		"https://github.com.evil.example/a",
	} {
		t.Run(target, func(t *testing.T) {
			previous := http.DefaultClient
			requests := 0
			http.DefaultClient = &http.Client{Transport: fixtureTransport(func(r *http.Request) (*http.Response, error) {
				requests++
				return &http.Response{StatusCode: 302, Header: http.Header{"Location": []string{target}}, Body: io.NopCloser(strings.NewReader("")), Request: r}, nil
			})}
			t.Cleanup(func() { http.DefaultClient = previous })
			if _, err := downloadRelease(context.Background(), base, 20); err == nil || requests != 1 {
				t.Fatal("unsafe redirect followed", requests, err)
			}
		})
	}
	t.Run("approved asset host", func(t *testing.T) {
		previous := http.DefaultClient
		hops := 0
		http.DefaultClient = &http.Client{Transport: fixtureTransport(func(r *http.Request) (*http.Response, error) {
			hops++
			if hops == 1 {
				return &http.Response{StatusCode: 302, Header: http.Header{"Location": []string{"https://release-assets.githubusercontent.com/fixture"}}, Body: io.NopCloser(strings.NewReader("")), Request: r}, nil
			}
			return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader("verified bytes")), Request: r}, nil
		})}
		t.Cleanup(func() { http.DefaultClient = previous })
		data, err := downloadRelease(context.Background(), base, 20)
		if err != nil || string(data) != "verified bytes" || hops != 2 {
			t.Fatal(string(data), hops, err)
		}
		if http.DefaultClient.CheckRedirect != nil {
			t.Fatal("redirect policy mutated shared HTTP client")
		}
	})
	u, _ := url.Parse("https://github.com/fixture")
	if err := releaseClient().CheckRedirect(&http.Request{URL: u}, make([]*http.Request, 10)); err == nil {
		t.Fatal("redirect loop accepted")
	}
	for _, host := range []string{"api.github.com", "github.com:443", "objects.githubusercontent.com"} {
		u, _ := url.Parse("https://" + host + "/fixture")
		if !allowedReleaseRedirect(u) {
			t.Fatal("official host refused", host)
		}
	}
}

func TestSetupIsScopedAndNeverSilentlyOverwrites(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	s := testService(t)
	if _, err := s.Setup("unknown", false); err == nil {
		t.Fatal("unknown setup accepted")
	}
	for _, action := range []string{"skill", "cli"} {
		result, err := s.Setup(action, false)
		if err != nil || result["installed"] != true {
			t.Fatal(action, result, err)
		}
		if _, err := s.Setup(action, false); err != nil {
			t.Fatal("idempotent setup", err)
		}
	}
	skill := filepath.Join(home, ".agents", "skills", "sift", "SKILL.md")
	if err := os.WriteFile(skill, []byte("Person's local changes"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Setup("skill", false); err == nil {
		t.Fatal("local skill overwritten")
	}
	if data, _ := os.ReadFile(skill); string(data) != "Person's local changes" {
		t.Fatal("local edits lost")
	}
	if _, err := s.Setup("skill", true); err != nil {
		t.Fatal(err)
	}
	cli := filepath.Join(home, ".local", "bin", "sift")
	if err := os.Remove(cli); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cli, []byte("Existing unrelated executable"), 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Setup("cli", true); err == nil {
		t.Fatal("unrelated executable replaced")
	}
	if runtime.GOOS == "darwin" {
		s.Address = "127.0.0.1:12345"
		result, err := s.Setup("startup", false)
		if err != nil || result["installed"] != true {
			t.Fatal(result, err)
		}
		data, _ := os.ReadFile(result["path"].(string))
		if !strings.Contains(string(data), "127.0.0.1:12345") || !strings.Contains(string(data), s.Dir) {
			t.Fatal("startup workspace/port lost")
		}
		if _, err := s.Setup("startup", false); err == nil {
			t.Fatal("startup overwritten without consent")
		}
		if _, err := s.Setup("startup", true); err != nil {
			t.Fatal(err)
		}
	}
	for _, shell := range []string{".zshrc", ".bashrc", ".profile"} {
		if _, err := os.Stat(filepath.Join(home, shell)); !os.IsNotExist(err) {
			t.Fatal("shell profile changed")
		}
	}
}

func TestSchedulerCoalescesDueTriggersAndRunsOneCatchup(t *testing.T) {
	fixturePi(t)
	s := testService(t)
	j := fixtureJob(t, s, "hang")
	j.Enabled = true
	j.NextRun = time.Now().Add(-7 * 24 * time.Hour).Format(time.RFC3339Nano)
	if err := s.Store.Put("job", j.ID, j, "fixture", "Missed schedule"); err != nil {
		t.Fatal(err)
	}
	s.scheduleTick(time.Now())
	s.runMu.Lock()
	runID := s.activeRun[j.ID]
	s.runMu.Unlock()
	if runID == "" || len(listAs[Run](s.Store, "run")) != 1 {
		t.Fatal("missing single catch-up")
	}
	var active Job
	s.Store.Get("job", j.ID, &active)
	active.NextRun = time.Now().Add(-time.Minute).Format(time.RFC3339Nano)
	s.Store.Put("job", j.ID, active, "fixture", "Due while active")
	s.scheduleTick(time.Now())
	s.Store.Get("job", j.ID, &active)
	if !active.Pending || len(listAs[Run](s.Store, "run")) != 1 {
		t.Fatal("overlap or lost pending trigger")
	}
	s.scheduleTick(time.Now())
	if len(listAs[Run](s.Store, "run")) != 1 {
		t.Fatal("coalesced trigger overlapped")
	}
	if err := s.CancelRun(runID); err != nil {
		t.Fatal(err)
	}
	awaitRun(t, s, runID, "cancelled")
	s.runMu.Lock()
	s.maintenance = true
	s.runMu.Unlock()
	s.scheduleTick(time.Now())
	if len(listAs[Run](s.Store, "run")) != 1 {
		t.Fatal("maintenance launched a run")
	}
}

func TestMaintenanceReportsBackupFailureAndRetriesWithoutNetwork(t *testing.T) {
	s := testService(t)
	var cfg Settings
	s.Store.Get("settings", "app", &cfg)
	cfg.CheckUpdates = false
	s.Store.Put("settings", "app", cfg, "fixture", "")
	path := filepath.Join(s.Dir, "backups")
	if err := os.WriteFile(path, []byte("block directory creation"), 0600); err != nil {
		t.Fatal(err)
	}
	s.checkMaintenance()
	s.Store.Get("settings", "app", &cfg)
	if cfg.BackupError == "" {
		t.Fatal("backup failure hidden")
	}
	cursor := s.Store.Latest()
	s.checkMaintenance()
	if s.Store.Latest() != cursor {
		t.Fatal("same failure emitted redundant writes")
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	s.checkMaintenance()
	s.Store.Get("settings", "app", &cfg)
	if cfg.LastBackup == "" || cfg.BackupError != "" {
		t.Fatal("recovery not recorded", cfg)
	}
	s.checkMaintenance()
}
