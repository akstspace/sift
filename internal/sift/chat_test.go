package sift

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

func chatPi(t *testing.T) {
	t.Helper()
	src, e := filepath.Abs("testdata/pi-chat-fixture.py")
	if e != nil {
		t.Fatal(e)
	}
	wrapper := filepath.Join(t.TempDir(), "pi")
	if e = os.WriteFile(wrapper, []byte("#!/bin/sh\nexec python3 \""+src+"\" \"$@\"\n"), 0700); e != nil {
		t.Fatal(e)
	}
	t.Setenv("SIFT_PI", wrapper)
}

func chatState(t *testing.T, h http.Handler, query string) map[string]any {
	t.Helper()
	var state map[string]any
	if err := json.Unmarshal(routeRequest(t, h, "GET", "/api/chat"+query, nil, 200, false), &state); err != nil {
		t.Fatal(err)
	}
	return state
}

// awaitChat reads relayed chat events until one matches.
func awaitChat(t *testing.T, ch chan []byte, match func(map[string]any) bool) map[string]any {
	t.Helper()
	deadline := time.After(8 * time.Second)
	for {
		select {
		case b, ok := <-ch:
			if !ok {
				t.Fatal("chat stream closed")
			}
			var e map[string]any
			_ = json.Unmarshal(b, &e)
			if match(e) {
				return e
			}
		case <-deadline:
			t.Fatal("chat event never arrived")
		}
	}
}

func eventType(kind string) func(map[string]any) bool {
	return func(e map[string]any) bool { return e["type"] == kind }
}

func messageText(m any) string {
	msg, _ := m.(map[string]any)
	if s, ok := msg["content"].(string); ok {
		return s
	}
	parts := []string{}
	blocks, _ := msg["content"].([]any)
	for _, b := range blocks {
		if block, _ := b.(map[string]any); block["type"] == "text" {
			parts = append(parts, block["text"].(string))
		}
	}
	return strings.Join(parts, "")
}

