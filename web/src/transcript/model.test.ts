import { describe, expect, it } from "vitest";
import { describePiError, emptyConversation, itemsFromMessages, itemsFromRunEntries, reduceConversation, type Conversation, type PiMessage } from "./model";

const call = (id: string, name = "bash", args: Record<string, unknown> = { command: "ls" }) => ({ type: "toolCall" as const, id, name, arguments: args });

describe("items from Pi's messages", () => {
  it("shows the person's words, images, and what Sift shared, without empty messages", () => {
    const items = itemsFromMessages([
      { role: "user", content: "Plan my day", siftContext: "Page: Today." },
      { role: "user", content: [{ type: "text", text: "Look" }, { type: "image", data: "AAA", mimeType: "image/png" }], pending: true },
      { role: "user", content: [] },
      { role: "user" },
    ]);
    expect(items).toEqual([
      { kind: "user", key: "m0", text: "Plan my day", images: [], context: "Page: Today.", pending: undefined },
      { kind: "user", key: "m1", text: "Look", images: [{ type: "image", data: "AAA", mimeType: "image/png" }], context: undefined, pending: true },
    ]);
  });
  it("shows a reply's thinking, text, and tools with their results", () => {
    const messages: PiMessage[] = [
      { role: "assistant", content: [
        { type: "thinking", thinking: "Hmm" }, { type: "thinking", thinking: "", redacted: true }, { type: "thinking", thinking: "" },
        { type: "text", text: "Checking." }, { type: "text", text: "" },
        call("a"), call("b"), { type: "toolCall" as const, id: "c", name: "read", arguments: undefined as unknown as Record<string, unknown> }, call("d"),
      ], stopReason: "toolUse" },
      { role: "toolResult", toolCallId: "a", content: [{ type: "text", text: "out" }, { type: "image", data: "I", mimeType: "image/png" }], isError: false },
      { role: "toolResult", toolCallId: "b", content: [{ type: "text", text: "bad" }], isError: true },
    ];
    const items = itemsFromMessages(messages, { c: { id: "c", name: "read", args: { path: "/a" }, status: "running", live: "tail", durationMs: 4 }, d: { id: "d", name: "bash", args: {}, status: "pending" } });
    expect(items.map(i => i.kind)).toEqual(["thinking", "thinking", "text", "tool", "tool", "tool", "tool"]);
    expect(items[1]).toMatchObject({ redacted: true, text: "" });
    const tools = items.filter(i => i.kind === "tool").map(i => i.kind === "tool" && i.tool);
    expect(tools[0]).toMatchObject({ status: "done", output: "out", images: [{ type: "image", data: "I", mimeType: "image/png" }], live: undefined });
    expect(tools[1]).toMatchObject({ status: "error", output: "bad" });
    expect(tools[2]).toMatchObject({ status: "running", args: { path: "/a" }, live: "tail", durationMs: 4 });
    // Never answered, and nothing is running any more.
    expect(tools[3]).toMatchObject({ status: "unknown" });
    expect(itemsFromMessages(messages, { d: { id: "d", name: "bash", args: {}, status: "pending" } }, { running: true }).at(-1)).toMatchObject({ tool: { status: "pending" } });
    expect(itemsFromMessages(messages, {}, { running: true }).at(-1)).toMatchObject({ tool: { status: "pending" } });
  });
  it("marks the block being streamed and explains how a reply ended", () => {
    const items = itemsFromMessages([
      { role: "assistant", content: [{ type: "text", text: "Partial" }] },
      { role: "assistant", content: [{ type: "text", text: "Half" }], stopReason: "aborted" },
      { role: "assistant", content: "not blocks", stopReason: "error", errorMessage: "Rate limited" },
      { role: "assistant", stopReason: "error" },
    ], {}, { streaming: 0 });
    expect(items).toEqual([
      { kind: "text", key: "m0:0", text: "Partial", streaming: true },
      { kind: "text", key: "m1:0", text: "Half", streaming: false },
      { kind: "notice", key: "m1:aborted", tone: "info", text: "Stopped" },
      { kind: "notice", key: "m2:error", tone: "error", text: "Rate limited" },
      { kind: "notice", key: "m3:error", tone: "error", text: "The reply ended with an error." },
    ]);
  });
  it("shows shell commands, summaries, and extension messages", () => {
    const items = itemsFromMessages([
      { role: "bashExecution", command: "ls", output: "a", exitCode: 0 },
      { role: "bashExecution", command: "false", exitCode: 1 },
      { role: "bashExecution", cancelled: true },
      { role: "compactionSummary", summary: "…" },
      { role: "branchSummary", summary: "…" },
      { role: "custom", content: "Reminder set", display: true },
      { role: "custom", content: "hidden", display: false },
      { role: "custom", content: [] },
      { role: "system", content: "prompt" },
    ]);
    expect(items.map(i => i.kind === "tool" ? i.tool.status : i.kind === "notice" ? i.text : i.kind)).toEqual([
      "done", "error", "unknown", "Earlier messages were summarized to make room.", "Continued from a summary of another branch.", "Reminder set",
    ]);
    expect(items[2]).toMatchObject({ tool: { args: { command: "" } } });
  });
});

