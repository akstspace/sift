package sift

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestRunTranscriptsKeepThinkingToolArgumentsAndClippedOutput(t *testing.T) {
	fixturePi(t)
	s := testService(t)
	j := fixtureJob(t, s, "success")
	r, err := s.RunJob(j.ID)
	if err != nil {
		t.Fatal(err)
	}
	awaitRun(t, s, r.ID, "succeeded")
	kinds := []string{}
	var tool, result RunEntry
	for _, e := range s.Store.Logs(r.ID) {
		kinds = append(kinds, e.Type)
		switch e.Type {
		case "thinking":
			if e.Text != "Checking the fixture notes." {
				t.Fatal("thinking deltas were not joined in order", e.Text)
			}
		case "tool":
			tool = e
		case "tool-result":
			result = e
		}
	}
	if strings.Join(kinds, ",") != "thinking,text,tool,tool-result" {
		t.Fatal("transcript order", kinds)
	}
	var args map[string]string
	if err = json.Unmarshal(tool.Args, &args); err != nil || args["path"] != "notes.md" || !strings.HasSuffix(args["content"], "… 1000 more characters") || len(args["content"]) > maxToolArgText+40 {
		t.Fatal("tool arguments were not kept and clipped", err, len(args["content"]))
	}
	if tool.Call != "call_read" || tool.Tool != "read" || tool.Text != "read: notes.md" {
		t.Fatal("tool start summary", tool)
	}
	if result.Call != "call_read" || result.DurationMs != 42 || result.Error || result.Text != "read finished" ||
		!strings.HasPrefix(result.Output, "line one\n") || !strings.Contains(result.Output, "more characters") || len(result.Output) > maxToolOutput+40 {
		t.Fatal("tool result", result.Call, result.DurationMs, result.Text, len(result.Output))
	}
}

func TestTranscriptHelpersSummarizeAndClipSafely(t *testing.T) {
	for _, tc := range []struct {
		name string
		args map[string]any
		want string
	}{
		{"bash", map[string]any{"command": "sift tasks list\nsift tasks get t1"}, "bash: sift tasks list …"},
		{"edit", map[string]any{"file_path": "/notes/today.md"}, "edit: /notes/today.md"},
		{"grep", map[string]any{"pattern": "  ", "query": "invoices"}, "grep: invoices"},
		{"web", map[string]any{"url": strings.Repeat("é", 100)}, "web: " + strings.Repeat("é", 80) + " …"},
		{"custom", nil, "custom"},
	} {
		if got := toolSummary(tc.name, tc.args); got != tc.want {
			t.Fatalf("%s: got %q, want %q", tc.name, got, tc.want)
		}
	}
	if clipArgs(nil) != nil {
		t.Fatal("empty arguments were stored")
	}
	nested := clipArgs(map[string]any{"edits": []any{map[string]any{"new": strings.Repeat("a", maxToolArgText+1)}, 3.0, true}})
	if !strings.Contains(string(nested), "1 more characters") || !strings.Contains(string(nested), ",3,true]") {
		t.Fatal("nested arguments", string(nested))
	}
	if clip("héllo", 2) != "h\n… 5 more characters" {
		t.Fatal("clipping split a character", clip("héllo", 2))
	}
	if toolOutput(nil) != "" || toolOutput(map[string]any{"content": []any{map[string]any{"type": "text", "text": 5}}}) != "" {
		t.Fatal("malformed results produced output")
	}
}
