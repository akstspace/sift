package sift

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type Connection struct {
	URL   string `json:"url"`
	Token string `json:"token"`
	PID   int    `json:"pid"`
}

func randomToken() string { b := make([]byte, 32); _, _ = rand.Read(b); return hex.EncodeToString(b) }

// ErrRestart reports that Serve stopped because the person asked Sift to
// restart (usually to finish an installed update). Every resource has been
// released when it is returned, so the caller may re-execute the binary.
var ErrRestart = errors.New("restart requested")

func Serve(ctx context.Context, dir, address string) error {
	if host, _, e := net.SplitHostPort(address); e != nil || host != "127.0.0.1" {
		return invalid("Sift binds only to 127.0.0.1")
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	lock, err := lockData(dir)
	if err != nil {
		return err
	}
	defer lock()
	s, err := NewService(dir)
	if err != nil {
		return err
	}
	defer s.Close()
	l, err := net.Listen("tcp", address)
	if err != nil {
		return fmt.Errorf("Cannot listen on %s: %w. Choose another port with sift serve --port NUMBER", address, err)
	}
	defer l.Close()
	s.Address = l.Addr().String()
	token := randomToken()
	connection := Connection{URL: "http://" + l.Addr().String(), Token: token, PID: os.Getpid()}
	connPath := filepath.Join(s.Dir, "connection.json")
	if err = os.WriteFile(connPath, encode(connection), 0600); err != nil {
		return err
	}
	defer os.Remove(connPath)
	mux := s.routes()
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'")
		if r.Host != l.Addr().String() {
			http.Error(w, "Invalid local host", 403)
			return
		}
		if origin := r.Header.Get("Origin"); origin != "" && origin != connection.URL {
			http.Error(w, "Cross-origin access denied", 403)
			return
		}
		if r.Header.Get("Sec-Fetch-Site") == "cross-site" {
			http.Error(w, "Cross-site access denied", 403)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/api/") {
			w.Header().Set("Cache-Control", "no-store")
			cookie, _ := r.Cookie("sift_session")
			authorized := r.Header.Get("Authorization") == "Bearer "+token || (cookie != nil && cookie.Value == token)
			if !authorized {
				http.Error(w, "Local session required; open Sift's local URL", 401)
				return
			}
			if r.Method != "GET" && r.Method != "HEAD" && r.Header.Get("X-Sift-Request") != "1" {
				http.Error(w, "Missing local request header", 403)
				return
			}
		} else if r.Method == "GET" {
			http.SetCookie(w, &http.Cookie{Name: "sift_session", Value: token, Path: "/", HttpOnly: true, SameSite: http.SameSiteStrictMode})
		}
		mux.ServeHTTP(w, r)
	})
	server := &http.Server{Handler: handler, ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 32 << 10}
	stopping, restartRequested := make(chan struct{}), make(chan struct{})
	var restarting atomic.Bool
	var requestOnce sync.Once
	s.stopping = stopping
	s.restart = func() { requestOnce.Do(func() { restarting.Store(true); close(restartRequested) }) }
	server.RegisterOnShutdown(func() { close(stopping) })
	s.Start()
	shutdownDone := make(chan struct{})
	go func() {
		defer close(shutdownDone)
		select {
		case <-ctx.Done():
		case <-restartRequested:
		}
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdown)
	}()
	fmt.Printf("Sift %s\nWorkspace: %s\nData: %s\n", Version, connection.URL, s.Dir)
	err = server.Serve(l)
	if err == http.ErrServerClosed {
		// Let in-flight requests (including the restart response) finish
		// before the deferred service, storage, and data-lock cleanup runs.
		<-shutdownDone
		if restarting.Load() {
			return ErrRestart
		}
		return nil
	}
	return err
}
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func apiError(w http.ResponseWriter, err error) {
	status := 500
	var e *APIError
	if errors.As(err, &e) {
		status = e.Status
	}
	logFailure(status, err)
	writeJSON(w, status, map[string]any{"error": err.Error()})
}