func TestChatConversationStreamsPersistsAndStartsOver(t *testing.T) {
	chatPi(t)
	record := filepath.Join(t.TempDir(), "args.jsonl")
	t.Setenv("PI_CHAT_RECORD_ARGS", record)
	s := testService(t)
	h := s.routes()

	// Peeking never starts Pi.
	peek := chatState(t, h, "?peek=1")
	if peek["loaded"] != false || peek["running"] != false {
		t.Fatalf("peek started Pi: %v", peek)
	}
	state := chatState(t, h, "")
	session, _ := state["sessionId"].(string)
	if state["available"] != true || !strings.HasPrefix(session, "chat_") {
		t.Fatalf("chat unavailable: %v", state)
	}
	if statuses, _ := state["statuses"].(map[string]any); statuses["fixture"] != "Fixture ready" {
		t.Fatalf("startup status lost: %v", state["statuses"])
	}
	if len(state["commands"].([]any)) != 2 || len(state["models"].([]any)) != 2 || len(state["thinkingLevels"].([]any)) != 4 {
		t.Fatalf("panel options missing: %v", state)
	}
	b, _ := os.ReadFile(record)
	var args []string
	json.Unmarshal([]byte(strings.Split(string(b), "\n")[0]), &args)
	flags := map[string]string{}
	for i := 0; i+1 < len(args); i++ {
		flags[args[i]] = args[i+1]
	}
	if flags["--session-id"] != session || flags["--session-dir"] != filepath.Join(s.Dir, "sessions", "chat") || !strings.Contains(flags["--append-system-prompt"], "--actor chat") || !strings.Contains(flags["--append-system-prompt"], "Keep task status current") || !strings.Contains(flags["--append-system-prompt"], s.Dir) {
		t.Fatalf("Pi started without the chat's session and guide: %v", args)
	}

	events := s.chat.subscribe()
	defer s.chat.unsubscribe(events)
	var started map[string]any
	json.Unmarshal(routeRequest(t, h, "POST", "/api/chat/prompt", ChatPrompt{Message: "hello", Context: "Page: Board. Open task: <Pay rent> (task_1)"}, 200, false), &started)
	if started["disposition"] != "started" {
		t.Fatalf("prompt not started: %v", started)
	}
	user := awaitChat(t, events, func(e map[string]any) bool {
		m, _ := e["message"].(map[string]any)
		return e["type"] == "message_end" && m["role"] == "user"
	})["message"].(map[string]any)
	if messageText(user) != "hello" || user["siftContext"] != "Page: Board. Open task: ‹Pay rent› (task_1)" {
		t.Fatalf("view context not separated from the message: %v", user)
	}
	awaitChat(t, events, eventType("agent_settled"))
	if s.chat.busy() {
		t.Fatal("chat still busy after the reply settled")
	}

	// Pi stops (idle reaping); the conversation resumes from its session.
	s.chat.mu.Lock()
	s.chat.lastUse = time.Now().Add(-time.Hour)
	s.chat.mu.Unlock()
	s.chat.reap(chatIdleTimeout)
	if chatState(t, h, "?peek=1")["loaded"] != false {
		t.Fatal("idle Pi not reaped")
	}
	awaitChat(t, events, func(e map[string]any) bool { return e["type"] == "sift_chat_stopped" && e["reason"] == "idle" })
	state = chatState(t, h, "")
	messages := state["messages"].([]any)
	if state["sessionId"] != session || len(messages) != 2 || messageText(messages[1]) != "Echo: hello" {
		t.Fatalf("conversation not resumed: %v", state)
	}

	// /new starts over without the earlier context, and is remembered.
	var reset map[string]any
	json.Unmarshal(routeRequest(t, h, "POST", "/api/chat/prompt", ChatPrompt{Message: " /new "}, 200, false), &reset)
	awaitChat(t, events, eventType("sift_chat_reset"))
	state = chatState(t, h, "")
	if reset["reset"] != true || state["sessionId"] == session || state["sessionId"] != reset["sessionId"] || len(state["messages"].([]any)) != 0 {
		t.Fatalf("/new kept the old conversation: %v %v", reset, state)
	}
	if again := newChat(s.Dir); again.cfg.SessionID != reset["sessionId"] {
		t.Fatalf("new session not saved: %v", again.cfg)
	}
	routeRequest(t, h, "POST", "/api/chat/new", nil, 200, false)
	if chatState(t, h, "")["sessionId"] == reset["sessionId"] {
		t.Fatal("New chat kept the session")
	}
}

