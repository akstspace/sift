// One shape for every agent transcript Sift shows. The chat builds it from
// Pi's messages and live events; Run history builds it from the entries a
// job run stored. Both render through the same Transcript component.

export interface ImageBlock { type?: "image"; data?: string; mimeType: string; omitted?: boolean }
export type PiContent =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; redacted?: boolean }
  | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
  | ({ type: "image" } & ImageBlock);

export interface PiMessage {
  role: string;
  content?: string | PiContent[];
  timestamp?: number;
  stopReason?: string;
  errorMessage?: string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  siftContext?: string;
  command?: string;
  output?: string;
  exitCode?: number;
  cancelled?: boolean;
  summary?: string;
  display?: boolean;
  /** Shown before Pi confirms it received the message. */
  pending?: boolean;
}

export type ToolStatus = "pending" | "running" | "done" | "error" | "unknown";
export interface ToolState {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: ToolStatus;
  output?: string;
  /** The tail of output while the tool is still running. */
  live?: string;
  durationMs?: number;
  images?: ImageBlock[];
  /** A one-line description stored by older runs, which kept no arguments. */
  summary?: string;
}

export type Item =
  | { kind: "user"; key: string; text: string; images: ImageBlock[]; context?: string; pending?: boolean }
  | { kind: "text"; key: string; text: string; streaming?: boolean }
  | { kind: "thinking"; key: string; text: string; streaming?: boolean; redacted?: boolean }
  | { kind: "tool"; key: string; tool: ToolState }
  | { kind: "notice"; key: string; tone: "info" | "error"; text: string; detail?: string };

const textOf = (content: PiMessage["content"]) =>
  typeof content === "string" ? content : (content || []).filter(b => b.type === "text").map(b => (b as { text: string }).text).join("\n");
const imagesOf = (content: PiMessage["content"]) =>
  typeof content === "string" ? [] : (content || []).filter(b => b.type === "image") as ImageBlock[];

/** Items for a conversation: Pi's messages plus what is known about running tools. */
export function itemsFromMessages(messages: PiMessage[], tools: Record<string, ToolState> = {}, opts: { streaming?: number; running?: boolean } = {}): Item[] {
  const items: Item[] = [];
  const results = new Map<string, PiMessage>();
  for (const m of messages) if (m.role === "toolResult" && m.toolCallId) results.set(m.toolCallId, m);
  messages.forEach((m, i) => {
    const key = "m" + i;
    switch (m.role) {
      case "user": {
        const text = textOf(m.content), images = imagesOf(m.content);
        if (text || images.length) items.push({ kind: "user", key, text, images, context: m.siftContext, pending: m.pending });
        break;
      }
      case "assistant": {
        const blocks = Array.isArray(m.content) ? m.content : [];
        const streaming = opts.streaming === i;
        blocks.forEach((b, j) => {
          const last = streaming && j === blocks.length - 1, k = key + ":" + j;
          if (b.type === "text" && b.text) items.push({ kind: "text", key: k, text: b.text, streaming: last });
          else if (b.type === "thinking" && (b.thinking || b.redacted)) items.push({ kind: "thinking", key: k, text: b.thinking || "", streaming: last, redacted: b.redacted });
          else if (b.type === "toolCall") {
            const known = tools[b.id], result = results.get(b.id);
            const status: ToolStatus = result ? (result.isError ? "error" : "done")
              : known && known.status !== "pending" ? known.status
              : streaming || opts.running ? (known?.status || "pending") : "unknown";
            items.push({ kind: "tool", key: k, tool: {
              id: b.id, name: b.name, args: b.arguments || known?.args || {}, status,
              output: result ? textOf(result.content) : known?.output, live: result ? undefined : known?.live,
              durationMs: known?.durationMs, images: result ? imagesOf(result.content) : known?.images,
            } });
          }
        });
        if (m.stopReason === "error") items.push({ kind: "notice", key: key + ":error", tone: "error", ...describePiError(m.errorMessage || "The reply ended with an error.") });
        else if (m.stopReason === "aborted") items.push({ kind: "notice", key: key + ":aborted", tone: "info", text: "Stopped" });
        break;
      }
      case "bashExecution":
        items.push({ kind: "tool", key, tool: { id: key, name: "bash", args: { command: m.command || "" }, output: m.output, status: m.cancelled ? "unknown" : m.exitCode === 0 ? "done" : "error" } });
        break;
      case "compactionSummary":
        items.push({ kind: "notice", key, tone: "info", text: "Earlier messages were summarized to make room." });
        break;
      case "branchSummary":
        items.push({ kind: "notice", key, tone: "info", text: "Continued from a summary of another branch." });
        break;
      case "custom":
        if (m.display !== false && textOf(m.content)) items.push({ kind: "notice", key, tone: "info", text: textOf(m.content) });
        break;
    }
  });
  return items;
}

