package sift

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// Chat is the person's conversation with their local Pi from inside Sift.
//
// It keeps one Pi process for one session. `/new` starts a fresh session, and
// any session Pi can't open is replaced with a new one, so the chat never gets
// stuck on a broken history. Pi's events are relayed to the browser as they
// arrive; questions an extension asks (confirm, choose, type) wait for the
// person's answer instead of failing the reply.
type Chat struct {
	dir string
	// startMu serializes starting and replacing the Pi process; mu guards the
	// fields below and is never held while waiting on Pi.
	startMu  sync.Mutex
	mu       sync.Mutex
	cfg      chatConfig
	pi       *Pi
	starting *Pi
	running  bool
	dialogs  map[string]chatDialog
	commands []any
	models   []any
	levels   []any
	modelErr string
	lastUse  time.Time
	stopping string
	// notice explains, once, that a broken session was replaced.
	notice string
	// queue and statuses repeat Pi's latest queue_update and extension
	// statuses for pages that open after they were sent.
	queue    map[string]any
	statuses map[string]string
	subsMu   sync.Mutex
	subs     map[chan []byte]struct{}
	// paused refuses to start Pi during backups, restores, and updates.
	paused func() error
}

type chatConfig struct {
	SessionID string `json:"sessionId"`
	Provider  string `json:"provider"`
	Model     string `json:"model"`
	Thinking  string `json:"thinking"`
}

type chatDialog struct {
	request map[string]any
	expires time.Time
}

// ChatPrompt is one message from the person. Context describes what they are
// looking at in Sift; images are pasted screenshots.
type ChatPrompt struct {
	Message string      `json:"message"`
	Context string      `json:"context"`
	Images  []ChatImage `json:"images"`
}
type ChatImage struct {
	Data     string `json:"data"`
	MimeType string `json:"mimeType"`
}

// ChatAnswer replies to a question an extension asked.
type ChatAnswer struct {
	Value     *string `json:"value"`
	Confirmed *bool   `json:"confirmed"`
	Cancelled bool    `json:"cancelled"`
}

const (
	chatIdleTimeout  = 15 * time.Minute
	maxChatImages    = 4
	maxChatImageSize = 5 << 20
	maxChatContext   = 1200
)

var chatImageTypes = map[string]bool{"image/png": true, "image/jpeg": true, "image/webp": true, "image/gif": true}

func newChat(dir string) *Chat {
	c := &Chat{dir: dir, dialogs: map[string]chatDialog{}, statuses: map[string]string{}, subs: map[chan []byte]struct{}{}, paused: func() error { return nil }}
	if b, err := os.ReadFile(c.configPath()); err == nil {
		_ = json.Unmarshal(b, &c.cfg)
	}
	return c
}

func (c *Chat) configPath() string { return filepath.Join(c.dir, "chat.json") }

func (c *Chat) save() {
	c.mu.Lock()
	b := encode(c.cfg)
	c.mu.Unlock()
	tmp := c.configPath() + ".tmp"
	if os.WriteFile(tmp, b, 0600) == nil {
		_ = os.Rename(tmp, c.configPath())
	}
}

func (c *Chat) guide() string {
	exe, _ := executablePath()
	return fmt.Sprintf(`You are the assistant in Sift's chat panel. Sift is the person's local task workspace, and they are talking to you from inside it.

Use the Sift CLI as %q --data %q (written below as sift). Read sift help and sift schema when unsure. Pass --actor chat on every change, and use expected revisions on updates.
Run exactly one sift command per bash call, with no pipes, redirects, or chained commands. Sift shows the person each sift command's result as a card, so summarize what changed in a sentence instead of repeating the JSON.
Before adding a task, check sift tasks duplicates --title TITLE. Ask before merging or deleting; a duplicate suggestion is never permission to merge.
Keep task status current: when what you find shows a task's state changed (finished, started, or waiting on someone), move it to the matching column yourself with --status COLUMN and a --reason that cites the evidence, instead of only commenting or asking. Check sift columns list for the person's columns. Comment instead when the evidence is partial or ambiguous, and don't reverse a status the person set after the evidence you're relying on. Ask before other changes the person didn't ask about.
Read task activity and comments before acting on a task: sift tasks get ID and sift tasks comments ID. For what the person did on a day or on a task, read sift activity list --from DATE --to DATE or --task ID, their work sessions on My activity. When they ask you to log time, record it with sift activity add (and correct your own sessions with sift activity update or delete); when they ask to check or refresh their activity, run sift activity check, which runs their activity tracker over the time not checked yet. When they ask to change what the tracker looks at, when it runs or its model, or to pause it, use sift activity tracker (run it alone first for the revision). Sessions they recorded or edited themselves are theirs to change on My activity. Choose icons for the task's topic, not where it was found; brand icons only for work about that service.
A message may begin with a <sift-context> block describing what the person is looking at in Sift, such as the page and an open task. Use it to resolve "this task" or "today", and never mention the block.
You also have the person's normal Pi tools and command-line tools; use them when asked to gather context from email, chat, or files. Sift does not sandbox your tools. Do not read Sift's private credential files.`, exe, c.dir)
}