func TestChatReplacesASessionPiCannotOpen(t *testing.T) {
	chatPi(t)
	dir := t.TempDir()
	os.MkdirAll(filepath.Join(dir, "sessions", "chat"), 0700)
	os.WriteFile(filepath.Join(dir, "chat.json"), encode(chatConfig{SessionID: "chat_broken"}), 0600)
	os.WriteFile(filepath.Join(dir, "sessions", "chat", "chat_broken.json"), []byte("{not json"), 0600)
	s, err := NewService(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	state := chatState(t, s.routes(), "")
	if state["available"] != true || state["sessionId"] == "chat_broken" || !strings.Contains(state["notice"].(string), "new one") {
		t.Fatalf("broken session not replaced: %v", state)
	}
	// The notice is shown once; the next message clears it.
	routeRequest(t, s.routes(), "POST", "/api/chat/prompt", ChatPrompt{Message: "hi"}, 200, false)
	if _, ok := chatState(t, s.routes(), "")["notice"]; ok {
		t.Fatal("notice repeated after a message")
	}
	if _, err := os.Stat(filepath.Join(dir, "sessions", "chat", "chat_broken.json")); err != nil {
		t.Fatal("old session discarded")
	}
}

func TestChatWhenPiIsMissingOrFailsToStart(t *testing.T) {
	t.Setenv("SIFT_PI", filepath.Join(t.TempDir(), "missing-pi"))
	s := testService(t)
	h := s.routes()
	state := chatState(t, h, "")
	if state["available"] != false || !strings.Contains(state["error"].(string), "local Pi is unavailable") {
		t.Fatalf("missing Pi not reported: %v", state)
	}
	routeRequest(t, h, "POST", "/api/chat/prompt", ChatPrompt{Message: "hi"}, 503, false)

	chatPi(t)
	t.Setenv("PI_CHAT_FAIL_START", "1")
	s.chat.cfg.SessionID = "chat_kept"
	state = chatState(t, h, "")
	if state["available"] != false || !strings.Contains(state["error"].(string), "Pi fixture refused to start") {
		t.Fatalf("start failure hidden: %v", state)
	}
	if state["sessionId"] != "chat_kept" {
		t.Fatal("a Pi that can't start replaced the session")
	}
}

func TestChatAnswersExtensionQuestionsInline(t *testing.T) {
	chatPi(t)
	t.Setenv("PI_CHAT_STARTUP_DIALOG", "1")
	s := testService(t)
	h := s.routes()
	events := s.chat.subscribe()
	defer s.chat.unsubscribe(events)
	state := chatState(t, h, "")
	// A question asked while Pi was starting still waits for an answer.
	if dialogs := state["dialogs"].([]any); len(dialogs) != 1 || dialogs[0].(map[string]any)["id"] != "dlg_startup" {
		t.Fatalf("startup question lost: %v", state["dialogs"])
	}
	if !s.chat.busy() {
		t.Fatal("an open question should count as busy")
	}
	routeRequest(t, h, "POST", "/api/chat/dialogs/dlg_startup", ChatAnswer{Cancelled: true}, 200, false)

	routeRequest(t, h, "POST", "/api/chat/prompt", ChatPrompt{Message: "ask"}, 200, false)
	awaitChat(t, events, func(e map[string]any) bool { return e["type"] == "extension_ui_request" && e["method"] == "select" })
	if dialogs := chatState(t, h, "")["dialogs"].([]any); len(dialogs) != 1 {
		t.Fatalf("question not listed: %v", dialogs)
	}
	routeRequest(t, h, "POST", "/api/chat/dialogs/dlg_choose", map[string]any{"confirmed": true}, 400, false)
	allow := "Allow"
	routeRequest(t, h, "POST", "/api/chat/dialogs/dlg_choose", ChatAnswer{Value: &allow}, 200, false)
	awaitChat(t, events, func(e map[string]any) bool { return e["type"] == "sift_chat_dialog_closed" && e["id"] == "dlg_choose" })
	end := awaitChat(t, events, func(e map[string]any) bool {
		m, _ := e["message"].(map[string]any)
		return e["type"] == "message_end" && m["role"] == "assistant"
	})
	if messageText(end["message"]) != "You chose Allow" {
		t.Fatalf("answer not delivered: %v", end)
	}
	routeRequest(t, h, "POST", "/api/chat/dialogs/dlg_choose", ChatAnswer{Value: &allow}, 404, false)
	// Questions that time out in Pi stop being offered.
	s.chat.mu.Lock()
	s.chat.dialogs["old"] = chatDialog{request: map[string]any{"id": "old", "method": "confirm"}, expires: time.Now().Add(-time.Second)}
	s.chat.mu.Unlock()
	yes := true
	routeRequest(t, h, "POST", "/api/chat/dialogs/old", ChatAnswer{Confirmed: &yes}, 404, false)
}

func TestChatSteersWhileReplyingAndStops(t *testing.T) {
	chatPi(t)
	prompts := filepath.Join(t.TempDir(), "prompts.jsonl")
	t.Setenv("PI_CHAT_RECORD_PROMPTS", prompts)
	s := testService(t)
	h := s.routes()
	events := s.chat.subscribe()
	defer s.chat.unsubscribe(events)
	routeRequest(t, h, "POST", "/api/chat/prompt", ChatPrompt{Message: "slow"}, 200, false)
	awaitChat(t, events, eventType("agent_start"))
	var queued map[string]any
	json.Unmarshal(routeRequest(t, h, "POST", "/api/chat/prompt", ChatPrompt{Message: "and then this", Context: "Page: Today"}, 200, false), &queued)
	if queued["disposition"] != "queued" {
		t.Fatalf("message during a reply not queued: %v", queued)
	}
	awaitChat(t, events, eventType("queue_update"))
	if q, _ := chatState(t, h, "")["queue"].(map[string]any); len(q["steering"].([]any)) != 1 {
		t.Fatalf("queue not reported: %v", q)
	}
	// Changing the model waits for the reply; so do backups and restarts.
	routeRequest(t, h, "PUT", "/api/chat/settings", chatConfig{Provider: "fixture", Model: "other-model"}, 409, false)
	if _, err := s.Backup(); err == nil || !strings.Contains(err.Error(), "chat reply") {
		t.Fatalf("backup ran during a reply: %v", err)
	}
	s.restart = func() {}
	if err := s.reserveRestart(false); err == nil {
		t.Fatal("restart reserved during a chat reply")
	}
	routeRequest(t, h, "POST", "/api/chat/abort", nil, 200, false)
	settled := awaitChat(t, events, eventType("agent_settled"))
	if settled["aborted"] != true {
		t.Fatalf("stop did not abort: %v", settled)
	}
	b, _ := os.ReadFile(prompts)
	lines := strings.Split(strings.TrimSpace(string(b)), "\n")
	var steer map[string]any
	json.Unmarshal([]byte(lines[len(lines)-1]), &steer)
	if steer["streamingBehavior"] != "steer" || !strings.HasPrefix(steer["message"].(string), "<sift-context>Page: Today</sift-context>\n\nand then this") {
		t.Fatalf("queued message sent wrong: %v", steer)
	}
	// Stop cleared the queue before aborting, so nothing else runs.
	time.Sleep(200 * time.Millisecond)
	if s.chat.busy() {
		t.Fatal("queued message ran after Stop")
	}
}

func TestChatRelaysCompactToolEvents(t *testing.T) {
	chatPi(t)
	s := testService(t)
	h := s.routes()
	events := s.chat.subscribe()
	defer s.chat.unsubscribe(events)
	routeRequest(t, h, "POST", "/api/chat/prompt", ChatPrompt{Message: "sift-op"}, 200, false)
	start := awaitChat(t, events, eventType("tool_execution_start"))
	if args, _ := start["args"].(map[string]any); !strings.HasPrefix(args["command"].(string), "sift tasks add") {
		t.Fatalf("tool args lost: %v", start)
	}
	update := awaitChat(t, events, eventType("tool_execution_update"))
	if out := update["output"].(string); !strings.HasPrefix(out, "…") || len(out) > 4010 {
		t.Fatalf("live output not trimmed to its tail: %d", len(out))
	}
	end := awaitChat(t, events, eventType("tool_execution_end"))
	if !strings.Contains(end["output"].(string), `Pay rent`) || end["durationMs"] != float64(12) {
		t.Fatalf("tool result: %v", end)
	}
	result := awaitChat(t, events, func(e map[string]any) bool {
		m, _ := e["message"].(map[string]any)
		return e["type"] == "message_end" && m["role"] == "toolResult"
	})["message"].(map[string]any)
	if _, ok := result["details"]; ok || len(messageText(result)) > maxToolOutput+100 {
		t.Fatal("tool result message not slimmed")
	}
	turn := awaitChat(t, events, eventType("turn_end"))
	if len(turn) != 1 {
		t.Fatalf("turn_end repeats messages: %v", turn)
	}
	awaitChat(t, events, eventType("agent_settled"))
	messages := chatState(t, h, "")["messages"].([]any)
	if len(messages) != 4 || len(messageText(messages[2])) > maxToolOutput+100 {
		t.Fatalf("history not slimmed: %d", len(messages))
	}
}

func TestChatModelAndThinkingChoices(t *testing.T) {
	chatPi(t)
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "chat.json"), encode(chatConfig{SessionID: "chat_model", Provider: "fixture", Model: "missing"}), 0600)
	s, err := NewService(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	h := s.routes()
	state := chatState(t, h, "")
	if !strings.Contains(state["modelError"].(string), "fixture/missing") {
		t.Fatalf("missing model not reported: %v", state)
	}
	// No silent fallback: the person chooses.
	routeRequest(t, h, "POST", "/api/chat/prompt", ChatPrompt{Message: "hi"}, 409, false)
	routeRequest(t, h, "PUT", "/api/chat/settings", chatConfig{Provider: "fixture"}, 400, false)
	routeRequest(t, h, "PUT", "/api/chat/settings", chatConfig{Provider: "fixture", Model: "missing"}, 400, false)
	var chosen map[string]any
	json.Unmarshal(routeRequest(t, h, "PUT", "/api/chat/settings", chatConfig{Provider: "fixture", Model: "other-model", Thinking: "off"}, 200, false), &chosen)
	if chosen["model"].(map[string]any)["id"] != "other-model" || chosen["thinkingLevel"] != "off" || len(chosen["thinkingLevels"].([]any)) != 1 {
		t.Fatalf("model not applied: %v", chosen)
	}
	if _, ok := chosen["modelError"]; ok {
		t.Fatal("model error kept after choosing another model")
	}
	routeRequest(t, h, "POST", "/api/chat/prompt", ChatPrompt{Message: "hi"}, 200, false)
	for s.chat.busy() {
		time.Sleep(10 * time.Millisecond)
	}
	// Pi's default needs a fresh start; the conversation continues.
	json.Unmarshal(routeRequest(t, h, "PUT", "/api/chat/settings", chatConfig{}, 200, false), &chosen)
	if chosen["model"].(map[string]any)["id"] != "fixture-model" || chosen["sessionId"] != "chat_model" || len(chosen["messages"].([]any)) != 2 {
		t.Fatalf("default model not restored: %v", chosen)
	}
	if saved := newChat(dir).cfg; saved.Provider != "" || saved.Model != "" {
		t.Fatalf("choice not saved: %v", saved)
	}
}

