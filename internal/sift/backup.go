package sift

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const archiveLimit = 800 << 20

var backupKinds = []string{"task", "column", "project", "tag", "job", "run", "attachment", "notification", "settings"}

type requestRecord struct {
	ID, Hash string
	Result   json.RawMessage
}
type logRecord struct {
	RunID, At string
	Data      json.RawMessage
}
type archiveManifest struct {
	Format     int               `json:"format"`
	Version    string            `json:"version"`
	ExportedAt string            `json:"exportedAt"`
	Files      map[string]string `json:"files"`
}

// Lock ordering is dataMu -> runMu -> Store.mu. This covers the entire
// pre-backup-to-commit interval, not just the moment maintenance is checked.
func (s *Service) beginMaintenance() (func(), error) {
	if !s.dataMu.TryLock() {
		return nil, conflict("Workspace is busy; try maintenance again")
	}
	s.runMu.Lock()
	if s.maintenance || len(s.active) != 0 {
		s.runMu.Unlock()
		s.dataMu.Unlock()
		return nil, conflict("Wait for active jobs or maintenance to finish")
	}
	s.maintenance = true
	s.runMu.Unlock()
	s.Store.mu.Lock()
	return func() {
		s.Store.mu.Unlock()
		s.runMu.Lock()
		s.maintenance = false
		s.runMu.Unlock()
		s.dataMu.Unlock()
	}, nil
}

// Caller holds the maintenance and store locks.
func (s *Service) backupLocked() (string, error) {
	return s.backupLockedContext(s.ctx)
}
func (s *Service) backupLockedContext(ctx context.Context) (string, error) {
	reportProgress(ctx, "Writing workspace records and history", 0, 0, "")
	dir := filepath.Join(s.Dir, "backups")
	if err := os.MkdirAll(dir, 0700); err != nil {
		return "", err
	}
	name := "sift-" + time.Now().UTC().Format("20060102-150405.000000000") + ".zip"
	f, err := os.OpenFile(filepath.Join(dir, name+".partial"), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return "", err
	}
	ok := false
	defer func() {
		f.Close()
		if !ok {
			os.Remove(f.Name())
		}
	}()
	z := zip.NewWriter(f)
	m := archiveManifest{Format: 2, Version: Version, ExportedAt: now(), Files: map[string]string{}}
	var total int64
	add := func(name string, b []byte) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		total += int64(len(b))
		if total > archiveLimit {
			return invalid("Backup exceeds the 800 MB export limit; reduce retained logs or session data")
		}
		w, e := z.Create(name)
		if e != nil {
			return e
		}
		if _, e = w.Write(b); e != nil {
			return e
		}
		h := sha256.Sum256(b)
		m.Files[name] = hex.EncodeToString(h[:])
		return nil
	}
	if err = add("workspace.json", encode(s.Store.SnapshotUnlocked())); err != nil {
		return "", err
	}
	events := []Event{}
	for cursor := int64(0); ; {
		if err := ctx.Err(); err != nil {
			return "", err
		}
		batch := s.Store.Events(cursor, "", 2000)
		if len(batch) == 0 {
			break
		}
		events = append(events, batch...)
		cursor = batch[len(batch)-1].ID
	}
	if err = add("history.json", encode(events)); err != nil {
		return "", err
	}
	requests, logs, err := backupAux(s.Store.DB)
	if err != nil {
		return "", err
	}
	if err = add("requests.json", encode(requests)); err != nil {
		return "", err
	}
	if err = add("logs.json", encode(logs)); err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	attachments := listAs[Attachment](s.Store, "attachment")
	reportProgress(ctx, "Backing up task images", 0, int64(len(attachments)), "images")
	for i, a := range attachments {
		b, e := s.Storage.Read(ctx, a.ID)
		if e != nil {
			return "", fmt.Errorf("Cannot back up image %s: %w", a.ID, e)
		}
		h := sha256.Sum256(b)
		if hex.EncodeToString(h[:]) != a.Hash {
			return "", invalid("Image checksum mismatch: %s", a.ID)
		}
		if err = add("images/"+a.ID, b); err != nil {
			return "", err
		}
		reportProgress(ctx, "Backing up task images", int64(i+1), int64(len(attachments)), "images")
	}
	reportProgress(ctx, "Backing up job memory", 0, 0, "")
	root := filepath.Join(s.Dir, "sessions")
	err = filepath.WalkDir(root, func(p string, d fs.DirEntry, e error) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if os.IsNotExist(e) && p == root {
			return nil
		}
		if e != nil {
			return e
		}
		if d.Type()&os.ModeSymlink != 0 {
			return invalid("Session backups do not follow symlinks: %s", p)
		}
		if d.IsDir() {
			return nil
		}
		info, e := d.Info()
		if e != nil {
			return e
		}
		if !info.Mode().IsRegular() || info.Size() > 64<<20 {
			return invalid("Invalid or oversized session file: %s", p)
		}
		rel, e := filepath.Rel(root, p)
		if e != nil {
			return e
		}
		b, e := os.ReadFile(p)
		if e != nil {
			return e
		}
		return add("sessions/"+filepath.ToSlash(rel), b)
	})
	if err != nil {
		return "", err
	}
	reportProgress(ctx, "Finalizing and syncing backup to disk", 0, 0, "")
	if err := ctx.Err(); err != nil {
		return "", err
	}
	w, err := z.Create("manifest.json")
	if err != nil {
		return "", err
	}
	if _, err = w.Write(encode(m)); err != nil {
		return "", err
	}
	if err = z.Close(); err != nil {
		return "", err
	}
	if err = f.Sync(); err != nil {
		return "", err
	}
	if err = f.Close(); err != nil {
		return "", err
	}
	dest := filepath.Join(dir, name)
	if err = os.Rename(f.Name(), dest); err != nil {
		return "", err
	}
	if err = syncDir(dir); err != nil {
		return "", err
	}
	ok = true
	var cfg Settings
	s.Store.Get("settings", "app", &cfg)
	cfg.LastBackup, cfg.BackupError = now(), ""
	if _, err = s.Store.DB.Exec("UPDATE objects SET data=? WHERE kind='settings' AND id='app'", encode(cfg)); err != nil {
		return "", err
	}
	entries, _ := filepath.Glob(filepath.Join(dir, "sift-*.zip"))
	sort.Strings(entries)
	for len(entries) > max(1, cfg.BackupRetention) {
		if e := os.Remove(entries[0]); e != nil {
			return dest, e
		}
		entries = entries[1:]
	}
	s.Store.signal()
	return dest, nil
}

