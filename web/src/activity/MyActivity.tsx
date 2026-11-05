import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  IconAlertTriangle as Warn,
  IconArrowUpRight as ArrowUpRight,
  IconCalendarSearch as CheckDay,
  IconChevronLeft as ChevronLeft,
  IconChevronRight as ChevronRight,
  IconHourglassEmpty as Hourglass,
  IconMoonStars as Quiet,
  IconPlayerPause as Paused,
  IconPlus as Plus,
  IconRefresh as Refresh,
  IconSettings as Settings2,
} from "@tabler/icons-react";
import { toast } from "sonner";
import { api } from "../api";
import type { ActivityEntry, ActivityPage, CatalogIcon, Job, Run, Snapshot, Task } from "../types";
import { Busy, Button, Empty, IconButton } from "../components/shared";
import { useIsMobile } from "../hooks/use-mobile";
import { pageMotion, selectionSpring, settle } from "../motion";
import {
  PARTS, addDays, categoryOf, clock, coverageLabel, dayOf, dayTitle, dayView, duration, lanes, nextCheckLabel, ribbonHours, sections, spanLabel, weekOf,
  type DayView, type Gap, type Session,
} from "./model";
import { TrackerDialog } from "./TrackerForm";
import { TrackerSetup } from "./TrackerSetup";
import { SessionEditor, blankEntry } from "./SessionEditor";
import { SessionRow, categoryColor, grow, swatch, timeRange, useSessionActions } from "./SessionRow";

const HOUR = 3_600_000, DAY = 24 * HOUR;

export function useNow(every = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), every); return () => clearInterval(t); }, [every]);
  return now;
}

/** A week of activity, refetched whenever the workspace changes. */
function useWeek(week: string, cursor: number, enabled: boolean) {
  const [state, setState] = useState<{ week: string; page: ActivityPage | null; error: string }>({ week: "", page: null, error: "" });
  useEffect(() => {
    let live = true;
    const t = setTimeout(async () => {
      try {
        const page = await api<ActivityPage>(`/activity?from=${week}&to=${addDays(week, 6)}`);
        if (live) setState({ week, page, error: "" });
      } catch (e) {
        if (live) setState(s => ({ ...s, error: (e as Error).message }));
      }
    }, state.page ? 120 : 0);
    return () => { live = false; clearTimeout(t); };
    // A changed cursor means something in the workspace changed.
  }, [week, cursor, enabled]);
  return state;
}

export function MyActivity({ snapshot, refresh, catalog, onOpenTask, onOpenRun, day: chosen, onDay }: {
  snapshot: Snapshot;
  refresh: () => Promise<void>;
  catalog: CatalogIcon[];
  onOpenTask: (task: Task) => void;
  onOpenRun: (id: string) => void;
  day: string;
  onDay: (day: string) => void;
}) {
  const reduced = !!useReducedMotion();
  const tz = snapshot.settings.timezone;
  const now = useNow();
  const today = dayOf(now, tz);
  const day = chosen && chosen <= today ? chosen : today;
  const week = weekOf(day);
  const tracker = snapshot.jobs.find(j => j.kind === "activity") || null;
  const { page, error, week: loaded } = useWeek(week, snapshot.cursor, !!tracker);
  if (!tracker) {
    return (
      <div className="page-body activity-page">
        {page ? <TrackerSetup defaultPrompt={page.defaultPrompt} defaultTimes={page.defaultTimes} timezone={tz} refresh={refresh} />
          : error ? <div className="error" role="alert">{error}</div> : <div className="page-loading"><Busy label="Opening My activity" /></div>}
      </div>
    );
  }
  return (
    <div className="page-body activity-page">
      <Timeline snapshot={snapshot} tracker={tracker} page={loaded === week ? page : null} stale={page} error={error} day={day} today={today} now={now}
        onDay={onDay} refresh={refresh} catalog={catalog} onOpenTask={onOpenTask} onOpenRun={onOpenRun} reduced={reduced} />
    </div>
  );
}