// ensure returns the running Pi, starting one for the current session if
// needed. If Pi can't open that session, a new session replaces it.
func (c *Chat) ensure(ctx context.Context) (*Pi, error) {
	c.startMu.Lock()
	defer c.startMu.Unlock()
	c.mu.Lock()
	p, session := c.pi, c.cfg.SessionID
	c.mu.Unlock()
	if p != nil {
		return p, nil
	}
	previous := session
	if err := c.paused(); err != nil {
		return nil, err
	}
	// Starting outlives the request that asked for it, so a closed tab
	// can't make a healthy session look broken.
	ctx = context.WithoutCancel(ctx)
	var lastErr error
	for attempt := 0; attempt < 2; attempt++ {
		if session == "" || attempt > 0 {
			session = newID("chat_")
		}
		p, err := c.start(ctx, session)
		if err == nil {
			c.mu.Lock()
			c.pi, c.starting, c.cfg.SessionID, c.running, c.lastUse = p, nil, session, false, time.Now()
			if previous != "" && previous != session {
				c.notice = "Pi couldn't open the previous conversation, so this is a new one. The old one is kept in Sift's data folder."
				log.Printf("Chat session %s could not be opened (%v); started %s", previous, lastErr, session)
			}
			c.mu.Unlock()
			c.save()
			c.prepare(ctx, p)
			return p, nil
		}
		lastErr = err
		if errors.Is(err, errPiUnavailable) {
			break
		}
	}
	return nil, lastErr
}

var errPiUnavailable = errors.New("local Pi is unavailable")

func (c *Chat) start(ctx context.Context, session string) (*Pi, error) {
	home, _ := os.UserHomeDir()
	p, err := StartPi(home, "--session-dir", filepath.Join(c.dir, "sessions", "chat"), "--session-id", session, "--name", "Sift chat", "--append-system-prompt", c.guide())
	if err != nil {
		return nil, fmt.Errorf("%w: %v", errPiUnavailable, err)
	}
	// Questions an extension asks while Pi starts belong to this chat too.
	c.mu.Lock()
	c.starting, c.dialogs, c.queue, c.statuses = p, map[string]chatDialog{}, nil, map[string]string{}
	c.mu.Unlock()
	go c.pump(p)
	cctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	_, err = p.Call(cctx, map[string]any{"type": "get_state"})
	if err == nil {
		// Reading the history proves the session file loads.
		_, err = p.Call(cctx, map[string]any{"type": "get_messages"})
	}
	if err != nil {
		tail := p.stderrTail()
		c.mu.Lock()
		c.starting = nil
		c.mu.Unlock()
		p.Close()
		if tail != "" {
			err = fmt.Errorf("%v (%s)", err, tail)
		}
		return nil, fmt.Errorf("Pi couldn't open the chat session: %w", err)
	}
	return p, nil
}

// prepare applies the chosen model and thinking level and caches what the
// chat panel offers: commands, models, and thinking levels.
func (c *Chat) prepare(ctx context.Context, p *Pi) {
	cctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	c.mu.Lock()
	cfg := c.cfg
	c.mu.Unlock()
	modelErr := ""
	if cfg.Provider != "" && cfg.Model != "" {
		if _, err := p.Call(cctx, map[string]any{"type": "set_model", "provider": cfg.Provider, "modelId": cfg.Model}); err != nil {
			modelErr = fmt.Sprintf("The chat's model %s/%s isn't available in Pi (%v). Choose another model.", cfg.Provider, cfg.Model, err)
		}
	}
	if cfg.Thinking != "" && modelErr == "" {
		_, _ = p.Call(cctx, map[string]any{"type": "set_thinking_level", "level": cfg.Thinking})
	}
	commands, models, levels := []any{}, []any{}, []any{}
	if d, err := p.Call(cctx, map[string]any{"type": "get_commands"}); err == nil {
		commands, _ = d["commands"].([]any)
	}
	if d, err := p.Call(cctx, map[string]any{"type": "get_available_models"}); err == nil {
		models, _ = d["models"].([]any)
	}
	if d, err := p.Call(cctx, map[string]any{"type": "get_available_thinking_levels"}); err == nil {
		levels, _ = d["levels"].([]any)
	}
	c.mu.Lock()
	if c.pi == p {
		c.modelErr, c.commands, c.models, c.levels = modelErr, commands, models, levels
	}
	c.mu.Unlock()
}

