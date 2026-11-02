package sift

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/mattn/go-isatty"
)

type cliProgress struct {
	mu      sync.Mutex
	out     io.Writer
	started time.Time
	err     error
	done    chan struct{}
	stopped chan struct{}
}

func progressEnabled(mode string, quiet bool, out io.Writer) (bool, error) {
	if mode == "" {
		mode = "auto"
	}
	if mode != "auto" && mode != "always" && mode != "never" {
		return false, invalid("--progress must be auto, always, or never")
	}
	if quiet || mode == "never" {
		return false, nil
	}
	if mode == "always" {
		return true, nil
	}
	f, ok := out.(*os.File)
	return ok && isatty.IsTerminal(f.Fd()), nil
}

// Append-only lines work in terminals and captured logs without ANSI escapes.
// The ticker only describes elapsed waiting, never invented completion/ETA.
func startCLIProgress(ctx context.Context, out io.Writer, label string, interval time.Duration) (*cliProgress, context.Context) {
	p := &cliProgress{out: out, started: time.Now(), done: make(chan struct{}), stopped: make(chan struct{})}
	p.update(operationProgress{Message: label})
	go func() {
		defer close(p.stopped)
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-p.done:
				return
			case <-ctx.Done():
				return
			case <-ticker.C:
				p.mu.Lock()
				p.write("[sift] Still waiting · %s elapsed (waiting)\n", time.Since(p.started).Truncate(time.Second))
				p.mu.Unlock()
			}
		}
	}()
	return p, context.WithValue(ctx, progressKey{}, p.update)
}

func terminalText(value string) string {
	return strings.Map(func(r rune) rune {
		if (unicode.IsControl(r) && r != '\n' && r != '\t') || unicode.In(r, unicode.Cf) {
			return -1
		}
		return r
	}, value)
}

func (p *cliProgress) update(v operationProgress) {
	message := terminalText(v.Message)
	if v.Unit != "" {
		if v.Total > 0 {
			message += fmt.Sprintf(" · %d/%d %s", v.Current, v.Total, terminalText(v.Unit))
		} else {
			message += fmt.Sprintf(" · %d %s", v.Current, terminalText(v.Unit))
		}
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	p.write("[sift] %s\n", message)
}

// Caller holds mu. A broken progress pipe must not replay or hide a mutation.
func (p *cliProgress) write(format string, values ...any) {
	if p.err == nil {
		_, p.err = fmt.Fprintf(p.out, format, values...)
	}
}

func (p *cliProgress) finish(err error) error {
	close(p.done)
	<-p.stopped
	p.mu.Lock()
	defer p.mu.Unlock()
	state := "Finished"
	if err != nil {
		state = "Stopped with an error; inspect the result before retrying"
	}
	p.write("[sift] %s · %s elapsed\n", state, time.Since(p.started).Truncate(time.Millisecond))
	if p.err != nil {
		return fmt.Errorf("Progress output failed; inspect the result before retrying: %w", p.err)
	}
	return nil
}

type runActivity struct {
	Run     Run           `json:"run"`
	Entries []runLogEntry `json:"entries"`
}
type runLogEntry struct {
	ID int64 `json:"id"`
	RunEntry
}

func (c *localClient) watchRun(ctx context.Context, id string, interval time.Duration) ([]byte, error) {
	var cursor int64
	var status string
	for {
		requestCtx, cancel := context.WithTimeout(ctx, 45*time.Second)
		b, err := c.request(requestCtx, "GET", fmt.Sprintf("/api/runs/%s/activity?after=%d", url.PathEscape(id), cursor), nil)
		cancel()
		if err != nil {
			if ctx.Err() != nil {
				return nil, fmt.Errorf("Stopped following run %s; the run was not cancelled: %w", id, ctx.Err())
			}
			return nil, err
		}
		var activity runActivity
		if err = json.Unmarshal(b, &activity); err != nil {
			return nil, err
		}
		if activity.Run.ID != id || activity.Run.Status == "" {
			return nil, invalid("Invalid run activity response")
		}
		if activity.Run.Status != status {
			status = activity.Run.Status
			reportProgress(ctx, "Run "+id+": "+status, 0, 0, "")
		}
		for _, entry := range activity.Entries {
			if entry.ID <= cursor {
				return nil, invalid("Run activity cursor did not advance")
			}
			cursor = entry.ID
			reportProgress(ctx, entry.Type+": "+entry.Text, 0, 0, "")
		}
		if len(activity.Entries) == 500 {
			continue
		}
		if status != "queued" && status != "running" {
			result := encode(activity.Run)
			if status != "succeeded" {
				return result, fmt.Errorf("Run %s ended %s: %s", id, status, terminalText(activity.Run.Error))
			}
			return result, nil
		}
		timer := time.NewTimer(interval)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil, fmt.Errorf("Stopped following run %s; the run was not cancelled: %w", id, ctx.Err())
		case <-timer.C:
		}
	}
}