export interface RunEntry {
  type: string;
  text: string;
  at?: string;
  tool?: string;
  call?: string;
  args?: Record<string, unknown>;
  output?: string;
  error?: boolean;
  durationMs?: number;
}

/**
 * Items for a stored job run. Pi streamed text and thinking in pieces; joined
 * here, Markdown split mid-list renders correctly. A tool's start and result
 * meet by call ID.
 */
export function itemsFromRunEntries(entries: RunEntry[], running: boolean): Item[] {
  const items: Item[] = [];
  const calls = new Map<string, ToolState>();
  entries.forEach((e, i) => {
    const last = items.at(-1), key = "e" + i;
    switch (e.type) {
      case "text":
      case "thinking":
        if (last?.kind === e.type) last.text += e.text;
        else items.push({ kind: e.type, key, text: e.text });
        break;
      case "tool": {
        // Older runs stored "Running read" and no arguments.
        const named = e.text.match(/^Running ([\w-]+)$/);
        const tool: ToolState = { id: e.call || key, name: e.tool || named?.[1] || "tool", args: e.args || {}, status: running ? "running" : "unknown", summary: named || (e.args && e.call) ? undefined : e.text };
        if (e.call) calls.set(e.call, tool);
        items.push({ kind: "tool", key, tool });
        break;
      }
      case "tool-result": {
        const tool = (e.call && calls.get(e.call)) || undefined;
        const result = { status: (e.error ? "error" : "done") as ToolStatus, output: e.output, durationMs: e.durationMs };
        if (tool) Object.assign(tool, result);
        else items.push({ kind: "tool", key, tool: { id: e.call || key, name: e.tool || "tool", args: {}, ...result } });
        break;
      }
      case "tool-error":
        items.push({ kind: "notice", key, tone: "error", text: e.text });
        break;
      default:
        if (e.text) items.push({ kind: "notice", key, tone: "info", text: e.text });
    }
  });
  // Tools still marked running in a finished run never reported back.
  if (!running) for (const t of calls.values()) if (t.status === "running") t.status = "unknown";
  return items;
}

/** The live conversation, as the chat panel holds it. */
export interface Conversation {
  messages: PiMessage[];
  /** Index of the assistant message being streamed. */
  streaming?: number;
  tools: Record<string, ToolState>;
}

export const emptyConversation = (messages: PiMessage[] = []): Conversation => ({ messages, tools: {} });

type Event = Record<string, unknown> & { type: string };

function applyDelta(m: PiMessage, ev: Record<string, unknown>): PiMessage {
  const content = Array.isArray(m.content) ? [...m.content] : [];
  const i = typeof ev.contentIndex === "number" ? ev.contentIndex : content.length;
  const block = content[i];
  switch (ev.type) {
    case "text_start": content[i] = { type: "text", text: "" }; break;
    case "text_delta": content[i] = { type: "text", text: (block?.type === "text" ? block.text : "") + String(ev.delta ?? "") }; break;
    case "text_end": if (typeof ev.content === "string") content[i] = { type: "text", text: ev.content }; break;
    case "thinking_start": content[i] = { type: "thinking", thinking: "" }; break;
    case "thinking_delta": content[i] = { type: "thinking", thinking: (block?.type === "thinking" ? block.thinking : "") + String(ev.delta ?? "") }; break;
    case "thinking_end": if (typeof ev.content === "string") content[i] = { type: "thinking", thinking: ev.content }; break;
    case "toolcall_start": content[i] = { type: "toolCall", id: String(ev.id ?? ""), name: String(ev.toolName ?? "tool"), arguments: {} }; break;
    case "toolcall_end": {
      const call = ev.toolCall as { id?: string; name?: string; arguments?: Record<string, unknown> } | undefined;
      if (call?.id) content[i] = { type: "toolCall", id: call.id, name: call.name || "tool", arguments: call.arguments || {} };
      break;
    }
    default: return m;
  }
  for (let j = 0; j < content.length; j++) if (!content[j]) content[j] = { type: "text", text: "" };
  return { ...m, content };
}

/**
 * Applies one relayed Pi event to the conversation. `replay` is set for events
 * that arrived while the conversation was loading: the loaded history may
 * already hold their messages, so they are matched by timestamp.
 */
