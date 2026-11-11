import { useState, type ReactNode } from "react";
import {
  IconCheck as Check,
  IconClockPlay as JobIcon,
  IconMessage2 as CommentIcon,
  IconRobot as Robot,
} from "@tabler/icons-react";
import { AgentMarkdown } from "./AgentMarkdown";
import { actorName, type Who } from "./AgentBadge";
import { MonoMark } from "./shared";
import { Button } from "./ui/button";
import { friendlyTime } from "../api";
import type { Column, Entity, HistoryEntry, Job, Task } from "../types";

export interface ActivityLookups {
  columns: Column[];
  projects: Entity[];
  tags: Entity[];
  jobs: Job[];
}

/** "Just now", "12 min ago", "Today, 21:57", "Yesterday, 09:10", "3 Nov, 21:57". */
export function whenLabel(at: string, now = new Date()): string {
  const d = new Date(at);
  if (Number.isNaN(d.valueOf())) return at;
  const seconds = (now.valueOf() - d.valueOf()) / 1000;
  if (seconds >= 0 && seconds < 60) return "Just now";
  if (seconds >= 0 && seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  const time = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(d);
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).valueOf();
  const days = Math.round((day(now) - day(d)) / 86400000);
  if (days === 0) return `Today, ${time}`;
  if (days === 1) return `Yesterday, ${time}`;
  const date = new Intl.DateTimeFormat(undefined, d.getFullYear() === now.getFullYear() ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" }).format(d);
  return `${date}, ${time}`;
}

const priorityNames: Record<string, string> = { urgent: "Urgent", high: "High priority", medium: "Medium priority", low: "Low priority" };
const shortDate = (value: string) => {
  const d = new Date(value.length === 10 ? value + "T00:00:00" : value);
  return Number.isNaN(d.valueOf()) ? value : new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" }).format(d);
};

/** What a task change did, as short phrases: "Moved to Done", "High priority", "Due 14 Nov". */
export function describeChange(before: Task | undefined, after: Task | undefined, lookups: ActivityLookups): string[] {
  if (!before || !after) return [];
  const out: string[] = [];
  const named = (list: Entity[], id: string) => list.find(e => e.id === id)?.name || id;
  if (!before.deletedAt && after.deletedAt) out.push("Deleted");
  if (before.deletedAt && !after.deletedAt) out.push("Restored");
  if (!before.mergedInto && after.mergedInto) out.push("Merged into another task");
  if (!before.archivedAt && after.archivedAt) out.push("Archived");
  if (before.archivedAt && !after.archivedAt) out.push("Unarchived");
  if (before.status !== after.status) out.push("Moved to " + (lookups.columns.find(c => c.id === after.status)?.name || after.status));
  if (before.title !== after.title) out.push("Renamed");
  if (before.priority !== after.priority) out.push(priorityNames[after.priority] || "No priority");
  if (before.dueDate !== after.dueDate) out.push(after.dueDate ? "Due " + shortDate(after.dueDate) : "No due date");
  if (before.snoozedUntil !== after.snoozedUntil) out.push(after.snoozedUntil ? "Snoozed until " + shortDate(after.snoozedUntil) : "Unsnoozed");
  if (before.project !== after.project) out.push(after.project ? "Project: " + named(lookups.projects, after.project) : "No project");
  const was = new Set(before.tags || []), now = new Set(after.tags || []);
  for (const t of now) if (!was.has(t)) out.push("Tagged " + named(lookups.tags, t));
  for (const t of was) if (!now.has(t)) out.push("Untagged " + named(lookups.tags, t));
  if (before.parentId !== after.parentId) out.push(after.parentId ? "Made a subtask" : "Made top-level");
  if (before.description !== after.description) out.push("Edited description");
  if (JSON.stringify(before.checklist || []) !== JSON.stringify(after.checklist || [])) {
    const list = after.checklist || [];
    out.push(list.length ? `Checklist ${list.filter(i => i.done).length}/${list.length}` : "Cleared checklist");
  }
  const images = (after.attachments || []).length - (before.attachments || []).length;
  if (images > 0) out.push(images === 1 ? "Added an image" : `Added ${images} images`);
  if (images < 0) out.push(images === -1 ? "Removed an image" : `Removed ${-images} images`);
  if (before.icon !== after.icon) out.push("Changed icon");
  if (before.agentChange && !after.agentChange) out.push("Reviewed");
  return out;
}

function Avatar({ who }: { who: Who }) {
  return (
    <span className={"activity-avatar " + who.kind} aria-hidden>
      {who.kind === "sift" ? <MonoMark size={11} /> : who.kind === "job" ? <JobIcon size={14} /> : who.kind === "agent" ? <Robot size={14} /> : (who.name[0] || "?").toUpperCase()}
    </span>
  );
}

const MAX_PILLS = 6;

/** A task's history, newest first: comments as notes, changes as pills. */
export function Activity({ history, lookups, undo, now }: { history: HistoryEntry[]; lookups: ActivityLookups; undo?: (entry: HistoryEntry) => ReactNode; now?: Date }) {
  if (!history.length) return null;
  return (
    <ol className="activity" aria-label="Task activity">
      {[...history].reverse().map(h => {
        const who = actorName(h.actor, lookups.jobs);
        const comment = h.kind === "comment", review = h.kind === "review";
        const pills = comment || review ? [] : describeChange(h.before, h.after, lookups);
        const shown = pills.slice(0, MAX_PILLS);
        // A review names whose change was looked at; its reason holds that agent.
        const summary = comment ? "" : review ? `Reviewed ${actorName(h.reason, lookups.jobs).name}’s change` : !h.before ? "Created this task" : !pills.length && !h.reason ? "Updated this task" : "";
        return (
          <li key={h.id} className={"activity-entry" + (comment ? " is-comment" : "")}>
            <Avatar who={who} />
            <div className="activity-main">
              <div className="activity-head">
                <strong className="activity-actor" title={h.actor}>{who.name}</strong>
                {comment ? <span className="activity-pill comment"><CommentIcon size={12} aria-hidden />Comment</span> : summary && <span className="activity-summary">{summary}</span>}
                <time dateTime={h.at} title={friendlyTime(h.at)}>{whenLabel(h.at, now)}</time>
              </div>
              {shown.length > 0 && (
                <ul className="activity-pills" aria-label="Changes">
                  {shown.map((p, i) => <li key={i + p} className="activity-pill">{p}</li>)}
                  {pills.length > shown.length && <li className="activity-pill more">+{pills.length - shown.length} more</li>}
                </ul>
              )}
              {comment
                ? <div className="activity-comment"><AgentMarkdown text={h.reason} /></div>
                : !review && h.reason && <p className="activity-reason">{h.reason}</p>}
            </div>
            {undo && h.kind === "task" && <div className="activity-undo">{undo(h)}</div>}
          </li>
        );
      })}
    </ol>
  );
}

/** The agent's status change behind a task's AI badge: its latest status change by that agent. */
export function agentStatusChange(task: Task, history: HistoryEntry[]) {
  return [...history].reverse().find(h => h.kind === "task" && h.actor === task.agentChange && h.before && h.after && h.before.status !== h.after.status);
}

/** One quiet line in a task's details: what the agent did, with Looks good and, while it's still the latest change, Undo. */
export function AgentReview({ task, history, lookups, onReviewed, undo }: {
  task: Task; history: HistoryEntry[]; lookups: ActivityLookups;
  onReviewed: () => Promise<unknown>; undo?: (entry: HistoryEntry) => ReactNode;
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const change = agentStatusChange(task, history);
  const who = actorName(task.agentChange || "", lookups.jobs).name;
  const status = change?.after?.status ?? task.status;
  const column = lookups.columns.find(c => c.id === status)?.name || status;
  return (
    <div className="agent-review">
      <span className="agent-badge" aria-hidden="true">AI</span>
      <p>
        <strong>{who}</strong> moved this to {column}
        {change?.reason ? <>: <span className="agent-review-reason" title={change.reason}>{change.reason}</span></> : "."}
      </p>
      <div className="agent-review-actions">
        {change && undo && change.after?.revision === task.revision && undo(change)}
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={async () => {
          setBusy(true); setError("");
          try { await onReviewed(); }
          catch (e) { setError((e as Error).message); }
          finally { setBusy(false); }
        }}><Check size={14} aria-hidden />Looks good</Button>
      </div>
      {error && <p className="agent-review-error" role="alert">{error}</p>}
    </div>
  );
}
