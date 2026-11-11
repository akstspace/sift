import { memo, useId, useRef, useState, type ComponentType, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  IconAlertTriangle as AlertTriangle,
  IconArrowBackUp as Undo,
  IconCheck as Check,
  IconChevronRight as ChevronRight,
  IconCircleDashed as CircleDashed,
  IconClockPlay as JobIcon,
  IconEye as Eye,
  IconFilePencil as FileEdit,
  IconFilePlus as FilePlus,
  IconFileText as FileText,
  IconFolder as Folder,
  IconGitMerge as Merge,
  IconHistory as RunIcon,
  IconListSearch as ListSearch,
  IconLoader2 as Loader,
  IconMessage2 as Comment,
  IconPhoto as Photo,
  IconSearch as Search,
  IconSparkles as Sparkles,
  IconSquareCheck as TaskGlyph,
  IconTag as Tag,
  IconTerminal2 as Terminal,
  IconTool as Tool,
  IconWorld as World,
  IconX as X,
} from "@tabler/icons-react";
import { AgentMarkdown } from "../components/AgentMarkdown";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/ui/collapsible";
import { TaskIcon } from "../components/shared";
import type { CatalogIcon, Task } from "../types";
import { settle } from "../motion";
import type { ImageBlock, Item, ToolState } from "./model";
import { describeSiftOp, parseSiftCommand, parseSiftOutput, type Lookups, type SiftOp, type TaskRef } from "./siftOps";

type IconType = ComponentType<{ size?: number; className?: string; "aria-hidden"?: boolean }>;

export interface TranscriptProps {
  items: Item[];
  lookups: Lookups;
  catalog: CatalogIcon[];
  onOpenTask?: (task: Task) => void;
  onOpenRun?: (id: string) => void;
  /** Animate items that arrive after the transcript first renders. */
  live?: boolean;
}

export function Transcript({ items, live = false, ...rest }: TranscriptProps) {
  // Items already present when the transcript opens never animate in.
  const initial = useRef<Set<string> | null>(null);
  if (!initial.current) initial.current = new Set(items.map(i => i.key));
  const reduced = !!useReducedMotion();
  return (
    <div className="transcript">
      {items.map(item => {
        const node = <TranscriptItem item={item} {...rest} />;
        if (!live || initial.current!.has(item.key)) return <div key={item.key} className={"t-item t-" + item.kind}>{node}</div>;
        return (
          <motion.div
            key={item.key}
            className={"t-item live t-" + item.kind}
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: item.kind === "user" ? 10 : 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={reduced ? { duration: 0.12 } : { duration: 0.32, ease: settle, opacity: { duration: 0.18 } }}
          >
            {node}
          </motion.div>
        );
      })}
    </div>
  );
}

type ItemProps = Omit<TranscriptProps, "items" | "live"> & { item: Item };

const TranscriptItem = memo(function TranscriptItem({ item, ...rest }: ItemProps) {
  switch (item.kind) {
    case "user": return <UserMessage text={item.text} images={item.images} context={item.context} pending={item.pending} />;
    case "text": return <AgentMarkdown className={item.streaming ? "streaming" : ""} text={item.text} />;
    case "thinking": return <Thinking text={item.text} streaming={!!item.streaming} redacted={!!item.redacted} />;
    case "notice": return <Notice tone={item.tone} detail={item.detail}>{item.text}</Notice>;
    case "tool": {
      const call = item.tool.name === "bash" ? parseSiftCommand(item.tool.args.command) : null;
      if (call) {
        const done = item.tool.status === "done" || item.tool.status === "error";
        const op = describeSiftOp(call, done ? parseSiftOutput(item.tool.output, item.tool.status === "error") : null, rest.lookups);
        return <SiftCard op={op} tool={item.tool} {...rest} />;
      }
      return <ToolRow tool={item.tool} />;
    }
  }
}, (a, b) => {
  if (a.lookups !== b.lookups || a.catalog !== b.catalog || a.onOpenTask !== b.onOpenTask) return false;
  const x = a.item, y = b.item;
  if (x === y) return true;
  if (x.kind !== y.kind || x.key !== y.key) return false;
  if (x.kind === "tool" && y.kind === "tool") {
    const s = x.tool, t = y.tool;
    return s.status === t.status && s.output === t.output && s.live === t.live && s.args === t.args && s.durationMs === t.durationMs && s.name === t.name;
  }
  if (x.kind === "user" && y.kind === "user") return x.text === y.text && x.pending === y.pending && x.images.length === y.images.length && x.context === y.context;
  if ((x.kind === "text" || x.kind === "thinking") && (y.kind === "text" || y.kind === "thinking")) return x.text === y.text && x.streaming === y.streaming;
  // Every other kind is handled above, so both are notices.
  const n = x as Extract<Item, { kind: "notice" }>, m = y as typeof n;
  return n.text === m.text && n.tone === m.tone && n.detail === m.detail;
});

