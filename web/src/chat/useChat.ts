import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { emptyConversation, itemsFromMessages, reduceConversation, type Conversation, type PiMessage } from "../transcript/model";

export interface PiModelInfo { id: string; name?: string; provider: string; reasoning?: boolean }
export interface PiCommand { name: string; description?: string; source?: string }
export interface ChatDialog {
  id: string;
  method: "select" | "confirm" | "input" | "editor";
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  timeout?: number;
  /** When this page first saw the question, for its timeout bar. */
  seenAt?: number;
}
export interface ChatInfo {
  available: boolean;
  error?: string;
  sessionId?: string;
  running?: boolean;
  loaded?: boolean;
  model?: PiModelInfo | null;
  thinkingLevel?: string;
  models: PiModelInfo[];
  thinkingLevels: string[];
  commands: PiCommand[];
  chosen?: { provider: string; model: string; thinking: string };
  modelError?: string;
  notice?: string;
  statuses?: Record<string, string>;
  queue?: { steering?: string[]; followUp?: string[] };
  dialogs: ChatDialog[];
  messages: PiMessage[];
}
export interface ChatImage { data: string; mimeType: string; name: string; size: number }
export type ChatEvent = Record<string, unknown> & { type: string };

/** A transient line under the conversation: retries, compaction, a crash. */
export interface ChatStatus { tone: "info" | "error"; text: string }

export const CHAT_EVENT = "sift:chat";

/**
 * The chat panel's conversation with Pi. Pi starts on first open; until then
 * the pill only follows whether a reply is running. Events arrive on the
 * workspace's event stream and are applied once per frame.
 */
