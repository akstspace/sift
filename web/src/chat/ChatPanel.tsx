import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  IconAlertTriangle as AlertTriangle,
  IconArrowDown as ArrowDown,
  IconArrowUp as ArrowUp,
  IconCheck as Check,
  IconChevronDown as ChevronDown,
  IconEye as Eye,
  IconEyeOff as EyeOff,
  IconMessagePlus as NewChat,
  IconPaperclip as Paperclip,
  IconPlayerStopFilled as Stop,
  IconX as X,
} from "@tabler/icons-react";
import { toast } from "sonner";
import { Button, IconButton, MonoMark } from "../components/shared";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover";
import { Transcript, contextLabel } from "../transcript/Transcript";
import type { CatalogIcon, Snapshot, Task } from "../types";
import { settle } from "../motion";
import { MAX_IMAGES, readImages, type ChatDialog, type ChatImage, type ChatInfo, type PiCommand, type useChat as UseChat } from "./useChat";
import type { ChatView } from "./Chat";

type Chat = ReturnType<typeof UseChat>;

export function ChatPanel({ chat, snapshot, catalog, view, onOpenTask, onOpenRun, composer, autoFocus = false, onClose }: {
  chat: Chat; snapshot: Snapshot; catalog: CatalogIcon[]; view: ChatView;
  onOpenTask: (t: Task) => void; onOpenRun: (id: string) => void;
  composer: React.RefObject<HTMLTextAreaElement | null>;
  /** The person opened the panel just now: put the keyboard in the composer. */
  autoFocus?: boolean;
  onClose: () => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const stick = useRef(true);
  const [draft, setDraft] = useState("");
  const lookups = useMemo(() => ({ tasks: snapshot.tasks, columns: snapshot.columns, projects: snapshot.projects, tags: snapshot.tags }), [snapshot.tasks, snapshot.columns, snapshot.projects, snapshot.tags]);
  const empty = chat.phase === "ready" && !chat.items.length && !chat.running && !chat.queue.length;
  const last = chat.items.at(-1);
  const replying = chat.running && !chat.dialogs.length && !(last && ((last.kind === "text" || last.kind === "thinking") && last.streaming || last.kind === "tool" && (last.tool.status === "running" || last.tool.status === "pending")));
  // Follow the conversation while the reader is at the end; never pull them back from earlier messages.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [chat.items, chat.dialogs, chat.queue, chat.status, replying, chat.phase]);
  const onScroll = () => {
    const el = scroller.current!;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    stick.current = bottom;
    setAtBottom(bottom);
  };
  const toBottom = () => {
    const el = scroller.current!;
    stick.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  };
  const suggest = (text: string) => { setDraft(text); requestAnimationFrame(() => { const c = composer.current; if (c) { c.focus(); c.setSelectionRange(text.length, text.length); } }); };
  return (
    <>
      <header className="chat-header">
        <span className="chat-header-mark"><MonoMark size={18} /></span>
        <div className="chat-heading">
          <h2>Ask Sift</h2>
          <ModelPicker chat={chat} />
        </div>
        <IconButton label="New chat" onClick={() => chat.newChat().catch(e => toast.error((e as Error).message))} disabled={chat.phase === "loading"}>
          <NewChat size={17} />
        </IconButton>
        <IconButton label="Close chat (Esc)" onClick={onClose}>
          <ChevronDown size={18} />
        </IconButton>
      </header>
      <div className="chat-scroll" ref={scroller} onScroll={onScroll} role="log" aria-label="Conversation" aria-live="polite" aria-relevant="additions" tabIndex={0}>
        {chat.phase === "loading" || chat.phase === "idle" ? (
          <div className="chat-starting" role="status"><span className="chat-skeleton" /><span className="chat-skeleton short" /><span className="sr-only">Starting Pi…</span><p>Starting Pi…</p></div>
        ) : chat.phase === "unavailable" ? (
          <Unavailable info={chat.info} retry={chat.load} />
        ) : (
          <>
            {chat.info?.notice && <p className="transcript-notice info chat-notice">{chat.info.notice}</p>}
            {empty ? <EmptyChat view={view} snapshot={snapshot} onPick={suggest} /> : (
              <Transcript items={chat.items} lookups={lookups} catalog={catalog} onOpenTask={onOpenTask} onOpenRun={onOpenRun} live />
            )}
            <AnimatePresence initial={false}>
              {replying && (
                <motion.div key="typing" className="typing" role="status" aria-label="Sift is replying" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                  <span /><span /><span />
                </motion.div>
              )}
            </AnimatePresence>
            {chat.queue.map((q, i) => (
              <div key={i + q} className="t-item t-user queued">
                <div className="user-message pending"><div className="user-bubble">{q.replace(/^<sift-context>[\s\S]*?<\/sift-context>\s*/, "")}</div><span className="user-context">Queued — Sift reads it after the current step</span></div>
              </div>
            ))}
            {chat.dialogs.map(d => <DialogCard key={d.id} dialog={d} onAnswer={v => {
              // The card leaves; the keyboard continues in the composer.
              requestAnimationFrame(() => composer.current?.focus());
              chat.answer(d.id, v).catch(e => toast.error((e as Error).message));
            }} />)}
            {chat.status && <p className={"transcript-notice " + chat.status.tone} role={chat.status.tone === "error" ? "alert" : "status"}>{chat.status.tone === "error" && <AlertTriangle size={14} aria-hidden />}<span>{chat.status.text}</span></p>}
          </>
        )}
      </div>
      <div className="jump-anchor">
        <AnimatePresence>
          {!atBottom && (
            <motion.button key="latest" type="button" className="jump-latest" onClick={toBottom} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 6 }} transition={{ duration: 0.18, ease: settle }}>
              <ArrowDown size={14} aria-hidden />Latest
            </motion.button>
          )}
        </AnimatePresence>
      </div>
      <Composer chat={chat} view={view} draft={draft} setDraft={setDraft} composer={composer} autoFocus={autoFocus} onSent={() => { stick.current = true; setAtBottom(true); }} />
    </>
  );
}