func TestChatValidatesMessagesImagesAndAccess(t *testing.T) {
	chatPi(t)
	prompts := filepath.Join(t.TempDir(), "prompts.jsonl")
	t.Setenv("PI_CHAT_RECORD_PROMPTS", prompts)
	s := testService(t)
	h := s.routes()
	png := base64.StdEncoding.EncodeToString([]byte("\x89PNG fixture"))
	for _, bad := range []ChatPrompt{
		{},
		{Message: strings.Repeat("x", 100001)},
		{Message: "x", Images: []ChatImage{{Data: png, MimeType: "image/svg+xml"}}},
		{Message: "x", Images: []ChatImage{{Data: "%%%", MimeType: "image/png"}}},
		{Message: "x", Images: []ChatImage{{Data: base64.StdEncoding.EncodeToString(make([]byte, maxChatImageSize+1)), MimeType: "image/png"}}},
		{Message: "x", Images: make([]ChatImage, maxChatImages+1)},
	} {
		routeRequest(t, h, "POST", "/api/chat/prompt", bad, 400, false)
	}
	routeRequest(t, h, "POST", "/api/chat/prompt", "{", 400, false)
	routeRequest(t, h, "PUT", "/api/chat/settings", "{", 400, false)
	routeRequest(t, h, "POST", "/api/chat/dialogs/x", "{", 400, false)
	// Commands go to Pi untouched, without the view context in front.
	routeRequest(t, h, "POST", "/api/chat/prompt", ChatPrompt{Message: "/skill:review now", Context: "Page: Board", Images: []ChatImage{{Data: png, MimeType: "image/png"}}}, 200, false)
	b, _ := os.ReadFile(prompts)
	var sent map[string]any
	json.Unmarshal(b, &sent)
	if sent["message"] != "/skill:review now" || len(sent["images"].([]any)) != 1 {
		t.Fatalf("command changed: %v", sent)
	}
	// The chat belongs to the person: agents, including the chat's own Pi,
	// can't read or drive it.
	for _, r := range [][2]string{{"GET", "/api/chat"}, {"POST", "/api/chat/prompt"}, {"POST", "/api/chat/abort"}, {"POST", "/api/chat/new"}, {"POST", "/api/chat/dialogs/x"}, {"PUT", "/api/chat/settings"}} {
		routeRequest(t, h, r[0], r[1], map[string]any{}, 403, true)
	}
	if got := chatContext("a" + strings.Repeat("é", maxChatContext)); len(got) > maxChatContext || !utf8.ValidString(got) {
		t.Fatal("context not clipped on a character boundary")
	}
	if text, view := splitChatContext("<sift-context>unterminated"); text != "<sift-context>unterminated" || view != "" {
		t.Fatal("unterminated context split")
	}
}

