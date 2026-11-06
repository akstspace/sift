package sift

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestMain(m *testing.M) {
	// Never run the developer's own shell start-up files from tests.
	shellPath = func() []string { return nil }
	os.Exit(m.Run())
}

func useShellPath(t *testing.T, dirs ...string) {
	previous := shellPath
	shellPath = func() []string { return dirs }
	t.Cleanup(func() { shellPath = previous })
}

func writeScript(t *testing.T, path, body string) string {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0700); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestLoginShellPathReadsOnlyBetweenMarkers(t *testing.T) {
	dir := t.TempDir()
	shell := writeScript(t, filepath.Join(dir, "shell"), "#!/bin/sh\necho 'rc noise'\nPATH=/from/shell/bin:/usr/bin:/bin\nexport PATH\n[ \"$1\" = -ilc ] || exit 3\neval \"$2\"\necho 'more noise'\n")
	if got, want := loginShellPath(shell, 5*time.Second), []string{"/from/shell/bin", "/usr/bin", "/bin"}; !reflect.DeepEqual(got, want) {
		t.Fatal(got)
	}
	silent := writeScript(t, filepath.Join(dir, "silent"), "#!/bin/sh\necho no markers here\n")
	unclosed := writeScript(t, filepath.Join(dir, "unclosed"), "#!/bin/sh\nprintf '%s/usr/bin' "+pathMark+"\n")
	for _, shell := range []string{"zsh", "", silent, unclosed, filepath.Join(dir, "missing")} {
		if got := loginShellPath(shell, 5*time.Second); got != nil {
			t.Fatal(shell, got)
		}
	}
}

func TestLoginShellPathGivesUpOnAHangingShell(t *testing.T) {
	// A start-up file that hangs, with a background process holding the
	// output open, must not hold up Pi.
	shell := writeScript(t, filepath.Join(t.TempDir(), "shell"), "#!/bin/sh\nsleep 30 &\nsleep 30\n")
	start := time.Now()
	if got := loginShellPath(shell, 200*time.Millisecond); got != nil {
		t.Fatal(got)
	}
	if time.Since(start) > 3*time.Second {
		t.Fatal("hanging shell held the search path", time.Since(start))
	}
}

func TestToolPathPutsTheLoginShellFirstWithoutRepeats(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("PATH", "/usr/bin:relative:/service/bin")
	useShellPath(t, "/shell/bin", "also-relative", "/usr/bin")
	want := []string{"/shell/bin", "/usr/bin", "/service/bin", "/next/to/pi", filepath.Join(home, ".bun/bin"), filepath.Join(home, ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin"}
	if got := toolPath("/next/to/pi", "/shell/bin"); !reflect.DeepEqual(got, want) {
		t.Fatal(got)
	}
	t.Setenv("HOME", "")
	if got := toolPath(); strings.Contains(strings.Join(got, ":"), ".bun") {
		t.Fatal("no home folder still searched one", got)
	}
}

func TestPiFindsNodeFromABareServicePath(t *testing.T) {
	// launchd starts Sift with only the system folders. Pi installed by bun
	// starts with "#!/usr/bin/env node", and node is where the shell put it.
	root := t.TempDir()
	nodeDir := filepath.Join(root, "node/bin")
	writeScript(t, filepath.Join(nodeDir, "node"), "#!/bin/sh\necho \"node ran ${1##*/} $2\"\n")
	pi := writeScript(t, filepath.Join(root, "bun/bin/pi"), "#!/usr/bin/env node\n")
	t.Setenv("HOME", t.TempDir())
	t.Setenv("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
	t.Setenv("SIFT_PI", pi)
	useShellPath(t, nodeDir, "/usr/bin", "/bin")
	cmd := piCommand(context.Background(), "--version")
	out, err := cmd.Output()
	if err != nil || strings.TrimSpace(string(out)) != "node ran pi --version" {
		t.Fatal(string(out), err)
	}
	paths := []string{}
	for _, v := range cmd.Env {
		if strings.HasPrefix(v, "PATH=") {
			paths = append(paths, v)
		}
	}
	if len(paths) != 1 || !strings.HasPrefix(paths[0], "PATH="+nodeDir+":") || !strings.Contains(paths[0], ":/sbin:"+filepath.Dir(pi)+":") {
		t.Fatal(paths)
	}
}

func TestPiUsesNodeInstalledBesideIt(t *testing.T) {
	// npm under nvm, volta, or fnm puts pi next to the node that runs it.
	bin := filepath.Join(t.TempDir(), "versions/node/v22/bin")
	writeScript(t, filepath.Join(bin, "node"), "#!/bin/sh\necho beside\n")
	pi := writeScript(t, filepath.Join(bin, "pi"), "#!/usr/bin/env node\n")
	t.Setenv("HOME", t.TempDir())
	t.Setenv("PATH", t.TempDir())
	t.Setenv("SIFT_PI", "")
	useShellPath(t, bin)
	if PiPath() != pi {
		t.Fatal("Pi on the login shell's PATH was not found", PiPath())
	}
	t.Setenv("SIFT_PI", pi)
	useShellPath(t)
	if out, err := piCommand(context.Background()).Output(); err != nil || strings.TrimSpace(string(out)) != "beside" {
		t.Fatal(string(out), err)
	}
	t.Setenv("SIFT_PI", "pi-by-name")
	for _, v := range piCommand(context.Background()).Env {
		if strings.HasPrefix(v, "PATH=") && strings.Contains(v, bin) {
			t.Fatal("a bare command name added a folder", v)
		}
	}
}