export function useChat(open: boolean) {
  const [info, setInfo] = useState<ChatInfo | null>(null);
  const [phase, setPhase] = useState<"idle" | "loading" | "ready" | "unavailable">("idle");
  const [conversation, setConversation] = useState<Conversation>(emptyConversation());
  const [running, setRunning] = useState(false);
  const [dialogs, setDialogs] = useState<ChatDialog[]>([]);
  const [queue, setQueue] = useState<string[]>([]);
  const [status, setStatus] = useState<ChatStatus | null>(null);
  const [unread, setUnread] = useState(false);
  const [editorText, setEditorText] = useState<{ text: string; n: number } | null>(null);
  const [notices, setNotices] = useState<{ id: number; text: string; tone: string }[]>([]);
  const pending = useRef<ChatEvent[]>([]);
  const frame = useRef(0);
  const loading = useRef<ChatEvent[] | null>(null);
  const openRef = useRef(open);
  openRef.current = open;
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  const apply = useCallback((events: ChatEvent[]) => {
    setConversation(c => events.reduce((acc, e) => reduceConversation(acc, e), c));
  }, []);

  const flush = useCallback(() => {
    frame.current = 0;
    const events = pending.current;
    pending.current = [];
    if (events.length) apply(events);
  }, [apply]);

  const adopt = useCallback((state: ChatInfo) => {
    setInfo(state);
    setRunning(!!state.running);
    setDialogs((state.dialogs || []).map(d => ({ ...d, seenAt: Date.now() })));
    setQueue([...(state.queue?.steering || []), ...(state.queue?.followUp || [])]);
    if (state.statuses) setInfo(i => i && { ...i, statuses: state.statuses });
  }, []);

  /** Loads the conversation, starting Pi if needed. Events that arrive meanwhile are replayed on top. */
  const load = useCallback(async () => {
    loading.current = [];
    setPhase(p => (p === "ready" ? p : "loading"));
    try {
      const state = await api<ChatInfo>("/chat");
      const missed = loading.current || [];
      loading.current = null;
      adopt(state);
      if (!state.available) { setPhase("unavailable"); return; }
      setConversation(missed.reduce((c, e) => reduceConversation(c, e, true), emptyConversation(state.messages || [])));
      setPhase("ready");
    } catch (e) {
      loading.current = null;
      setInfo(i => ({ ...(i || { models: [], thinkingLevels: [], commands: [], dialogs: [], messages: [] }), available: false, error: (e as Error).message }));
      setPhase("unavailable");
    }
  }, [adopt]);

  // Whether a reply is running is known before the panel ever opens.
  useEffect(() => {
    api<ChatInfo>("/chat?peek=1").then(s => { setRunning(!!s.running); setDialogs((s.dialogs || []).map(d => ({ ...d, seenAt: Date.now() }))); }).catch(() => {});
  }, []);

  useEffect(() => {
    if (open && phase === "idle") load();
    if (open) setUnread(false);
  }, [open, phase, load]);

  useEffect(() => {
    const onEvent = (raw: Event) => {
      const e = (raw as CustomEvent<ChatEvent>).detail;
      if (!e?.type) return;
      switch (e.type) {
        case "sift_chat_resync":
          if (phaseRef.current === "ready" || phaseRef.current === "unavailable") load();
          else api<ChatInfo>("/chat?peek=1").then(s => setRunning(!!s.running)).catch(() => {});
          return;
        case "sift_chat_reset":
          setConversation(emptyConversation());
          setDialogs([]); setQueue([]); setStatus(null); setRunning(false);
          if (phaseRef.current !== "idle") load();
          return;
        case "sift_chat_configured":
          if (phaseRef.current === "ready") api<ChatInfo>("/chat").then(s => setInfo(i => ({ ...s, statuses: s.statuses || i?.statuses }))).catch(() => {});
          return;
        case "sift_chat_stopped":
          setRunning(false); setDialogs([]); setQueue([]);
          if (e.reason === "exited") setStatus({ tone: "error", text: String(e.error || "Pi stopped unexpectedly.") + " Your next message starts it again." });
          // Pi was stopped on purpose (idle, maintenance); the next message resumes it.
          if (phaseRef.current === "ready") { pending.current.push(e); if (!frame.current) frame.current = requestAnimationFrame(flush); }
          return;
        case "sift_chat_dialog_closed":
          setDialogs(d => d.filter(x => x.id !== e.id));
          return;
        case "agent_start":
          setRunning(true); setStatus(null);
          break;
        case "agent_settled":
          setRunning(false); setStatus(null);
          if (!openRef.current) setUnread(true);
          break;
        case "queue_update":
          setQueue([...((e.steering as string[]) || []), ...((e.followUp as string[]) || [])]);
          return;
        case "auto_retry_start":
          setStatus({ tone: "info", text: `Retrying${e.attempt ? ` (attempt ${e.attempt}${e.maxAttempts ? ` of ${e.maxAttempts}` : ""})` : ""}…${e.errorMessage ? " " + String(e.errorMessage) : ""}` });
          return;
        case "auto_retry_end":
        case "compaction_end":
          setStatus(null);
          return;
        case "compaction_start":
          setStatus({ tone: "info", text: "Summarizing earlier messages to make room…" });
          return;
        case "extension_ui_request":
          switch (e.method) {
            case "select": case "confirm": case "input": case "editor":
              setDialogs(d => d.some(x => x.id === e.id) ? d : [...d, { ...(e as unknown as ChatDialog), seenAt: Date.now() }]);
              if (!openRef.current) setUnread(true);
              return;
            case "notify":
              if (!e.message) return;
              setNotices(n => [...n.slice(-2), { id: Date.now() + Math.random(), text: String(e.message), tone: String(e.notifyType || "info") }]);
              return;
            case "setStatus":
              setInfo(i => {
                if (!i) return i;
                const statuses = { ...(i.statuses || {}) };
                if (e.statusText) statuses[String(e.statusKey)] = String(e.statusText); else delete statuses[String(e.statusKey)];
                return { ...i, statuses };
              });
              return;
            case "set_editor_text":
              setEditorText(t => ({ text: String(e.text || ""), n: (t?.n || 0) + 1 }));
              return;
          }
          return;
        case "thinking_level_changed":
          setInfo(i => i && { ...i, thinkingLevel: String(e.level || "") });
          return;
      }
      if (loading.current) { loading.current.push(e); return; }
      if (phaseRef.current !== "ready") return;
      pending.current.push(e);
      if (!frame.current) frame.current = requestAnimationFrame(flush);
    };
    window.addEventListener(CHAT_EVENT, onEvent);
    return () => { window.removeEventListener(CHAT_EVENT, onEvent); if (frame.current) cancelAnimationFrame(frame.current); frame.current = 0; };
  }, [flush, load]);

  const newChat = useCallback(async () => {
    await api("/chat/new", "POST", {});
    setConversation(emptyConversation());
    setDialogs([]); setQueue([]); setStatus(null); setRunning(false);
    await load();
  }, [load]);

  const send = useCallback(async (message: string, images: ChatImage[], context: string) => {
    const text = message.trim();
    if (text === "/new" && !images.length) { await newChat(); return { disposition: "reset" }; }
    const optimistic = !running;
    if (optimistic) {
      const content = [...(text ? [{ type: "text" as const, text }] : []), ...images.map(i => ({ type: "image" as const, data: i.data, mimeType: i.mimeType }))];
      setConversation(c => ({ ...c, messages: [...c.messages, { role: "user", content, pending: true, siftContext: text.startsWith("/") ? undefined : context || undefined, timestamp: Date.now() }] }));
    }
    setStatus(null);
    try {
      const out = await api<{ disposition?: string }>("/chat/prompt", "POST", { message: text, images: images.map(i => ({ data: i.data, mimeType: i.mimeType })), context });
      if (out.disposition === "started") setRunning(true);
      if (out.disposition === "handled" && optimistic) setConversation(c => ({ ...c, messages: c.messages.filter(m => !m.pending) }));
      if (info?.notice) setInfo(i => i && { ...i, notice: undefined });
      return out;
    } catch (e) {
      if (optimistic) setConversation(c => ({ ...c, messages: c.messages.filter(m => !m.pending) }));
      throw e;
    }
  }, [running, info?.notice, newChat]);

  const stop = useCallback(async () => {
    await api("/chat/abort", "POST", {});
  }, []);

  const answer = useCallback(async (id: string, value: { value?: string; confirmed?: boolean; cancelled?: boolean }) => {
    setDialogs(d => d.filter(x => x.id !== id));
    try { await api("/chat/dialogs/" + encodeURIComponent(id), "POST", value); }
    catch (e) {
      // Pi already answered it itself (it timed out); nothing is waiting.
      if (!/no longer waiting/i.test((e as Error).message)) throw e;
    }
  }, []);

  const configure = useCallback(async (choice: { provider: string; model: string; thinking: string }) => {
    const state = await api<ChatInfo>("/chat/settings", "PUT", choice);
    setInfo(i => ({ ...state, statuses: state.statuses || i?.statuses }));
  }, []);

  const items = useMemo(() => itemsFromMessages(conversation.messages, conversation.tools, { streaming: conversation.streaming, running }), [conversation, running]);

  return {
    info, phase, items, running, dialogs, queue, status, unread, editorText, notices,
    streaming: conversation.streaming !== undefined,
    dismissNotice: (id: number) => setNotices(n => n.filter(x => x.id !== id)),
    load, send, newChat, stop, answer, configure,
  };
}

/** Reads pasted, dropped, or chosen image files for Pi. */
export const MAX_IMAGES = 4;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

export async function readImages(files: File[], have: number): Promise<{ images: ChatImage[]; error: string }> {
  const images: ChatImage[] = [];
  let error = "";
  for (const file of files) {
    if (!file.type.startsWith("image/")) continue;
    if (!IMAGE_TYPES.includes(file.type)) { error = "Images must be PNG, JPEG, WebP, or GIF."; continue; }
    if (file.size > MAX_IMAGE_BYTES) { error = `${file.name || "That image"} is over 5 MB.`; continue; }
    if (have + images.length >= MAX_IMAGES) { error = `Attach up to ${MAX_IMAGES} images.`; break; }
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    images.push({ data, mimeType: file.type, name: file.name, size: file.size });
  }
  return { images, error };
}