func backupAux(db *sql.DB) ([]requestRecord, []logRecord, error) {
	requests, logs := []requestRecord{}, []logRecord{}
	rows, err := db.Query("SELECT id,hash,result FROM requests ORDER BY id")
	if err != nil {
		return nil, nil, err
	}
	for rows.Next() {
		var v requestRecord
		if err = rows.Scan(&v.ID, &v.Hash, &v.Result); err != nil {
			break
		}
		requests = append(requests, v)
	}
	if err == nil {
		err = rows.Err()
	}
	rows.Close()
	if err != nil {
		return nil, nil, err
	}
	rows, err = db.Query("SELECT run_id,at,data FROM run_logs ORDER BY rowid")
	if err != nil {
		return nil, nil, err
	}
	for rows.Next() {
		var v logRecord
		if err = rows.Scan(&v.RunID, &v.At, &v.Data); err != nil {
			break
		}
		logs = append(logs, v)
	}
	if err == nil {
		err = rows.Err()
	}
	rows.Close()
	return requests, logs, err
}

func readArchive(b []byte) (map[string][]byte, error) {
	if len(b) > archiveLimit {
		return nil, invalid("Backup exceeds 800 MB")
	}
	z, err := zip.NewReader(bytes.NewReader(b), int64(len(b)))
	if err != nil {
		return nil, invalid("Invalid Sift backup archive")
	}
	if len(z.File) > 100000 {
		return nil, invalid("Too many backup entries")
	}
	files := map[string][]byte{}
	var total uint64
	for _, f := range z.File {
		n := f.Name
		if path.Clean(n) != n || strings.HasPrefix(n, "/") || strings.Contains(n, "\\") || n == ".." || strings.HasPrefix(n, "../") || f.FileInfo().IsDir() || !f.Mode().IsRegular() {
			return nil, invalid("Unsafe backup entry: %s", n)
		}
		if _, exists := files[n]; exists {
			return nil, invalid("Duplicate backup entry: %s", n)
		}
		if f.UncompressedSize64 > archiveLimit || total > archiveLimit-f.UncompressedSize64 {
			return nil, invalid("Expanded backup exceeds 800 MB")
		}
		total += f.UncompressedSize64
		r, e := f.Open()
		if e != nil {
			return nil, e
		}
		v, e := io.ReadAll(io.LimitReader(r, int64(f.UncompressedSize64)+1))
		r.Close()
		if e != nil || uint64(len(v)) != f.UncompressedSize64 {
			return nil, invalid("Corrupt backup entry: %s", n)
		}
		files[n] = v
	}
	var m archiveManifest
	if json.Unmarshal(files["manifest.json"], &m) != nil || m.Format != 2 {
		return nil, invalid("Unsupported backup format; a complete format-2 Sift backup is required")
	}
	if len(m.Files) != len(files)-1 {
		return nil, invalid("Backup integrity index is incomplete")
	}
	for n, h := range m.Files {
		v, ok := files[n]
		sum := sha256.Sum256(v)
		if !ok || hex.EncodeToString(sum[:]) != h {
			return nil, invalid("Backup checksum failed: %s", n)
		}
		if n != "workspace.json" && n != "history.json" && n != "requests.json" && n != "logs.json" && !strings.HasPrefix(n, "images/") && !strings.HasPrefix(n, "sessions/") {
			return nil, invalid("Unknown backup entry: %s", n)
		}
	}
	return files, nil
}

