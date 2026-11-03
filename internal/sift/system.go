package sift

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

type UpdateInfo struct {
	Current   string    `json:"current"`
	Latest    string    `json:"latest"`
	Available bool      `json:"available"`
	URL       string    `json:"url"`
	Error     string    `json:"error"`
	CheckedAt time.Time `json:"checkedAt"`
	// Installed is a version already written over this executable that only
	// takes effect after a restart; it survives later checks until then.
	Installed       string         `json:"installed,omitempty"`
	RestartRequired bool           `json:"restartRequired"`
	Assets          []ReleaseAsset `json:"-"`
}
type ReleaseAsset struct {
	Name string `json:"name"`
	URL  string `json:"browser_download_url"`
}

func (s *Service) CheckUpdate(ctx context.Context) UpdateInfo {
	reportProgress(ctx, "Checking stable Sift releases on GitHub", 0, 0, "")
	s.updateMu.Lock()
	defer s.updateMu.Unlock()
	info := UpdateInfo{Current: Version, CheckedAt: time.Now()}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", "https://api.github.com/repos/akstspace/sift/releases/latest", nil)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "Sift/"+Version)
	r, err := releaseClient().Do(req)
	if err != nil {
		info.Error = "Cannot reach GitHub: " + err.Error()
	} else {
		defer r.Body.Close()
		if r.StatusCode == 404 {
			info.Error = "No public Sift release has been published yet"
		} else if r.StatusCode != 200 {
			info.Error = fmt.Sprintf("GitHub returned %d; try again later", r.StatusCode)
		} else {
			var release struct {
				Tag        string         `json:"tag_name"`
				HTML       string         `json:"html_url"`
				Prerelease bool           `json:"prerelease"`
				Assets     []ReleaseAsset `json:"assets"`
			}
			if err = json.NewDecoder(io.LimitReader(r.Body, 2<<20)).Decode(&release); err != nil {
				info.Error = err.Error()
			} else if !release.Prerelease {
				info.Latest = release.Tag
				info.URL = release.HTML
				info.Assets = release.Assets
				info.Available = newerVersion(release.Tag, Version)
			}
		}
	}
	info.Installed, info.RestartRequired = s.update.Installed, s.update.RestartRequired
	if info.Available && info.Installed != info.Latest && s.replacedExecutableVersion(ctx) == strings.TrimPrefix(info.Latest, "v") {
		info.Installed, info.RestartRequired = info.Latest, true
	}
	s.update = info
	return info
}

// replacedExecutableVersion reports the version of the executable on disk when
// it is no longer the file this process started from: an update installed by
// an earlier process, the CLI, or an installer that only needs a restart. It
// runs nothing while the file is unchanged.
func (s *Service) replacedExecutableVersion(ctx context.Context) string {
	if s.startedFrom == nil {
		return ""
	}
	exe, err := executablePath()
	if err != nil {
		return ""
	}
	current, err := os.Stat(exe)
	if err != nil || (os.SameFile(current, s.startedFrom) && current.Size() == s.startedFrom.Size() && current.ModTime().Equal(s.startedFrom.ModTime())) {
		return ""
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, exe, "version").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}
func newerVersion(a, b string) bool {
	var av, bv [3]int
	stable := strings.TrimPrefix(a, "v")
	current := strings.TrimSuffix(strings.TrimPrefix(b, "v"), "-dev")
	_, ea := fmt.Sscanf(stable, "%d.%d.%d", &av[0], &av[1], &av[2])
	_, eb := fmt.Sscanf(current, "%d.%d.%d", &bv[0], &bv[1], &bv[2])
	if ea != nil || eb != nil || av[0] < 0 || av[1] < 0 || av[2] < 0 || bv[0] < 0 || bv[1] < 0 || bv[2] < 0 ||
		stable != fmt.Sprintf("%d.%d.%d", av[0], av[1], av[2]) || current != fmt.Sprintf("%d.%d.%d", bv[0], bv[1], bv[2]) {
		return false
	}
	for i := range av {
		if av[i] != bv[i] {
			return av[i] > bv[i]
		}
	}
	return strings.HasSuffix(b, "-dev")
}
func allowedReleaseURL(v string) bool {
	return strings.HasPrefix(v, "https://github.com/akstspace/sift/releases/download/")
}

