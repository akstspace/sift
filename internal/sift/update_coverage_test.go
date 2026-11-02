package sift

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func updateArchive(t *testing.T, name, content string) []byte {
	t.Helper()
	var b bytes.Buffer
	gz := gzip.NewWriter(&b)
	tarball := tar.NewWriter(gz)
	if err := tarball.WriteHeader(&tar.Header{Name: name, Mode: 0700, Size: int64(len(content)), Typeflag: tar.TypeReg}); err != nil {
		t.Fatal(err)
	}
	if _, err := tarball.Write([]byte(content)); err != nil {
		t.Fatal(err)
	}
	if err := tarball.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func updateHTTP(t *testing.T, archive []byte, checksum string, checksStatus, assetStatus int) {
	t.Helper()
	name := "sift_" + runtime.GOOS + "_" + runtime.GOARCH + ".tar.gz"
	base := "https://github.com/akstspace/sift/releases/download/v99.0.0/"
	previous := http.DefaultClient
	http.DefaultClient = &http.Client{Transport: fixtureTransport(func(r *http.Request) (*http.Response, error) {
		status, body := 200, ""
		switch r.URL.String() {
		case "https://api.github.com/repos/akstspace/sift/releases/latest":
			body = fmt.Sprintf(`{"tag_name":"v99.0.0","assets":[{"name":%q,"browser_download_url":%q},{"name":"checksums.txt","browser_download_url":%q}]}`, name, base+name, base+"checksums.txt")
		case base + "checksums.txt":
			status = checksStatus
			body = checksum
		case base + name:
			status, body = assetStatus, string(archive)
		default:
			t.Errorf("unexpected network request: %s", r.URL)
		}
		return &http.Response{StatusCode: status, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body)), Request: r}, nil
	})}
	t.Cleanup(func() { http.DefaultClient = previous })
}

func archiveChecksum(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:]) + "  *sift_" + runtime.GOOS + "_" + runtime.GOARCH + ".tar.gz\n"
}

func TestUpdateVerificationBeforeAnyReplacement(t *testing.T) {
	valid := updateArchive(t, "sift", "#!/bin/sh\necho 99.0.0\n")
	missing := updateArchive(t, "not-sift", "not an executable")
	wrongVersion := updateArchive(t, "sift", "#!/bin/sh\necho 199.0.0\n")
	var corruptTar bytes.Buffer
	gz := gzip.NewWriter(&corruptTar)
	if _, err := gz.Write([]byte(strings.Repeat("x", 512))); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	var truncatedTar bytes.Buffer
	gz = gzip.NewWriter(&truncatedTar)
	tw := tar.NewWriter(gz)
	if err := tw.WriteHeader(&tar.Header{Name: "sift", Typeflag: tar.TypeReg, Mode: 0700, Size: 100}); err != nil {
		t.Fatal(err)
	}
	if _, err := tw.Write([]byte("short")); err != nil {
		t.Fatal(err)
	}
	// Deliberately omit the remaining tar body, but finish the gzip stream.
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name, checksum, want string
		archive              []byte
		checks, asset        int
		busy, blockedBackup  bool
	}{
		{"checks download", "", "HTTP 503", valid, 503, 200, false, false},
		{"missing checksum", "another-file", "No valid SHA-256", valid, 200, 200, false, false},
		{"asset download", archiveChecksum(valid), "HTTP 503", valid, 200, 503, false, false},
		{"checksum mismatch", strings.Repeat("0", 64) + "  sift_" + runtime.GOOS + "_" + runtime.GOARCH + ".tar.gz", "checksum does not match", valid, 200, 200, false, false},
		{"not gzip", archiveChecksum([]byte("not gzip")), "unexpected EOF", []byte("not gzip"), 200, 200, false, false},
		{"corrupt tar", archiveChecksum(corruptTar.Bytes()), "invalid tar header", corruptTar.Bytes(), 200, 200, false, false},
		{"truncated executable", archiveChecksum(truncatedTar.Bytes()), "unexpected EOF", truncatedTar.Bytes(), 200, 200, false, false},
		{"missing executable", archiveChecksum(missing), "does not contain sift", missing, 200, 200, false, false},
		{"active workspace", archiveChecksum(valid), "Wait for active jobs", valid, 200, 200, true, false},
		{"safety backup", archiveChecksum(valid), "Pre-update backup failed", valid, 200, 200, false, true},
		{"wrong exact version", archiveChecksum(wrongVersion), "version validation", wrongVersion, 200, 200, false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			updateHTTP(t, tc.archive, tc.checksum, tc.checks, tc.asset)
			s := testService(t)
			s.maintenance = tc.busy
			if tc.blockedBackup {
				if err := os.WriteFile(filepath.Join(s.Dir, "backups"), []byte("blocked"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := s.ApplyUpdate(context.Background()); err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("want %q, got %v", tc.want, err)
			}
		})
	}
}