const imageSrc = (img: ImageBlock) => (img.data ? `data:${img.mimeType};base64,${img.data}` : "");

function UserMessage({ text, images, context, pending }: { text: string; images: ImageBlock[]; context?: string; pending?: boolean }) {
  return (
    <div className={"user-message" + (pending ? " pending" : "")}>
      {images.length > 0 && (
        <div className="user-images">
          {images.map((img, i) => img.data
            ? <img key={i} src={imageSrc(img)} alt={`Attached image ${i + 1}`} />
            : <span key={i} className="image-omitted"><Photo size={16} aria-hidden />Image</span>)}
        </div>
      )}
      {text && <div className="user-bubble">{text}</div>}
      {context && (
        <span className="user-context" title={context}>
          <Eye size={12} aria-hidden />
          <span className="sr-only">Sift shared: </span>
          {contextLabel(context)}
        </span>
      )}
    </div>
  );
}

/** "Page: All tasks. Open task: Pay rent (task_1)." reads as "All tasks · Pay rent". */
export function contextLabel(context: string) {
  const page = context.match(/Page: ([^.]+)/)?.[1];
  const task = context.match(/Open task: (.+?) \(task_[\w-]+\)/)?.[1];
  return [page, task].filter(Boolean).join(" · ") || context;
}