describe("provider errors", () => {
  it("says what a provider's failure means and keeps its words", () => {
    const raw = '401 {"type":"error","error":{"type":"authentication_error","message":"Invalid bearer token"},"request_id":"req_1"}';
    expect(describePiError(raw)).toEqual({ text: "The model’s provider didn’t accept Pi’s sign-in (Invalid bearer token). Sign in again in Pi, or choose another model.", detail: raw });
    expect(describePiError('403 {"message":"Forbidden."}').text).toBe("The model’s provider didn’t accept Pi’s sign-in (Forbidden). Sign in again in Pi, or choose another model.");
    expect(describePiError('429 {"error":"Too many requests"}').text).toBe("The model’s provider is limiting requests (Too many requests). Try again shortly, or choose another model.");
    expect(describePiError("503 {}").text).toBe("The model’s provider had a problem. Try again shortly.");
    expect(describePiError('400 {"error":{"message":"prompt is too long"}}').text).toBe("The model’s provider refused the request (prompt is too long).");
    expect(describePiError("500 {not json}").text).toBe("The model’s provider had a problem. Try again shortly.");
    expect(describePiError("Pi exited before agent_settled")).toEqual({ text: "Pi exited before agent_settled" });
  });
  it("turns a reply's provider error into that explanation", () => {
    expect(itemsFromMessages([{ role: "assistant", content: [], stopReason: "error", errorMessage: '401 {"error":{"message":"Bad key"}}' }])).toEqual([
      { kind: "notice", key: "m0:error", tone: "error", text: "The model’s provider didn’t accept Pi’s sign-in (Bad key). Sign in again in Pi, or choose another model.", detail: '401 {"error":{"message":"Bad key"}}' },
    ]);
  });
});