func TestReleaseDownloadsRejectMalformedAndTruncatedResponses(t *testing.T) {
	base := "https://github.com/akstspace/sift/releases/download/v99.0.0/"
	if _, err := downloadRelease(context.Background(), base+"bad\nasset", 1024); err == nil {
		t.Fatal("malformed release URL accepted")
	}
	previous := http.DefaultClient
	http.DefaultClient = &http.Client{Transport: fixtureTransport(func(r *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: unreadableBody{}, Request: r}, nil
	})}
	t.Cleanup(func() { http.DefaultClient = previous })
	if _, err := downloadRelease(context.Background(), base+"asset", 1024); !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatal("truncated release returned success", err)
	}
}

func TestInstallUpdateOnDisposablePackagePaths(t *testing.T) {
	for _, scenario := range []string{"success", "missing executable", "unwritable directory", "failed validation", "rename refusal"} {
		t.Run(scenario, func(t *testing.T) {
			dir := t.TempDir()
			exe := filepath.Join(dir, "sift")
			original := []byte("previous package bytes")
			if err := os.WriteFile(exe, original, 0700); err != nil {
				t.Fatal(err)
			}
			payload := []byte("#!/bin/sh\nprintf '99.0.0\\n'\n")
			switch scenario {
			case "missing executable":
				exe = filepath.Join(dir, "missing")
			case "unwritable directory":
				if err := os.Chmod(dir, 0500); err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { os.Chmod(dir, 0700) })
			case "failed validation":
				payload = []byte("#!/bin/sh\nprintf 'wrong version\\n'\n")
			case "rename refusal":
				if err := os.Remove(exe); err != nil {
					t.Fatal(err)
				}
				if err := os.Mkdir(exe, 0700); err != nil {
					t.Fatal(err)
				}
			}
			result, err := installUpdate(context.Background(), exe, "v99.0.0", payload)
			if scenario == "success" {
				data, readErr := os.ReadFile(exe)
				if err != nil || readErr != nil || !bytes.Equal(data, payload) || result["installed"] != "v99.0.0" || result["restartRequired"] != true {
					t.Fatal("successful replacement mismatch", result, err, readErr)
				}
			} else if err == nil || result != nil {
				t.Fatal("failed replacement reported success", result, err)
			} else if scenario == "unwritable directory" || scenario == "failed validation" {
				if data, err := os.ReadFile(exe); err != nil || !bytes.Equal(data, original) {
					t.Fatal("refused update damaged previous executable", err)
				}
			}
			entries, globErr := filepath.Glob(filepath.Join(dir, ".sift-update-*"))
			if globErr != nil || len(entries) != 0 {
				t.Fatal("replacement left staging executable", entries, globErr)
			}
		})
	}
}

// Run successful replacement only inside a disposable COPY of this test binary.
// Neither the developer's Sift executable nor the running go-test binary is changed.
func TestUpdateReplacesOnlyDisposableExecutable(t *testing.T) {
	const childFlag = "SIFT_DISPOSABLE_UPDATE_TEST"
	if os.Getenv(childFlag) == "1" {
		archive := updateArchive(t, "sift", "#!/bin/sh\necho 99.0.0\n")
		updateHTTP(t, archive, archiveChecksum(archive), 200, 200)
		s := testService(t)
		result, err := s.ApplyUpdate(context.Background())
		if err != nil || result["installed"] != "v99.0.0" || result["restartRequired"] != true {
			t.Fatal(result, err)
		}
		entries, _ := os.ReadDir(filepath.Join(s.Dir, "backups"))
		if len(entries) != 1 {
			t.Fatal("missing safety backup")
		}
		return
	}
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(exe)
	if err != nil {
		t.Fatal(err)
	}
	copy := filepath.Join(t.TempDir(), "disposable-sift-test")
	if err = os.WriteFile(copy, data, 0700); err != nil {
		t.Fatal(err)
	}
	command := exec.Command(copy, "-test.run=^TestUpdateReplacesOnlyDisposableExecutable$", "-test.count=1")
	command.Env = append(os.Environ(), childFlag+"=1")
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("disposable update: %v\n%s", err, output)
	}
	output, err := exec.Command(copy, "version").Output()
	if err != nil || strings.TrimSpace(string(output)) != "99.0.0" {
		t.Fatal("disposable binary was not replaced", string(output), err)
	}
}
