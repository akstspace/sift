package sift

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"modernc.org/sqlite"
)

func TestBackupFilesystemFailuresPreserveWorkAndPermitExplicitRetry(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("permission failures require an unprivileged process")
	}
	for _, scenario := range []string{"session metadata", "archive rename", "directory durability"} {
		t.Run(scenario, func(t *testing.T) {
			s := testService(t)
			task := mustTask(t, s.Store, Task{Title: "Keep current task and history"})
			history := encode(s.Store.Events(0, task.ID, 100))
			var before Settings
			if !s.Store.Get("settings", "app", &before) {
				t.Fatal("missing settings fixture")
			}
			backups, sessions := filepath.Join(s.Dir, "backups"), filepath.Join(s.Dir, "sessions")
			for _, dir := range []string{backups, sessions} {
				if err := os.Mkdir(dir, 0700); err != nil {
					t.Fatal(err)
				}
			}
			memory := []byte("private session must survive an export failure")
			if err := os.WriteFile(filepath.Join(sessions, "memory.jsonl"), memory, 0600); err != nil {
				t.Fatal(err)
			}
			// These are real filesystem permission failures on this test's own
			// workspace. No mocked writer, descriptor closure, or disk exhaustion.
			t.Cleanup(func() {
				os.Chmod(backups, 0700)
				os.Chmod(sessions, 0700)
			})
			reset := func() {}
			var policyError error
			policyCalls := 0
			switch scenario {
			case "session metadata":
				// Directory listing works, but stat/open of an entry needs search
				// permission. WalkDir must report the real DirEntry.Info failure.
				if err := os.Chmod(sessions, 0400); err != nil {
					t.Fatal(err)
				}
			case "archive rename":
				// The archive is already open when auxiliary records are read.
				// Revoke directory writes then: file writes/fsync still work,
				// while publishing the completed archive must fail.
				reset = denyQuery(t, s.Store.DB, func(action sqlite.AuthorizerActionCode, table, _ string) bool {
					if action == sqlite.AuthRead && table == "run_logs" {
						policyCalls++
						policyError = os.Chmod(backups, 0500)
					}
					return false
				})
			case "directory durability":
				// Write/search permit file creation and rename, but opening the
				// directory for fsync requires read permission. Rename alone is
				// not sufficient to claim a durable, successful backup.
				if err := os.Chmod(backups, 0300); err != nil {
					t.Fatal(err)
				}
			}
			path, err := s.Backup()
			reset()
			if err == nil || !errors.Is(err, os.ErrPermission) || path != "" || policyError != nil {
				t.Fatal("filesystem failure reported success or the wrong error", path, err, policyError)
			}
			if scenario == "archive rename" && policyCalls == 0 {
				t.Fatal("archive rename fault was not reached")
			}
			for _, dir := range []string{backups, sessions} {
				if err := os.Chmod(dir, 0700); err != nil {
					t.Fatal(err)
				}
			}
			var got Task
			var after Settings
			if !s.Store.Get("task", task.ID, &got) || !bytes.Equal(encode(got), encode(task)) || !bytes.Equal(encode(s.Store.Events(0, task.ID, 100)), history) {
				t.Fatal("export failure changed the task or its history")
			}
			if !s.Store.Get("settings", "app", &after) || !bytes.Equal(encode(before), encode(after)) {
				t.Fatal("failed export claimed a successful backup in settings", after)
			}
			if data, err := os.ReadFile(filepath.Join(sessions, "memory.jsonl")); err != nil || !bytes.Equal(data, memory) {
				t.Fatal("export failure changed the private session", err)
			}
			entries, err := os.ReadDir(backups)
			if err != nil {
				t.Fatal(err)
			}
			wantEntries := 0
			if scenario != "session metadata" {
				wantEntries = 1 // intact bytes exist, but publication/durability failed
			}
			if len(entries) != wantEntries {
				t.Fatal("unexpected leftover export files", entries)
			}
			for _, entry := range entries {
				suffix := ".zip"
				if scenario == "archive rename" {
					// Publication and deferred unlink both lack write permission.
					// Preserve the incomplete-name evidence, never call it success.
					suffix = ".zip.partial"
				}
				if !strings.HasSuffix(entry.Name(), suffix) {
					t.Fatal("failed export used the wrong completion name", entry.Name())
				}
				data, err := os.ReadFile(filepath.Join(backups, entry.Name()))
				if err != nil {
					t.Fatal(err)
				}
				if _, err := readArchive(data); err != nil {
					t.Fatal("completed archive lost integrity after durability refusal", err)
				}
			}
			path, err = s.Backup()
			if err != nil || path == "" {
				t.Fatal("explicit retry failed or maintenance lock leaked", path, err)
			}
			data, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			files, err := readArchive(data)
			if err != nil || !bytes.Equal(files["sessions/memory.jsonl"], memory) {
				t.Fatal("explicit retry failed integrity/session checks", err)
			}
			if !s.Store.Get("settings", "app", &after) || after.LastBackup == "" || after.BackupError != "" {
				t.Fatal("explicit retry did not record successful backup", after)
			}
		})
	}
}