// updateRefreshInterval bounds how often opening or reloading Sift asks GitHub
// for the latest release; GitHub limits anonymous requests per address.
var updateRefreshInterval = 2 * time.Minute

// RefreshUpdate checks for a new release when the page loads. It respects the
// "Check for updates" setting and reuses a result younger than
// updateRefreshInterval, so reloads never hammer GitHub.
func (s *Service) RefreshUpdate(ctx context.Context) UpdateInfo {
	var cfg Settings
	s.Store.Get("settings", "app", &cfg)
	s.updateMu.Lock()
	info := s.update
	s.updateMu.Unlock()
	if !cfg.CheckUpdates || time.Since(info.CheckedAt) < updateRefreshInterval {
		return info
	}
	return s.CheckUpdate(ctx)
}

// Clone the configured client so tests and callers keep their transport, while
// no redirect can downgrade TLS or leave GitHub's release delivery hosts.
func releaseClient() *http.Client {
	client := *http.DefaultClient
	client.CheckRedirect = func(req *http.Request, via []*http.Request) error {
		if len(via) >= 10 {
			return invalid("Too many release redirects")
		}
		if !allowedReleaseRedirect(req.URL) {
			return invalid("Release redirect is outside GitHub HTTPS asset hosts")
		}
		return nil
	}
	return &client
}
func allowedReleaseRedirect(u *url.URL) bool {
	if u.Scheme != "https" || u.User != nil || (u.Port() != "" && u.Port() != "443") {
		return false
	}
	switch u.Hostname() {
	case "github.com", "api.github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com":
		return true
	}
	return false
}

// Release downloads cross the network: a dropped connection or a brief GitHub
// fault is retried before it is reported, as a GitHub problem (502), not a
// fault in Sift.
const releaseAttempts = 3

var releaseRetryDelay = time.Second

