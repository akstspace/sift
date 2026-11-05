import type { ActivityCheck, ActivityEntry, ActivityWindow } from "../types";

// My activity works in the person's timezone (from Settings), so a day here
// is the same day Sift's Today uses, whatever the browser's own zone is.

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;

/** The categories in display order: legend, filters, and the stacked bar. */
export const CATEGORIES = [
  { id: "code", label: "Coding" },
  { id: "review", label: "Reviewing" },
  { id: "meeting", label: "Meetings" },
  { id: "message", label: "Messages" },
  { id: "admin", label: "Admin" },
  { id: "research", label: "Research" },
  { id: "writing", label: "Writing" },
  { id: "other", label: "Other" },
] as const;

export const categoryOf = (id: string) => CATEGORIES.find(c => c.id === id) ?? CATEGORIES[CATEGORIES.length - 1];

function zoneOr(tz: string) {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return tz; } catch { return undefined; }
}

/** Minutes to add to UTC to get local time in tz at an instant. */
export function offsetAt(ms: number, tz: string): number {
  const zone = zoneOr(tz);
  if (!zone) return -new Date(ms).getTimezoneOffset();
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(ms));
  const n = (type: string) => Number(parts.find(p => p.type === type)?.value);
  const local = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second"));
  return Math.round((local - Math.floor(ms / 1000) * 1000) / MINUTE);
}

/** The instant a wall-clock time (minutes after midnight) happens on a day in tz. */
export function zoned(day: string, minutes: number, tz: string): number {
  const [y, m, d] = day.split("-").map(Number);
  const wall = Date.UTC(y, m - 1, d) + minutes * MINUTE;
  const first = wall - offsetAt(wall, tz) * MINUTE;
  return wall - offsetAt(first, tz) * MINUTE;
}

/** The YYYY-MM-DD day an instant falls on in tz. */
export function dayOf(ms: number, tz: string): string {
  return new Date(ms + offsetAt(ms, tz) * MINUTE).toISOString().slice(0, 10);
}

/** Minutes after local midnight of an instant in tz. */
export function minuteOf(ms: number, tz: string): number {
  const local = ms + offsetAt(ms, tz) * MINUTE;
  return Math.floor(((local % DAY) + DAY) % DAY / MINUTE);
}

export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Monday of the day's week. */
export function weekOf(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return addDays(day, -((weekday + 6) % 7));
}

const formatter = (tz: string, options: Intl.DateTimeFormatOptions) => {
  const zone = zoneOr(tz);
  return new Intl.DateTimeFormat(undefined, zone ? { ...options, timeZone: zone } : options);
};

/** "09:10" (or "9:10 AM" where the locale says so). */
export const clock = (ms: number, tz: string) => formatter(tz, { hour: "2-digit", minute: "2-digit" }).format(ms);

/** A day for headings: "Tuesday 4 November". */
export function dayTitle(day: string, options: Intl.DateTimeFormatOptions = { weekday: "long", day: "numeric", month: "long" }) {
  const [y, m, d] = day.split("-").map(Number);
  return new Intl.DateTimeFormat(undefined, { ...options, timeZone: "UTC" }).format(Date.UTC(y, m - 1, d, 12));
}

/** "1h 15m", "45m", "under a minute". */
export function duration(ms: number): string {
  const minutes = Math.round(ms / MINUTE);
  if (minutes < 1) return "under a minute";
  const h = Math.floor(minutes / 60), m = minutes % 60;
  return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}

export interface Span { from: number; to: number }

const ms = (v: string) => new Date(v).valueOf();

/** Overlapping spans merged, earliest first. */
export function union(spans: Span[]): Span[] {
  const sorted = spans.filter(s => s.to > s.from).sort((a, b) => a.from - b.from);
  const out: Span[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.from <= last.to) last.to = Math.max(last.to, s.to);
    else out.push({ ...s });
  }
  return out;
}

/** The parts of a span no other span covers, ignoring slivers under a minute. */
export function subtract(span: Span, covered: Span[]): Span[] {
  const out: Span[] = [];
  let cursor = span.from;
  for (const c of union(covered)) {
    if (c.to <= cursor) continue;
    if (c.from >= span.to) break;
    if (c.from > cursor) out.push({ from: cursor, to: c.from });
    cursor = Math.max(cursor, c.to);
  }
  if (span.to > cursor) out.push({ from: cursor, to: span.to });
  return out.filter(s => s.to - s.from >= MINUTE);
}

const total = (spans: Span[]) => union(spans).reduce((sum, s) => sum + s.to - s.from, 0);

export interface Session extends ActivityEntry { from: number; to: number }

/** Why a stretch hasn't been checked, which decides what the timeline offers. */
export type GapKind = "running" | "next" | "older";
export interface Gap extends Span { kind: GapKind }

export interface DayView {
  day: string;
  start: number;
  end: number;
  sessions: Session[];
  checked: Span[];
  gaps: Gap[];
  /** Time worked: overlapping sessions count once. */
  total: number;
  categories: { id: string; label: string; total: number }[];
  tasks: string[];
  /** The day hasn't started yet, or tracking began after it ended. */
  future: boolean;
  beforeTracking: boolean;
}

