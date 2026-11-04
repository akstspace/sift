import { useEffect, useId, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  IconArrowBackUp as RestoreIcon,
  IconChevronDown as ChevronDown,
  IconPlus as Plus,
  IconTrash as Trash2,
  IconX as X,
} from "@tabler/icons-react";
import { toast } from "sonner";
import { api } from "../api";
import type { Job, JobSchedule, PiInfo } from "../types";
import { Busy, Button, Confirm, Field } from "../components/shared";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { Switch } from "../components/ui/switch";
import { Checkbox } from "../components/ui/checkbox";
import { SearchChoice } from "../components/SearchChoice";
import { JobSchedules } from "../components/JobSchedules";
import { useDraftGuard, useDraftProtection } from "../components/DraftGuard";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { settle } from "../motion";

export const MAX_CHECKS = 6;

export interface TrackerDraft {
  prompt: string;
  schedules: JobSchedule[];
  provider: string;
  model: string;
  thinking: string;
  enabled: boolean;
  backfill: boolean;
}

export const FALLBACK_TIMES = ["12:30", "17:30", "22:00"];

export function draftFrom(job: Job | null | undefined, defaultPrompt: string, defaultTimes: string[] = FALLBACK_TIMES): TrackerDraft {
  if (job) return { prompt: job.prompt, schedules: job.schedules, provider: job.provider, model: job.model, thinking: job.thinking, enabled: job.enabled, backfill: false };
  return { prompt: defaultPrompt, schedules: defaultTimes.map(t => ({ type: "daily", schedule: t })), provider: "", model: "", thinking: "", enabled: true, backfill: true };
}

/** Daily times sorted and without repeats, so "12:30, 09:00" saves as 09:00 then 12:30. */
export function tidySchedules(list: JobSchedule[]): JobSchedule[] {
  if (!list.every(s => s.type === "daily")) return list;
  return [...new Set(list.map(s => s.schedule).filter(Boolean))].sort().map(schedule => ({ type: "daily", schedule }));
}

export async function saveTracker(draft: TrackerDraft, tracker: Job | null | undefined, timezone: string) {
  return api<Job>("/activity/tracker", "PUT", { ...draft, schedules: tidySchedules(draft.schedules), timezone: tracker?.timezone || timezone, revision: tracker?.revision || 0 });
}

/** Up to six daily check times, as small editable time chips. */
function CheckTimes({ value, onChange, disabled }: { value: JobSchedule[]; onChange: (v: JobSchedule[]) => void; disabled?: boolean }) {
  const id = useId();
  const add = () => {
    const taken = new Set(value.map(v => v.schedule));
    const next = ["09:00", "12:30", "15:00", "17:30", "20:00", "22:00", "07:30"].find(t => !taken.has(t)) || "08:00";
    onChange([...value, { type: "daily", schedule: next }]);
  };
  return (
    <div className="check-times" role="group" aria-labelledby={id}>
      <span id={id} className="sr-only">Daily check times</span>
      <AnimatePresence initial={false}>
        {value.map((s, i) => (
          <motion.span key={i} className="check-time" layout="position" initial={{ opacity: 0, scale: 0.92 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.92, transition: { duration: 0.12 } }} transition={{ duration: 0.22, ease: settle }}>
            <Input type="time" aria-label={`Check ${i + 1}`} value={s.schedule} disabled={disabled} required
              onChange={e => onChange(value.map((v, k) => k === i ? { ...v, schedule: e.target.value } : v))} />
            {value.length > 1 && (
              <button type="button" className="check-time-remove" aria-label={`Remove the ${s.schedule} check`} disabled={disabled} onClick={() => onChange(value.filter((_, k) => k !== i))}>
                <X size={12} aria-hidden />
              </button>
            )}
          </motion.span>
        ))}
      </AnimatePresence>
      {value.length < MAX_CHECKS && (
        <Button type="button" variant="ghost" size="sm" className="check-time-add" disabled={disabled} onClick={add}>
          <Plus size={14} aria-hidden />Add a time
        </Button>
      )}
    </div>
  );
}

/** Pi's models, discovered when the person opens the choice. */
function ModelChoice({ draft, set }: { draft: TrackerDraft; set: (patch: Partial<TrackerDraft>) => void }) {
  const [pi, setPi] = useState<PiInfo | null>(null), [error, setError] = useState(""), [loading, setLoading] = useState(true);
  useEffect(() => {
    let live = true;
    api<PiInfo>("/pi").then(info => live && setPi(info), e => live && setError((e as Error).message)).finally(() => live && setLoading(false));
    return () => { live = false; };
  }, []);
  const current = draft.provider && draft.model ? draft.provider + "::" + draft.model : "";
  return (
    <Field label="Model" hint={error ? "Pi didn’t answer: " + error : "If this model is unavailable, the check stops rather than switching models."}>
      <SearchChoice searchLabel="Search Pi models" disabled={loading} value={current}
        onValueChange={value => { const [provider = "", model = ""] = value.split("::"); set({ provider, model, thinking: "" }); }}
        options={[{ value: "", label: "Pi default model" }, ...(pi?.models || []).map(m => ({ value: m.provider + "::" + m.id, label: m.provider + " / " + (m.name || m.id) })),
          ...(current && !pi?.models?.some(m => m.id === draft.model && m.provider === draft.provider) ? [{ value: current, label: draft.provider + " / " + draft.model + (loading ? "" : " (unavailable)") }] : [])]} />
    </Field>
  );
}