// pump relays every Pi event. It must keep reading: Pi stops answering
// commands while its event buffer is full.
func (c *Chat) pump(p *Pi) {
	for {
		select {
		case e := <-p.events:
			c.handle(p, e)
		case <-p.done:
			for {
				select {
				case e := <-p.events:
					c.handle(p, e)
					continue
				default:
				}
				break
			}
			c.exited(p)
			return
		}
	}
}

func (c *Chat) handle(p *Pi, e map[string]any) {
	kind := eventString(e, "type")
	c.mu.Lock()
	current := c.pi == p || c.starting == p
	if current {
		c.lastUse = time.Now()
		switch kind {
		case "agent_start":
			c.running = true
		case "agent_settled":
			c.running = false
		case "queue_update":
			c.queue = map[string]any{"steering": e["steering"], "followUp": e["followUp"]}
		case "extension_ui_request":
			switch eventString(e, "method") {
			case "setStatus":
				if text := eventString(e, "statusText"); text != "" {
					c.statuses[eventString(e, "statusKey")] = text
				} else {
					delete(c.statuses, eventString(e, "statusKey"))
				}
			case "select", "confirm", "input", "editor":
				d := chatDialog{request: e}
				if ms, ok := e["timeout"].(float64); ok && ms > 0 {
					d.expires = time.Now().Add(time.Duration(ms) * time.Millisecond)
				}
				c.dialogs[eventString(e, "id")] = d
			}
		}
	}
	c.mu.Unlock()
	if !current {
		return
	}
	c.broadcast(slimEvent(e))
}

// slimEvent keeps relayed events small: message_end already carries each
// message, so the bulk repeats are dropped, and tool output is clipped.
func slimEvent(e map[string]any) map[string]any {
	switch kind := eventString(e, "type"); kind {
	case "agent_end":
		return map[string]any{"type": kind, "willRetry": e["willRetry"]}
	case "turn_end":
		return map[string]any{"type": kind}
	case "message_start", "message_end":
		if m, ok := e["message"].(map[string]any); ok {
			return map[string]any{"type": kind, "message": slimMessage(m)}
		}
	case "tool_execution_start":
		args, _ := e["args"].(map[string]any)
		return map[string]any{"type": kind, "toolCallId": e["toolCallId"], "toolName": e["toolName"], "args": json.RawMessage(clipArgs(args))}
	case "tool_execution_update":
		// Tools such as bash resend their whole output so far; the tail is
		// what a live view shows.
		out := toolOutput(e["partialResult"])
		if len(out) > 4000 {
			cut := len(out) - 4000
			for cut < len(out) && !utf8.RuneStart(out[cut]) {
				cut++
			}
			out = "…" + out[cut:]
		}
		return map[string]any{"type": kind, "toolCallId": e["toolCallId"], "toolName": e["toolName"], "output": out}
	case "tool_execution_end":
		return map[string]any{"type": kind, "toolCallId": e["toolCallId"], "toolName": e["toolName"], "isError": e["isError"], "durationMs": e["durationMs"], "output": clip(toolOutput(e["result"]), maxToolOutput)}
	}
	return e
}