func (s *Service) restore(ctx context.Context, b []byte) error {
	files, err := readArchive(b)
	if err != nil {
		return err
	}
	var data map[string][]json.RawMessage
	// workspace also contains scalar cursor/version fields.
	var workspace map[string]json.RawMessage
	if json.Unmarshal(files["workspace.json"], &workspace) != nil {
		return invalid("Invalid workspace records")
	}
	data = map[string][]json.RawMessage{}
	for _, k := range backupKinds {
		var records []json.RawMessage
		if json.Unmarshal(workspace[k+"s"], &records) != nil {
			return invalid("Invalid %s records", k)
		}
		data[k] = records
	}
	if err = validateWorkspace(data); err != nil {
		return err
	}
	var events []Event
	var requests []requestRecord
	var logs []logRecord
	if json.Unmarshal(files["history.json"], &events) != nil || json.Unmarshal(files["requests.json"], &requests) != nil || json.Unmarshal(files["logs.json"], &logs) != nil {
		return invalid("Invalid backup history, requests, or logs")
	}
	var last int64
	for _, e := range events {
		if e.ID <= last || e.Kind == "" || e.EntityID == "" {
			return invalid("Invalid history ordering")
		}
		last = e.ID
	}
	for _, v := range requests {
		if v.ID == "" || len(v.Hash) != 64 || !json.Valid(v.Result) {
			return invalid("Invalid idempotency record")
		}
	}
	for _, v := range logs {
		var e RunEntry
		if json.Unmarshal(v.Data, &e) != nil || v.RunID == "" {
			return invalid("Invalid run log")
		}
	}
	for _, raw := range data["attachment"] {
		var a Attachment
		_ = json.Unmarshal(raw, &a)
		image := files["images/"+a.ID]
		h := sha256.Sum256(image)
		meta, e := inspectImage(a.Name, image)
		if e != nil || !safeObjectID(a.ID) || hex.EncodeToString(h[:]) != a.Hash || a.ID != meta.ID || a.MIME != meta.MIME || a.Width != meta.Width || a.Height != meta.Height || a.Size != meta.Size {
			return invalid("Invalid or missing backup image: %s", a.ID)
		}
	}
	release, err := s.beginMaintenance()
	if err != nil {
		return err
	}
	defer release()
	if _, err = s.backupLocked(); err != nil {
		return fmt.Errorf("Pre-restore backup failed; workspace unchanged: %w", err)
	}
	for _, raw := range data["attachment"] {
		var a Attachment
		_ = json.Unmarshal(raw, &a)
		if _, err = s.Storage.Upload(ctx, a.Name, files["images/"+a.ID]); err != nil {
			return err
		}
	}
	id := newID("restore_")
	stage, old := filepath.Join(s.Dir, id+"-new"), filepath.Join(s.Dir, id+"-old")
	if err = os.Mkdir(stage, 0700); err != nil {
		return err
	}
	defer os.RemoveAll(stage) // only the uniquely-created restore staging directory
	for n, v := range files {
		if !strings.HasPrefix(n, "sessions/") {
			continue
		}
		if len(v) > 64<<20 {
			return invalid("Session file exceeds 64 MB")
		}
		dest := filepath.Join(stage, filepath.FromSlash(strings.TrimPrefix(n, "sessions/")))
		if err = os.MkdirAll(filepath.Dir(dest), 0700); err != nil {
			return err
		}
		if err = writeSync(dest, v, 0600); err != nil {
			return err
		}
	}
	_, rootErr := os.Stat(filepath.Join(s.Dir, "sessions"))
	journal := restoreJournal{ID: id, Stage: filepath.Base(stage), Old: filepath.Base(old), HadSessions: rootErr == nil}
	if err = writeSync(filepath.Join(s.Dir, "restore.json"), encode(journal), 0600); err != nil {
		return err
	}
	if err = syncDir(s.Dir); err != nil {
		return err
	}
	root := filepath.Join(s.Dir, "sessions")
	if _, e := os.Stat(root); e == nil {
		if err = os.Rename(root, old); err != nil {
			return err
		}
	}
	if err = os.Rename(stage, root); err != nil {
		_ = s.recoverRestore()
		return err
	}
	committed := false
	defer func() {
		if !committed {
			_ = s.recoverRestore()
		}
	}()
	tx, err := s.Store.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, q := range []string{"DELETE FROM objects", "DELETE FROM events", "DELETE FROM requests", "DELETE FROM run_logs"} {
		if _, err = tx.Exec(q); err != nil {
			return err
		}
	}
	for _, k := range backupKinds {
		for _, raw := range data[k] {
			v := jsonMap(raw)
			rid := v["id"].(string)
			if k == "job" {
				v["enabled"], v["pending"] = false, false
				v["revision"] = int(v["revision"].(float64)) + 1
			}
			if k == "run" && (v["status"] == "running" || v["status"] == "queued") {
				v["status"], v["error"] = "interrupted", "Restored from backup; inspect side effects before explicitly running again"
			}
			if _, err = tx.Exec("INSERT INTO objects VALUES(?,?,?)", k, rid, encode(v)); err != nil {
				return err
			}
		}
	}
	// Keep IDs stable for history and CLI references. Force a cursor reset on SSE
	// clients after restore rather than silently skipping restored history.
	for _, e := range events {
		if _, err = tx.Exec("INSERT INTO events(id,kind,entity_id,actor,reason,at,before_data,after_data,group_id) VALUES(?,?,?,?,?,?,?,?,?)", e.ID, e.Kind, e.EntityID, e.Actor, e.Reason, e.At, []byte(e.Before), []byte(e.After), e.Group); err != nil {
			return err
		}
	}
	for _, v := range requests {
		if _, err = tx.Exec("INSERT INTO requests VALUES(?,?,?)", v.ID, v.Hash, []byte(v.Result)); err != nil {
			return err
		}
	}
	for _, v := range logs {
		if _, err = tx.Exec("INSERT INTO run_logs VALUES(?,?,?)", v.RunID, v.At, []byte(v.Data)); err != nil {
			return err
		}
	}
	if _, err = tx.Exec("INSERT INTO metadata(key,value) VALUES('restore_generation',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", id); err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	committed = true
	if err = s.recoverRestore(); err != nil {
		return err
	}
	s.Store.signal()
	return nil
}