func TestChatRecoversWhenPiExitsAndPausesForMaintenance(t *testing.T) {
	chatPi(t)
	s := testService(t)
	h := s.routes()
	events := s.chat.subscribe()
	defer s.chat.unsubscribe(events)
	session := chatState(t, h, "")["sessionId"]
	routeRequest(t, h, "POST", "/api/chat/prompt", ChatPrompt{Message: "crash"}, 200, false)
	stopped := awaitChat(t, events, eventType("sift_chat_stopped"))
	if stopped["reason"] != "exited" || !strings.Contains(stopped["error"].(string), "stopped unexpectedly") {
		t.Fatalf("crash not reported: %v", stopped)
	}
	if s.chat.busy() {
		t.Fatal("crashed reply still counted as running")
	}
	// The next message starts Pi again in the same conversation.
	routeRequest(t, h, "POST", "/api/chat/prompt", ChatPrompt{Message: "again"}, 200, false)
	awaitChat(t, events, eventType("agent_settled"))
	if chatState(t, h, "")["sessionId"] != session {
		t.Fatal("crash replaced the conversation")
	}

	// Maintenance stops an idle Pi, and the chat waits until it's done.
	release, err := s.beginMaintenance()
	if err != nil {
		t.Fatal(err)
	}
	awaitChat(t, events, func(e map[string]any) bool { return e["type"] == "sift_chat_stopped" && e["reason"] == "maintenance" })
	state := chatState(t, h, "")
	if state["available"] != false || !strings.Contains(state["error"].(string), "backup, restore, or update") {
		t.Fatalf("chat started during maintenance: %v", state)
	}
	release()
	if chatState(t, h, "")["available"] != true {
		t.Fatal("chat did not come back after maintenance")
	}
}