function Timeline({ snapshot, tracker, page, stale, error, day, today, now, onDay, refresh, catalog, onOpenTask, onOpenRun, reduced }: {
  snapshot: Snapshot; tracker: Job; page: ActivityPage | null; stale: ActivityPage | null; error: string; day: string; today: string; now: number;
  onDay: (day: string) => void; refresh: () => Promise<void>; catalog: CatalogIcon[]; onOpenTask: (task: Task) => void; onOpenRun: (id: string) => void; reduced: boolean;
}) {
  const tz = snapshot.settings.timezone;
  const runs = useMemo(() => snapshot.runs.filter(r => r.jobId === tracker.id).sort((a, b) => b.startedAt.localeCompare(a.startedAt)), [snapshot.runs, tracker.id]);
  const running = runs.find(r => r.status === "running");
  const lookback = (page || stale)?.lookbackDays ?? 7;
  const since = tracker.since ? new Date(tracker.since).valueOf() : -Infinity;
  const autoFrom = Math.max(since, now - lookback * DAY);
  const data = page || { entries: [], checks: [] };
  const view = useMemo(() => dayView(day, tz, data.entries, data.checks, { now, since: tracker.since, autoFrom, running: running?.windows }), [day, tz, data, now, tracker.since, autoFrom, running]);
  const [settings, setSettings] = useState(false);
  const [editing, setEditing] = useState<ActivityEntry | null>(null);
  const [chosenFilter, setFilter] = useState("");
  // A kind of work that's no longer on the day (its last session was removed) stops filtering.
  const filter = view.categories.some(c => c.id === chosenFilter) ? chosenFilter : "";
  const [hovered, setHovered] = useState("");
  const [flash, setFlash] = useState("");
  const [checking, setChecking] = useState(false);
  const previous = useRef(day);
  const direction = { sign: (day >= previous.current ? 1 : -1) as 1 | -1, depth: false };
  useEffect(() => { previous.current = day; setFilter(""); }, [day]);
  const check = async (window?: Gap) => {
    setChecking(true);
    try {
      await api("/activity/check", "POST", window ? { from: new Date(window.from).toISOString(), to: new Date(window.to).toISOString() } : {});
      await refresh();
    } catch (e) {
      const message = (e as Error).message;
      if (/already been checked/i.test(message)) toast.info(message);
      else toast.error(message);
    } finally { setChecking(false); }
  };
  const { save, remove } = useSessionActions(refresh);
  const reveal = (id: string) => {
    document.getElementById("session-" + id)?.scrollIntoView({ block: "center", behavior: reduced ? "auto" : "smooth" });
    setFlash(id);
    setTimeout(() => setFlash(f => f === id ? "" : f), 1400);
  };
  const tasks = useMemo(() => new Map(snapshot.tasks.map(t => [t.id, t])), [snapshot.tasks]);
  return (
    <div className="activity-timeline">
      <header className="activity-heading">
        <div className="activity-title">
          <h1>My activity</h1>
          <div className="activity-day-line">
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.p key={day} className="activity-day-label" initial={{ opacity: 0, y: reduced ? 0 : 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: reduced ? 0 : -4, transition: { duration: 0.1 } }} transition={{ duration: 0.24, ease: settle }}>
                {day === today ? "Today, " : day === addDays(today, -1) ? "Yesterday, " : ""}{dayTitle(day)}
              </motion.p>
            </AnimatePresence>
            <AnimatePresence initial={false}>
              {day !== today && (
                <motion.span key="today" className="activity-back" initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.1 } }} transition={{ duration: 0.2, ease: settle }}>
                  <Button variant="ghost" size="sm" onClick={() => onDay("")}>Back to today</Button>
                </motion.span>
              )}
            </AnimatePresence>
          </div>
        </div>
        <div className="activity-actions">
          <TrackerStatus tracker={tracker} running={running} last={runs.find(r => r.status !== "running")} tz={tz} now={now} onOpenRun={onOpenRun} />
          {!running && (
            <Button variant="outline" size="sm" disabled={checking} onClick={() => check()}>
              <Refresh size={14} aria-hidden className={checking ? "spin" : ""} />Check now
            </Button>
          )}
          <IconButton label="Activity tracking settings" onClick={() => setSettings(true)}><Settings2 size={17} /></IconButton>
        </div>
      </header>
      <WeekStrip day={day} today={today} tz={tz} page={page} tracker={tracker} now={now} autoFrom={autoFrom} running={running} onDay={onDay} />
      {error && !page && <div className="error" role="alert">{error}</div>}
      <div className="activity-day-frame">
        <AnimatePresence mode="popLayout" initial={false} custom={direction}>
          <motion.div key={day} className="activity-day" custom={direction} variants={pageMotion(reduced)} initial="enter" animate="visible" exit="exit">
            {!page ? <div className="activity-loading"><Busy label="Reading activity" /></div> : <>
              <DayOverview view={view} tz={tz} now={now} filter={filter} onFilter={setFilter} hovered={hovered} onHover={setHovered} onReveal={reveal} reduced={reduced} />
              <Feed view={view} tz={tz} now={now} filter={filter} hovered={hovered} onHover={setHovered} flash={flash} tasks={tasks} catalog={catalog}
                tracker={tracker} running={running} checking={checking} reduced={reduced}
                onCheck={check} onOpenTask={onOpenTask} onOpenRun={onOpenRun} onEdit={setEditing} onSave={save} onRemove={remove}
                onAdd={() => setEditing(blankEntry(day, today, now, tz))} />
            </>}
          </motion.div>
        </AnimatePresence>
      </div>
      {settings && <TrackerDialog tracker={tracker} defaultPrompt={(page || stale)?.defaultPrompt || ""} timezone={tz} onClose={() => setSettings(false)} refresh={refresh} />}
      {editing && <SessionEditor entry={editing} tz={tz} now={now} tasks={snapshot.tasks} catalog={catalog} onClose={() => setEditing(null)} refresh={refresh} />}
    </div>
  );
}