export function reduceConversation(c: Conversation, e: Event, replay = false): Conversation {
  const message = e.message as PiMessage | undefined;
  switch (e.type) {
    case "message_start": {
      if (!message) return c;
      if (message.role === "assistant") {
        // Replayed after a reload that already has this message: stream into it.
        const known = replay && message.timestamp ? c.messages.findIndex(m => m.role === "assistant" && m.timestamp === message.timestamp) : -1;
        if (known >= 0) return { ...c, messages: c.messages.map((m, i) => i === known ? { ...message, content: [] } : m), streaming: known };
        return { ...c, messages: [...c.messages, { ...message, content: [] }], streaming: c.messages.length };
      }
      if (message.role === "user") {
        // Pi confirmed a message this page showed while sending it.
        const pending = c.messages.findIndex(m => m.pending);
        if (pending >= 0) return { ...c, messages: c.messages.map((m, i) => i === pending ? message : m) };
        if (message.timestamp && c.messages.some(m => m.role === "user" && m.timestamp === message.timestamp)) return c;
        return { ...c, messages: [...c.messages, message] };
      }
      return c;
    }
    case "message_update": {
      if (c.streaming === undefined) return c;
      const ev = e.assistantMessageEvent as Record<string, unknown> | undefined;
      if (!ev) return c;
      const messages = [...c.messages];
      messages[c.streaming] = applyDelta(messages[c.streaming], ev);
      return { ...c, messages };
    }
    case "message_end": {
      if (!message) return c;
      const same = (replay || message.role === "toolResult") && message.timestamp ? c.messages.findIndex(m => m.role === message.role && m.timestamp === message.timestamp && m.toolCallId === message.toolCallId) : -1;
      if (message.role === "assistant") {
        if (c.streaming === undefined) return same >= 0 ? { ...c, messages: c.messages.map((m, i) => i === same ? message : m) } : { ...c, messages: [...c.messages, message] };
        const messages = [...c.messages];
        messages[c.streaming] = message;
        return { ...c, messages, streaming: undefined };
      }
      if (message.role === "user") return reduceConversation(c, { ...e, type: "message_start" }, replay);
      if (same >= 0) return { ...c, messages: c.messages.map((m, i) => i === same ? message : m) };
      return { ...c, messages: [...c.messages, message] };
    }
    case "tool_execution_start": {
      const id = String(e.toolCallId ?? "");
      return { ...c, tools: { ...c.tools, [id]: { ...c.tools[id], id, name: String(e.toolName ?? "tool"), args: (e.args as Record<string, unknown>) || {}, status: "running" } } };
    }
    case "tool_execution_update": {
      const id = String(e.toolCallId ?? ""), t = c.tools[id];
      if (!t) return c;
      return { ...c, tools: { ...c.tools, [id]: { ...t, live: String(e.output ?? "") } } };
    }
    case "tool_execution_end": {
      const id = String(e.toolCallId ?? ""), t = c.tools[id];
      return { ...c, tools: { ...c.tools, [id]: { ...t, args: t?.args || {}, id, name: String(e.toolName ?? t?.name ?? "tool"), status: e.isError ? "error" : "done", output: String(e.output ?? ""), live: undefined, durationMs: typeof e.durationMs === "number" ? e.durationMs : undefined } } };
    }
    case "sift_chat_stopped":
    case "agent_settled": {
      // A reply that ended without its final message (for example, Pi stopped)
      // no longer streams.
      return c.streaming === undefined ? c : { ...c, streaming: undefined };
    }
  }
  return c;
}

/**
 * Providers answer failures as `401 {"type":"error","error":{"message":"…"}}`.
 * Say what happened and what to do; keep the provider's own words as detail.
 */
export function describePiError(raw: string): { text: string; detail?: string } {
  const m = raw.trim().match(/^(\d{3})\s+(\{[\s\S]*\})$/);
  if (!m) return { text: raw };
  const status = Number(m[1]);
  let message = "";
  try {
    const body = JSON.parse(m[2]) as { message?: unknown; error?: unknown };
    const error = body.error as { message?: unknown } | string | undefined;
    message = String((typeof error === "string" ? error : error?.message) ?? body.message ?? "");
  } catch { /* Not JSON after all: the status still says enough. */ }
  const why = message ? ` (${message.replace(/\.$/, "")})` : "";
  const text = status === 401 || status === 403 ? `The model’s provider didn’t accept Pi’s sign-in${why}. Sign in again in Pi, or choose another model.`
    : status === 429 ? `The model’s provider is limiting requests${why}. Try again shortly, or choose another model.`
    : status >= 500 ? `The model’s provider had a problem${why}. Try again shortly.`
    : `The model’s provider refused the request${why}.`;
  return { text, detail: raw.trim() };
}