func TestEventStreamCarriesTheChatToThePersonOnly(t *testing.T) {
	chatPi(t)
	s := testService(t)
	server := httptest.NewServer(s.routes())
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	open := func(agent bool) *bufio.Reader {
		req, _ := http.NewRequestWithContext(ctx, "GET", server.URL+"/api/events", nil)
		if agent {
			req.Header.Set("Authorization", "Bearer fixture")
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { res.Body.Close() })
		return bufio.NewReader(res.Body)
	}
	person, agent := open(false), open(true)
	subscribed := func() int { s.chat.subsMu.Lock(); defer s.chat.subsMu.Unlock(); return len(s.chat.subs) }
	for subscribed() != 1 {
		time.Sleep(5 * time.Millisecond)
	}
	s.chat.broadcast(map[string]any{"type": "fixture_event"})
	for {
		line, err := person.ReadString('\n')
		if err != nil {
			t.Fatal(err)
		}
		if strings.HasPrefix(line, "data: ") && strings.Contains(line, "fixture_event") {
			break
		}
	}
	// A page that falls behind (its subscription was dropped) is told to
	// reload the conversation.
	s.chat.subsMu.Lock()
	for ch := range s.chat.subs {
		delete(s.chat.subs, ch)
		close(ch)
	}
	s.chat.subsMu.Unlock()
	for {
		line, err := person.ReadString('\n')
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(line, "sift_chat_resync") {
			break
		}
	}
	s.chat.broadcast(map[string]any{"type": "after_resync"})
	for {
		line, err := person.ReadString('\n')
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(line, "after_resync") {
			break
		}
	}
	// The agent's stream carries changes and ticks but never the chat.
	for ticks := 0; ticks < 2; {
		line, err := agent.ReadString('\n')
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(line, "event: chat") {
			t.Fatal("agent stream received the chat")
		}
		if strings.HasPrefix(line, "event: tick") {
			ticks++
		}
	}
}

func TestChatBroadcastDropsAStreamThatFallsBehind(t *testing.T) {
	c := newChat(t.TempDir())
	slow, fast := c.subscribe(), c.subscribe()
	for len(slow) < cap(slow) {
		slow <- []byte("{}")
	}
	c.broadcast(map[string]any{"type": "x"})
	if len(fast) != 1 {
		t.Fatal("healthy stream missed the event")
	}
	for range slow {
	}
	c.unsubscribe(slow) // already dropped; must not panic
	c.unsubscribe(fast)
	if len(c.subs) != 0 {
		t.Fatal("subscriptions leaked")
	}
}