function Thinking({ text, streaming, redacted }: { text: string; streaming: boolean; redacted: boolean }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const reduced = !!useReducedMotion();
  return (
    <div className={"thinking" + (open ? " open" : "")}>
      <button type="button" className="thinking-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen(v => !v)}>
        <Sparkles size={14} aria-hidden />
        <span className={streaming ? "shimmer" : ""}>{streaming ? "Thinking…" : redacted && !text ? "Thinking hidden" : "Thought"}</span>
        <ChevronRight size={13} className="chevron" aria-hidden />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div id={id} className="thinking-body" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={reduced ? { duration: 0.1 } : { duration: 0.24, ease: settle }}>
            <div className="thinking-text">
              {text ? <AgentMarkdown className={"thinking-markdown" + (streaming ? " streaming" : "")} text={text} /> : <p>The model’s provider doesn’t share its thinking.</p>}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Notice({ tone, detail, children }: { tone: "info" | "error"; detail?: string; children: ReactNode }) {
  return (
    <div className={"transcript-notice " + tone} role={tone === "error" ? "alert" : undefined}>
      {tone === "error" ? <AlertTriangle size={14} aria-hidden /> : <CircleDashed size={14} aria-hidden />}
      <span>{children}{detail && <PiErrorDetail detail={detail} />}</span>
    </div>
  );
}

/** The provider's own words, on request. */
export function PiErrorDetail({ detail }: { detail: string }) {
  return (
    <Collapsible className="notice-detail">
      <CollapsibleTrigger className="notice-detail-toggle">
        <ChevronRight size={12} className="chevron" aria-hidden />Details
      </CollapsibleTrigger>
      <CollapsibleContent><code>{detail}</code></CollapsibleContent>
    </Collapsible>
  );
}

export function formatDuration(ms?: number) {
  if (ms === undefined || ms < 0) return "";
  if (ms < 1000) return (ms / 1000).toFixed(1) + "s";
  if (ms < 60000) return Math.round(ms / 1000) + "s";
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

function StatusMark({ status }: { status: ToolState["status"] }) {
  const label = { pending: "Starting", running: "Running", done: "Done", error: "Failed", unknown: "No result" }[status];
  return (
    <span className="tool-status" data-status={status} role="img" aria-label={label}>
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span key={status === "pending" ? "running" : status} className="tool-status-glyph" initial={{ opacity: 0, scale: 0.6 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.6 }} transition={{ duration: 0.18, ease: settle }}>
          {status === "running" || status === "pending" ? <Loader size={13} className="spin" /> : status === "done" ? <Check size={13} /> : status === "error" ? <X size={13} /> : <CircleDashed size={13} />}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
const basename = (p: string) => p.replace(/\/+$/, "").split("/").pop() || p;
/** Output without blank lines at either end, and no gap taller than one blank line. */
export const tidyOutput = (text: string) => text.replace(/^(?:[ \t]*\n)+/, "").trimEnd().replace(/\n(?:[ \t]*\n){2,}/g, "\n\n");
/** "read: notes.md" without its "read: ". Tool names come from extensions, so never a RegExp. */
const unprefixed = (text: string, prefix: string) => (text.startsWith(prefix) ? text.slice(prefix.length) : text);

/** How Pi's built-in tools read in one line. Unknown tools show their main argument. */
export function toolLine(tool: ToolState): { icon: IconType; verb: string; target: string; title?: string } {
  const a = tool.args, path = str(a.path) || str(a.file_path);
  // Older runs kept only a line of text for each tool call.
  if (tool.summary && !Object.keys(a).length) {
    const target = unprefixed(tool.summary, tool.name + ": ");
    return { icon: tool.name === "bash" ? Terminal : Tool, verb: "", target, title: tool.summary };
  }
  switch (tool.name) {
    case "bash": {
      const command = str(a.command).trim();
      const first = command.split("\n")[0];
      return { icon: Terminal, verb: "", target: first + (command.includes("\n") ? " …" : "") || unprefixed(tool.summary || "", "bash: ") || "bash", title: command };
    }
    case "read": return { icon: FileText, verb: "Read", target: basename(path), title: path };
    case "write": return { icon: FilePlus, verb: "Wrote", target: basename(path), title: path };
    case "edit": return { icon: FileEdit, verb: "Edited", target: basename(path), title: path };
    case "grep": return { icon: Search, verb: "Searched for", target: str(a.pattern), title: [str(a.pattern), str(a.path)].filter(Boolean).join(" in ") };
    case "find": return { icon: ListSearch, verb: "Found", target: str(a.pattern) || basename(path), title: str(a.pattern) };
    case "ls": return { icon: Folder, verb: "Listed", target: basename(path) || ".", title: path };
  }
  const main = ["query", "url", "path", "pattern", "command", "prompt"].map(k => str(a[k])).find(Boolean)
    || Object.values(a).map(str).find(Boolean) || unprefixed(tool.summary || "", tool.name + ": ");
  const icon = /web|search|fetch|browse|url/i.test(tool.name) ? World : Tool;
  return { icon, verb: tool.name.replace(/[_-]+/g, " "), target: main.split("\n")[0], title: main };
}

function Disclosure({ open, children }: { open: boolean; children: ReactNode }) {
  const reduced = !!useReducedMotion();
  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div className="disclosure" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={reduced ? { duration: 0.1 } : { duration: 0.26, ease: settle, opacity: { duration: 0.16 } }}>
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

const ToolRow = memo(function ToolRow({ tool }: { tool: ToolState }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const line = toolLine(tool);
  const Icon = line.icon;
  const running = tool.status === "running" || tool.status === "pending";
  const tail = running && tool.live ? tool.live.trimEnd().split("\n").slice(-3).join("\n") : "";
  return (
    <div className={"tool-row" + (open ? " open" : "")} data-status={tool.status}>
      <button type="button" className="tool-head" aria-expanded={open} aria-controls={id} onClick={() => setOpen(v => !v)} title={line.title}>
        <Icon size={14} className="tool-icon" aria-hidden />
        <span className="tool-label">
          {(line.verb || !line.target) && <span className="tool-verb">{line.verb || tool.name}</span>}
          {line.target && <code className="tool-target">{line.target}</code>}
        </span>
        <span className="tool-meta">
          {/* Only a tool slow enough to notice says how long it took. */}
          {!running && tool.durationMs !== undefined && tool.durationMs >= 1000 && <span className="tool-time">{formatDuration(tool.durationMs)}</span>}
          <StatusMark status={tool.status} />
          <ChevronRight size={13} className="chevron" aria-hidden />
        </span>
      </button>
      {tail && !open && <pre className="tool-tail" aria-hidden>{tail}</pre>}
      <Disclosure open={open}>
        <div id={id} className="tool-body">
          <ToolDetails tool={tool} />
        </div>
      </Disclosure>
    </div>
  );
});

function ToolDetails({ tool }: { tool: ToolState }) {
  const a = tool.args;
  const output = tool.output ?? tool.live;
  const parts: ReactNode[] = [];
  if (tool.name === "bash" && str(a.command)) parts.push(<pre key="cmd" className="tool-command"><span aria-hidden>$ </span>{str(a.command)}</pre>);
  else if (tool.name === "edit") {
    const edits = Array.isArray(a.edits) ? a.edits as Record<string, unknown>[] : [a];
    parts.push(<p key="path" className="tool-path">{str(a.path)}</p>);
    edits.forEach((e, i) => parts.push(<Diff key={"d" + i} before={str(e.oldText) || str(e.old_string)} after={str(e.newText) || str(e.new_string)} />));
  } else if (tool.name === "write") {
    parts.push(<p key="path" className="tool-path">{str(a.path)}</p>);
    parts.push(<pre key="content" className="tool-output">{str(a.content)}</pre>);
  } else if (tool.name === "read" || tool.name === "ls" || tool.name === "find" || tool.name === "grep") {
    const where = [str(a.pattern), str(a.path), a.offset ? `from line ${a.offset}` : "", a.limit ? `${a.limit} lines` : ""].filter(Boolean).join(" · ");
    if (where) parts.push(<p key="path" className="tool-path">{where}</p>);
  } else if (Object.keys(a).length) parts.push(<pre key="args" className="tool-args">{JSON.stringify(a, null, 2)}</pre>);
  else if (tool.summary) parts.push(<p key="summary" className="tool-path">{tool.summary}</p>);
  if (output && tool.name !== "write" && tool.name !== "edit") parts.push(<pre key="out" className={"tool-output" + (tool.status === "error" ? " is-error" : "")}>{tidyOutput(output)}</pre>);
  else if (output && tool.status === "error") parts.push(<pre key="out" className="tool-output is-error">{output}</pre>);
  for (const [i, img] of (tool.images || []).entries()) if (img.data) parts.push(<img key={"img" + i} className="tool-image" src={imageSrc(img)} alt={`Image from ${tool.name}`} />);
  if (!parts.length) parts.push(<p key="none" className="tool-path">{tool.status === "running" ? "Waiting for output…" : "No output"}</p>);
  return <>{parts}</>;
}

function Diff({ before, after }: { before: string; after: string }) {
  const lines = (s: string) => (s ? s.replace(/\n$/, "").split("\n") : []);
  return (
    <pre className="tool-diff" aria-label="Changes">
      {lines(before).map((l, i) => <span key={"b" + i} className="del"><span aria-hidden>- </span>{l}{"\n"}</span>)}
      {lines(after).map((l, i) => <span key={"a" + i} className="add"><span aria-hidden>+ </span>{l}{"\n"}</span>)}
    </pre>
  );
}

const opIcons: Record<SiftOp["icon"], IconType> = {
  task: TaskGlyph, comment: Comment, merge: Merge, project: Folder, tag: Tag, job: JobIcon, run: RunIcon, undo: Undo, read: ListSearch, search: Search, image: Photo, sift: TaskGlyph,
};

type CardProps = Omit<ItemProps, "item"> & { op: SiftOp; tool: ToolState };

function SiftCard({ op, tool, lookups, catalog, onOpenTask, onOpenRun }: CardProps) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const Icon = opIcons[op.icon];
  const running = tool.status === "running" || tool.status === "pending";
  const quiet = op.emphasis === "read" && !op.error;
  const chips = op.tasks.filter(t => t.id || t.title);
  const shown = quiet ? chips.slice(0, 12) : chips;
  const body = (
    <>
      {!quiet && shown.length > 0 && (
        <ul className="sift-tasks" aria-label="Tasks">
          {shown.map((t, i) => <li key={(t.id || "new") + i}><TaskChip task={t} lookups={lookups} catalog={catalog} onOpen={onOpenTask} /></li>)}
        </ul>
      )}
      {op.changes.length > 0 && <ul className="sift-changes" aria-label="Changes">{op.changes.map(c => <li key={c}>{c}</li>)}</ul>}
      {op.entity && <p className="sift-entity">{op.entity.color && <span className={"status-dot " + op.entity.color} aria-hidden />}{op.entity.name}</p>}
      {op.quote && <blockquote className="sift-quote">{op.quote}</blockquote>}
      {op.error && <p className="sift-error">{op.error}</p>}
      {op.runId && onOpenRun && <button type="button" className="sift-link" onClick={() => onOpenRun(op.runId!)}>Open in Run history<ChevronRight size={12} aria-hidden /></button>}
    </>
  );
  const details = (
    <div className="sift-details">
      <pre className="tool-command"><span aria-hidden>$ </span>{str(tool.args.command)}</pre>
      {tool.output && <pre className={"tool-output" + (tool.status === "error" ? " is-error" : "")}>{tidyOutput(tool.output)}</pre>}
    </div>
  );
  if (quiet) {
    return (
      <div className={"tool-row sift-row" + (open ? " open" : "")} data-status={tool.status}>
        <button type="button" className="tool-head" aria-expanded={open} aria-controls={id} onClick={() => setOpen(v => !v)}>
          <Icon size={14} className="tool-icon" aria-hidden />
          <span className="tool-label"><span className="tool-verb">{op.verb}</span>{op.detail && <span className="tool-detail">{op.detail}</span>}</span>
          <span className="tool-meta">
            <StatusMark status={tool.status} />
            <ChevronRight size={13} className="chevron" aria-hidden />
          </span>
        </button>
        <Disclosure open={open}>
          <div id={id} className="tool-body">
            {shown.length > 0 && (
              <ul className="sift-tasks compact" aria-label="Tasks">
                {shown.map((t, i) => <li key={t.id + i}><TaskChip task={t} lookups={lookups} catalog={catalog} onOpen={onOpenTask} /></li>)}
              </ul>
            )}
            {chips.length > shown.length && <p className="tool-path">and {chips.length - shown.length} more</p>}
            {op.runId && onOpenRun && <button type="button" className="sift-link" onClick={() => onOpenRun(op.runId!)}>Open in Run history<ChevronRight size={12} aria-hidden /></button>}
            {details}
          </div>
        </Disclosure>
      </div>
    );
  }
  const Glyph = op.error ? AlertTriangle : Icon;
  return (
    <section className={"sift-card" + (op.error ? " failed" : "") + (running ? " running" : "")} aria-label={op.verb}>
      <header>
        <span className="sift-glyph"><Glyph size={14} aria-hidden /></span>
        <span className="sift-verb"><span className={running ? "shimmer" : ""}>{op.verb}</span>{op.detail && <span className="tool-detail">{op.detail}</span>}</span>
        {!op.error && <StatusMark status={tool.status} />}
        <button type="button" className="sift-details-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen(v => !v)} aria-label={(open ? "Hide" : "Show") + " command and output"} title="Command and output">
          <ChevronRight size={13} className="chevron" aria-hidden />
        </button>
      </header>
      {body}
      <Disclosure open={open}><div id={id}>{details}</div></Disclosure>
    </section>
  );
}

function TaskChip({ task, lookups, catalog, onOpen }: { task: TaskRef; lookups: Lookups; catalog: CatalogIcon[]; onOpen?: (t: Task) => void }) {
  const live = lookups.tasks.find(t => t.id === task.id);
  const t = live || task.snapshot;
  const column = lookups.columns.find(c => c.id === t?.status);
  const state = !task.id ? "" : !live ? "Not in workspace" : live.deletedAt ? "In Trash" : live.mergedInto ? "Merged" : live.archivedAt ? "Archived" : "";
  const content = (
    <>
      <span className="chip-icon"><TaskIcon id={t?.icon || "circle-check"} catalog={catalog} size={15} /></span>
      <span className={"chip-title" + (t?.status === "done" ? " done" : "")}>{task.title || t?.title || task.id}</span>
      {state ? <span className="chip-state">{state}</span> : column && <span className="chip-status"><span className={"status-dot " + column.color} aria-hidden />{column.name}</span>}
    </>
  );
  if (!onOpen || !live) return <span className="task-chip static">{content}</span>;
  return <button type="button" className="task-chip" onClick={() => onOpen(live)} aria-label={`Open task ${live.title}`}>{content}</button>;
}