function TrackerStatus({ tracker, running, last, tz, now, onOpenRun }: { tracker: Job; running?: Run; last?: Run; tz: string; now: number; onOpenRun: (id: string) => void }) {
  if (running) {
    return <button type="button" className="tracker-status is-running" onClick={() => onOpenRun(running.id)}><span className="tracker-pulse" aria-hidden />Checking your activity<ArrowUpRight size={13} aria-hidden /></button>;
  }
  if (last && !["succeeded", "cancelled"].includes(last.status)) {
    return <button type="button" className="tracker-status is-warning" onClick={() => onOpenRun(last.id)} title={last.error}><Warn size={14} aria-hidden />Last check needs attention</button>;
  }
  const checked = last?.endedAt ? "Last checked " + clock(new Date(last.endedAt).valueOf(), tz) : "Not checked yet";
  if (!tracker.enabled) return <span className="tracker-status is-paused" title={checked}><Paused size={14} aria-hidden />Paused</span>;
  const next = nextCheckLabel(tracker.nextRun, tz, now);
  return <span className="tracker-status" title={checked}><span className="tracker-dot" aria-hidden />{next ? "Next check " + next : "Scheduled"}</span>;
}

/** Seven days, each with a miniature of its timeline. */
function WeekStrip({ day, today, tz, page, tracker, now, autoFrom, running, onDay }: {
  day: string; today: string; tz: string; page: ActivityPage | null; tracker: Job; now: number; autoFrom: number; running?: Run; onDay: (d: string) => void;
}) {
  const week = weekOf(day);
  const days = Array.from({ length: 7 }, (_, i) => addDays(week, i));
  const views = useMemo(() => days.map(d => page ? dayView(d, tz, page.entries, page.checks, { now, since: tracker.since, autoFrom, running: running?.windows }) : null), [page, week, tz, now, tracker.since, autoFrom, running]);
  const move = (d: string) => onDay(d >= today ? "" : d);
  const list = useRef<HTMLDivElement>(null);
  const focusDay = (d: string) => requestAnimationFrame(() => list.current?.querySelector<HTMLButtonElement>(`[data-day="${d}"]`)?.focus());
  return (
    <nav className="week-strip" aria-label="Choose a day">
      <IconButton label="Previous week" onClick={() => move(addDays(day, -7))}><ChevronLeft size={16} /></IconButton>
      <div className="week-days" ref={list} role="group" aria-label={"Week of " + dayTitle(week, { day: "numeric", month: "long" })}>
        {days.map((d, i) => {
          const v = views[i];
          const future = d > today;
          const label = dayTitle(d) + (v && !future ? v.total ? `, ${duration(v.total)} recorded` : v.beforeTracking ? ", before tracking started" : v.gaps.length && !v.checked.length ? ", not checked yet" : ", nothing recorded" : "");
          return (
            <button key={d} type="button" data-day={d} className={"week-day" + (d === day ? " is-selected" : "") + (d === today ? " is-today" : "") + (v?.beforeTracking ? " is-before" : "")}
              disabled={future} aria-current={d === day ? "date" : undefined} aria-label={label}
              onClick={() => move(d)}
              onKeyDown={e => {
                const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
                if (!step) return;
                e.preventDefault();
                const next = addDays(d, step);
                if (next > today) return;
                move(next);
                focusDay(next);
              }}>
              {d === day && <motion.span className="week-day-selection" layoutId="week-day-selection" transition={selectionSpring} aria-hidden />}
              <span className="week-day-name" aria-hidden>{dayTitle(d, { weekday: "short" })}</span>
              <span className="week-day-number" aria-hidden>{Number(d.slice(8))}</span>
              <span className="week-day-track" aria-hidden>
                {v?.sessions.map(s => {
                  const from = Math.max(0, (s.from - v.start) / DAY), to = Math.min(1, (s.to - v.start) / DAY);
                  return <span key={s.id} style={{ left: pct(from), width: `max(2px, ${pct(to - from)})`, background: categoryColor(s.category) }} />;
                })}
              </span>
            </button>
          );
        })}
      </div>
      <IconButton label="Next week" disabled={addDays(week, 7) > today} onClick={() => move(addDays(day, 7) > today ? today : addDays(day, 7))}><ChevronRight size={16} /></IconButton>
    </nav>
  );
}