function Unavailable({ info, retry }: { info: ChatInfo | null; retry: () => void }) {
  // Retrying shows "Starting Pi…" in place of this card straight away.
  return (
    <div className="chat-unavailable">
      <AlertTriangle size={22} aria-hidden />
      <h3>Pi isn’t available right now</h3>
      <p className="break-anywhere">{info?.error || "Sift couldn’t start Pi."}</p>
      <Button variant="outline" size="sm" onClick={retry}>Try again</Button>
      <small>Sift runs Pi on this computer. Settings → Local connections shows where it looks.</small>
    </div>
  );
}

function EmptyChat({ view, snapshot, onPick }: { view: ChatView; snapshot: Snapshot; onPick: (text: string) => void }) {
  const task = view.context.match(/Open task: (.+?) \(task_/)?.[1];
  const open = snapshot.tasks.some(t => t.status !== "done" && !t.deletedAt && !t.archivedAt && !t.mergedInto);
  const ideas = [
    task ? `Break “${task}” into smaller steps` : open ? "What should I focus on today?" : "What’s on my plate this week?",
    "Add a task: ",
    snapshot.runs.length ? "What did my agents do today?" : "Help me set up a morning planning job",
    "Find tasks that look like duplicates",
  ];
  return (
    <div className="chat-empty">
      <h3>What can I sift for you?</h3>
      <p>Sift uses Pi to read and change your tasks and to use your usual tools. Every change shows up here.</p>
      <ul>
        {ideas.map((idea, i) => (
          <motion.li key={idea} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.28, ease: settle, delay: 0.12 + i * 0.04 }}>
            <button type="button" onClick={() => onPick(idea)}>{idea.trim()}</button>
          </motion.li>
        ))}
      </ul>
    </div>
  );
}

const modelLabel = (m?: { id: string; name?: string } | null) => (m ? m.name || m.id : "No model");