/**
 * Everything one day shows: its sessions, what's been checked, and what
 * hasn't. Automatic checks reach back to `autoFrom` (when tracking started,
 * at most the lookback); older unchecked time can be checked on request.
 */
export function dayView(day: string, tz: string, entries: ActivityEntry[], checks: ActivityCheck[], opts: { now: number; since?: string; autoFrom?: number; running?: ActivityWindow[] }): DayView {
  const start = zoned(day, 0, tz), end = zoned(addDays(day, 1), 0, tz);
  const sessions = entries
    .map(e => ({ ...e, from: ms(e.start), to: ms(e.end) }))
    .filter(e => e.from < end && (e.to > start || (e.from === e.to && e.from >= start)))
    .sort((a, b) => a.from - b.from || a.to - b.to);
  const clip = (s: Span) => ({ from: Math.max(s.from, start), to: Math.min(s.to, end) });
  const checked = union(checks.map(c => clip({ from: ms(c.from), to: ms(c.to) })).filter(s => s.to > s.from));
  const since = opts.since ? ms(opts.since) : NaN;
  const running = union((opts.running || []).map(w => clip({ from: ms(w.from), to: ms(w.to) })).filter(s => s.to > s.from));
  // A day before tracking began is just that, until something's on it: a check, a session, or a check running now.
  const beforeTracking = !Number.isNaN(since) && end <= since && !checked.length && !running.length && !sessions.length;
  const until = Math.min(end, opts.now);
  const gaps: Gap[] = [];
  if (until > start && !beforeTracking) {
    const open = subtract({ from: start, to: until }, checked);
    for (const g of open) {
      for (const r of running) {
        const from = Math.max(g.from, r.from), to = Math.min(g.to, r.to);
        if (to - from >= MINUTE) gaps.push({ from, to, kind: "running" });
      }
      const autoFrom = opts.autoFrom ?? -Infinity;
      for (const rest of subtract(g, running)) {
        if (rest.to <= autoFrom) gaps.push({ ...rest, kind: "older" });
        else if (rest.from >= autoFrom) gaps.push({ ...rest, kind: "next" });
        else gaps.push({ from: rest.from, to: autoFrom, kind: "older" }, { from: autoFrom, to: rest.to, kind: "next" });
      }
    }
    gaps.sort((a, b) => a.from - b.from);
  }
  const clipped = sessions.map(s => clip(s));
  const categories = CATEGORIES.map(c => ({ id: c.id, label: c.label, total: total(sessions.filter(s => categoryOf(s.category).id === c.id).map(clip)) })).filter(c => c.total > 0);
  return {
    day, start, end, sessions, checked, gaps,
    total: total(clipped),
    categories,
    tasks: [...new Set(sessions.map(s => s.taskId).filter(Boolean))],
    future: start > opts.now,
    beforeTracking,
  };
}

export interface TaskDay { day: string; total: number; sessions: Session[] }
export interface TaskTime {
  /** Time worked: overlapping sessions count once. */
  total: number;
  sessions: number;
  /** Newest first, each with its sessions newest first. A session belongs to the day it started. */
  days: TaskDay[];
  categories: { id: string; label: string; total: number }[];
}

/** The time spent on a task, from its sessions, by day and by kind of work. */
export function taskTime(entries: ActivityEntry[], tz: string): TaskTime {
  const sessions = entries.map(e => ({ ...e, from: ms(e.start), to: ms(e.end) })).sort((a, b) => b.from - a.from || b.to - a.to);
  const days: TaskDay[] = [];
  for (const s of sessions) {
    const day = dayOf(s.from, tz);
    let last = days[days.length - 1];
    if (!last || last.day !== day) days.push(last = { day, total: 0, sessions: [] });
    last.sessions.push(s);
  }
  for (const d of days) d.total = total(d.sessions);
  const categories = CATEGORIES.map(c => ({ id: c.id, label: c.label, total: total(sessions.filter(s => categoryOf(s.category).id === c.id)) })).filter(c => c.total > 0);
  return { total: total(sessions), sessions: sessions.length, days, categories };
}

/** The first days to show, whole, until they hold at least `count` sessions. */
export function firstDays(days: TaskDay[], count: number): TaskDay[] {
  const out: TaskDay[] = [];
  let shown = 0;
  for (const d of days) {
    if (shown >= count) break;
    out.push(d);
    shown += d.sessions.length;
  }
  return out;
}

/** The hours a day's ribbon spans: at least 08:00–20:00, widened to fit the day's sessions and now. */
export function ribbonHours(view: DayView, tz: string, now: number): [number, number] {
  let first = 8, last = 20;
  const hour = (t: number) => minuteOf(t, tz) / 60;
  for (const s of view.sessions) {
    if (s.from >= view.start) first = Math.min(first, Math.floor(hour(s.from)));
    else first = 0;
    if (s.to < view.end) last = Math.max(last, Math.ceil(hour(s.to) || 0.01));
    else last = 24;
  }
  if (now > view.start && now < view.end) last = Math.max(last, Math.ceil(hour(now) + 0.01));
  return [Math.max(0, first), Math.min(24, last)];
}