const pct = (v: number) => `${(v * 100).toFixed(3)}%`;

/** The day at a glance: totals, the ribbon, and time per kind of work. */
function DayOverview({ view, tz, now, filter, onFilter, hovered, onHover, onReveal, reduced }: {
  view: DayView; tz: string; now: number; filter: string; onFilter: (c: string) => void; hovered: string; onHover: (id: string) => void; onReveal: (id: string) => void; reduced: boolean;
}) {
  const coverage = coverageLabel(view, tz, now);
  return (
    <section className="day-overview" aria-label="Day at a glance">
      <div className="overview-stats">
        <div className="overview-stat"><strong>{view.total ? duration(view.total) : "—"}</strong><span>recorded</span></div>
        <div className="overview-stat"><strong>{view.sessions.length}</strong><span>{view.sessions.length === 1 ? "session" : "sessions"}</span></div>
        <div className="overview-stat"><strong>{view.tasks.length}</strong><span>{view.tasks.length === 1 ? "task" : "tasks"}</span></div>
        <span className="overview-coverage">{coverage}</span>
      </div>
      <Ribbon view={view} tz={tz} now={now} filter={filter} hovered={hovered} onHover={onHover} onReveal={onReveal} reduced={reduced} />
      {view.categories.length > 0 && (
        <div className="overview-legend" role="group" aria-label="Show one kind of work">
          {view.categories.map(c => (
            <button key={c.id} type="button" className="legend-chip" style={swatch(c.id)} aria-pressed={filter === c.id}
              onClick={() => onFilter(filter === c.id ? "" : c.id)}>
              <span className="legend-swatch" aria-hidden />{c.label}<span className="legend-time">{duration(c.total)}</span>
            </button>
          ))}
          {/* Only when the filter hides something: with one kind of work on the day there's nothing more to show. */}
          <AnimatePresence initial={false}>
            {filter && view.categories.length > 1 && (
              <motion.span initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.1 } }}>
                <Button variant="ghost" size="sm" className="legend-clear" onClick={() => onFilter("")}>Show all</Button>
              </motion.span>
            )}
          </AnimatePresence>
        </div>
      )}
    </section>
  );
}

