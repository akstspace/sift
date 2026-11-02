package sift

import (
	"archive/zip"
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

func TestArchiveResourceAndEncodingLimitsWithoutLargeAllocation(t *testing.T) {
	// Reserve a real oversized read-only input without allocating or touching
	// 800 MB of physical memory. The raw-size guard must run before ZIP parsing.
	oversized, err := syscall.Mmap(-1, 0, archiveLimit+1, syscall.PROT_READ, syscall.MAP_PRIVATE|syscall.MAP_ANON)
	if err != nil {
		t.Fatal(err)
	}
	defer syscall.Munmap(oversized)
	if _, err := readArchive(oversized); err == nil || err.Error() != "Backup exceeds 800 MB" {
		t.Fatal("oversized raw archive reached ZIP parsing", err)
	}
	for _, tc := range []struct {
		name, want string
		method     uint16
		size       uint64
		crc        uint32
	}{
		{"expanded size", "Expanded backup exceeds", zip.Store, archiveLimit + 1, 0},
		{"unsupported compression", "unsupported compression", 99, 0, 0},
		{"corrupt body", "Corrupt backup entry", zip.Store, 4, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var b bytes.Buffer
			z := zip.NewWriter(&b)
			if _, err := z.CreateRaw(&zip.FileHeader{Name: "workspace.json", Method: tc.method, UncompressedSize64: tc.size, CRC32: tc.crc}); err != nil {
				t.Fatal(err)
			}
			if err := z.Close(); err != nil {
				t.Fatal(err)
			}
			if _, err := readArchive(b.Bytes()); err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatal(tc.want, err)
			}
		})
	}
	var b bytes.Buffer
	z := zip.NewWriter(&b)
	for i := 0; i <= 100000; i++ {
		if _, err := z.CreateHeader(&zip.FileHeader{Name: "entry", Method: zip.Store}); err != nil {
			t.Fatal(err)
		}
	}
	if err := z.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := readArchive(b.Bytes()); err == nil || !strings.Contains(err.Error(), "Too many backup entries") {
		t.Fatal(err)
	}
	for _, manifest := range []string{`{"format":1}`, `{"format":2,"files":{}}`} {
		b.Reset()
		z = zip.NewWriter(&b)
		w, _ := z.Create("manifest.json")
		w.Write([]byte(manifest))
		w, _ = z.Create("workspace.json")
		w.Write([]byte("{}"))
		z.Close()
		if _, err := readArchive(b.Bytes()); err == nil {
			t.Fatal("incomplete index accepted")
		}
	}
}

func TestBackupAuxRejectsCorruptSQLRows(t *testing.T) {
	for _, kind := range []string{"request scan", "log query", "log scan"} {
		t.Run(kind, func(t *testing.T) {
			s := testService(t)
			switch kind {
			case "request scan":
				s.Store.DB.Exec("DROP TABLE requests")
				s.Store.DB.Exec("CREATE TABLE requests(id,hash,result)")
				s.Store.DB.Exec("INSERT INTO requests VALUES(NULL,'hash','{}')")
			case "log query":
				s.Store.DB.Exec("DROP TABLE run_logs")
			case "log scan":
				s.Store.DB.Exec("INSERT INTO run_logs VALUES(NULL,'at','{}')")
			}
			if _, _, err := backupAux(s.Store.DB); err == nil {
				t.Fatal("corrupt auxiliary records exported")
			}
		})
	}
}

func TestRestoreInsertFailuresRollBackEveryTableAndMemory(t *testing.T) {
	for _, table := range []string{"objects", "events", "requests", "run_logs", "metadata"} {
		t.Run(table, func(t *testing.T) {
			s := testService(t)
			a, err := s.Store.SaveTask(Task{Title: "Backup task"}, 0, "user", "fixture", "request")
			if err != nil {
				t.Fatal(err)
			}
			s.Store.AddLog("run", RunEntry{Type: "text", Text: "evidence"})
			files := backupFiles(t, s)
			a.Title = "Current task"
			mustTask(t, s.Store, a)
			root := filepath.Join(s.Dir, "sessions")
			os.Mkdir(root, 0700)
			os.WriteFile(filepath.Join(root, "memory"), []byte("current"), 0600)
			before := encode(s.Store.Snapshot())
			if _, err := s.Store.DB.Exec("CREATE TRIGGER refuse_restore_insert BEFORE INSERT ON " + table + " BEGIN SELECT RAISE(FAIL,'fixture insert failure'); END"); err != nil {
				t.Fatal(err)
			}
			if err := s.RestoreArchive(context.Background(), indexedArchive(t, files)); err == nil {
				t.Fatal("failed insert reported successful restore", table)
			}
			// Pre-restore backup updates only settings' LastBackup, not task/history.
			var original, current map[string]json.RawMessage
			json.Unmarshal(before, &original)
			json.Unmarshal(encode(s.Store.Snapshot()), &current)
			delete(original, "settings")
			delete(current, "settings")
			if !bytes.Equal(encode(original), encode(current)) {
				t.Fatal("failed restore changed records", table)
			}
			data, err := os.ReadFile(filepath.Join(root, "memory"))
			if err != nil || string(data) != "current" {
				t.Fatal("failed restore changed memory", table, err)
			}
		})
	}
}

func TestCorruptTaskGraphAndFailedTransactionsDoNotChangeWork(t *testing.T) {
	for _, operation := range []string{"save", "undo", "merge", "delete column"} {
		t.Run(operation, func(t *testing.T) {
			s := testStore(t)
			a := mustTask(t, s, Task{Title: "A"})
			b := mustTask(t, s, Task{Title: "B"})
			event := s.Events(0, a.ID, 100)[0]
			if _, err := s.DB.Exec("INSERT INTO objects VALUES('task','corrupt',?)", []byte("{")); err != nil {
				t.Fatal(err)
			}
			var err error
			switch operation {
			case "save":
				_, err = s.SaveTask(Task{Title: "C"}, 0, "user", "", "")
			case "undo":
				err = s.Undo(event.ID, "user")
			case "merge":
				err = s.Merge(a.ID, b.ID, a.Revision, b.Revision, "user", "fixture")
			case "delete column":
				err = s.DeleteColumn("progress", "open")
			}
			if err == nil {
				t.Fatal("corrupt graph accepted", operation)
			}
			var after Task
			s.Get("task", a.ID, &after)
			if !bytes.Equal(encode(after), encode(a)) {
				t.Fatal("graph failure changed source")
			}
		})
	}
	s := testStore(t)
	s.Close()
	if err := s.DeleteColumn("progress", "open"); err == nil {
		t.Fatal("closed workflow write succeeded")
	}
	if err := s.MergeEntity("project", "a", "b", "user"); err == nil {
		t.Fatal("closed organization write succeeded")
	}
	// A rolled-back transaction provides a real database/sql ErrTxDone path.
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	tx.Rollback()
	if _, _, err := taskGraphTx(tx); err == nil {
		t.Fatal("finished transaction read succeeded")
	}
}
