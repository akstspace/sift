package sift

import (
	"context"
	"encoding/json"
	"github.com/robfig/cron/v3"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"
)

type Service struct {
	Store   *Store
	Storage *Storage
	Dir     string
	Address string
	// dataMu gates API writes against maintenance. Always acquire it before runMu.
	dataMu      sync.RWMutex
	runMu       sync.Mutex
	active      map[string]context.CancelFunc
	activeRun   map[string]string
	maintenance bool
	ctx         context.Context
	cancel      context.CancelFunc
	backupMu    sync.Mutex
	piUpdateMu  sync.Mutex
	updateMu    sync.Mutex
	update      UpdateInfo
	wg          sync.WaitGroup
	runs        sync.WaitGroup
}

func NewService(dir string) (*Service, error) {
	dir, _ = filepath.Abs(dir)
	store, err := OpenStore(dir)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	s := &Service{Dir: dir, Store: store, Storage: &Storage{}, active: map[string]context.CancelFunc{}, activeRun: map[string]string{}, ctx: ctx, cancel: cancel}
	if err = s.recoverRestore(); err != nil {
		cancel()
		store.Close()
		return nil, err
	}
	interrupted := map[string]bool{}
	for _, r := range listAs[Run](store, "run") {
		if r.Status == "running" || r.Status == "queued" {
			r.Status = "interrupted"
			r.Error = "Sift restarted during this run; retry explicitly after inspecting side effects"
			r.EndedAt = now()
			_ = store.Put("run", r.ID, r, "system", "Recovered interrupted run")
			interrupted[r.JobID] = true
		}
	}
	for _, j := range listAs[Job](store, "job") {
		if !interrupted[j.ID] {
			continue
		}
		j.Pending = false
		if next, e := nextJob(j, time.Now()); e == nil {
			j.NextRun = next.UTC().Format(time.RFC3339Nano)
		}
		_ = store.Put("job", j.ID, j, "system", "Interrupted run not replayed; next regular occurrence retained")
	}
	return s, nil
}
func (s *Service) Start() {
	s.wg.Add(3)
	go func() {
		defer s.wg.Done()
		err := s.Storage.Start(s.ctx, s.Dir)
		if err != nil {
			s.Storage.mu.Lock()
			s.Storage.Error = err.Error()
			s.Storage.mu.Unlock()
			s.Notify("Image storage needs attention", err.Error())
		}
		s.Store.signal()
	}()
	go func() { defer s.wg.Done(); s.scheduleLoop() }()
	go func() { defer s.wg.Done(); s.maintenanceLoop() }()
}
func (s *Service) Close() {
	s.cancel()
	s.runMu.Lock()
	s.maintenance = true
	for _, c := range s.active {
		c()
	}
	s.runMu.Unlock()
	s.wg.Wait()
	s.runs.Wait()
	s.Storage.Close()
	_ = s.Store.Close()
}
func (s *Service) Notify(title, message string) {
	n := Notification{ID: newID("ntf_"), Title: title, Message: message, At: now()}
	_ = s.Store.Put("notification", n.ID, n, "system", title)
}
func nextJob(job Job, after time.Time) (time.Time, error) {
	loc, err := time.LoadLocation(job.Timezone)
	if err != nil {
		return time.Time{}, invalid("Select a valid IANA timezone")
	}
	if job.ScheduleType == "interval" {
		d, e := time.ParseDuration(job.Schedule)
		if e != nil || d < time.Minute {
			return time.Time{}, invalid("Interval must be at least 1m, for example 30m or 2h")
		}
		return after.Add(d), nil
	}
	spec := job.Schedule
	if job.ScheduleType == "daily" || job.ScheduleType == "weekdays" {
		clock, e := time.Parse("15:04", spec)
		if e != nil || clock.Format("15:04") != spec {
			return time.Time{}, invalid("Daily schedule must be HH:MM")
		}
		h, m := clock.Hour(), clock.Minute()
		for day := 0; day < 370; day++ {
			date := after.In(loc).AddDate(0, 0, day)
			if job.ScheduleType == "weekdays" {
				allowed := false
				for _, d := range job.Weekdays {
					if d == int(date.Weekday()) {
						allowed = true
					}
				}
				if !allowed {
					continue
				}
			}
			y, mo, d := date.Date()
			start := time.Date(y, mo, d, 0, 0, 0, 0, loc)
			desired := h*60 + m
			seen := false
			for t := start; t.Before(start.AddDate(0, 0, 1)); t = t.Add(time.Minute) {
				local := t.In(loc)
				minute := local.Hour()*60 + local.Minute()
				if minute < desired {
					continue
				}
				if seen {
					break
				}
				seen = true
				if t.After(after) {
					return t, nil
				}
			}
		}
		return time.Time{}, invalid("Could not calculate next daily occurrence")
	}
	if job.ScheduleType != "cron" {
		return time.Time{}, invalid("Unknown schedule type")
	}
	parser := cron.NewParser(cron.Minute | cron.Hour | cron.Dom | cron.Month | cron.Dow)
	// Evaluate cron against a monotonic wall-clock timeline. A missing local
	// minute maps to the next valid instant; a repeated minute fires only once.
	wall := time.Date(after.In(loc).Year(), after.In(loc).Month(), after.In(loc).Day(), after.In(loc).Hour(), after.In(loc).Minute(), 0, 0, time.UTC)
	plain, err := parser.Parse(spec)
	if err != nil {
		return time.Time{}, invalid("Invalid cron expression: %v", err)
	}
	for attempts := 0; attempts < 10000; attempts++ {
		wall = plain.Next(wall)
		if wall.IsZero() {
			break
		}
		y, mo, d := wall.Date()
		midnight := time.Date(y, mo, d, 0, 0, 0, 0, loc)
		for t := midnight; t.Before(midnight.AddDate(0, 0, 1)); t = t.Add(time.Minute) {
			l := t.In(loc)
			if l.Hour()*60+l.Minute() < wall.Hour()*60+wall.Minute() {
				continue
			}
			if t.After(after) {
				return t, nil
			}
			break
		}
	}
	return time.Time{}, invalid("No cron occurrence found within supported range")
}
func (s *Service) SaveJob(j Job, expected int, actor string) (Job, error) {
	if trim(j.Name) == "" || trim(j.Prompt) == "" {
		return j, invalid("Job name and prompt are required")
	}
	if j.Directory == "" {
		j.Directory, _ = os.UserHomeDir()
	}
	if !filepath.IsAbs(j.Directory) {
		return j, invalid("Working directory must be absolute")
	}
	info, e := os.Stat(j.Directory)
	if e != nil || !info.IsDir() {
		return j, invalid("Working directory does not exist")
	}
	if j.Timezone == "" {
		var cfg Settings
		s.Store.Get("settings", "app", &cfg)
		j.Timezone = cfg.Timezone
	}
	if j.TimeoutMinutes == 0 {
		var cfg Settings
		s.Store.Get("settings", "app", &cfg)
		j.TimeoutMinutes = cfg.TimeoutMinutes
	}
	if (j.Provider == "") != (j.Model == "") {
		return j, invalid("Select both provider and model, or use Pi's configured default")
	}
	if len(j.Name) > 200 || len(j.Prompt) > 1<<20 {
		return j, invalid("Job name or prompt is too long")
	}
	if j.TimeoutMinutes < 1 || j.TimeoutMinutes > 1440 {
		return j, invalid("Timeout must be between 1 and 1440 minutes")
	}
	if j.ScheduleType != "daily" && j.ScheduleType != "weekdays" && j.ScheduleType != "cron" && j.ScheduleType != "interval" {
		return j, invalid("Choose daily, selected weekdays, interval, or cron")
	}
	if j.ScheduleType == "weekdays" {
		if len(j.Weekdays) == 0 {
			return j, invalid("Choose at least one weekday")
		}
		for _, d := range j.Weekdays {
			if d < 0 || d > 6 {
				return j, invalid("Invalid weekday")
			}
		}
	}
	next, err := nextJob(j, time.Now())
	if err != nil {
		return j, err
	}
	s.runMu.Lock()
	defer s.runMu.Unlock()
	if s.maintenance {
		return j, conflict("Sift is paused for maintenance")
	}
	if _, running := s.active[j.ID]; running {
		return j, conflict("Wait for or cancel this job's active run before editing")
	}
	var old Job
	if j.ID != "" && s.Store.Get("job", j.ID, &old) {
		if old.Revision != expected {
			return j, conflict("Job changed; refresh before saving")
		}
		j.SessionID = old.SessionID
		j.LastRun = old.LastRun
		j.Pending = old.Pending && j.Enabled
		j.Revision = old.Revision + 1
	} else {
		if expected != 0 {
			return j, conflict("Job no longer exists")
		}
		j.ID = newID("job_")
		j.SessionID = newID("session_")
		j.Revision = 1
		j.Pending = false
	}
	j.NextRun = next.UTC().Format(time.RFC3339Nano)
	return j, s.Store.Put("job", j.ID, j, actor, "Save scheduled job")
}
func (s *Service) RunJob(id string) (Run, error) {
	s.runMu.Lock()
	defer s.runMu.Unlock()
	if s.maintenance {
		return Run{}, conflict("Sift is paused for backup or update")
	}
	var j Job
	if !s.Store.Get("job", id, &j) {
		return Run{}, invalid("Job not found")
	}
	var cfg Settings
	s.Store.Get("settings", "app", &cfg)
	if _, ok := s.active[id]; ok {
		j.Pending = true
		_ = s.Store.Put("job", id, j, "system", "Coalesced pending trigger")
		return Run{}, conflict("This job is already running; one pending run is queued")
	}
	if len(s.active) >= cfg.Concurrency {
		j.Pending = true
		_ = s.Store.Put("job", id, j, "system", "Queued behind concurrency limit")
		return Run{}, conflict("Concurrency limit reached; job queued")
	}
	return s.startRunLocked(j)
}
func (s *Service) startRunLocked(j Job) (Run, error) {
	j.Pending = false
	j.LastRun = now()
	next, err := nextJob(j, time.Now())
	if err != nil {
		return Run{}, err
	}
	j.NextRun = next.UTC().Format(time.RFC3339Nano)
	if err = s.Store.Put("job", j.ID, j, "system", "Starting run"); err != nil {
		return Run{}, err
	}
	r := Run{ID: newID("run_"), JobID: j.ID, JobName: j.Name, Status: "running", StartedAt: now(), Model: j.Provider + "/" + j.Model, SessionID: j.SessionID, Job: j}
	if err = s.Store.Put("run", r.ID, r, "system", "Run started"); err != nil {
		return r, err
	}
	ctx, cancel := context.WithTimeout(s.ctx, time.Duration(j.TimeoutMinutes)*time.Minute)
	s.active[j.ID] = cancel
	s.activeRun[j.ID] = r.ID
	s.runs.Add(1)
	go func() { defer s.runs.Done(); defer cancel(); s.executeRun(ctx, j, r) }()
	return r, nil
}
func (s *Service) CancelRun(id string) error {
	var r Run
	if !s.Store.Get("run", id, &r) {
		return invalid("Run not found")
	}
	s.runMu.Lock()
	defer s.runMu.Unlock()
	c := s.active[r.JobID]
	if c == nil || s.activeRun[r.JobID] != id {
		return conflict("Run is no longer active")
	}
	c()
	var j Job
	if s.Store.Get("job", r.JobID, &j) {
		j.Pending = false
		_ = s.Store.Put("job", j.ID, j, "user", "Cancelled run and pending trigger")
	}
	return nil
}
func (s *Service) ResetJob(id string) error {
	s.runMu.Lock()
	defer s.runMu.Unlock()
	if s.maintenance {
		return conflict("Sift is paused for maintenance")
	}
	if _, ok := s.active[id]; ok {
		return conflict("Cancel the current run before resetting memory")
	}
	var j Job
	if !s.Store.Get("job", id, &j) {
		return invalid("Job not found")
	}
	j.SessionID = newID("session_")
	j.Revision++
	return s.Store.Put("job", id, j, "user", "Reset job memory; old run history retained")
}
func (s *Service) scheduleLoop() {
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	for {
		select {
		case <-s.ctx.Done():
			return
		case <-tick.C:
			s.scheduleTick(time.Now())
		}
	}
}
func (s *Service) scheduleTick(now time.Time) {
	s.runMu.Lock()
	defer s.runMu.Unlock()
	if s.maintenance {
		return
	}
	var cfg Settings
	s.Store.Get("settings", "app", &cfg)
	for _, j := range listAs[Job](s.Store, "job") {
		_, busy := s.active[j.ID]
		due, parseErr := time.Parse(time.RFC3339Nano, j.NextRun)
		if j.Enabled && parseErr == nil && !now.Before(due) && (busy || len(s.active) >= cfg.Concurrency) {
			j.Pending = true
			next, e := nextJob(j, now)
			if e == nil {
				j.NextRun = next.UTC().Format(time.RFC3339Nano)
			}
			_ = s.Store.Put("job", j.ID, j, "system", "Coalesced scheduled trigger")
		}
		if busy || len(s.active) >= cfg.Concurrency {
			continue
		}
		due, err := time.Parse(time.RFC3339Nano, j.NextRun)
		if j.Pending || (j.Enabled && err == nil && !now.Before(due)) {
			_, _ = s.startRunLocked(j)
		}
	}
}
func (s *Service) maintenanceLoop() {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	s.checkMaintenance()
	for {
		select {
		case <-s.ctx.Done():
			return
		case <-ticker.C:
			s.checkMaintenance()
		}
	}
}
func (s *Service) checkMaintenance() {
	var cfg Settings
	s.Store.Get("settings", "app", &cfg)
	last, _ := time.Parse(time.RFC3339Nano, cfg.LastBackup)
	if time.Since(last) >= 24*time.Hour {
		func() {
			_, err := s.Backup()
			if err != nil && s.dataMu.TryRLock() {
				defer s.dataMu.RUnlock()
				var settings Settings
				s.Store.Get("settings", "app", &settings)
				if settings.BackupError != err.Error() {
					settings.BackupError = err.Error()
					_ = s.Store.Put("settings", "app", settings, "system", "Backup needs attention")
				}
			}
		}()
	}
	if cfg.CheckUpdates {
		s.updateMu.Lock()
		lastCheck := s.update.CheckedAt
		s.updateMu.Unlock()
		if time.Since(lastCheck) > 24*time.Hour {
			s.CheckUpdate(s.ctx)
		}
	}
	if s.dataMu.TryRLock() {
		if err := s.Store.ArchiveCompleted(cfg.AutoArchiveDays, time.Now()); err != nil {
			log.Printf("Archive completed tasks: %v", err)
		}
		s.Store.Prune(cfg)
		s.dataMu.RUnlock()
	}
}
func (s *Service) SaveSettings(in Settings) error {
	if err := validateSettings(in); err != nil {
		return err
	}
	var old Settings
	s.Store.Get("settings", "app", &old)
	in.LastBackup, in.BackupError = old.LastBackup, old.BackupError
	in.ID = "app"
	return s.Store.Put("settings", "app", in, "user", "Update settings")
}
func (s *Service) Schema() map[string]any {
	return map[string]any{"version": 1, "commands": []string{"tasks list/search/get/add/update/tree/duplicates/merge", "columns list", "projects list/add/update", "tags list/add/update", "icons search", "images upload", "jobs list/add/update/run/reset", "runs list/get/cancel", "models list", "history", "undo", "backup", "update", "serve"}, "task": Task{}, "job": Job{}, "rules": []string{"Use expected revisions on update", "Agent closure/reopening/manual override requires reason", "Only UI user can manage columns", "One subtask level; active children block completion", "Catalog icons only", "Potential duplicates never authorize an automatic merge"}, "columns": s.Store.ListRaw("column"), "priorities": []string{"none", "low", "medium", "high", "urgent"}}
}
func jsonMap(b []byte) map[string]any { v := map[string]any{}; _ = json.Unmarshal(b, &v); return v }