/**
 * The day as one horizontal band: sessions placed by time and colored by kind
 * of work, checked time plain, unchecked time hatched, and a now marker. It's
 * a picture of the feed below (which carries the same facts as text), so
 * assistive technology reads the feed instead.
 */
function Ribbon({ view, tz, now, filter, hovered, onHover, onReveal, reduced }: {
  view: DayView; tz: string; now: number; filter: string; hovered: string; onHover: (id: string) => void; onReveal: (id: string) => void; reduced: boolean;
}) {
  const [first, last] = ribbonHours(view, tz, now);
  const from = view.start + first * HOUR, to = view.start + last * HOUR, span = to - from;
  const x = (t: number) => Math.min(1, Math.max(0, (t - from) / span));
  const lane = lanes(view.sessions.map(s => ({ from: s.from, to: s.to })));
  const laneCount = Math.max(1, ...lane.map(l => l + 1));
  const compact = useIsMobile();
  const hoursSpan = last - first;
  const step = compact ? (hoursSpan > 12 ? 6 : 4) : hoursSpan > 18 ? 4 : hoursSpan > 12 ? 3 : 2;
  const nowAt = now > from && now < to ? x(now) : -1;
  const hours = [];
  // Hour labels make room for the Now label.
  for (let h = Math.ceil(first / step) * step; h <= last; h += step) if (nowAt < 0 || Math.abs((h - first) / hoursSpan - nowAt) > (compact ? 0.11 : 0.055)) hours.push(h);
  // The left edge always says when the ribbon starts.
  if (!hours.length || hours[0] - first >= step / 2) hours.unshift(first);
  const hourLabel = (h: number) => new Intl.DateTimeFormat(undefined, { hour: "numeric", timeZone: safeZone(tz) }).format(view.start + h * HOUR);
  // The tooltip is for pointing at the ribbon; hovering a row below only highlights its block.
  const [pointed, setPointed] = useState("");
  const tip = view.sessions.find(s => s.id === pointed && s.id === hovered);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; }, []);
  return (
    <div className="ribbon" aria-hidden="true" onMouseLeave={() => { setPointed(""); onHover(""); }}>
      <div className="ribbon-track" style={{ "--lanes": laneCount } as CSSProperties}>
        <div className="ribbon-fill">
        {view.checked.map(c => <span key={"c" + c.from} className="ribbon-checked" style={{ left: pct(x(c.from)), width: pct(x(c.to) - x(c.from)) }} />)}
        {view.gaps.map(g => <span key={"g" + g.from} className={"ribbon-gap is-" + g.kind} style={{ left: pct(x(g.from)), width: pct(x(g.to) - x(g.from)) }} />)}
        {view.sessions.map((s, i) => {
          const left = x(s.from), width = x(s.to) - left;
          const muted = (filter && categoryOf(s.category).id !== filter) || (hovered && hovered !== s.id);
          return (
            <motion.span key={s.id} className={"ribbon-session" + (hovered === s.id ? " is-hovered" : "") + (muted ? " is-muted" : "")}
              style={{ left: pct(left), width: `max(5px, ${pct(width)})`, top: `calc(6px + ${lane[i]} * (100% - 12px) / var(--lanes))`, height: `calc((100% - 12px) / var(--lanes) - ${laneCount > 1 ? 2 : 0}px)`, background: categoryColor(s.category) }}
              initial={reduced ? { opacity: 0 } : { opacity: 0, scaleX: 0 }} animate={{ opacity: muted ? 0.28 : 1, scaleX: 1 }}
              transition={mounted.current ? { duration: reduced ? 0.12 : 0.2, ease: settle } : { duration: reduced ? 0.12 : 0.42, ease: settle, delay: reduced ? 0 : 0.08 + i * 0.025 }}
              onMouseEnter={() => { setPointed(s.id); onHover(s.id); }} onClick={() => onReveal(s.id)} />
          );
        })}
        </div>
        {nowAt >= 0 && <span className="ribbon-now" style={{ left: pct(nowAt) }} />}
      </div>
      <div className="ribbon-hours">
        {hours.map(h => <span key={h} className={h === first ? "is-start" : h === last ? "is-end" : undefined} style={{ left: pct((h - first) / hoursSpan) }}>{hourLabel(h)}</span>)}
        {nowAt >= 0 && <span className={"ribbon-now-label" + (nowAt > 0.97 ? " is-end" : nowAt < 0.03 ? " is-start" : "")} style={{ left: pct(nowAt) }}>Now</span>}
      </div>
      <AnimatePresence>
        {tip && (
          <motion.div key="tip" className="ribbon-tip" style={{ left: pct(Math.min(0.86, Math.max(0.14, (x(tip.from) + x(tip.to)) / 2))) }}
            initial={{ opacity: 0, y: 3 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, transition: { duration: 0.08 } }} transition={{ duration: 0.14, ease: settle }}>
            <strong>{tip.title}</strong>
            <span><span className="legend-swatch" style={swatch(tip.category)} />{categoryOf(tip.category).label} · {timeRange(tip, tz)}</span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function safeZone(tz: string) {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return tz; } catch { return undefined; }
}

interface FeedProps {
  view: DayView; tz: string; now: number; filter: string; hovered: string; onHover: (id: string) => void; flash: string;
  tasks: Map<string, Task>; catalog: CatalogIcon[]; tracker: Job; running?: Run; checking: boolean; reduced: boolean;
  onCheck: (gap?: Gap) => void; onOpenTask: (t: Task) => void; onOpenRun: (id: string) => void;
  onEdit: (e: ActivityEntry) => void; onSave: (e: ActivityEntry, patch: Partial<ActivityEntry>) => Promise<unknown>; onRemove: (e: ActivityEntry) => Promise<void>; onAdd: () => void;
}

/** The day's sessions on a rail, most recent first, by part of day, with what's still unchecked in place and a check in progress on top. */
function Feed(props: FeedProps) {
  const { view, tz, filter, reduced } = props;
  const parts = sections(view, tz).map(s => ({ ...s, rows: s.rows.filter(r => !filter || r.kind !== "session" || categoryOf(r.session.category).id === filter) })).filter(s => s.rows.length);
  const fullyQuiet = !view.sessions.length && !view.gaps.length && view.checked.length > 0;
  const reading = view.beforeTracking ? [] : view.gaps.filter(g => g.kind === "running");
  return (
    <div className="activity-feed">
      {view.beforeTracking ? (
        <Empty icon={Hourglass} title="Before tracking started"
          action={<Button variant="outline" size="sm" disabled={!!props.running || props.checking} onClick={() => props.onCheck({ from: view.start, to: Math.min(view.end, props.now), kind: "older" })}><CheckDay size={15} aria-hidden />Check this day</Button>}>
          Sift began tracking on {dayTitle(dayOf(new Date(props.tracker.since || 0).valueOf(), tz), { day: "numeric", month: "long" })}. It can still look back at this day.
        </Empty>
      ) : fullyQuiet ? (
        <Empty icon={Quiet} title="A quiet day">Sift checked this day and didn’t find anything you worked on.</Empty>
      ) : <>
        <AnimatePresence initial={false}>
          {reading.length > 0 && (
            <motion.ol key="reading" className="feed-rows feed-reading" {...grow(reduced)}>
              {reading.map(g => <li key={"reading:" + g.from} className="feed-row is-gap"><GapRow {...props} gap={g} /></li>)}
            </motion.ol>
          )}
        </AnimatePresence>
        <AnimatePresence initial={false}>{parts.map(section => (
          <motion.section key={section.part} className="feed-part" aria-label={PARTS[section.part]} {...grow(reduced)}>
            <header className="feed-part-head">
              <h2>{PARTS[section.part]}</h2>
              {section.total > 0 && <span>{duration(section.total)}</span>}
            </header>
            <ol className="feed-rows">
              <AnimatePresence initial={false}>
                {section.rows.map(row => (
                  <motion.li key={row.key} className={"feed-row is-" + row.kind} {...grow(reduced)}>
                    {row.kind === "session" ? <SessionRow session={row.session} tz={props.tz} tasks={props.tasks} catalog={props.catalog} hovered={props.hovered} onHover={props.onHover} flash={props.flash}
                      anchor={"session-" + row.session.id} onOpenTask={props.onOpenTask} onEdit={props.onEdit} onSave={props.onSave} onRemove={props.onRemove} />
                      : row.kind === "gap" ? <GapRow {...props} gap={row.gap} />
                        : <div className="quiet-row"><span className="row-time" /><span className="row-rail" aria-hidden /><span className="quiet-label">{duration(row.span.to - row.span.from)} with nothing recorded</span></div>}
                  </motion.li>
                ))}
              </AnimatePresence>
            </ol>
          </motion.section>
        ))}</AnimatePresence>
      </>}
      {!view.future && !view.beforeTracking && (
        <div className="feed-foot">
          <Button variant="ghost" size="sm" onClick={props.onAdd}><Plus size={14} aria-hidden />Add activity</Button>
        </div>
      )}
    </div>
  );
}

function GapRow({ gap, view, tz, now, tracker, running, checking, onCheck, onOpenRun }: FeedProps & { gap: Gap }) {
  const range = spanLabel(gap, view, tz, now);
  if (gap.kind === "running") {
    return (
      <div className="gap-row is-running" role="status">
        <span className="row-time" />
        <span className="row-rail" aria-hidden><span className="gap-node"><span /></span></span>
        <div className="gap-body">
          <p><strong>Sift is reading your activity</strong><span>{range}</span></p>
          <span className="gap-shimmer" aria-hidden><span /><span /></span>
        </div>
        {running && <Button variant="ghost" size="sm" onClick={() => onOpenRun(running.id)}>Watch<ArrowUpRight size={13} aria-hidden /></Button>}
      </div>
    );
  }
  const next = gap.kind === "next" && tracker.enabled ? nextCheckLabel(tracker.nextRun, tz, now) : "";
  const before = tracker.since && gap.to <= new Date(tracker.since).valueOf();
  return (
    <div className={"gap-row is-" + gap.kind}>
      <span className="row-time"><span>{clock(gap.from, tz)}</span></span>
      <span className="row-rail" aria-hidden><span className="gap-node" /></span>
      <div className="gap-body">
        <p><strong>{gap.kind === "next" ? "Not checked yet" : "Not checked"}</strong><span>{range}</span></p>
        <small>{gap.kind === "next" ? (next ? `The next check, ${next}, covers this.` : "Check now to fill this in.") : before ? "Before tracking started. Sift can still look back at it." : "More than a week ago, so scheduled checks skip it."}</small>
      </div>
      <Button variant="ghost" size="sm" disabled={!!running || checking} onClick={() => onCheck(gap.kind === "older" ? gap : undefined)}>Check now</Button>
    </div>
  );
}