/**
 * What the tracker looks at and when: the prompt (prefilled with Sift's
 * default, restorable), the daily check times, and optionally Pi's model.
 */
export function TrackerFields({ draft, onChange, defaultPrompt, timezone, disabled, compact, isNew }: {
  draft: TrackerDraft;
  onChange: (d: TrackerDraft) => void;
  defaultPrompt: string;
  timezone: string;
  disabled?: boolean;
  compact?: boolean;
  isNew?: boolean;
}) {
  const set = (patch: Partial<TrackerDraft>) => onChange({ ...draft, ...patch });
  const [model, setModel] = useState(!!draft.model);
  const daily = draft.schedules.every(s => s.type === "daily");
  const changed = draft.prompt.trim() !== defaultPrompt.trim();
  return (
    <div className={"tracker-fields" + (compact ? " compact" : "")}>
      <div className="tracker-prompt">
        <Field label="What Sift looks at" hint="Pi reads these with your computer account’s permissions and sends what it finds to your model. Activity is stored in Sift, on this computer.">
          <Textarea rows={compact ? 7 : 10} value={draft.prompt} disabled={disabled} required spellCheck
            onChange={e => set({ prompt: e.target.value })} />
        </Field>
        <AnimatePresence initial={false}>
          {changed && defaultPrompt && (
            <motion.div className="tracker-restore" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, transition: { duration: 0.1 } }}>
              <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => set({ prompt: defaultPrompt })}>
                <RestoreIcon size={14} aria-hidden />Restore default
              </Button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      <div className="tracker-when">
        <div className="tracker-label">
          <strong>When to check</strong>
          <small>Each check covers the time since the last one{timezone ? ` · ${timezone.replaceAll("_", " ")}` : ""}</small>
        </div>
        {daily ? <CheckTimes value={draft.schedules} disabled={disabled} onChange={schedules => set({ schedules })} />
          : <JobSchedules value={draft.schedules} onChange={schedules => set({ schedules })} />}
      </div>
      {!compact && (
        <div className="tracker-model">
          {model ? <ModelChoice draft={draft} set={set} /> : (
            <Button type="button" variant="ghost" size="sm" className="tracker-model-toggle" disabled={disabled} onClick={() => setModel(true)}>
              Uses Pi’s default model<span>Change</span><ChevronDown size={14} aria-hidden />
            </Button>
          )}
        </div>
      )}
      {isNew && (
        <label className="checkbox-field">
          <Checkbox checked={draft.backfill} disabled={disabled} onCheckedChange={v => set({ backfill: v === true })} />
          <span>Fill in today so far<small>The first check starts at midnight instead of now.</small></span>
        </label>
      )}
    </div>
  );
}

/** Activity tracking settings, opened from My activity. */
export function TrackerDialog({ tracker, defaultPrompt, timezone, onClose, refresh }: {
  tracker: Job;
  defaultPrompt: string;
  timezone: string;
  onClose: () => void;
  refresh: () => Promise<void>;
}) {
  const initial = useRef(draftFrom(tracker, defaultPrompt)).current;
  const [draft, setDraft] = useState(initial), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const { guard } = useDraftGuard();
  useDraftProtection(dirty, busy);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError("");
    try {
      await saveTracker(draft, tracker, timezone);
      await refresh();
      onClose();
      toast.success("Activity tracking saved");
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <Dialog open onOpenChange={v => !v && guard(onClose)}>
      <DialogContent className="tracker-dialog">
        <DialogHeader>
          <DialogTitle>Activity tracking</DialogTitle>
          <DialogDescription>Sift uses Pi to write down what you worked on, a few times a day.</DialogDescription>
        </DialogHeader>
        <form onSubmit={save}>
          <div className="tracker-dialog-scroll">
            <label className="tracker-enabled">
              <span><strong>Check on schedule</strong><small>{draft.enabled ? "Sift checks at the times below." : "Paused. Check now still works."}</small></span>
              <Switch checked={draft.enabled} disabled={busy} onCheckedChange={enabled => setDraft(d => ({ ...d, enabled }))} aria-label="Check on schedule" />
            </label>
            <TrackerFields draft={draft} onChange={setDraft} defaultPrompt={defaultPrompt} timezone={tracker.timezone || timezone} disabled={busy} />
            {error && <div className="error" role="alert">{error}</div>}
          </div>
          <DialogFooter>
            <Confirm title="Turn off activity tracking" destructive
              description="Sift stops checking and forgets these settings. What it already recorded stays on My activity."
              action={async () => {
                await api("/jobs/" + tracker.id + "?revision=" + tracker.revision, "DELETE");
                await refresh();
                onClose();
                toast.success("Activity tracking turned off");
              }}>
              {open => <Button type="button" variant="ghost" className="job-delete" disabled={busy} onClick={open}><Trash2 size={14} aria-hidden />Turn off</Button>}
            </Confirm>
            <Button type="button" variant="outline" disabled={busy} onClick={() => guard(onClose)}>Cancel</Button>
            <Button type="submit" disabled={busy || !dirty}>{busy ? <Busy label="Saving" /> : "Save"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
