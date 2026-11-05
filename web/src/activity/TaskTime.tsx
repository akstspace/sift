import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { IconArrowUpRight as ArrowUpRight, IconChevronDown as ChevronDown, IconPlus as Plus, IconRefresh as Refresh } from "@tabler/icons-react";
import { toast } from "sonner";
import { api } from "../api";
import type { ActivityEntry, ActivityPage, CatalogIcon, Snapshot, Task } from "../types";
import { Button } from "../components/shared";
import { addDays, dayOf, dayTitle, duration, firstDays, taskTime } from "./model";
import { SessionEditor, blankEntry } from "./SessionEditor";
import { SessionRow, categoryColor, grow, swatch, useSessionActions } from "./SessionRow";

/** Sessions shown before "Show earlier": whole days, newest first, until there are at least this many. */
const SHOWN = 4;

/**
 * The time spent on a task, from My activity: the total, where it went by kind
 * of work, and its sessions by day on My activity's rail. Sessions on tasks
 * merged into this one count too.
 */
export function TaskTime({ task, snapshot, catalog, refresh, onOpenDay, onOpenTask }: {
  task: Task;
  snapshot: Snapshot;
  catalog: CatalogIcon[];
  refresh: () => Promise<void>;
  /** Opens My activity on a day. */
  onOpenDay?: (day: string) => void;
  onOpenTask: (task: Task) => void;
}) {
  const reduced = !!useReducedMotion();
  const tz = snapshot.settings.timezone;
  const [page, setPage] = useState<ActivityPage | null>(null);
  // Only a first read that fails shows; later ones keep what's on screen.
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    api<ActivityPage>("/activity?task=" + encodeURIComponent(task.id)).then(p => { if (live) { setPage(p); setFailed(false); } }, () => live && setFailed(true));
    return () => { live = false; };
    // A changed cursor means something in the workspace changed.
  }, [task.id, snapshot.cursor, attempt]);
  const time = useMemo(() => taskTime(page?.entries || [], tz), [page, tz]);
  const tasks = useMemo(() => new Map(snapshot.tasks.map(t => [t.id, t])), [snapshot.tasks]);
  const { save, remove } = useSessionActions(refresh);
  // Moving a session off this task takes it out of the list, so say where it went and offer it back.
  const move = useCallback(async (entry: ActivityEntry, patch: Partial<ActivityEntry>) => {
    const saved = await save(entry, patch);
    if (!saved || patch.taskId === undefined || patch.taskId === entry.taskId) return saved;
    const before = tasks.get(entry.taskId);
    const back = before && !before.deletedAt && !before.mergedInto ? entry.taskId : task.id;
    const to = patch.taskId && tasks.get(patch.taskId);
    toast.success(to ? `Moved to “${to.title}”` : "Unlinked from this task", { action: { label: "Undo", onClick: () => void save(saved, { taskId: back }) } });
    return saved;
  }, [save, tasks, task.id]);
  const [expanded, setExpanded] = useState(false);
  const [hovered, setHovered] = useState("");
  const [editing, setEditing] = useState<ActivityEntry | null>(null);
  const headingId = useId(), feedId = useId();
  const open = !task.deletedAt && !task.mergedInto;
  const tracking = snapshot.jobs.some(j => j.kind === "activity");
  if (!page && failed) {
    return (
      <section className="task-time" aria-labelledby={headingId}>
        <div className="section-heading"><h3 id={headingId}>Time spent</h3></div>
        <p className="task-time-error" role="alert">
          Time spent couldn’t be read.
          <Button type="button" variant="ghost" size="sm" onClick={() => setAttempt(n => n + 1)}><Refresh size={14} aria-hidden />Try again</Button>
        </p>
      </section>
    );
  }
  // Without tracking and with nothing recorded, the section would only be in the way.
  if (!page || (!time.sessions && !(tracking && open))) return null;

  const now = Date.now(), today = dayOf(now, tz);
  const label = (day: string) => day === today ? "Today" : day === addDays(today, -1) ? "Yesterday"
    : dayTitle(day, { weekday: "short", day: "numeric", month: "short", ...(day.slice(0, 4) !== today.slice(0, 4) ? { year: "numeric" } : {}) });
  const first = firstDays(time.days, SHOWN);
  const days = expanded ? time.days : first;
  const earlier = time.sessions - first.reduce((n, d) => n + d.sessions.length, 0);
  const sessions = time.sessions === 1 ? "1 session" : `${time.sessions} sessions`;
  // Overlapping sessions of different kinds count once in the total but in full for each kind.
  const overlapping = time.categories.reduce((n, c) => n + c.total, 0) - time.total >= 60_000;
  const span = time.days.length > 1 ? `on ${time.days.length} days` : time.days[0] ? (time.days[0].day === today || time.days[0].day === addDays(today, -1) ? label(time.days[0].day).toLowerCase() : "on " + label(time.days[0].day)) : "";

  return (
    <section className="task-time" aria-labelledby={headingId}>
      <div className="section-heading">
        <h3 id={headingId}>Time spent</h3>
        {open && (
          <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(blankEntry(today, today, now, tz, task.id))}>
            <Plus size={14} aria-hidden />Add time
          </Button>
        )}
      </div>
      {!time.sessions ? (
        <p className="task-time-empty">Nothing recorded yet. Sessions linked to this task in My activity add up here.</p>
      ) : <>
        <p className="task-time-summary">
          {time.total > 0 && <strong>{duration(time.total)}</strong>}
          <span>{sessions} {span}</span>
        </p>
        {time.categories.length > 1 && <>
          <div className="task-time-bar" aria-hidden>
            {time.categories.map(c => <span key={c.id} title={`${c.label}, ${duration(c.total)}`} style={{ flexGrow: c.total, background: categoryColor(c.id) }} />)}
          </div>
          <ul className="task-time-legend" aria-label="By kind of work">
            {time.categories.map(c => (
              <li key={c.id} style={swatch(c.id)}><span className="legend-swatch" aria-hidden />{c.label}<span className="legend-time">{duration(c.total)}</span></li>
            ))}
          </ul>
          {overlapping && <p className="task-time-note">Sessions that overlap count once in the total.</p>}
        </>}
        <div id={feedId} className={"activity-feed task-time-feed" + (!expanded && earlier > 0 ? " is-collapsed" : "")}>
          <AnimatePresence initial={false}>
            {days.map(d => (
              <motion.section key={d.day} className="feed-part" aria-labelledby={headingId + d.day} {...grow(reduced)}>
                <header className="feed-part-head">
                  <h4 id={headingId + d.day}>
                    {onOpenDay ? (
                      <button type="button" className="task-time-day" aria-label={`${label(d.day)}${d.day >= addDays(today, -1) ? ", " + dayTitle(d.day) : ""}: open in My activity`} title="Open in My activity" onClick={() => onOpenDay(d.day)}>
                        {label(d.day)}<ArrowUpRight size={12} aria-hidden />
                      </button>
                    ) : label(d.day)}
                  </h4>
                  {d.total > 0 && <span>{duration(d.total)}</span>}
                </header>
                <ol className="feed-rows">
                  <AnimatePresence initial={false}>
                    {d.sessions.map(s => (
                      <motion.li key={s.id} className="feed-row is-session" {...grow(reduced)}>
                        <SessionRow session={s} tz={tz} tasks={tasks} catalog={catalog} level={5} onTask={task} hovered={hovered} onHover={setHovered}
                          onOpenTask={onOpenTask} onEdit={setEditing} onSave={move} onRemove={remove} />
                      </motion.li>
                    ))}
                  </AnimatePresence>
                </ol>
              </motion.section>
            ))}
          </AnimatePresence>
          {earlier > 0 && (
            <div className="task-time-more">
              <span className="task-time-more-rail" aria-hidden />
              <Button type="button" variant="ghost" size="sm" aria-expanded={expanded} aria-controls={feedId} onClick={() => setExpanded(v => !v)}>
                {expanded ? "Show fewer" : `Show ${earlier} earlier ${earlier === 1 ? "session" : "sessions"}`}
                <ChevronDown size={14} aria-hidden className={expanded ? "is-flipped" : undefined} />
              </Button>
            </div>
          )}
        </div>
      </>}
      {editing && <SessionEditor entry={editing} tz={tz} now={now} tasks={snapshot.tasks} catalog={catalog} onClose={() => setEditing(null)} refresh={refresh} />}
    </section>
  );
}
