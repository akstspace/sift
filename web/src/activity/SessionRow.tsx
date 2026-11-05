import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  IconArrowUpRight as ArrowUpRight,
  IconCheck as Check,
  IconCircleCheckFilled as DoneIcon,
  IconDots as Dots,
  IconGitMerge as Merged,
  IconLink as LinkIcon,
  IconPencil as Pencil,
  IconTrash as Trash2,
  IconUnlink as Unlink,
} from "@tabler/icons-react";
import { toast } from "sonner";
import { api } from "../api";
import type { ActivityEntry, CatalogIcon, Task } from "../types";
import { AgentMarkdown } from "../components/AgentMarkdown";
import { Button, Confirm, TaskIcon } from "../components/shared";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "../components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "../components/ui/command";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../components/ui/dropdown-menu";
import { settle } from "../motion";
import { categoryOf, clock, duration, type Session } from "./model";
import { sourceOf } from "./sources";

export const categoryColor = (id: string) => `var(--cat-${categoryOf(id).id})`;
export const swatch = (id: string) => ({ "--cat": categoryColor(id) }) as CSSProperties;
export const timeRange = (s: { from: number; to: number }, tz: string) => s.to > s.from ? `${clock(s.from, tz)}–${clock(s.to, tz)}` : clock(s.from, tz);

/**
 * A row (or group of rows) that arrives while the page is open opens up from
 * nothing, so what's below flows down with it instead of being overlapped;
 * one that leaves closes the same way. What's there on arrival doesn't move.
 */
export const grow = (reduced: boolean) => reduced
  ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 }, transition: { duration: 0.12 } }
  : {
    initial: { opacity: 0, height: 0, overflow: "hidden" },
    animate: { opacity: 1, height: "auto", transitionEnd: { overflow: "visible" } },
    exit: { opacity: 0, height: 0, overflow: "hidden", transition: { duration: 0.22, ease: [0.4, 0, 1, 1] } },
    transition: { height: { duration: 0.38, ease: settle }, opacity: { duration: 0.26, delay: 0.08 } },
  } as const;

/** A link's label: host and path, without scheme, "www.", query or fragment, split so its last segment stays in view when the rest is cut short. */
export function linkParts(href: string): [string, string] {
  let plain: string;
  try {
    const url = new URL(href);
    plain = url.protocol === "mailto:" ? url.pathname : url.host.replace(/^www\./i, "") + url.pathname;
  } catch { plain = href.replace(/^[a-z][a-z0-9+.-]*:(\/\/)?/i, "").replace(/^www\./i, ""); }
  plain = plain.replace(/\/$/, "");
  const cut = plain.lastIndexOf("/");
  return cut > 0 && plain.length - cut <= 24 ? [plain.slice(0, cut), plain.slice(cut)] : [plain, ""];
}

/** Saving and removing a session, then refreshing the workspace. A save resolves to the saved session, or null when it failed (and said so). */
export function useSessionActions(refresh: () => Promise<void>) {
  return useMemo(() => ({
    save: async (entry: ActivityEntry, patch: Partial<ActivityEntry>): Promise<ActivityEntry | null> => {
      try {
        const saved = await api<ActivityEntry>("/activity/" + entry.id, "PUT", { entry: { ...entry, ...patch }, expectedRevision: entry.revision });
        await refresh();
        return saved;
      } catch (e) { toast.error((e as Error).message); return null; }
    },
    remove: async (entry: ActivityEntry) => {
      await api("/activity/" + entry.id + "?revision=" + entry.revision, "DELETE");
      await refresh();
      toast.success("Activity removed");
    },
  }), [refresh]);
}

export interface SessionRowProps {
  session: Session;
  tz: string;
  tasks: Map<string, Task>;
  catalog: CatalogIcon[];
  onOpenTask: (t: Task) => void;
  onEdit: (e: ActivityEntry) => void;
  onSave: (e: ActivityEntry, patch: Partial<ActivityEntry>) => Promise<unknown>;
  onRemove: (e: ActivityEntry) => Promise<void>;
  hovered?: string;
  onHover?: (id: string) => void;
  flash?: string;
  /** An id for the row, so My activity's ribbon can scroll to it. */
  anchor?: string;
  /** The title's heading level: 3 under My activity's parts of day, 5 under a task's days. */
  level?: 3 | 5;
  /** The task the row is shown on. Its own chip is left out, and a session recorded on a task merged into it says so. */
  onTask?: Task;
}

