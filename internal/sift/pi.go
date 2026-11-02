package sift

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

type Pi struct {
	cmd       *exec.Cmd
	in        io.WriteCloser
	mu        sync.Mutex
	pending   map[string]chan map[string]any
	events    chan map[string]any
	done      chan struct{}
	stop      chan struct{}
	stderr    bytes.Buffer
	errMu     sync.Mutex
	exitErr   error
	closeOnce sync.Once
}

func PiPath() string {
	if v := os.Getenv("SIFT_PI"); v != "" {
		return v
	}
	p, err := exec.LookPath("pi")
	if err == nil {
		return p
	}
	home, _ := os.UserHomeDir()
	for _, p := range []string{filepath.Join(home, ".bun/bin/pi"), filepath.Join(home, ".local/bin/pi"), "/opt/homebrew/bin/pi", "/usr/local/bin/pi"} {
		if _, e := os.Stat(p); e == nil {
			return p
		}
	}
	return "pi"
}
func StartPi(dir string, args ...string) (*Pi, error) {
	p := &Pi{pending: map[string]chan map[string]any{}, events: make(chan map[string]any, 1024), done: make(chan struct{}), stop: make(chan struct{})}
	p.cmd = exec.Command(PiPath(), append([]string{"--mode", "rpc"}, args...)...)
	p.cmd.Dir = dir
	p.cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	in, err := p.cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	p.in = in
	out, err := p.cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr, err := p.cmd.StderrPipe()
	if err != nil {
		return nil, err
	}
	if err = p.cmd.Start(); err != nil {
		return nil, fmt.Errorf("Cannot start local Pi: %w", err)
	}
	go func() {
		buf := make([]byte, 8192)
		for {
			n, e := stderr.Read(buf)
			if n > 0 {
				p.errMu.Lock()
				if p.stderr.Len() > 32768 {
					p.stderr.Reset()
				}
				p.stderr.Write(buf[:n])
				p.errMu.Unlock()
			}
			if e != nil {
				return
			}
		}
	}()
	go func() {
		r := bufio.NewReaderSize(out, 64*1024)
		for {
			line, e := readRecord(r, 64<<20)
			if e != nil {
				break
			}
			var event map[string]any
			if json.Unmarshal(line, &event) != nil {
				continue
			}
			if event["type"] == "response" {
				id, _ := event["id"].(string)
				p.mu.Lock()
				ch := p.pending[id]
				delete(p.pending, id)
				p.mu.Unlock()
				if ch != nil {
					ch <- event
				}
			} else {
				select {
				case p.events <- event:
				case <-p.stop:
				}
			}
		}
		p.exitErr = p.cmd.Wait()
		close(p.done)
	}()
	return p, nil
}
func readRecord(r *bufio.Reader, maxBytes int) ([]byte, error) {
	var b []byte
	for {
		part, e := r.ReadSlice('\n')
		if len(b)+len(part) > maxBytes {
			return nil, errors.New("Pi record exceeds safety limit")
		}
		b = append(b, part...)
		if e == bufio.ErrBufferFull {
			continue
		}
		if e != nil {
			return nil, e
		}
		return bytes.TrimSuffix(bytes.TrimSuffix(b, []byte{'\n'}), []byte{'\r'}), nil
	}
}
func (p *Pi) Call(ctx context.Context, command map[string]any) (map[string]any, error) {
	id := newID("rpc_")
	command["id"] = id
	ch := make(chan map[string]any, 1)
	p.mu.Lock()
	p.pending[id] = ch
	defer func() { p.mu.Lock(); delete(p.pending, id); p.mu.Unlock() }()
	_, err := p.in.Write(append(encode(command), '\n'))
	p.mu.Unlock()
	if err != nil {
		return nil, err
	}
	select {
	case response := <-ch:
		if response["success"] != true {
			return nil, fmt.Errorf("Pi: %v", response["error"])
		}
		data, _ := response["data"].(map[string]any)
		return data, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-p.done:
		return nil, fmt.Errorf("Pi exited before responding")
	}
}
func (p *Pi) Close() {
	p.closeOnce.Do(func() {
		close(p.stop)
		_ = p.in.Close()
		select {
		case <-p.done:
			return
		case <-time.After(3 * time.Second):
		}
		if p.cmd.Process != nil {
			_ = syscall.Kill(-p.cmd.Process.Pid, syscall.SIGTERM)
		}
		select {
		case <-p.done:
		case <-time.After(2 * time.Second):
			if p.cmd.Process != nil {
				_ = syscall.Kill(-p.cmd.Process.Pid, syscall.SIGKILL)
			}
		}
	})
}
func (p *Pi) Abort() {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_, _ = p.Call(ctx, map[string]any{"type": "clear_queue"})
	_, _ = p.Call(ctx, map[string]any{"type": "abort"})
}
func ProbePi(ctx context.Context, provider, model string) (map[string]any, error) {
	p, err := StartPi("", "--no-session")
	if err != nil {
		return nil, err
	}
	defer p.Close()
	state, err := p.Call(ctx, map[string]any{"type": "get_state"})
	if err != nil {
		return nil, err
	}
	models, err := p.Call(ctx, map[string]any{"type": "get_available_models"})
	if err != nil {
		return nil, err
	}
	if provider != "" && model != "" {
		_, err = p.Call(ctx, map[string]any{"type": "set_model", "provider": provider, "modelId": model})
		if err != nil {
			return nil, err
		}
	}
	thinking, e := p.Call(ctx, map[string]any{"type": "get_available_thinking_levels"})
	if e != nil {
		thinking = map[string]any{"levels": []any{}}
	}
	vctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	version, _ := exec.CommandContext(vctx, PiPath(), "--version").Output()
	return map[string]any{"connected": true, "version": trim(string(version)), "path": PiPath(), "state": state, "models": models["models"], "thinking": thinking}, nil
}
func (s *Service) executeRun(ctx context.Context, job Job, run Run) {
	defer func() { s.runMu.Lock(); delete(s.active, job.ID); delete(s.activeRun, job.ID); s.runMu.Unlock() }()
	args := []string{"--session-dir", filepath.Join(s.Dir, "sessions", job.ID), "--session-id", job.SessionID, "--name", "Sift · " + job.Name}
	p, err := StartPi(job.Directory, args...)
	if err != nil {
		s.finishRun(run, "action-needed", err.Error(), "")
		return
	}
	defer p.Close()
	rpcctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	if job.Provider != "" && job.Model != "" {
		_, err = p.Call(rpcctx, map[string]any{"type": "set_model", "provider": job.Provider, "modelId": job.Model})
		if err != nil {
			if s.finishCancelled(ctx, run) {
				return
			}
			s.finishRun(run, "action-needed", err.Error(), "")
			return
		}
	}
	if job.Thinking != "" {
		_, err = p.Call(rpcctx, map[string]any{"type": "set_thinking_level", "level": job.Thinking})
		if err != nil {
			if s.finishCancelled(ctx, run) {
				return
			}
			s.finishRun(run, "action-needed", err.Error(), "")
			return
		}
	}
	state, err := p.Call(rpcctx, map[string]any{"type": "get_state"})
	if err != nil {
		if s.finishCancelled(ctx, run) {
			return
		}
		s.finishRun(run, "failed", err.Error(), "")
		return
	}
	if m, ok := state["model"].(map[string]any); ok {
		run.Model = fmt.Sprint(m["provider"]) + "/" + fmt.Sprint(m["id"])
		if job.Model != "" && (m["id"] != job.Model || m["provider"] != job.Provider) {
			s.finishRun(run, "action-needed", "Pi did not select the requested model; refusing silent fallback", "")
			return
		}
	} else {
		s.finishRun(run, "action-needed", "Pi has no configured model; select and authenticate a model in Pi", "")
		return
	}
	_ = s.Store.Put("run", run.ID, run, "system", "Pi connected")
	exe, _ := os.Executable()
	guide := fmt.Sprintf("You are running a scheduled Sift job. Use %q --data %q for the local task CLI. Read `sift help` and `sift schema` first. You can add/update tasks, discover columns, search icons and potential duplicates, manage projects/tags and subtasks, upload local task images, complete with a reason, and merge only when the user explicitly authorized the specific merge, with a reason. A duplicate suggestion is never merge authorization. Use --actor %q on mutations and expected task revisions. Never create columns. Check potential duplicates before creating work; use source keys and request IDs for deduplication. Your own job/run IDs are %s/%s. Sift does not sandbox normal Pi tools. Do not read Sift private credential files. The user prompt follows.\n\n", exe, s.Dir, "job:"+job.ID, job.ID, run.ID)
	command := map[string]any{"type": "prompt", "message": guide + job.Prompt}
	if job.IncludeImages {
		images := []map[string]string{}
		for _, task := range s.Store.Tasks() {
			if !task.Today || task.DeletedAt != "" {
				continue
			}
			for _, id := range task.Attachments {
				if len(images) >= 8 {
					break
				}
				var a Attachment
				if s.Store.Get("attachment", id, &a) && a.Size < 5<<20 {
					if data, e := s.Storage.ReadBase64(ctx, id); e == nil {
						images = append(images, map[string]string{"type": "image", "data": data, "mimeType": a.MIME})
					}
				}
			}
		}
		command["images"] = images
	}
	accepted, err := p.Call(rpcctx, command)
	if err != nil {
		if s.finishCancelled(ctx, run) {
			return
		}
		s.finishRun(run, "action-needed", err.Error(), "")
		return
	}
	if accepted["disposition"] == "handled" {
		s.finishRun(run, "succeeded", "", "Prompt handled without a model run")
		return
	}
	var text strings.Builder
	var failure string
	var pending strings.Builder
	ticker := time.NewTicker(150 * time.Millisecond)
	defer ticker.Stop()
	flush := func() {
		if pending.Len() > 0 {
			s.Store.AddLog(run.ID, RunEntry{Type: "text", Text: pending.String()})
			pending.Reset()
		}
	}
	for {
		select {
		case <-ctx.Done():
			p.Abort()
			flush()
			status := "cancelled"
			if errors.Is(ctx.Err(), context.DeadlineExceeded) {
				status = "timed-out"
			}
			s.finishRun(run, status, ctx.Err().Error(), text.String())
			return
		case <-p.done:
			flush()
			s.finishRun(run, "interrupted", "Pi exited before agent_settled", text.String())
			return
		case <-ticker.C:
			flush()
		case e := <-p.events:
			kind, _ := e["type"].(string)
			switch kind {
			case "message_update":
				if update, ok := e["assistantMessageEvent"].(map[string]any); ok && update["type"] == "text_delta" {
					delta, _ := update["delta"].(string)
					text.WriteString(delta)
					pending.WriteString(delta)
				}
			case "tool_execution_start":
				flush()
				s.Store.AddLog(run.ID, RunEntry{Type: "tool", Tool: fmt.Sprint(e["toolName"]), Text: "Running " + fmt.Sprint(e["toolName"])})
			case "tool_execution_end":
				if e["isError"] == true {
					s.Store.AddLog(run.ID, RunEntry{Type: "tool-error", Tool: fmt.Sprint(e["toolName"]), Text: "Tool reported an error; inspect Pi session for details"})
				}
			case "message_end":
				if msg, ok := e["message"].(map[string]any); ok && msg["role"] == "assistant" && msg["stopReason"] == "error" {
					failure = fmt.Sprint(msg["errorMessage"])
				}
			case "extension_ui_request":
				method := fmt.Sprint(e["method"])
				if method == "confirm" || method == "select" || method == "input" || method == "editor" {
					flush()
					p.Abort()
					s.finishRun(run, "action-needed", "A Pi extension requested human input: "+fmt.Sprint(e["title"]), text.String())
					return
				}
			case "auto_retry_start", "auto_compaction_start", "auto_compaction_end":
				s.Store.AddLog(run.ID, RunEntry{Type: "system", Text: strings.ReplaceAll(kind, "_", " ")})
			case "agent_settled":
				flush()
				status := "succeeded"
				if e["aborted"] == true {
					status = "cancelled"
				}
				if failure != "" {
					status = piFailureStatus(failure)
				}
				s.finishRun(run, status, failure, text.String())
				return
			}
		}
	}
}
func (s *Service) finishCancelled(ctx context.Context, run Run) bool {
	if ctx.Err() == nil {
		return false
	}
	status := "cancelled"
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		status = "timed-out"
	}
	s.finishRun(run, status, ctx.Err().Error(), "")
	return true
}
func (s *Service) finishRun(run Run, status, message, text string) {
	run.Status = status
	run.Error = message
	run.EndedAt = now()
	if len(text) > 16000 {
		text = text[len(text)-16000:]
	}
	run.Summary = text
	_ = s.Store.Put("run", run.ID, run, "system", "Run "+status)
	if status == "action-needed" {
		s.runMu.Lock()
		var j Job
		if s.Store.Get("job", run.JobID, &j) {
			j.Enabled, j.Pending = false, false
			j.Revision++
			_ = s.Store.Put("job", j.ID, j, "system", "Paused until human attention: "+message)
		}
		s.runMu.Unlock()
	}
	if status != "succeeded" && status != "cancelled" {
		s.Notify("Job needs attention", run.JobName+": "+message)
	}
}

func piFailureStatus(message string) string {
	v := strings.ToLower(message)
	for _, marker := range []string{"auth", "unauthorized", "api key", "api_key", "credential", "sign in", "login", "log in", "401", "403", "model not found", "model unavailable", "unknown model"} {
		if strings.Contains(v, marker) {
			return "action-needed"
		}
	}
	return "failed"
}
