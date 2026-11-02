package sift

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"
)

const progressMediaType = "application/x-ndjson"

type operationProgress struct {
	Message string `json:"message"`
	Current int64  `json:"current,omitempty"`
	Total   int64  `json:"total,omitempty"`
	Unit    string `json:"unit,omitempty"`
}
type progressKey struct{}
type progressEnvelope struct {
	Type     string             `json:"type"`
	Progress *operationProgress `json:"progress,omitempty"`
	Result   json.RawMessage    `json:"result,omitempty"`
	Error    string             `json:"error,omitempty"`
}

func reportProgress(ctx context.Context, message string, current, total int64, unit string) {
	if report, ok := ctx.Value(progressKey{}).(func(operationProgress)); ok {
		report(operationProgress{Message: message, Current: current, Total: total, Unit: unit})
	}
}

// Streaming is opt-in on the same authenticated request. There is no second
// mutation, background job, global progress state, or retry on stream failure.
func writeOperation(w http.ResponseWriter, r *http.Request, operation func(context.Context) (any, error)) {
	flusher, streaming := w.(http.Flusher)
	if r.Header.Get("Accept") != progressMediaType || !streaming {
		result, err := operation(r.Context())
		if err != nil {
			apiError(w, err)
			return
		}
		writeJSON(w, 200, result)
		return
	}
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	w.Header().Set("Content-Type", progressMediaType)
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Accel-Buffering", "no")
	encoder := json.NewEncoder(w)
	send := func(frame progressEnvelope) {
		_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(5 * time.Second))
		if err := encoder.Encode(frame); err != nil {
			cancel()
			return
		}
		flusher.Flush()
	}
	ctx = context.WithValue(ctx, progressKey{}, func(p operationProgress) { send(progressEnvelope{Type: "progress", Progress: &p}) })
	result, err := operation(ctx)
	if err != nil {
		status := 500
		var e *APIError
		if errors.As(err, &e) {
			status = e.Status
		}
		logFailure(status, err)
		send(progressEnvelope{Type: "error", Error: err.Error()})
		return
	}
	send(progressEnvelope{Type: "result", Result: encode(result)})
}

func readOperation(ctx context.Context, reader io.Reader) ([]byte, error) {
	decoder := json.NewDecoder(io.LimitReader(reader, 32<<20))
	for {
		var frame progressEnvelope
		if err := decoder.Decode(&frame); err != nil {
			return nil, fmt.Errorf("Operation stream ended before a result; inspect its effects before retrying: %w", err)
		}
		switch frame.Type {
		case "progress":
			if frame.Progress != nil {
				p := frame.Progress
				reportProgress(ctx, p.Message, p.Current, p.Total, p.Unit)
			}
		case "result":
			if len(frame.Result) == 0 {
				return nil, fmt.Errorf("Operation stream returned no result")
			}
			return frame.Result, nil
		case "error":
			return nil, fmt.Errorf("Operation failed: %s", terminalText(frame.Error))
		default:
			return nil, fmt.Errorf("Unknown operation stream frame %q", frame.Type)
		}
	}
}

type progressReader struct {
	reader         io.Reader
	ctx            context.Context
	message        string
	current, total int64
	last           time.Time
}

func (r *progressReader) Read(b []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	n, err := r.reader.Read(b)
	r.current += int64(n)
	if time.Since(r.last) >= 250*time.Millisecond || err != nil || r.current == r.total {
		reportProgress(r.ctx, r.message, r.current, r.total, "bytes")
		r.last = time.Now()
	}
	return n, err
}