func downloadRelease(ctx context.Context, url string, limit int64) ([]byte, error) {
	if !allowedReleaseURL(url) {
		return nil, invalid("Release asset is outside akstspace/sift")
	}
	for attempt := 1; ; attempt++ {
		b, retry, err := fetchRelease(ctx, url, limit)
		if err == nil || !retry || attempt == releaseAttempts {
			return b, err
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(releaseRetryDelay * time.Duration(attempt)):
		}
	}
}
func fetchRelease(ctx context.Context, url string, limit int64) (b []byte, retry bool, err error) {
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return nil, false, err
	}
	r, err := releaseClient().Do(req)
	if err != nil {
		var refused *APIError
		if errors.As(err, &refused) || ctx.Err() != nil {
			return nil, false, err
		}
		return nil, true, upstream(err, "Couldn’t reach GitHub to download the update: %v", err)
	}
	defer r.Body.Close()
	if r.StatusCode != 200 {
		transient := r.StatusCode >= 500 || r.StatusCode == http.StatusTooManyRequests
		return nil, transient, upstream(nil, "GitHub returned HTTP %d for the update download; try again later", r.StatusCode)
	}
	b, err = io.ReadAll(&progressReader{reader: io.LimitReader(r.Body, limit+1), ctx: ctx, message: "Downloading release file", total: r.ContentLength})
	if int64(len(b)) > limit {
		return nil, false, invalid("Release exceeds download limit")
	}
	if err != nil {
		if ctx.Err() != nil {
			return nil, false, err
		}
		return nil, true, upstream(err, "The update download was interrupted: %v", err)
	}
	return b, false, nil
}
func (s *Service) ApplyUpdate(ctx context.Context) (map[string]any, error) {
	info := s.CheckUpdate(ctx)
	if info.Error != "" {
		return nil, invalid("%s", info.Error)
	}
	if info.RestartRequired && info.Installed == info.Latest {
		// Already on disk; only the restart is missing. Never download it again.
		release, err := s.beginMaintenance()
		if err != nil {
			return nil, err
		}
		defer release()
		return s.installed(ctx, info.Latest), nil
	}
	if !info.Available {
		return nil, invalid("No newer stable release is available")
	}
	name := "sift_" + runtime.GOOS + "_" + runtime.GOARCH + ".tar.gz"
	var asset, checks string
	for _, a := range info.Assets {
		if a.Name == name {
			asset = a.URL
		}
		if a.Name == "checksums.txt" {
			checks = a.URL
		}
	}
	if asset == "" || checks == "" {
		return nil, invalid("Release lacks this platform's binary or checksums.txt")
	}
	reportProgress(ctx, "Downloading release checksums", 0, 0, "")
	sumFile, err := downloadRelease(ctx, checks, 1<<20)
	if err != nil {
		return nil, err
	}
	var expected string
	for _, line := range strings.Split(string(sumFile), "\n") {
		f := strings.Fields(line)
		if len(f) == 2 && strings.TrimPrefix(f[1], "*") == name {
			expected = f[0]
		}
	}
	if len(expected) != 64 {
		return nil, invalid("No valid SHA-256 checksum for this asset")
	}
	reportProgress(ctx, "Downloading Sift for this computer", 0, 0, "")
	archive, err := downloadRelease(ctx, asset, 800<<20)
	if err != nil {
		return nil, err
	}
	reportProgress(ctx, "Verifying release checksum and extracting executable", 0, 0, "")
	sum := sha256.Sum256(archive)
	if hex.EncodeToString(sum[:]) != expected {
		return nil, invalid("Release checksum does not match; installation refused")
	}
	gz, err := gzip.NewReader(bytes.NewReader(archive))
	if err != nil {
		return nil, err
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	var executable []byte
	for {
		h, e := tr.Next()
		if e == io.EOF {
			break
		}
		if e != nil {
			return nil, e
		}
		if h.Typeflag == tar.TypeReg && h.Name == "sift" {
			executable, err = io.ReadAll(io.LimitReader(tr, 800<<20))
			if err != nil {
				return nil, err
			}
			break
		}
	}
	if len(executable) == 0 {
		return nil, invalid("Release does not contain sift")
	}
	release, err := s.beginMaintenance()
	if err != nil {
		return nil, err
	}
	defer release()
	if _, err = s.backupLockedContext(ctx); err != nil {
		return nil, fmt.Errorf("Pre-update backup failed: %w", err)
	}
	exe, err := executablePath()
	if err != nil {
		return nil, err
	}
	reportProgress(ctx, "Validating and installing Sift", 0, 0, "")
	if _, err = installUpdate(ctx, exe, info.Latest, executable); err != nil {
		return nil, err
	}
	s.updateMu.Lock()
	s.update.Installed, s.update.RestartRequired = info.Latest, true
	s.updateMu.Unlock()
	return s.installed(ctx, info.Latest), nil
}

// installed describes an update on disk. While Sift is serving and idle (the
// caller holds maintenance, so no agent is running), it also reserves the
// restart that puts the update into use; the request handler then restarts.
func (s *Service) installed(ctx context.Context, version string) map[string]any {
	result := map[string]any{"installed": version, "restartRequired": true, "restarting": false}
	if s.reserveRestart(true) == nil {
		reportProgress(ctx, "Update installed; restarting Sift", 0, 0, "")
		result["restarting"] = true
	}
	return result
}

// The replacement transaction takes an explicit executable path so it can also
// be verified on disposable package files without replacing the running test
// process. ApplyUpdate alone chooses os.Executable after the safety backup.
func installUpdate(ctx context.Context, exe, version string, executable []byte) (map[string]any, error) {
	var err error
	exe, err = filepath.EvalSymlinks(exe)
	if err != nil {
		return nil, err
	}
	f, err := os.CreateTemp(filepath.Dir(exe), ".sift-update-*")
	if err != nil {
		return nil, err
	}
	temp := f.Name()
	f.Close()
	defer os.Remove(temp)
	if err = writeSync(temp, executable, 0700); err != nil {
		return nil, err
	}
	if err = os.Chmod(temp, 0700); err != nil {
		return nil, err
	}
	vctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	v, err := exec.CommandContext(vctx, temp, "version").Output()
	if err != nil || strings.TrimSpace(string(v)) != strings.TrimPrefix(version, "v") {
		os.Remove(temp)
		return nil, invalid("Downloaded executable failed version validation")
	}
	if err = os.Rename(temp, exe); err != nil {
		return nil, err
	}
	if err = syncDir(filepath.Dir(exe)); err != nil {
		return nil, err
	}
	return map[string]any{"installed": version, "restartRequired": true}, nil
}
func (s *Service) Backup() (string, error) {
	return s.backupContext(s.ctx)
}
func (s *Service) backupContext(ctx context.Context) (string, error) {
	reportProgress(ctx, "Preparing consistent backup; checking active jobs", 0, 0, "")
	release, err := s.beginMaintenance()
	if err != nil {
		return "", err
	}
	defer release()
	return s.backupLockedContext(ctx)
}
func (s *Store) SnapshotUnlocked() map[string]any {
	out := map[string]any{"cursor": s.Latest(), "version": Version}
	for _, k := range []string{"task", "column", "project", "tag", "job", "run", "attachment", "notification", "settings"} {
		out[k+"s"] = s.ListRaw(k)
	}
	return out
}
func (s *Service) RestoreArchive(ctx context.Context, b []byte) error {
	return s.restore(ctx, b)
}
func (s *Service) Setup(action string, overwrite bool) (map[string]any, error) {
	home, _ := os.UserHomeDir()
	exe, _ := os.Executable()
	switch action {
	case "skill":
		dir := filepath.Join(home, ".agents", "skills", "sift")
		dest := filepath.Join(dir, "SKILL.md")
		old, e := os.ReadFile(dest)
		if e == nil && string(old) != skillText && !overwrite {
			return nil, conflict("An existing Sift skill differs; confirm replacement before installing")
		}
		if e = os.MkdirAll(dir, 0700); e != nil {
			return nil, e
		}
		if e = os.WriteFile(dest, []byte(skillText), 0600); e != nil {
			return nil, e
		}
		return map[string]any{"installed": true, "path": dest}, nil
	case "cli":
		dir := filepath.Join(home, ".local", "bin")
		_ = os.MkdirAll(dir, 0755)
		dest := filepath.Join(dir, "sift")
		installed, installedErr := os.Stat(dest)
		current, currentErr := os.Stat(exe)
		if installedErr == nil && currentErr == nil && os.SameFile(installed, current) {
			return map[string]any{"installed": true, "path": dest}, nil
		}
		if _, e := os.Lstat(dest); e == nil {
			return nil, conflict("A file already exists at " + dest + "; inspect it before replacing")
		}
		if e := os.Symlink(exe, dest); e != nil {
			return nil, e
		}
		return map[string]any{"installed": true, "path": dest, "note": "Ensure ~/.local/bin is on PATH; no shell files were changed"}, nil
	case "startup":
		var path, content string
		address := s.Address
		if address == "" {
			address = "127.0.0.1:" + DefaultPort
		}
		if runtime.GOOS == "darwin" {
			path = filepath.Join(home, "Library/LaunchAgents/space.akst.sift.plist")
			esc := func(v string) string {
				v = strings.ReplaceAll(v, "&", "&amp;")
				v = strings.ReplaceAll(v, "<", "&lt;")
				return strings.ReplaceAll(v, ">", "&gt;")
			}
			content = fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>space.akst.sift</string><key>ProgramArguments</key><array><string>%s</string><string>serve</string><string>--data</string><string>%s</string><string>--address</string><string>%s</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>StandardErrorPath</key><string>%s</string></dict></plist>`, esc(exe), esc(s.Dir), esc(address), esc(filepath.Join(s.Dir, "service.log")))
		} else {
			path = filepath.Join(home, ".config/systemd/user/sift.service")
			quote := func(v string) string {
				return `"` + strings.ReplaceAll(strings.ReplaceAll(v, `\`, `\\`), `"`, `\"`) + `"`
			}
			content = "[Unit]\nDescription=Sift local workspace\n[Service]\nExecStart=" + quote(exe) + " serve --data " + quote(s.Dir) + " --address " + quote(address) + "\nRestart=on-failure\n[Install]\nWantedBy=default.target\n"
		}
		if _, e := os.Stat(path); e == nil && !overwrite {
			return nil, conflict("Startup configuration already exists; confirm replacement")
		}
		_ = os.MkdirAll(filepath.Dir(path), 0700)
		if e := os.WriteFile(path, []byte(content), 0600); e != nil {
			return nil, e
		}
		if runtime.GOOS == "linux" {
			ctx, cancel := context.WithTimeout(s.ctx, 10*time.Second)
			defer cancel()
			if b, e := exec.CommandContext(ctx, "systemctl", "--user", "enable", "sift.service").CombinedOutput(); e != nil {
				return map[string]any{"path": path, "installed": false, "note": string(b), "command": "systemctl --user daemon-reload && systemctl --user enable sift.service"}, nil
			}
		}
		return map[string]any{"installed": true, "path": path, "note": "Starts at the next login. Current service is unchanged."}, nil
	}
	return nil, invalid("Unknown setup action")
}
