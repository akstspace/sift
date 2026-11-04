import { useEffect, useState, type CSSProperties } from "react";
import { api } from "../api";
import type { ActivityPage } from "../types";
import { categoryOf, clock, dayOf, dayTitle, duration, union } from "./model";

const SHOWN = 4;

/** Time on a task from My activity: the total, and its latest sessions, each opening its day. */
export function TaskTime({ taskId, cursor, tz, onOpenDay }: { taskId: string; cursor: number; tz: string; onOpenDay?: (day: string) => void }) {
  const [page, setPage] = useState<ActivityPage | null>(null);
  useEffect(() => {
    let live = true;
    api<ActivityPage>("/activity?task=" + encodeURIComponent(taskId)).then(p => live && setPage(p), () => {});
    return () => { live = false; };
  }, [taskId, cursor]);
  const entries = page?.entries || [];
  if (!entries.length) return null;
  const spans = entries.map(e => ({ from: new Date(e.start).valueOf(), to: new Date(e.end).valueOf() }));
  const total = union(spans).reduce((sum, s) => sum + s.to - s.from, 0);
  const latest = [...entries].reverse().slice(0, SHOWN);
  return (
    <section className="task-time" aria-labelledby={"task-time-" + taskId}>
      <div className="section-heading">
        <h3 id={"task-time-" + taskId}>Worked on</h3>
        <span>{total ? duration(total) : ""}{total ? " · " : ""}{entries.length} {entries.length === 1 ? "session" : "sessions"}</span>
      </div>
      <ol className="task-time-list">
        {latest.map(e => {
          const from = new Date(e.start).valueOf(), to = new Date(e.end).valueOf();
          const day = dayOf(from, tz);
          return (
            <li key={e.id}>
              <button type="button" disabled={!onOpenDay} onClick={() => onOpenDay?.(day)} style={{ "--cat": `var(--cat-${categoryOf(e.category).id})` } as CSSProperties}>
                <span className="legend-swatch" aria-hidden />
                <span className="task-time-title">{e.title}</span>
                <span className="task-time-when">{dayTitle(day, { weekday: "short", day: "numeric", month: "short" })} · {clock(from, tz)}{to > from ? "–" + clock(to, tz) : ""}</span>
              </button>
            </li>
          );
        })}
      </ol>
      {entries.length > SHOWN && <p className="task-time-more">{entries.length - SHOWN} earlier {entries.length - SHOWN === 1 ? "session" : "sessions"} on My activity</p>}
    </section>
  );
}
