import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "../api";
import type { ActivityEntry, CatalogIcon, Task } from "../types";
import { Busy, Button, Field } from "../components/shared";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { Choice } from "../components/Choice";
import { DateChoice } from "../components/DateChoice";
import { SearchChoice } from "../components/SearchChoice";
import { useDraftGuard, useDraftProtection } from "../components/DraftGuard";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { CATEGORIES, addDays, dayOf, dayTitle, dayView, minuteOf, zoned } from "./model";

const HOUR = 3_600_000;

/** A new half-hour session: ending now on today, or at 10:00 on an earlier day. */
export function blankEntry(day: string, today: string, now: number, tz: string, taskId = ""): ActivityEntry {
  const end = day === today ? now : new Date(dayView(day, tz, [], [], { now }).start + 10 * HOUR).valueOf();
  const start = end - HOUR / 2;
  return { id: "", start: new Date(start).toISOString(), end: new Date(end).toISOString(), title: "", summary: "", category: "code", source: "", link: "", taskId, sourceKey: "", actor: "user", createdAt: "", updatedAt: "", revision: 0 };
}

const hhmm = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
const minutes = (v: string) => { const [h, m] = v.split(":").map(Number); return h * 60 + m; };

/** Add or correct one session, in the person's timezone. It opens on the day the session starts (a new one's default half hour can begin the evening before). */
export function SessionEditor({ entry, tz, now, tasks, onClose, refresh }: {
  entry: ActivityEntry;
  tz: string;
  now: number;
  tasks: Task[];
  catalog: CatalogIcon[];
  onClose: () => void;
  refresh: () => Promise<void>;
}) {
  const initial = useRef({
    title: entry.title, summary: entry.summary, category: entry.category || "other", link: entry.link, taskId: entry.taskId,
    day: dayOf(new Date(entry.start).valueOf(), tz),
    start: hhmm(minuteOf(new Date(entry.start).valueOf(), tz)), end: hhmm(minuteOf(new Date(entry.end).valueOf(), tz)),
  }).current;
  const [draft, setDraft] = useState(initial), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const set = (patch: Partial<typeof draft>) => setDraft(d => ({ ...d, ...patch }));
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  // Closing asks only about this session's draft, not about a task being edited behind it.
  const scope = useDraftProtection(dirty, busy);
  const { guard } = useDraftGuard();
  const close = () => guard(onClose, scope);
  const form = useRef<HTMLFormElement>(null);
  const options = useMemo(() => {
    // A session keeps its link to a task merged, deleted or archived since; it stays the choice until changed.
    const linked = tasks.find(t => t.id === entry.taskId && (t.deletedAt || t.mergedInto || t.archivedAt));
    const kept = linked ? [{ value: linked.id, label: linked.title + (linked.mergedInto ? " (merged)" : linked.deletedAt ? " (deleted)" : " (archived)") }] : [];
    return [{ value: "", label: "No task" }, ...kept, ...tasks.filter(t => !t.deletedAt && !t.mergedInto && !t.archivedAt).map(t => ({ value: t.id, label: t.title + (t.status === "done" ? " (done)" : "") }))];
  }, [tasks, entry.taskId]);
  const today = dayOf(now, tz);
  // A session that ends earlier on the clock than it starts runs past midnight.
  const startDay = draft.day, endDay = minutes(draft.end) < minutes(draft.start) ? addDays(startDay, 1) : startDay;
  // One save at a time, whichever way it was asked for: the button, Enter, or ⌘/Ctrl+Enter.
  const saving = useRef(false);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    // Opened from a task, the editor sits inside the task's form in React's tree; its submit stays here.
    e.stopPropagation();
    if (saving.current || (entry.id && !dirty)) return;
    saving.current = true;
    setBusy(true); setError("");
    try {
      const start = zoned(startDay, minutes(draft.start), tz), end = zoned(endDay, minutes(draft.end), tz);
      if (end > now + 60_000) throw Error("A session can’t end in the future.");
      const next = { ...entry, title: draft.title, summary: draft.summary, category: draft.category, link: draft.link, taskId: draft.taskId, start: new Date(start).toISOString(), end: new Date(end).toISOString(), source: entry.source || (entry.id ? "" : "you") };
      await api(entry.id ? "/activity/" + entry.id : "/activity", entry.id ? "PUT" : "POST", { entry: next, expectedRevision: entry.revision });
      await refresh();
      onClose();
      toast.success(entry.id ? "Activity updated" : "Activity added");
    } catch (err) { setError((err as Error).message); }
    finally { saving.current = false; setBusy(false); }
  };
  return (
    <Dialog open onOpenChange={v => !v && close()}>
      <DialogContent className="session-editor" onKeyDown={e => {
        // ⌘/Ctrl+Enter saves this session, as it saves a task in the task panel, and goes no further.
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); e.stopPropagation(); form.current?.requestSubmit(); }
      }}>
        <DialogHeader>
          <DialogTitle>{entry.id ? "Edit activity" : "Add activity"}</DialogTitle>
          <DialogDescription>{dayTitle(draft.day)}{entry.id && entry.actor !== "user" ? ". Once you edit it, checks leave it as you wrote it." : ""}</DialogDescription>
        </DialogHeader>
        <form ref={form} onSubmit={save}>
          <div className="session-editor-scroll">
            <fieldset className="session-editor-fields" disabled={busy}>
              <Field label="What you did">
                <Input required maxLength={200} autoFocus placeholder="Reviewed the onboarding PR" value={draft.title} onChange={e => set({ title: e.target.value })} />
              </Field>
              <div className="form-grid session-editor-times">
                <Field label="Day"><DateChoice required max={today} value={draft.day} onValueChange={day => set({ day })} /></Field>
                <Field label="From"><Input type="time" required value={draft.start} onChange={e => set({ start: e.target.value })} /></Field>
                <Field label="To" hint={endDay !== startDay ? "Ends the next day" : undefined}><Input type="time" required value={draft.end} onChange={e => set({ end: e.target.value })} /></Field>
              </div>
              <div className="form-grid">
                <Field label="Kind of work">
                  <Choice value={draft.category} onValueChange={category => set({ category })} options={CATEGORIES.map(c => ({ value: c.id, label: c.label }))} />
                </Field>
                <Field label="Task">
                  <SearchChoice searchLabel="Search tasks" value={draft.taskId} onValueChange={taskId => set({ taskId })} options={options} placeholder="No task" />
                </Field>
              </div>
              <Field label="Details" hint="Markdown works here.">
                <Textarea rows={3} maxLength={4000} value={draft.summary} onChange={e => set({ summary: e.target.value })} />
              </Field>
              <Field label="Link">
                <Input type="url" placeholder="https://" value={draft.link} onChange={e => set({ link: e.target.value })} />
              </Field>
              {error && <div className="error" role="alert">{error}</div>}
            </fieldset>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={close}>Cancel</Button>
            <Button type="submit" disabled={busy || (!!entry.id && !dirty)}>{busy ? <Busy label="Saving" /> : entry.id ? "Save" : "Add"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