// logFailure records server-side failures in the service log, so a browser
// that only shows a status code still leaves the reason somewhere to inspect.
func logFailure(status int, err error) {
	if status >= 500 {
		log.Printf("Request failed (%d): %v", status, err)
	}
}
func decodeBody(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 2<<20)
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		apiError(w, invalid("Invalid JSON request: %v", err))
		return false
	}
	return true
}
func actorOf(r *http.Request) string {
	v := r.Header.Get("X-Sift-Actor")
	if v == "" {
		if r.Header.Get("Authorization") != "" {
			return "local-agent"
		}
		return "user"
	}
	if v == "user" && r.Header.Get("Authorization") != "" {
		return "local-agent"
	}
	return v
}
func (s *Service) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/snapshot", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, s.Store.Snapshot()) })
	mux.HandleFunc("GET /api/schema", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, s.Schema()) })
	mux.HandleFunc("GET /api/events", s.streamEvents)
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		var cfg Settings
		s.Store.Get("settings", "app", &cfg)
		writeJSON(w, 200, map[string]any{"version": Version, "dataDir": s.Dir, "storage": s.Storage.Status(), "piPath": PiPath(), "timezone": cfg.Timezone, "platform": runtime.GOOS})
	})
	mux.HandleFunc("GET /api/pi", func(w http.ResponseWriter, r *http.Request) {
		writeOperation(w, r, func(ctx context.Context) (any, error) {
			reportProgress(ctx, "Connecting to Pi and discovering available models; no AI task is run", 0, 0, "")
			ctx, cancel := context.WithTimeout(ctx, 25*time.Second)
			defer cancel()
			data, err := ProbePi(ctx, r.URL.Query().Get("provider"), r.URL.Query().Get("model"))
			if err != nil {
				return nil, &APIError{Status: 503, Message: err.Error()}
			}
			return data, nil
		})
	})
	mux.HandleFunc("POST /api/pi/update", func(w http.ResponseWriter, r *http.Request) {
		s.piUpdateMu.Lock()
		defer s.piUpdateMu.Unlock()
		release, err := s.beginMaintenance()
		if err != nil {
			apiError(w, err)
			return
		}
		defer release()
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Minute)
		defer cancel()
		cmd := exec.CommandContext(ctx, PiPath(), "update")
		out, err := cmd.CombinedOutput()
		if err != nil {
			apiError(w, fmt.Errorf("Pi update failed: %w: %s", err, out))
			return
		}
		writeJSON(w, 200, map[string]any{"updated": true, "output": string(out)})
	})
	mux.HandleFunc("GET /api/icons", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, searchIcons(Icons, r.URL.Query().Get("q")))
	})
	mux.HandleFunc("GET /api/tasks/duplicates", func(w http.ResponseWriter, r *http.Request) {
		t := Task{Title: r.URL.Query().Get("title"), ID: r.URL.Query().Get("id"), Project: r.URL.Query().Get("project"), Source: r.URL.Query().Get("source"), SourceKey: r.URL.Query().Get("sourceKey")}
		if t.ID != "" && t.Title == "" {
			s.Store.Get("task", t.ID, &t)
		}
		writeJSON(w, 200, s.Store.Duplicates(t))
	})
	mux.HandleFunc("GET /api/tasks", func(w http.ResponseWriter, r *http.Request) {
		q := strings.ToLower(r.URL.Query().Get("q"))
		out := []Task{}
		for _, t := range s.Store.Tasks() {
			if strings.Contains(strings.ToLower(t.Title+" "+t.Description), q) {
				out = append(out, t)
			}
		}
		writeJSON(w, 200, out)
	})
	mux.HandleFunc("GET /api/tasks/{id}", func(w http.ResponseWriter, r *http.Request) {
		var t Task
		if !s.Store.Get("task", r.PathValue("id"), &t) {
			apiError(w, &APIError{Status: 404, Message: "Task not found"})
			return
		}
		writeJSON(w, 200, map[string]any{"task": t, "potentialDuplicates": s.Store.Duplicates(t), "history": s.Store.Events(0, t.ID, 2000)})
	})
	mux.HandleFunc("POST /api/tasks", func(w http.ResponseWriter, r *http.Request) { s.mutateTask(w, r, "") })
	mux.HandleFunc("PUT /api/tasks/{id}", func(w http.ResponseWriter, r *http.Request) { s.mutateTask(w, r, r.PathValue("id")) })
	mux.HandleFunc("GET /api/tasks/{id}/comments", func(w http.ResponseWriter, r *http.Request) {
		var task Task
		if !s.Store.Get("task", r.PathValue("id"), &task) {
			apiError(w, &APIError{Status: 404, Message: "Task not found"})
			return
		}
		var after int64
		if value := r.URL.Query().Get("after"); value != "" {
			var err error
			after, err = strconv.ParseInt(value, 10, 64)
			if err != nil || after < 0 {
				apiError(w, invalid("after must be a nonnegative event ID"))
				return
			}
		}
		writeJSON(w, 200, s.Store.events(after, task.ID, 1000, "comment"))
	})
	mux.HandleFunc("POST /api/tasks/{id}/comments", func(w http.ResponseWriter, r *http.Request) {
		s.runMu.Lock()
		paused := s.maintenance
		s.runMu.Unlock()
		if paused {
			apiError(w, conflict("Comments paused during backup/update"))
			return
		}
		var in struct {
			Text      string `json:"text"`
			RequestID string `json:"requestId"`
		}
		if !decodeBody(w, r, &in) {
			return
		}
		event, err := s.Store.AddComment(r.PathValue("id"), in.Text, actorOf(r), in.RequestID)
		if err != nil {
			apiError(w, err)
			return
		}
		writeJSON(w, 200, event)
	})
	mux.HandleFunc("POST /api/tasks/{id}/merge", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Target         string `json:"target"`
			Revision       int    `json:"revision"`
			TargetRevision int    `json:"targetRevision"`
			Reason         string `json:"reason"`
		}
		if !decodeBody(w, r, &in) {
			return
		}
		if err := s.Store.Merge(r.PathValue("id"), in.Target, in.Revision, in.TargetRevision, actorOf(r), in.Reason); err != nil {
			apiError(w, err)
			return
		}
		var survivor Task
		s.Store.Get("task", in.Target, &survivor)
		writeJSON(w, 200, map[string]any{"merged": true, "task": survivor})
	})
	mux.HandleFunc("GET /api/history", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, s.Store.Events(0, r.URL.Query().Get("entity"), 10000))
	})
	mux.HandleFunc("POST /api/undo/{id}", func(w http.ResponseWriter, r *http.Request) {
		id, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
		if err := s.Store.Undo(id, actorOf(r)); err != nil {
			apiError(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{"undone": true})
	})
	mux.HandleFunc("GET /api/columns", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, s.Store.ListRaw("column")) })
	mux.HandleFunc("POST /api/columns", s.saveColumn)
	mux.HandleFunc("DELETE /api/columns/{id}", s.deleteColumn)
	for _, kind := range []string{"project", "tag"} {
		mux.HandleFunc("POST /api/"+kind+"s/{id}/merge", func(w http.ResponseWriter, r *http.Request) {
			var in struct {
				Target string `json:"target"`
			}
			if !decodeBody(w, r, &in) {
				return
			}
			if err := s.Store.MergeEntity(kind, r.PathValue("id"), in.Target, actorOf(r)); err != nil {
				apiError(w, err)
				return
			}
			writeJSON(w, 200, map[string]bool{"merged": true})
		})
		mux.HandleFunc("GET /api/"+kind+"s", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, s.Store.ListRaw(kind)) })
		mux.HandleFunc("POST /api/"+kind+"s", func(w http.ResponseWriter, r *http.Request) {
			var v Entity
			if !decodeBody(w, r, &v) {
				return
			}
			if trim(v.Name) == "" || len(v.Name) > 100 {
				apiError(w, invalid("Name is required and must be at most 100 characters"))
				return
			}
			if v.ID == "" {
				v.ID = newID(kind + "_")
			}
			if err := s.Store.Put(kind, v.ID, v, actorOf(r), "Save "+kind); err != nil {
				apiError(w, err)
				return
			}
			writeJSON(w, 200, v)
		})
	}
	mux.HandleFunc("GET /api/jobs", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, s.Store.ListRaw("job")) })
	mux.HandleFunc("POST /api/jobs", func(w http.ResponseWriter, r *http.Request) {
		var j Job
		if !decodeBody(w, r, &j) {
			return
		}
		out, err := s.SaveJob(j, j.Revision, actorOf(r))
		if err != nil {
			apiError(w, err)
			return
		}
		writeJSON(w, 200, out)
	})
	mux.HandleFunc("POST /api/jobs/{id}/run", func(w http.ResponseWriter, r *http.Request) {
		run, err := s.RunJob(r.PathValue("id"))
		if err != nil {
			apiError(w, err)
			return
		}
		writeJSON(w, 200, run)
	})
	mux.HandleFunc("POST /api/jobs/{id}/reset", func(w http.ResponseWriter, r *http.Request) {
		if err := s.ResetJob(r.PathValue("id")); err != nil {
			apiError(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{"reset": true})
	})
	mux.HandleFunc("GET /api/runs", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, s.Store.ListRaw("run")) })
	mux.HandleFunc("GET /api/runs/{id}/activity", func(w http.ResponseWriter, r *http.Request) {
		var run Run
		if !s.Store.Get("run", r.PathValue("id"), &run) {
			apiError(w, &APIError{Status: 404, Message: "Run not found"})
			return
		}
		var after int64
		if value := r.URL.Query().Get("after"); value != "" {
			var err error
			after, err = strconv.ParseInt(value, 10, 64)
			if err != nil || after < 0 {
				apiError(w, invalid("after must be a nonnegative activity ID"))
				return
			}
		}
		entries, err := s.Store.RunActivity(run.ID, after)
		if err != nil {
			apiError(w, err)
			return
		}
		writeJSON(w, 200, runActivity{Run: run, Entries: entries})
	})
	mux.HandleFunc("GET /api/runs/{id}", func(w http.ResponseWriter, r *http.Request) {
		var run Run
		if !s.Store.Get("run", r.PathValue("id"), &run) {
			apiError(w, invalid("Run not found"))
			return
		}
		writeJSON(w, 200, map[string]any{"run": run, "entries": s.Store.Logs(run.ID)})
	})
	mux.HandleFunc("POST /api/runs/{id}/cancel", func(w http.ResponseWriter, r *http.Request) {
		if err := s.CancelRun(r.PathValue("id")); err != nil {
			apiError(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{"cancelled": true})
	})
	mux.HandleFunc("POST /api/images", func(w http.ResponseWriter, r *http.Request) {
		s.runMu.Lock()
		paused := s.maintenance
		s.runMu.Unlock()
		if paused {
			apiError(w, conflict("Uploads paused during backup/update"))
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, 21<<20)
		if err := r.ParseMultipartForm(1 << 20); err != nil {
			apiError(w, invalid("Use multipart image upload, maximum 20 MB"))
			return
		}
		defer r.MultipartForm.RemoveAll()
		file, header, err := r.FormFile("file")
		if err != nil {
			apiError(w, invalid("Image file required"))
			return
		}
		defer file.Close()
		b, err := io.ReadAll(io.LimitReader(file, 21<<20))
		if err != nil {
			apiError(w, err)
			return
		}
		a, err := s.Storage.Upload(r.Context(), header.Filename, b)
		if err != nil {
			apiError(w, err)
			return
		}
		if err = s.Store.Put("attachment", a.ID, a, actorOf(r), "Uploaded task image"); err != nil {
			apiError(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{"attachment": a, "url": "/api/images/" + a.ID})
	})
	mux.HandleFunc("GET /api/images/{id}", func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		var a Attachment
		if !safeObjectID(id) || !s.Store.Get("attachment", id, &a) {
			http.NotFound(w, r)
			return
		}
		b, err := s.Storage.Read(r.Context(), id)
		if err != nil {
			apiError(w, &APIError{Status: 503, Message: "Image storage unavailable"})
			return
		}
		w.Header().Set("Content-Type", a.MIME)
		w.Header().Set("Content-Disposition", `inline; filename="image"`)
		_, _ = w.Write(b)
	})
	mux.HandleFunc("PUT /api/settings", func(w http.ResponseWriter, r *http.Request) {
		var cfg Settings
		if !decodeBody(w, r, &cfg) {
			return
		}
		if err := s.SaveSettings(cfg); err != nil {
			apiError(w, err)
			return
		}
		writeJSON(w, 200, cfg)
	})
	mux.HandleFunc("POST /api/setup/{action}", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Overwrite bool `json:"overwrite"`
		}
		if !decodeBody(w, r, &in) {
			return
		}
		out, err := s.Setup(r.PathValue("action"), in.Overwrite)
		if err != nil {
			apiError(w, err)
			return
		}
		writeJSON(w, 200, out)
	})
	mux.HandleFunc("POST /api/notifications/{id}/read", func(w http.ResponseWriter, r *http.Request) {
		var n Notification
		if !s.Store.Get("notification", r.PathValue("id"), &n) {
			apiError(w, invalid("Notification not found"))
			return
		}
		n.Read = true
		if err := s.Store.Put("notification", n.ID, n, "user", "Read notification"); err != nil {
			apiError(w, err)
			return
		}
		writeJSON(w, 200, n)
	})
	mux.HandleFunc("GET /api/update", func(w http.ResponseWriter, r *http.Request) {
		s.updateMu.Lock()
		defer s.updateMu.Unlock()
		writeJSON(w, 200, s.update)
	})
	mux.HandleFunc("POST /api/update/check", func(w http.ResponseWriter, r *http.Request) {
		writeOperation(w, r, func(ctx context.Context) (any, error) { return s.CheckUpdate(ctx), nil })
	})
	mux.HandleFunc("POST /api/update/apply", func(w http.ResponseWriter, r *http.Request) {
		// A successful install restarts Sift on its own once the response is
		// sent, so the update is never left on disk behind an old process.
		restarting := false
		writeOperation(w, r, func(ctx context.Context) (any, error) {
			result, err := s.ApplyUpdate(ctx)
			restarting = err == nil && result["restarting"] == true
			return result, err
		})
		if restarting {
			s.restart()
		}
	})
	mux.HandleFunc("POST /api/restart", func(w http.ResponseWriter, r *http.Request) {
		if err := s.reserveRestart(false); err != nil {
			apiError(w, err)
			return
		}
		writeJSON(w, 202, map[string]bool{"restarting": true})
		s.restart()
	})
	mux.HandleFunc("POST /api/backups", func(w http.ResponseWriter, r *http.Request) {
		writeOperation(w, r, func(ctx context.Context) (any, error) {
			path, err := s.backupContext(ctx)
			return map[string]any{"name": filepath.Base(path), "path": path}, err
		})
	})
	mux.HandleFunc("GET /api/backups", func(w http.ResponseWriter, r *http.Request) {
		files, _ := filepath.Glob(filepath.Join(s.Dir, "backups", "*.zip"))
		sort.Sort(sort.Reverse(sort.StringSlice(files)))
		out := []map[string]any{}
		for _, f := range files {
			i, _ := os.Stat(f)
			out = append(out, map[string]any{"name": filepath.Base(f), "size": i.Size(), "at": i.ModTime()})
		}
		writeJSON(w, 200, out)
	})
	mux.HandleFunc("GET /api/backups/{name}", func(w http.ResponseWriter, r *http.Request) {
		name := r.PathValue("name")
		if filepath.Base(name) != name || !strings.HasSuffix(name, ".zip") {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Disposition", `attachment; filename="`+name+`"`)
		http.ServeFile(w, r, filepath.Join(s.Dir, "backups", name))
	})
	mux.HandleFunc("POST /api/restore", func(w http.ResponseWriter, r *http.Request) {
		r.Body = http.MaxBytesReader(w, r.Body, 800<<20)
		b, err := io.ReadAll(r.Body)
		if err == nil {
			err = s.RestoreArchive(r.Context(), b)
		}
		if err != nil {
			apiError(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{"restored": true, "jobsPaused": true})
	})
	root, _ := fs.Sub(frontend, "public")
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" {
			http.Error(w, "Method not allowed", 405)
			return
		}
		path := strings.TrimPrefix(r.URL.Path, "/")
		if path == "" {
			path = "index.html"
		}
		if _, err := fs.Stat(root, path); err != nil {
			path = "index.html"
		}
		if path == "sw.js" {
			w.Header().Set("Service-Worker-Allowed", "/")
			w.Header().Set("Cache-Control", "no-cache")
		}
		data, err := fs.ReadFile(root, path)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		if path == "index.html" {
			w.Header().Set("Cache-Control", "no-cache")
		}
		http.ServeContent(w, r, path, time.Time{}, bytes.NewReader(data))
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		maintenance := r.URL.Path == "/api/update/apply" || r.URL.Path == "/api/pi/update" || r.URL.Path == "/api/backups" || r.URL.Path == "/api/restore"
		if r.Method != "GET" && r.Method != "HEAD" && !maintenance {
			if !s.dataMu.TryRLock() {
				apiError(w, conflict("Workspace changes are paused for maintenance"))
				return
			}
			defer s.dataMu.RUnlock()
		}
		mux.ServeHTTP(w, r)
	})
}
func (s *Service) mutateTask(w http.ResponseWriter, r *http.Request, id string) {
	s.runMu.Lock()
	paused := s.maintenance
	s.runMu.Unlock()
	if paused {
		apiError(w, conflict("Task changes paused during backup/update"))
		return
	}
	var in struct {
		Task             Task   `json:"task"`
		ExpectedRevision int    `json:"expectedRevision"`
		Reason           string `json:"reason"`
		RequestID        string `json:"requestId"`
	}
	if !decodeBody(w, r, &in) {
		return
	}
	if id != "" {
		in.Task.ID = id
	}
	out, err := s.Store.SaveTask(in.Task, in.ExpectedRevision, actorOf(r), in.Reason, in.RequestID)
	if err != nil {
		apiError(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"task": out, "potentialDuplicates": s.Store.Duplicates(out)})
}
func (s *Service) streamEvents(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "Streaming unavailable", 500)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	cursor, _ := strconv.ParseInt(r.Header.Get("Last-Event-ID"), 10, 64)
	if cursor == 0 {
		cursor, _ = strconv.ParseInt(r.URL.Query().Get("after"), 10, 64)
	}
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()
	var generation string
	_ = s.Store.DB.QueryRow("SELECT value FROM metadata WHERE key='restore_generation'").Scan(&generation)
	for {
		var latestGeneration string
		_ = s.Store.DB.QueryRow("SELECT value FROM metadata WHERE key='restore_generation'").Scan(&latestGeneration)
		if latestGeneration != generation || cursor > s.Store.Latest() {
			cursor = 0
			generation = latestGeneration
			if _, err := fmt.Fprint(w, "event: reset\ndata: {}\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
		_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(5 * time.Second))
		events := s.Store.Events(cursor, "", 500)
		for _, e := range events {
			_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(5 * time.Second))
			if _, err := fmt.Fprintf(w, "id: %d\nevent: change\ndata: %s\n\n", e.ID, encode(e)); err != nil {
				return
			}
			cursor = e.ID
		}
		if len(events) > 0 {
			flusher.Flush()
		}
		select {
		case <-r.Context().Done():
			return
		case <-s.stopping:
			return
		case <-ticker.C:
			fmt.Fprintf(w, "event: tick\ndata: {}\n\n")
			flusher.Flush()
		case <-heartbeat.C:
			fmt.Fprint(w, ": heartbeat\n\n")
			flusher.Flush()
		}
	}
}
func (s *Service) saveColumn(w http.ResponseWriter, r *http.Request) {
	if actorOf(r) != "user" {
		apiError(w, &APIError{Status: 403, Message: "Only the user can manage columns through the UI"})
		return
	}
	var c Column
	if !decodeBody(w, r, &c) {
		return
	}
	if trim(c.Name) == "" {
		apiError(w, invalid("Column name required"))
		return
	}
	if c.ID == "" {
		c.ID = newID("col_")
		c.Order = len(s.Store.ListRaw("column"))
	}
	if err := s.Store.Put("column", c.ID, c, "user", "Save workflow column"); err != nil {
		apiError(w, err)
		return
	}
	writeJSON(w, 200, c)
}
func (s *Service) deleteColumn(w http.ResponseWriter, r *http.Request) {
	if actorOf(r) != "user" {
		apiError(w, &APIError{Status: 403, Message: "Only the user can manage columns"})
		return
	}
	id := r.PathValue("id")
	if id == "open" || id == "done" {
		apiError(w, invalid("Open and Done are required workflow columns"))
		return
	}
	target := r.URL.Query().Get("moveTo")
	var c Column
	if !s.Store.Get("column", target, &c) || target == id {
		apiError(w, invalid("Select a valid destination column"))
		return
	}
	if err := s.Store.DeleteColumn(id, target); err != nil {
		apiError(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"deleted": true})
}