/** Lanes for overlapping sessions on the ribbon: the first lane with room, up to three. */
export function lanes(sessions: Span[]): number[] {
  const ends: number[] = [];
  return sessions.map(s => {
    let lane = ends.findIndex(end => end <= s.from);
    if (lane < 0) lane = ends.length < 3 ? ends.length : ends.indexOf(Math.min(...ends));
    ends[lane] = Math.max(s.to, s.from + MINUTE);
    return lane;
  });
}

export type Part = "night" | "morning" | "afternoon" | "evening";
export const PARTS: Record<Part, string> = { night: "Early hours", morning: "Morning", afternoon: "Afternoon", evening: "Evening" };
export function partOf(minute: number): Part {
  if (minute < 5 * 60) return "night";
  if (minute < 12 * 60) return "morning";
  if (minute < 17 * 60) return "afternoon";
  return "evening";
}

export type Row =
  | { kind: "session"; key: string; at: number; session: Session }
  | { kind: "gap"; key: string; at: number; gap: Gap }
  | { kind: "quiet"; key: string; at: number; span: Span };

export interface Section { part: Part; rows: Row[]; total: number }

/** Quiet checked stretches at least this long get a marker on the rail. */
const QUIET = 75 * MINUTE;

/** The feed, most recent first: sessions and unchecked stretches split by part of day, with long quiet stretches marked. */
export function sections(view: DayView, tz: string): Section[] {
  const items: Exclude<Row, { kind: "quiet" }>[] = [
    ...view.sessions.map(s => ({ kind: "session" as const, key: s.id, at: Math.max(s.from, view.start), session: s })),
    // A check in progress isn't part of the day's story; the feed shows it on top, above the sessions it's adding.
    ...view.gaps.filter(g => g.kind !== "running").map(g => ({ kind: "gap" as const, key: `gap:${g.kind}:${g.from}`, at: g.from, gap: g })),
  ].sort((a, b) => a.at - b.at || (a.kind === "gap" ? 1 : -1));
  const rows: Row[] = [];
  let reach = -Infinity;
  for (const item of items) {
    // Only a checked stretch is quiet; an unchecked one is a gap row of its own.
    if (reach > -Infinity && item.at - reach >= QUIET && rows[rows.length - 1]?.kind === "session" && !subtract({ from: reach, to: item.at }, view.checked).length) {
      rows.push({ kind: "quiet", key: `quiet:${reach}`, at: reach, span: { from: reach, to: item.at } });
    }
    rows.push(item);
    const to = item.kind === "session" ? Math.min(item.session.to, view.end) : item.gap.to;
    reach = Math.max(reach, to);
  }
  // Built oldest first so quiet stretches fall between the right rows, then read newest first.
  const out: Section[] = [];
  for (const row of rows.reverse()) {
    const part = partOf(minuteOf(row.at, tz));
    let section = out[out.length - 1];
    if (!section || section.part !== part) out.push(section = { part, rows: [], total: 0 });
    section.rows.push(row);
  }
  for (const section of out) {
    section.total = total(section.rows.flatMap(r => r.kind === "session" ? [{ from: Math.max(r.session.from, view.start), to: Math.min(r.session.to, view.end) }] : []));
  }
  return out;
}

/** The next time a schedule runs, as "17:30" today, or "Tomorrow 12:30". */
export function nextCheckLabel(nextRun: string, tz: string, now: number): string {
  const at = ms(nextRun);
  if (Number.isNaN(at)) return "";
  const today = dayOf(now, tz), day = dayOf(at, tz);
  const time = clock(at, tz);
  if (day === today) return time;
  if (day === addDays(today, 1)) return "tomorrow " + time;
  return dayTitle(day, { weekday: "short", day: "numeric", month: "short" }) + " " + time;
}

/** How much of a day has been checked, in a few words. */
export function coverageLabel(view: DayView, tz: string, now: number): string {
  if (view.gaps.some(g => g.kind === "running") && !view.checked.length) return "Checking now";
  if (!view.checked.length) return view.future ? "" : "Not checked yet";
  const last = view.checked[view.checked.length - 1];
  const reach = Math.min(view.end, now);
  if (!view.gaps.length || view.gaps.every(g => g.kind === "running")) {
    return reach < view.end ? "Checked until " + clock(last.to, tz) : "Whole day checked";
  }
  if (view.checked.length === 1) return last.to >= view.end ? "Checked from " + clock(last.from, tz) : `Checked ${clock(last.from, tz)}–${clock(last.to, tz)}`;
  return "Partly checked";
}

/** A stretch of the day in words: "Whole day", "09:00–now", "18:30–midnight", "09:00–12:30". Time before tracking began ends at a clock time, never "now". */
export function spanLabel(span: Span & { kind?: GapKind }, view: DayView, tz: string, now: number): string {
  if (span.from <= view.start && span.to >= view.end) return "Whole day";
  const end = span.to >= now - MINUTE && span.kind !== "older" ? "now" : span.to >= view.end ? "midnight" : clock(span.to, tz);
  return `${clock(span.from, tz)}–${end}`;
}