type restoreJournal struct {
	ID, Stage, Old string
	HadSessions    bool
}

func (s *Service) recoverRestore() error {
	p := filepath.Join(s.Dir, "restore.json")
	b, err := os.ReadFile(p)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	var j restoreJournal
	if json.Unmarshal(b, &j) != nil || !strings.HasPrefix(j.ID, "restore_") || j.Stage != j.ID+"-new" || j.Old != j.ID+"-old" || filepath.Base(j.ID) != j.ID {
		return invalid("Invalid restore journal; manual recovery required")
	}
	var generation string
	_ = s.Store.DB.QueryRow("SELECT value FROM metadata WHERE key='restore_generation'").Scan(&generation)
	root, stage, old := filepath.Join(s.Dir, "sessions"), filepath.Join(s.Dir, j.Stage), filepath.Join(s.Dir, j.Old)
	if generation != j.ID {
		if _, e := os.Stat(old); e == nil {
			if err = os.RemoveAll(root); err != nil {
				return err
			}
			if err = os.Rename(old, root); err != nil {
				return err
			}
		} else if !j.HadSessions {
			if err = os.RemoveAll(root); err != nil {
				return err
			}
		}
	}
	for _, p := range []string{old, stage} {
		if err = os.RemoveAll(p); err != nil {
			return err
		}
	}
	if err = os.Remove(p); err != nil {
		return err
	}
	return syncDir(s.Dir)
}

func writeSync(path string, b []byte, mode fs.FileMode) error {
	f, e := os.OpenFile(path, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, mode)
	if e != nil {
		return e
	}
	if _, e = f.Write(b); e == nil {
		e = f.Sync()
	}
	ce := f.Close()
	if e != nil {
		return e
	}
	return ce
}
func syncDir(path string) error {
	f, e := os.Open(path)
	if e != nil {
		return e
	}
	defer f.Close()
	return f.Sync()
}