describe("items from a stored job run", () => {
  it("joins streamed pieces and pairs each tool with its result", () => {
    const items = itemsFromRunEntries([
      { type: "thinking", text: "Plan" }, { type: "thinking", text: "ning" },
      { type: "text", text: "##" }, { type: "text", text: "# Today\n1. **Deli" }, { type: "text", text: "ver**" },
      { type: "tool", text: "bash: ls", tool: "bash", call: "c1", args: { command: "ls" } },
      { type: "tool-result", text: "bash finished", tool: "bash", call: "c1", output: "a\nb", durationMs: 30 },
      { type: "tool", text: "read: x", tool: "read", call: "c2", args: { path: "x" } },
      { type: "tool-result", text: "read reported an error", tool: "read", call: "c2", error: true, output: "missing" },
      { type: "tool-result", text: "orphan", call: "c9", output: "?" },
      { type: "tool-result", text: "unnamed" },
      { type: "text", text: "Done." },
    ], false);
    expect(items.map(i => i.kind)).toEqual(["thinking", "text", "tool", "tool", "tool", "tool", "text"]);
    expect(items[0]).toMatchObject({ text: "Planning" });
    expect(items[1]).toMatchObject({ text: "### Today\n1. **Deliver**" });
    expect(items[2]).toMatchObject({ tool: { id: "c1", status: "done", output: "a\nb", durationMs: 30, args: { command: "ls" }, summary: undefined } });
    expect(items[3]).toMatchObject({ tool: { status: "error", output: "missing" } });
    expect(items[4]).toMatchObject({ tool: { id: "c9", name: "tool", status: "done", output: "?" } });
    expect(items[5]).toMatchObject({ tool: { id: "e10", name: "tool" } });
  });
  it("reads older runs that kept one line per tool", () => {
    const items = itemsFromRunEntries([
      { type: "tool", text: "Running read" },
      { type: "tool", text: "read local file" },
      { type: "tool", text: "bash: ls -la", tool: "bash" },
      { type: "tool-error", text: "bash reported an error" },
      { type: "system", text: "auto retry start" },
      { type: "system", text: "" },
    ], false);
    expect(items.map(i => i.kind === "tool" ? [i.tool.name, i.tool.summary ?? "", i.tool.status] : [i.kind, i.kind === "notice" ? i.tone : ""])).toEqual([
      ["read", "", "unknown"], ["tool", "read local file", "unknown"], ["bash", "bash: ls -la", "unknown"], ["notice", "error"], ["notice", "info"],
    ]);
  });
  it("keeps tools running while the run is", () => {
    expect(itemsFromRunEntries([{ type: "tool", text: "bash: sleep", tool: "bash", call: "c", args: { command: "sleep 9" } }], true)[0]).toMatchObject({ tool: { status: "running" } });
  });
});