// slimMessage clips tool results and separates the Sift view context from
// what the person typed.
func slimMessage(m map[string]any) map[string]any {
	out := make(map[string]any, len(m)+1)
	for k, v := range m {
		out[k] = v
	}
	switch m["role"] {
	case "user":
		switch content := m["content"].(type) {
		case string:
			out["content"], out["siftContext"] = splitChatContext(content)
		case []any:
			blocks := make([]any, len(content))
			copy(blocks, content)
			for i, b := range blocks {
				if block, ok := b.(map[string]any); ok && block["type"] == "text" {
					text, view := splitChatContext(eventString(block, "text"))
					if view != "" {
						blocks[i] = map[string]any{"type": "text", "text": text}
						out["siftContext"] = view
					}
					break
				}
			}
			out["content"] = blocks
		}
		if out["siftContext"] == "" {
			delete(out, "siftContext")
		}
	case "toolResult":
		content, _ := m["content"].([]any)
		blocks := make([]any, 0, len(content))
		for _, b := range content {
			block, _ := b.(map[string]any)
			switch {
			case block["type"] == "text":
				blocks = append(blocks, map[string]any{"type": "text", "text": clip(eventString(block, "text"), maxToolOutput)})
			case block["type"] == "image" && len(eventString(block, "data")) > 2<<20:
				blocks = append(blocks, map[string]any{"type": "image", "mimeType": block["mimeType"], "omitted": true})
			default:
				blocks = append(blocks, b)
			}
		}
		out["content"] = blocks
		delete(out, "details")
	case "bashExecution":
		out["output"] = clip(eventString(m, "output"), maxToolOutput)
	case "custom":
		delete(out, "details")
	}
	return out
}

func splitChatContext(text string) (string, string) {
	rest, ok := strings.CutPrefix(text, "<sift-context>")
	if !ok {
		return text, ""
	}
	view, body, ok := strings.Cut(rest, "</sift-context>")
	if !ok {
		return text, ""
	}
	return strings.TrimLeft(body, "\n"), view
}

func (c *Chat) exited(p *Pi) {
	c.mu.Lock()
	current := c.pi == p
	reason := c.stopping
	if current {
		c.pi, c.running, c.dialogs, c.stopping = nil, false, map[string]chatDialog{}, ""
	}
	c.mu.Unlock()
	if !current {
		return
	}
	event := map[string]any{"type": "sift_chat_stopped", "reason": reason}
	if reason == "" {
		event["reason"] = "exited"
		event["error"] = strings.TrimSpace("Pi stopped unexpectedly. " + p.stderrTail())
	}
	c.broadcast(event)
}

// stop ends the Pi process (the session is kept). It waits for Pi to exit.
func (c *Chat) stop(reason string) {
	c.startMu.Lock()
	defer c.startMu.Unlock()
	c.mu.Lock()
	p := c.pi
	if p != nil {
		c.stopping = reason
	}
	c.mu.Unlock()
	if p != nil {
		p.Close()
		<-p.done
		// The pump also reports the exit, later; callers (maintenance, a new
		// message) need the chat settled when stop returns. Only the first counts.
		c.exited(p)
	}
}

// busy reports whether Pi is working on a reply or waiting on the person.
func (c *Chat) busy() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.pi != nil && (c.running || len(c.liveDialogs()) > 0)
}

// reap stops an idle Pi to free memory; the next message resumes the session.
func (c *Chat) reap(idle time.Duration) {
	c.mu.Lock()
	idleLong := c.pi != nil && !c.running && len(c.liveDialogs()) == 0 && time.Since(c.lastUse) > idle
	c.mu.Unlock()
	if idleLong {
		c.stop("idle")
	}
}

// liveDialogs drops questions Pi has already answered itself after their
// timeout. Callers hold mu.
func (c *Chat) liveDialogs() []map[string]any {
	out := []map[string]any{}
	for id, d := range c.dialogs {
		if !d.expires.IsZero() && time.Now().After(d.expires) {
			delete(c.dialogs, id)
			continue
		}
		out = append(out, d.request)
	}
	return out
}

func (c *Chat) subscribe() chan []byte {
	ch := make(chan []byte, 512)
	c.subsMu.Lock()
	c.subs[ch] = struct{}{}
	c.subsMu.Unlock()
	return ch
}

func (c *Chat) unsubscribe(ch chan []byte) {
	c.subsMu.Lock()
	if _, ok := c.subs[ch]; ok {
		delete(c.subs, ch)
		close(ch)
	}
	c.subsMu.Unlock()
}

// broadcast sends an event to every open chat stream. A stream that falls
// behind is closed, so its page reconnects and reloads the conversation
// rather than showing it with gaps.
func (c *Chat) broadcast(v any) {
	b := encode(v)
	c.subsMu.Lock()
	defer c.subsMu.Unlock()
	for ch := range c.subs {
		select {
		case ch <- b:
		default:
			delete(c.subs, ch)
			close(ch)
		}
	}
}

