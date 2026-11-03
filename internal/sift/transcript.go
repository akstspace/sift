package sift

import (
	"encoding/json"
	"fmt"
	"strings"
	"unicode/utf8"
)

// Run transcripts keep enough of each tool call to show what happened without
// storing whole files or mailboxes: long argument strings and outputs are
// clipped, with a note of how much was left out.
const (
	maxToolArgText = 4000
	maxToolOutput  = 16000
)

func clip(s string, n int) string {
	if len(s) <= n {
		return s
	}
	cut := n
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut] + fmt.Sprintf("\n… %d more characters", len(s)-cut)
}

// clipArgs keeps tool arguments as JSON while clipping long strings, such as
// the content of a file being written.
func clipArgs(args map[string]any) json.RawMessage {
	if len(args) == 0 {
		return nil
	}
	var walk func(any) any
	walk = func(v any) any {
		switch v := v.(type) {
		case string:
			return clip(v, maxToolArgText)
		case map[string]any:
			out := make(map[string]any, len(v))
			for k, item := range v {
				out[k] = walk(item)
			}
			return out
		case []any:
			out := make([]any, len(v))
			for i, item := range v {
				out[i] = walk(item)
			}
			return out
		}
		return v
	}
	return encode(walk(args))
}

// toolOutput joins the text blocks of a tool result; images are noted rather
// than stored.
func toolOutput(result any) string {
	r, _ := result.(map[string]any)
	blocks, _ := r["content"].([]any)
	parts := []string{}
	for _, b := range blocks {
		block, _ := b.(map[string]any)
		switch block["type"] {
		case "text":
			if text, ok := block["text"].(string); ok {
				parts = append(parts, text)
			}
		case "image":
			parts = append(parts, "[image]")
		}
	}
	return strings.Join(parts, "\n")
}

// toolSummary is the one-line text for a tool call, which `sift runs watch`
// prints: the command for bash, otherwise the tool's main argument.
func toolSummary(name string, args map[string]any) string {
	for _, key := range []string{"command", "path", "file_path", "pattern", "query", "url"} {
		if v, ok := args[key].(string); ok && strings.TrimSpace(v) != "" {
			line, _, more := strings.Cut(strings.TrimSpace(v), "\n")
			if len(line) > 160 {
				cut := 160
				for cut > 0 && !utf8.RuneStart(line[cut]) {
					cut--
				}
				line, more = line[:cut], true
			}
			if more {
				line += " …"
			}
			return name + ": " + line
		}
	}
	return name
}

func eventString(e map[string]any, key string) string {
	v, _ := e[key].(string)
	return v
}
