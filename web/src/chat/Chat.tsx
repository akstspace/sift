import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { toast } from "sonner";
import type { CatalogIcon, Snapshot, Task } from "../types";
import { settle } from "../motion";
import { preloadable } from "../lib/preloadable";
import { useChat } from "./useChat";

// The panel (and the Markdown renderer it brings) loads on first open, or
// once the workspace is idle, so the pill costs nothing up front.
const ChatPanel = preloadable(() => import("./ChatPanel").then(m => m.ChatPanel));
export const preloadChat = () => ChatPanel.preload();

const dockSpring = { type: "spring", stiffness: 420, damping: 38, mass: 0.9 } as const;
// Task details, confirmations, and open popovers own the keyboard, as they do
// for the workspace's other shortcuts. Radix dialogs don't set aria-modal.
const KEYBOARD_OWNERS = '[role="dialog"], [role="alertdialog"]';
const STORAGE = "sift.chat";

export interface ChatView {
  /** "Page: Today. Open task: Pay rent (task_1)." — what Pi is told the person is looking at. */
  context: string;
}

/** Pi's mark: the letter it is named for. */
export function PiGlyph({ size = 22 }: { size?: number }) {
  return <span className="pi-glyph" style={{ width: size, height: size, fontSize: size * 0.62 }} aria-hidden>π</span>;
}

export function ChatDock({ snapshot, catalog, view, onOpenTask, onOpenRun, raised = false }: {
  snapshot: Snapshot;
  catalog: CatalogIcon[];
  view: ChatView;
  onOpenTask: (task: Task) => void;
  onOpenRun: (id: string) => void;
  /** The activity strip is showing; sit above it. */
  raised?: boolean;
}) {
  const [open, setOpenState] = useState(() => { try { return localStorage.getItem(STORAGE) === "open"; } catch { return false; } });
  // Opening the panel moves the keyboard into it; a panel restored with the page doesn't.
  const [opened, setOpened] = useState(false);
  const chat = useChat(open);
  const pill = useRef<HTMLButtonElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const reduced = !!useReducedMotion();
  const setOpen = useCallback((value: boolean) => {
    setOpenState(value);
    if (value) setOpened(true);
    try { localStorage.setItem(STORAGE, value ? "open" : "closed"); } catch { /* Storage can be disabled. */ }
  }, []);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "j" || e.altKey || e.shiftKey) return;
      if (document.querySelector(KEYBOARD_OWNERS)) return;
      e.preventDefault();
      setOpen(!open);
    };
    // Escape closes the panel from inside it, or when nothing else has focus
    // (for example, right after a question card was answered and removed).
    const escape = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || !open) return;
      const active = document.activeElement;
      const inside = !!active?.closest(".chat-panel");
      if (!inside && active !== document.body) return;
      if (document.querySelector(KEYBOARD_OWNERS + ', [role="menu"]')) return;
      e.preventDefault();
      setOpen(false);
    };
    window.addEventListener("keydown", escape);
    window.addEventListener("keydown", key);
    return () => { window.removeEventListener("keydown", key); window.removeEventListener("keydown", escape); };
  }, [open, setOpen]);
  // Focus returns to the pill on close, from inside the leaving panel or from
  // nowhere. (The composer takes it on open, once it mounts.)
  const wasOpen = useRef(open);
  useEffect(() => {
    const active = document.activeElement;
    if (!open && wasOpen.current && (active === document.body || active?.closest(".chat-panel"))) requestAnimationFrame(() => pill.current?.focus());
    wasOpen.current = open;
  }, [open]);
  useEffect(() => {
    for (const n of chat.notices) {
      (n.tone === "error" ? toast.error : n.tone === "warning" ? toast.warning : toast)(n.text);
      chat.dismissNotice(n.id);
    }
  }, [chat.notices]);

  const waiting = chat.dialogs.length > 0;
  const pillState = waiting ? "question" : chat.running ? "working" : chat.unread ? "unread" : "idle";
  const pillText = { question: "Pi has a question", working: "Pi is working…", unread: "New reply from Pi", idle: "Ask Pi" }[pillState];
  return (
    <div className={"chat-dock" + (raised ? " raised" : "") + (open ? " is-open" : "")}>
      <AnimatePresence initial={false} mode="popLayout">
        {open ? (
          <motion.section
            key="panel"
            layoutId="chat-surface"
            className="chat-panel"
            role="complementary"
            aria-label="Chat with Pi"
            style={{ borderRadius: 20 }}
            transition={reduced ? { duration: 0.12 } : dockSpring}
          >
            <motion.div className="chat-panel-inner" initial={{ opacity: 0 }} animate={{ opacity: 1, transition: { duration: 0.2, delay: reduced ? 0 : 0.08 } }} exit={{ opacity: 0, transition: { duration: 0.08 } }}>
              <Suspense fallback={<div className="chat-starting chat-loading" role="status"><span className="chat-skeleton" /><span className="chat-skeleton short" /><p>Opening chat…</p></div>}>
                <ChatPanel chat={chat} snapshot={snapshot} catalog={catalog} view={view} onOpenTask={onOpenTask} onOpenRun={onOpenRun} composer={composer} autoFocus={opened} onClose={() => setOpen(false)} />
              </Suspense>
            </motion.div>
          </motion.section>
        ) : (
          <motion.button
            key="pill"
            ref={pill}
            layoutId="chat-surface"
            type="button"
            className={"chat-pill " + pillState}
            style={{ borderRadius: 999 }}
            transition={reduced ? { duration: 0.12 } : dockSpring}
            onClick={() => setOpen(true)}
            onPointerEnter={() => { preloadChat().catch(() => {}); }}
            onFocus={() => { preloadChat().catch(() => {}); }}
            aria-label={pillText + ". Open chat (⌘J)"}
            aria-keyshortcuts="Meta+J Control+J"
          >
            <motion.span className="chat-pill-inner" initial={{ opacity: 0 }} animate={{ opacity: 1, transition: { duration: 0.18, delay: reduced ? 0 : 0.1 } }} exit={{ opacity: 0, transition: { duration: 0.06 } }}>
              <PiGlyph size={22} />
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.span key={pillState} className="chat-pill-text" initial={{ opacity: 0, y: reduced ? 0 : 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: reduced ? 0 : -6 }} transition={{ duration: 0.2, ease: settle }}>
                  {pillState !== "idle" && <span className={"pill-signal " + pillState} aria-hidden />}
                  {pillText}
                </motion.span>
              </AnimatePresence>
              <kbd aria-hidden>⌘J</kbd>
            </motion.span>
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  );
}