// State is everything the chat panel needs to draw the conversation. With
// start false it only reports whether a reply is in progress, without
// starting Pi.
func (c *Chat) State(ctx context.Context, start bool) map[string]any {
	out := map[string]any{"available": true, "messages": []any{}, "dialogs": []any{}, "commands": []any{}, "models": []any{}, "thinkingLevels": []any{}}
	var p *Pi
	var err error
	if start {
		p, err = c.ensure(ctx)
	} else {
		c.mu.Lock()
		p = c.pi
		c.mu.Unlock()
		out["loaded"] = p != nil
	}
	if err != nil {
		out["available"], out["error"] = false, err.Error()
	} else if p != nil {
		cctx, cancel := context.WithTimeout(ctx, 20*time.Second)
		defer cancel()
		if d, e := p.Call(cctx, map[string]any{"type": "get_messages"}); e == nil {
			list, _ := d["messages"].([]any)
			messages := make([]any, 0, len(list))
			for _, m := range list {
				// The system prompt and tool list aren't part of the conversation.
				if m, ok := m.(map[string]any); ok && m["role"] != "system" {
					messages = append(messages, slimMessage(m))
				}
			}
			out["messages"] = messages
		}
		if d, e := p.Call(cctx, map[string]any{"type": "get_state"}); e == nil {
			out["model"], out["thinkingLevel"] = d["model"], d["thinkingLevel"]
		}
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	out["sessionId"], out["running"] = c.cfg.SessionID, c.pi != nil && c.running
	out["chosen"] = map[string]string{"provider": c.cfg.Provider, "model": c.cfg.Model, "thinking": c.cfg.Thinking}
	if c.pi != nil {
		out["dialogs"], out["commands"], out["models"], out["thinkingLevels"] = c.liveDialogs(), c.commands, c.models, c.levels
		if c.modelErr != "" {
			out["modelError"] = c.modelErr
		}
		if c.notice != "" {
			out["notice"] = c.notice
		}
		statuses := make(map[string]string, len(c.statuses))
		for k, v := range c.statuses {
			statuses[k] = v
		}
		out["statuses"] = statuses
		if c.queue != nil {
			out["queue"] = c.queue
		}
	}
	return out
}

// Prompt sends one message. While Pi is replying, the message steers the
// reply in progress. "/new" starts a new session instead.
func (c *Chat) Prompt(ctx context.Context, in ChatPrompt) (map[string]any, error) {
	text := strings.TrimSpace(in.Message)
	if text == "/new" && len(in.Images) == 0 {
		return map[string]any{"reset": true, "sessionId": c.NewSession()}, nil
	}
	if text == "" && len(in.Images) == 0 {
		return nil, invalid("Write a message")
	}
	if len(text) > 100000 {
		return nil, invalid("Message is too long")
	}
	if len(in.Images) > maxChatImages {
		return nil, invalid("Attach up to %d images", maxChatImages)
	}
	images := make([]map[string]string, 0, len(in.Images))
	for _, img := range in.Images {
		data, err := base64.StdEncoding.DecodeString(img.Data)
		if err != nil || !chatImageTypes[img.MimeType] {
			return nil, invalid("Images must be PNG, JPEG, WebP, or GIF")
		}
		if len(data) > maxChatImageSize {
			return nil, invalid("Each image must be under 5 MB")
		}
		images = append(images, map[string]string{"type": "image", "data": img.Data, "mimeType": img.MimeType})
	}
	p, err := c.ensure(ctx)
	if err != nil {
		return nil, &APIError{Status: 503, Message: err.Error(), Err: err}
	}
	c.mu.Lock()
	modelErr, running := c.modelErr, c.running
	c.lastUse, c.notice = time.Now(), ""
	c.mu.Unlock()
	if modelErr != "" {
		return nil, conflict(modelErr)
	}
	message := text
	// Pi runs /commands only when the message starts with them.
	if view := chatContext(in.Context); view != "" && !strings.HasPrefix(text, "/") {
		message = "<sift-context>" + view + "</sift-context>\n\n" + text
	}
	command := map[string]any{"type": "prompt", "message": message, "images": images}
	if running {
		command["streamingBehavior"] = "steer"
	}
	cctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	data, err := p.Call(cctx, command)
	if err != nil && !running && strings.Contains(strings.ToLower(err.Error()), "streaming") {
		// Pi started replying before its agent_start event reached us.
		command["streamingBehavior"] = "steer"
		data, err = p.Call(cctx, command)
	}
	if err != nil {
		return nil, invalid("%v", err)
	}
	if data["disposition"] == "started" {
		c.mu.Lock()
		if c.pi == p {
			c.running = true
		}
		c.mu.Unlock()
	}
	return data, nil
}

func chatContext(v string) string {
	v = strings.Join(strings.Fields(strings.NewReplacer("<", "‹", ">", "›").Replace(v)), " ")
	if len(v) > maxChatContext {
		cut := maxChatContext
		for cut > 0 && !utf8.RuneStart(v[cut]) {
			cut--
		}
		v = v[:cut]
	}
	return v
}

// NewSession switches to a fresh session without the previous context.
func (c *Chat) NewSession() string {
	c.startMu.Lock()
	c.mu.Lock()
	old := c.pi
	c.pi, c.running, c.dialogs, c.modelErr, c.notice = nil, false, map[string]chatDialog{}, "", ""
	c.cfg.SessionID = newID("chat_")
	session := c.cfg.SessionID
	c.mu.Unlock()
	c.startMu.Unlock()
	c.save()
	if old != nil {
		go func() { old.Abort(); old.Close() }()
	}
	c.broadcast(map[string]any{"type": "sift_chat_reset", "sessionId": session})
	return session
}

// Abort stops the reply in progress and anything queued behind it.
func (c *Chat) Abort() {
	c.mu.Lock()
	p := c.pi
	c.mu.Unlock()
	if p != nil {
		p.Abort()
	}
}

// Answer replies to a question an extension asked.
func (c *Chat) Answer(id string, a ChatAnswer) error {
	c.mu.Lock()
	p := c.pi
	c.liveDialogs()
	d, open := c.dialogs[id]
	if open {
		delete(c.dialogs, id)
	}
	c.mu.Unlock()
	if p == nil || !open {
		return &APIError{Status: 404, Message: "That question is no longer waiting for an answer"}
	}
	record := map[string]any{"type": "extension_ui_response", "id": id}
	switch {
	case a.Cancelled:
		record["cancelled"] = true
	case eventString(d.request, "method") == "confirm" && a.Confirmed != nil:
		record["confirmed"] = *a.Confirmed
	case eventString(d.request, "method") != "confirm" && a.Value != nil:
		record["value"] = *a.Value
	default:
		c.mu.Lock()
		c.dialogs[id] = d
		c.mu.Unlock()
		return invalid("Answer the question or dismiss it")
	}
	if err := p.Send(record); err != nil {
		return err
	}
	c.broadcast(map[string]any{"type": "sift_chat_dialog_closed", "id": id})
	return nil
}

// Configure chooses the chat's model and thinking level. An empty model means
// Pi's configured default, which takes effect when Pi next starts.
func (c *Chat) Configure(ctx context.Context, cfg chatConfig) error {
	if (cfg.Provider == "") != (cfg.Model == "") {
		return invalid("Choose both a provider and a model, or Pi's default")
	}
	c.startMu.Lock()
	defer c.startMu.Unlock()
	c.mu.Lock()
	p, running, previous := c.pi, c.running, c.cfg
	c.mu.Unlock()
	if running {
		return conflict("Wait for the reply to finish before changing the model")
	}
	if p != nil {
		cctx, cancel := context.WithTimeout(ctx, 20*time.Second)
		defer cancel()
		if cfg.Provider == "" && previous.Provider != "" {
			// Pi has no "back to default" command; the next start uses it.
			c.mu.Lock()
			c.stopping = "model"
			c.mu.Unlock()
			p.Close()
			<-p.done
			p = nil
		} else if cfg.Provider != "" {
			if _, err := p.Call(cctx, map[string]any{"type": "set_model", "provider": cfg.Provider, "modelId": cfg.Model}); err != nil {
				return invalid("Pi couldn't switch to %s/%s: %v", cfg.Provider, cfg.Model, err)
			}
		}
		if p != nil && cfg.Thinking != "" {
			if _, err := p.Call(cctx, map[string]any{"type": "set_thinking_level", "level": cfg.Thinking}); err != nil {
				return invalid("Pi couldn't use thinking level %s: %v", cfg.Thinking, err)
			}
		}
		if p != nil {
			levels := []any{}
			if d, err := p.Call(cctx, map[string]any{"type": "get_available_thinking_levels"}); err == nil {
				levels, _ = d["levels"].([]any)
			}
			c.mu.Lock()
			c.levels = levels
			c.mu.Unlock()
		}
	}
	c.mu.Lock()
	c.cfg.Provider, c.cfg.Model, c.cfg.Thinking, c.modelErr = cfg.Provider, cfg.Model, cfg.Thinking, ""
	c.mu.Unlock()
	c.save()
	c.broadcast(map[string]any{"type": "sift_chat_configured"})
	return nil
}