/** One session on a rail: when and how long, what it was, and what can be done with it. */
export function SessionRow({ session: s, tz, hovered, onHover, flash, tasks, catalog, onOpenTask, onEdit, onSave, onRemove, anchor, level = 3, onTask }: SessionRowProps) {
  const source = sourceOf(s.source);
  const Source = source.icon;
  const category = categoryOf(s.category);
  const task = s.taskId ? tasks.get(s.taskId) : undefined;
  const shown = task?.mergedInto ? tasks.get(task.mergedInto) || task : task;
  // On a task, a session from a task merged into it says where it was recorded.
  const from = onTask && s.taskId && s.taskId !== onTask.id ? task?.title || "a merged task" : "";
  const chip = shown && !(onTask && (shown.id === onTask.id || s.taskId === onTask.id)) ? shown : undefined;
  const [more, setMore] = useState(false), [overflows, setOverflows] = useState(false);
  const summary = useRef<HTMLDivElement>(null);
  // Measured again whenever the row's width changes, so a summary clamped on a narrower screen still offers the rest.
  useEffect(() => {
    const el = summary.current;
    if (!el) return;
    const measure = () => setOverflows(el.scrollHeight > el.clientHeight + 2);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [s.summary]);
  const [linking, setLinking] = useState(false);
  // The picker opens once the menu has closed, so the menu's focus return doesn't dismiss it.
  const pickAfterMenu = useRef(false);
  const titleId = useId();
  const Title = level === 5 ? "h5" : "h3";
  const length = s.to - s.from;
  const link = linkParts(s.link);
  return (
    <article id={anchor} className={"session-row" + (hovered === s.id ? " is-hovered" : "") + (flash === s.id ? " is-flash" : "")}
      style={swatch(s.category)} onMouseEnter={() => onHover?.(s.id)} onMouseLeave={() => onHover?.("")} aria-labelledby={titleId}>
      <div className="row-time">
        <time dateTime={s.start}>{clock(s.from, tz)}</time>
        {length > 0 && <span>{length < 60_000 ? "<1m" : duration(length)}</span>}
      </div>
      <div className="row-rail" aria-hidden><span className="session-node"><Source size={14} aria-hidden /></span></div>
      <div className="row-body">
        <Title id={titleId} className="session-title">{s.title}</Title>
        <p className="session-meta">
          <span className="session-category"><span className="legend-swatch" aria-hidden />{category.label}</span>
          {s.source && <><span aria-hidden>·</span><span>{source.label}</span></>}
          <span aria-hidden>·</span><span>{timeRange(s, tz)}</span>
          {s.actor === "user" ? <><span aria-hidden>·</span><span>Added by you</span></> : s.edited ? <><span aria-hidden>·</span><span>Edited</span></> : null}
        </p>
        {from && <p className="session-from"><Merged size={13} aria-hidden /><span>From “{from}”</span></p>}
        {s.summary && (
          <div className={"session-summary" + (more ? " is-open" : "")} ref={summary}>
            <AgentMarkdown text={s.summary} />
          </div>
        )}
        {s.summary && (overflows || more) && (
          <button type="button" className="session-more" aria-expanded={more} onClick={() => setMore(m => !m)}>{more ? "Show less" : "Show more"}</button>
        )}
        {(chip || s.link) && (
          <div className="session-chips">
            {chip && (
              <button type="button" className={"session-task" + (chip.status === "done" ? " is-done" : "") + (chip.deletedAt ? " is-deleted" : "")} onClick={() => onOpenTask(chip)} disabled={!!chip.deletedAt}>
                {chip.status === "done" ? <DoneIcon size={14} aria-hidden className="session-task-done" /> : <TaskIcon id={chip.icon} catalog={catalog} size={14} />}
                <span>{chip.deletedAt ? "Deleted task" : chip.title}</span>
              </button>
            )}
            {s.link && (
              <a className="session-link" href={s.link} target="_blank" rel="noreferrer noopener" title={s.link}>
                <span className="session-link-label"><span>{link[0]}</span>{link[1] && <span className="session-link-tail">{link[1]}</span>}</span><ArrowUpRight size={12} aria-hidden />
              </a>
            )}
          </div>
        )}
      </div>
      <div className="row-actions">
        {!task && (
          <TaskPicker open={linking} onOpenChange={setLinking} tasks={tasks} catalog={catalog} onPick={t => onSave(s, { taskId: t.id })}>
            <Button variant="ghost" size="sm" className="session-link-task"><LinkIcon size={14} aria-hidden />Link task</Button>
          </TaskPicker>
        )}
        <Confirm title="Remove this activity" destructive description={`“${s.title}” is removed from My activity. Sift won’t add it back unless a check finds new evidence for it.`} action={() => onRemove(s)}>
          {confirm => (
            <DropdownMenu>
              <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="session-menu-trigger" aria-label={"More for " + s.title}><Dots size={16} aria-hidden /></Button></DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="session-menu" onCloseAutoFocus={e => {
                if (!pickAfterMenu.current) return;
                pickAfterMenu.current = false;
                e.preventDefault();
                setLinking(true);
              }}>
                <DropdownMenuItem onSelect={() => onEdit(s)}><Pencil size={15} aria-hidden />Edit</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => { pickAfterMenu.current = true; }}><LinkIcon size={15} aria-hidden />{task ? "Change task" : "Link to a task"}</DropdownMenuItem>
                {task && <DropdownMenuItem onSelect={() => onSave(s, { taskId: "" })}><Unlink size={15} aria-hidden />Unlink task</DropdownMenuItem>}
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={() => setTimeout(confirm)}><Trash2 size={15} aria-hidden />Remove</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </Confirm>
        {task && (
          <TaskPicker anchor current={task.id} open={linking} onOpenChange={setLinking} tasks={tasks} catalog={catalog} onPick={t => t.id !== task.id && onSave(s, { taskId: t.id })}>
            <span className="session-picker-anchor" />
          </TaskPicker>
        )}
      </div>
    </article>
  );
}

/** Search the person's open tasks (and today's finished ones) to link. */
export function TaskPicker({ open, onOpenChange, tasks, catalog, onPick, children, anchor, current = "" }: {
  open: boolean; onOpenChange: (v: boolean) => void; tasks: Map<string, Task>; catalog: CatalogIcon[]; onPick: (t: Task) => void; children: ReactNode; anchor?: boolean; current?: string;
}) {
  const [query, setQuery] = useState("");
  const list = useMemo(() => [...tasks.values()].filter(t => !t.deletedAt && !t.mergedInto && !t.archivedAt)
    .sort((a, b) => Number(a.status === "done") - Number(b.status === "done") || Number(b.today) - Number(a.today) || b.updatedAt.localeCompare(a.updatedAt)), [tasks]);
  const q = query.trim().toLocaleLowerCase();
  const matches = (q ? list.filter(t => t.title.toLocaleLowerCase().includes(q)) : list).slice(0, 60);
  return (
    <Popover open={open} onOpenChange={v => { onOpenChange(v); if (!v) setQuery(""); }}>
      {anchor ? <PopoverAnchor asChild>{children}</PopoverAnchor> : <PopoverTrigger asChild>{children}</PopoverTrigger>}
      <PopoverContent className="search-choice-content task-picker" align="end" sideOffset={6}>
        <Command shouldFilter={false} label={current ? "Change the linked task" : "Link to a task"} defaultValue={current || undefined}>
          <CommandInput aria-label="Search tasks" placeholder="Search tasks…" value={query} onValueChange={setQuery} />
          <CommandList aria-label="Tasks">
            <CommandEmpty>No matching tasks.</CommandEmpty>
            <CommandGroup>
              {matches.map(t => (
                <CommandItem key={t.id} value={t.id} onSelect={() => { onPick(t); onOpenChange(false); setQuery(""); }}>
                  {t.status === "done" ? <DoneIcon size={15} aria-hidden className="session-task-done" /> : <TaskIcon id={t.icon} catalog={catalog} size={15} />}
                  <span className="task-picker-title">{t.title}</span>
                  {t.id === current ? <span className="task-picker-current"><Check size={14} aria-hidden />Linked</span>
                    : t.today && t.status !== "done" && <span className="task-picker-today">Today</span>}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