function ModelPicker({ chat }: { chat: Chat }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState("");
  const info = chat.info;
  if (!info || chat.phase !== "ready") return <span className="chat-model muted">{chat.phase === "unavailable" ? "Not connected" : "Connecting…"}</span>;
  const chosen = info.chosen || { provider: "", model: "", thinking: "" };
  const levels = info.thinkingLevels || [];
  const choose = async (choice: { provider: string; model: string; thinking: string }, key: string) => {
    setBusy(key);
    try { await chat.configure(choice); }
    catch (e) { toast.error((e as Error).message); }
    finally { setBusy(""); }
  };
  const providers = [...new Set(info.models.map(m => m.provider))];
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className={"chat-model" + (info.modelError ? " problem" : "")} aria-label={`Model: ${modelLabel(info.model)}${info.thinkingLevel ? `, thinking ${info.thinkingLevel}` : ""}. Change model`}>
          <span>{modelLabel(info.model)}</span>
          {info.thinkingLevel && info.thinkingLevel !== "off" && <span className="chat-thinking">· {info.thinkingLevel}</span>}
          <ChevronDown size={12} aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="bottom" className="chat-model-menu" onOpenAutoFocus={e => e.preventDefault()}>
        {chat.running && <p className="model-note">You can change the model after this reply.</p>}
        <div role="radiogroup" aria-label="Model" className="model-list">
          <button type="button" role="radio" aria-checked={!chosen.provider} disabled={chat.running || !!busy} onClick={() => choose({ provider: "", model: "", thinking: chosen.thinking }, "default")}>
            <span><strong>Pi’s default</strong><small>{!chosen.provider && info.model ? `Now ${modelLabel(info.model)}` : "As set in Pi"}</small></span>{!chosen.provider && <Check size={14} aria-hidden />}
          </button>
          {providers.map(p => (
            <div key={p} className="model-group">
              <span className="model-provider">{p}</span>
              {info.models.filter(m => m.provider === p).map(m => {
                const on = chosen.provider === m.provider && chosen.model === m.id;
                return (
                  <button key={m.id} type="button" role="radio" aria-checked={on} disabled={chat.running || !!busy} onClick={() => choose({ provider: m.provider, model: m.id, thinking: chosen.thinking }, m.provider + "/" + m.id)}>
                    <span><strong>{modelLabel(m)}</strong>{m.name && m.name !== m.id && <small>{m.id}</small>}</span>
                    {busy === m.provider + "/" + m.id ? <span className="spin-dot" aria-label="Switching" /> : on && <Check size={14} aria-hidden />}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        {levels.length > 1 && (
          <div className="thinking-picker" role="radiogroup" aria-label="Thinking">
            <span>Thinking</span>
            <div>
              {levels.map(l => (
                <button key={l} type="button" role="radio" aria-checked={info.thinkingLevel === l} disabled={chat.running || !!busy} onClick={() => choose({ ...chosen, thinking: l }, "thinking")}>{l}</button>
              ))}
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

function DialogCard({ dialog, onAnswer }: { dialog: ChatDialog; onAnswer: (v: { value?: string; confirmed?: boolean; cancelled?: boolean }) => void }) {
  const [value, setValue] = useState(dialog.method === "editor" ? dialog.prefill || "" : "");
  const first = useRef<HTMLElement | null>(null);
  const id = useId();
  const reduced = !!useReducedMotion();
  useEffect(() => { first.current?.focus({ preventScroll: true }); }, []);
  const remaining = dialog.timeout ? Math.max(0, dialog.timeout - (Date.now() - (dialog.seenAt || Date.now()))) : 0;
  return (
    <motion.section className="chat-question" aria-labelledby={id} initial={reduced ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={reduced ? { duration: 0.12 } : { duration: 0.3, ease: settle }}>
      <span className="question-eyebrow"><span aria-hidden />Sift is waiting for you</span>
      <h3 id={id}>{dialog.title || "Sift needs an answer"}</h3>
      {dialog.message && <p>{dialog.message}</p>}
      {dialog.method === "select" && (
        <div className="question-options">
          {(dialog.options || []).map((o, i) => <Button key={o} variant="outline" size="sm" ref={i === 0 ? (el: HTMLButtonElement | null) => { first.current = el; } : undefined} onClick={() => onAnswer({ value: o })}>{o}</Button>)}
        </div>
      )}
      {dialog.method === "confirm" && (
        <div className="question-actions">
          <Button variant="outline" size="sm" onClick={() => onAnswer({ confirmed: false })}>No</Button>
          <Button size="sm" ref={(el: HTMLButtonElement | null) => { first.current = el; }} onClick={() => onAnswer({ confirmed: true })}>Yes</Button>
        </div>
      )}
      {(dialog.method === "input" || dialog.method === "editor") && (
        <form onSubmit={e => { e.preventDefault(); onAnswer({ value }); }}>
          {dialog.method === "input"
            ? <input className="question-input" aria-label={dialog.title || "Answer"} placeholder={dialog.placeholder} value={value} onChange={e => setValue(e.target.value)} ref={el => { first.current = el; }} />
            : <textarea className="question-input" aria-label={dialog.title || "Answer"} rows={5} value={value} onChange={e => setValue(e.target.value)} ref={el => { first.current = el; }} onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onAnswer({ value }); } }} />}
          <div className="question-actions">
            <Button type="button" variant="ghost" size="sm" onClick={() => onAnswer({ cancelled: true })}>Dismiss</Button>
            <Button type="submit" size="sm">Send answer</Button>
          </div>
        </form>
      )}
      {dialog.method !== "input" && dialog.method !== "editor" && (
        <Button className="question-dismiss" variant="ghost" size="sm" onClick={() => onAnswer({ cancelled: true })}>Dismiss</Button>
      )}
      {remaining > 0 && <span className="question-timer" style={{ animationDuration: remaining + "ms" }} aria-hidden />}
    </motion.section>
  );
}

function Composer({ chat, view, draft, setDraft, composer, autoFocus, onSent }: {
  chat: Chat; view: ChatView; draft: string; setDraft: (v: string) => void;
  composer: React.RefObject<HTMLTextAreaElement | null>; autoFocus: boolean; onSent: () => void;
}) {
  const [images, setImages] = useState<ChatImage[]>([]);
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [share, setShare] = useState(true);
  const [menu, setMenu] = useState(0);
  const [menuClosed, setMenuClosed] = useState(false);
  const [dragging, setDragging] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const menuId = useId();
  // Opening the panel puts the keyboard here, even while Pi is still starting,
  // unless the person already moved into the panel (a question, the model menu).
  // On touch screens it would raise the keyboard over the conversation.
  useEffect(() => {
    if (!autoFocus || matchMedia("(pointer: coarse)").matches) return;
    const raf = requestAnimationFrame(() => { if (!document.activeElement?.closest(".chat-panel")) composer.current?.focus(); });
    return () => cancelAnimationFrame(raf);
  }, [autoFocus, composer]);
  // A new view is shared again by default.
  useEffect(() => setShare(true), [view.context]);
  useEffect(() => { if (chat.editorText) setDraft(chat.editorText.text); }, [chat.editorText]);
  // Grow with the message, up to a limit, then scroll.
  useLayoutEffect(() => {
    const el = composer.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 180) + "px";
  }, [draft, composer]);
  const commands: PiCommand[] = useMemo(() => [{ name: "new", description: "Start a new chat without the earlier context", source: "sift" }, ...(chat.info?.commands || [])], [chat.info?.commands]);
  const slash = /^\/\S*$/.test(draft) && !menuClosed;
  const matches = slash ? commands.filter(c => ("/" + c.name).startsWith(draft) || c.name.includes(draft.slice(1))).slice(0, 8) : [];
  useEffect(() => { setMenu(0); setMenuClosed(false); }, [draft.split(" ")[0]]);
  const add = async (files: File[]) => {
    const { images: read, error } = await readImages(files, images.length);
    setImages(v => [...v, ...read].slice(0, MAX_IMAGES));
    setError(error);
  };
  const ready = chat.phase === "ready";
  const canSend = ready && !sending && (draft.trim() !== "" || images.length > 0) && !chat.info?.modelError;
  const submit = async () => {
    if (!canSend) return;
    const text = draft, attached = images;
    setSending(true); setError("");
    setDraft(""); setImages([]);
    onSent();
    try { await chat.send(text, attached, share ? view.context : ""); }
    catch (e) { setDraft(text); setImages(attached); setError((e as Error).message); }
    finally { setSending(false); requestAnimationFrame(() => composer.current?.focus()); }
  };
  const pick = (c: PiCommand) => { setDraft("/" + c.name + (c.name === "new" ? "" : " ")); setMenuClosed(true); composer.current?.focus(); };
  const onKey = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (matches.length) {
      if (e.key === "ArrowDown") { e.preventDefault(); setMenu(i => (i + 1) % matches.length); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setMenu(i => (i - 1 + matches.length) % matches.length); return; }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && "/" + matches[menu].name !== draft.trim())) { e.preventDefault(); pick(matches[menu]); return; }
      if (e.key === "Escape") { e.preventDefault(); setMenuClosed(true); return; }
    }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
  };
  const statuses = Object.values(chat.info?.statuses || {}).filter(Boolean);
  const label = contextLabel(view.context);
  return (
    <footer
      className={"chat-composer" + (dragging ? " dragging" : "")}
      onDragOver={e => { if ([...e.dataTransfer.types].includes("Files")) { e.preventDefault(); setDragging(true); } }}
      onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false); }}
      onDrop={e => { e.preventDefault(); setDragging(false); add([...e.dataTransfer.files]); }}
    >
      {chat.info?.modelError && (
        <div className="composer-problem" role="alert">
          <AlertTriangle size={14} aria-hidden /><span>{chat.info.modelError}</span>
          <Button variant="outline" size="sm" onClick={() => chat.configure({ provider: "", model: "", thinking: chat.info?.chosen?.thinking || "" }).catch(e => toast.error((e as Error).message))}>Use Pi’s default</Button>
        </div>
      )}
      <AnimatePresence>
        {matches.length > 0 && (
          <motion.ul key="menu" id={menuId} className="slash-menu" role="listbox" aria-label="Commands" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 4 }} transition={{ duration: 0.16, ease: settle }}>
            {matches.map((c, i) => (
              <li key={c.name} id={menuId + "-" + i} role="option" aria-selected={i === menu} onMouseDown={e => { e.preventDefault(); pick(c); }} onMouseEnter={() => setMenu(i)}>
                <code>/{c.name}</code>
                <span>{c.description || (c.source === "skill" ? "Skill" : c.source === "prompt" ? "Prompt" : "Command")}</span>
              </li>
            ))}
          </motion.ul>
        )}
      </AnimatePresence>
      {images.length > 0 && (
        <ul className="composer-images" aria-label="Attached images">
          {images.map((img, i) => (
            <li key={i}>
              <img src={`data:${img.mimeType};base64,${img.data}`} alt={img.name || `Image ${i + 1}`} />
              <button type="button" aria-label={`Remove ${img.name || "image " + (i + 1)}`} onClick={() => setImages(v => v.filter((_, j) => j !== i))}><X size={11} /></button>
            </li>
          ))}
        </ul>
      )}
      <div className="composer-box">
        <textarea
          ref={composer}
          rows={1}
          value={draft}
          onChange={e => { setDraft(e.target.value); setError(""); }}
          onKeyDown={onKey}
          onPaste={e => { const files = [...e.clipboardData.files].filter(f => f.type.startsWith("image/")); if (files.length) { e.preventDefault(); add(files); } }}
          placeholder={chat.running ? "Add to what Sift is doing…" : "Ask Sift, or type / for commands"}
          aria-label="Message Sift"
          aria-controls={matches.length ? menuId : undefined}
          aria-activedescendant={matches.length ? menuId + "-" + menu : undefined}
          aria-autocomplete="list"
          disabled={chat.phase === "unavailable"}
        />
        <div className="composer-actions">
          <IconButton label="Attach images" onClick={() => file.current?.click()} disabled={chat.phase === "unavailable" || images.length >= MAX_IMAGES}>
            <Paperclip size={16} />
          </IconButton>
          <input ref={file} type="file" hidden accept="image/png,image/jpeg,image/webp,image/gif" multiple onChange={e => { const f = [...(e.target.files || [])]; e.target.value = ""; add(f); }} />
          {label && (
            <button type="button" className={"context-chip" + (share ? "" : " off")} aria-pressed={share} onClick={() => setShare(v => !v)} title={share ? "Pi sees what you’re viewing. Click to stop sharing it for this message." : "Not sharing your view. Click to share it."}>
              {share ? <Eye size={13} aria-hidden /> : <EyeOff size={13} aria-hidden />}
              <span>{share ? label : "View not shared"}</span>
            </button>
          )}
          <span className="composer-spacer" />
          <AnimatePresence mode="popLayout" initial={false}>
            {chat.running && (
              <motion.span key="stop" initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.8 }} transition={{ duration: 0.16 }}>
                <IconButton label="Stop" className="composer-stop" onClick={() => chat.stop().catch(e => toast.error((e as Error).message))}>
                  <Stop size={13} />
                </IconButton>
              </motion.span>
            )}
          </AnimatePresence>
          <IconButton label={chat.running ? "Send — Sift reads it after the current step" : "Send"} className="composer-send" onClick={submit} disabled={!canSend}>
            <ArrowUp size={16} />
          </IconButton>
        </div>
      </div>
      {(error || statuses.length > 0) && (
        <p className={"composer-note" + (error ? " is-error" : "")} role={error ? "alert" : undefined}>{error || statuses.join(" · ")}</p>
      )}
    </footer>
  );
}