describe("following a live conversation", () => {
  const run = (events: Record<string, unknown>[], start: Conversation = emptyConversation(), replay = false) =>
    events.reduce<Conversation>((c, e) => reduceConversation(c, e as { type: string }, replay), start);

  it("streams a reply block by block and settles on the final message", () => {
    let c = run([
      { type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "stale" }], timestamp: 1 } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "Hm" } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "m" } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "Hmm." } },
      { type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 1 } },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "Hel" } },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "lo" } },
      { type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 2, id: "t1", toolName: "bash" } },
      { type: "message_update", assistantMessageEvent: { type: "toolcall_delta", contentIndex: 2, delta: "{" } },
      // A delta for a block that never started, and one past the end.
      { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 4 } },
      { type: "message_update", assistantMessageEvent: { type: "toolcall_end", contentIndex: 2, toolCall: { id: "t1", name: "bash", arguments: { command: "ls" } } } },
      { type: "message_update", assistantMessageEvent: { type: "toolcall_end", contentIndex: 2, toolCall: {} } },
      { type: "message_update" },
    ]);
    expect(c.streaming).toBe(0);
    expect(c.messages[0].content).toEqual([
      { type: "thinking", thinking: "Hmm." }, { type: "text", text: "Hello" }, call("t1"), { type: "text", text: "" }, { type: "text", text: "" },
    ]);
    c = run([
      { type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 1, content: "Hello!" } },
      { type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 1 } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: 0 } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_delta" } },
      { type: "message_update", assistantMessageEvent: { type: "toolcall_start" } },
    ], c);
    expect((c.messages[0].content as { text?: string }[])[1].text).toBe("Hello!");
    c = run([{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Final" }], stopReason: "stop" } }], c);
    expect(c).toMatchObject({ streaming: undefined, messages: [{ content: [{ type: "text", text: "Final" }] }] });
    // Joined mid-reply: deltas wait for the final message.
    c = run([{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "x" } }, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Whole" }] } }], emptyConversation());
    expect(c.messages).toEqual([{ role: "assistant", content: [{ type: "text", text: "Whole" }] }]);
    expect(run([{ type: "message_start" }, { type: "message_end" }, { type: "message_start", message: { role: "toolResult" } }]).messages).toEqual([]);
  });
  it("confirms the person's message in place and ignores repeats", () => {
    const pending: PiMessage = { role: "user", content: "Hi", pending: true, timestamp: 5 };
    let c = run([{ type: "message_start", message: { role: "user", content: "Hi", timestamp: 9 } }], emptyConversation([pending]));
    expect(c.messages).toEqual([{ role: "user", content: "Hi", timestamp: 9 }]);
    c = run([{ type: "message_end", message: { role: "user", content: "Hi", timestamp: 9 } }, { type: "message_start", message: { role: "user", content: "Again", timestamp: 10 } }, { type: "message_start", message: { role: "user", content: "No time" } }], c);
    expect(c.messages.map(m => m.content)).toEqual(["Hi", "Again", "No time"]);
  });
  it("tracks tool execution and its results", () => {
    let c = run([
      { type: "tool_execution_update", toolCallId: "x" },
      { type: "tool_execution_start", toolCallId: "t", toolName: "bash", args: { command: "ls" } },
      { type: "tool_execution_update", toolCallId: "t", output: "a" },
      { type: "tool_execution_update", toolCallId: "t" },
      { type: "tool_execution_start" },
    ]);
    expect(c.tools.t).toMatchObject({ status: "running", live: "", args: { command: "ls" } });
    expect(c.tools[""]).toMatchObject({ name: "tool", args: {} });
    c = run([
      { type: "tool_execution_end", toolCallId: "t", isError: true, output: "bad", durationMs: 7 },
      { type: "tool_execution_end", toolCallId: "u", toolName: "read" },
      { type: "tool_execution_end" },
      { type: "message_end", message: { role: "toolResult", toolCallId: "t", content: [], timestamp: 3 } },
      { type: "message_end", message: { role: "toolResult", toolCallId: "t", content: [{ type: "text", text: "final" }], timestamp: 3 } },
    ], c);
    expect(c.tools.t).toMatchObject({ status: "error", output: "bad", durationMs: 7, live: undefined });
    expect(c.tools.u).toMatchObject({ status: "done", name: "read", output: "", args: {}, durationMs: undefined });
    expect(c.tools[""]).toMatchObject({ name: "tool" });
    expect(c.messages).toEqual([{ role: "toolResult", toolCallId: "t", content: [{ type: "text", text: "final" }], timestamp: 3 }]);
  });
  it("replays events missed while loading onto history that may already hold them", () => {
    const loaded = emptyConversation([{ role: "user", content: "Q", timestamp: 1 }, { role: "assistant", content: [{ type: "text", text: "A" }], timestamp: 2 }]);
    let c = run([
      { type: "message_start", message: { role: "assistant", content: [], timestamp: 2 } },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "A" } },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "A!" }], timestamp: 2 } },
      { type: "message_end", message: { role: "user", content: "Q", timestamp: 1 } },
    ], loaded, true);
    expect(c.messages).toEqual([{ role: "user", content: "Q", timestamp: 1 }, { role: "assistant", content: [{ type: "text", text: "A!" }], timestamp: 2 }]);
    c = run([{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "A2" }], timestamp: 2 } }], c, true);
    expect(c.messages).toHaveLength(2);
    // Outside a replay, a new message is always new, even in the same millisecond.
    c = run([{ type: "message_start", message: { role: "assistant", content: [], timestamp: 2 } }, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "B" }], timestamp: 2 } }], c);
    expect(c.messages).toHaveLength(3);
    expect(run([{ type: "message_end", message: { role: "assistant", content: [], timestamp: 2 } }], c).messages).toHaveLength(4);
  });
  it("stops streaming when Pi settles or stops, and ignores other events", () => {
    const streaming = run([{ type: "message_start", message: { role: "assistant", content: [] } }]);
    expect(run([{ type: "agent_settled" }], streaming).streaming).toBeUndefined();
    expect(run([{ type: "sift_chat_stopped" }], streaming).streaming).toBeUndefined();
    const idle = emptyConversation();
    expect(run([{ type: "agent_settled" }, { type: "turn_end" }], idle)).toBe(idle);
  });
});
