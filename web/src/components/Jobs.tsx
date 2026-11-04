import { Action } from "./shared";
import { AgentMarkdown } from "./AgentMarkdown";
import { useEffect, useMemo, useRef, useState } from "react";
import { PiErrorDetail, Transcript } from "../transcript/Transcript";
import { describePiError, itemsFromRunEntries, type RunEntry } from "../transcript/model";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { Choice } from "./Choice";
import { SearchChoice, TimezoneChoice } from "./SearchChoice";
import { Checkbox } from "./ui/checkbox";
import {
  IconClock as Clock3,
  IconHistory as History,
  IconLoader2 as LoaderCircle,
  IconPlayerPlay as Play,
  IconPlus as Plus,
  IconRefresh as RefreshCw,
  IconRotate2 as RotateCcw,
  IconSettings as Settings2,
  IconPlayerStop as Square,
  IconTerminal2 as Terminal,
  IconTimeline as Timeline,
  IconTrash as Trash2,
} from "@tabler/icons-react";
import { toast } from "sonner";
import { api, friendlyTime } from "../api";
import type { CatalogIcon, Job, PiInfo, Run, Snapshot, Task } from "../types";
import { Button, Busy, Confirm, Empty, Field } from "./shared";
import { JobSchedules, describeDailyTimes, describeSchedules } from "./JobSchedules";
import { useDraftGuard, useDraftProtection } from "./DraftGuard";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

export function Jobs({
  snapshot,
  refresh,
  create,
  onCreated,
  onRun,
  onOpenActivity,
}: {
  snapshot: Snapshot;
  refresh: () => Promise<void>;
  create: boolean;
  onCreated: () => void;
  onRun: (id: string) => void;
  onOpenActivity?: () => void;
}) {
  // Activity tracking is set up and changed on My activity, not here.
  const tracker = snapshot.jobs.find(j => j.kind === "activity");
  const jobs = snapshot.jobs.filter(j => j !== tracker);
  const [editing, setEditing] = useState<Job | null>(null),
    [busy, setBusy] = useState("");
  const blank = (): Job => ({
    id: "",
    name: "",
    prompt: "",
    directory: "",
    provider: "",
    model: "",
    thinking: "",
    schedules: [{ type: "daily", schedule: "09:00" }],
    timezone: snapshot.settings.timezone,
    enabled: false,
    timeoutMinutes: snapshot.settings.timeoutMinutes,
    sessionId: "",
    nextRun: "",
    lastRun: "",
    pending: false,
    includeImages: false,
    revision: 0,
  });
  useEffect(() => {
    if (create) {
      setEditing(blank());
      onCreated();
    }
  }, [create]);
  const run = async (j: Job) => {
    setBusy(j.id);
    try {
      const r = await api<Run>("/jobs/" + j.id + "/run", "POST", {});
      await refresh();
      onRun(r.id);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  return (
    <div className="page-body jobs-page">
      <header className="page-heading">
        <div>
          <h1>Agents</h1>
          <p>Useful work, on your schedule.</p>
        </div>
        <Button onClick={() => setEditing(blank())}>
          <Plus size={16} />
          New job
        </Button>
      </header>
      <div className="notice">
        <Terminal size={17} />
        <span>
          Jobs use your local Pi, normal tools, and OS permissions. Each job
          keeps its own memory. Nothing runs until you enable it or choose Run
          now.
        </span>
      </div>
      {tracker && (
        <article className="job-row tracker-row">
          <div className={"job-symbol " + (snapshot.runs.some(r => r.jobId === tracker.id && r.status === "running") ? "active" : "")}>
            <Timeline size={21} />
          </div>
          <div className="job-information">
            <div className="job-title">
              <Action onClick={() => onOpenActivity?.()}>{tracker.name}</Action>
              <span className={"status-badge " + (tracker.enabled ? "enabled" : "paused")}>{tracker.enabled ? "Scheduled" : "Paused"}</span>
            </div>
            <p>Writes down what you worked on, {describeDailyTimes(tracker.schedules)}.</p>
          </div>
          <div className="job-controls">
            <Button variant="outline" onClick={() => onOpenActivity?.()}>Open My activity</Button>
          </div>
        </article>
      )}
      {!jobs.length ? (
        <Empty
          icon={Clock3}
          title="A little help, at the right time."
          action={
            <Button onClick={() => setEditing(blank())}>
              <Plus size={16} />
              Set up your first job
            </Button>
          }
        >
          Give an agent a clear prompt, a working directory, and a schedule.
          Sift brings its task changes back here.
        </Empty>
      ) : (
        <div className="jobs-list">
          {jobs.map((j) => {
            const active = snapshot.runs.find(
              (r) => r.jobId === j.id && r.status === "running",
            );
            const last = snapshot.runs
              .filter((r) => r.jobId === j.id)
              .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
            return (
              <article className="job-row" key={j.id}>
                <div className={"job-symbol " + (active ? "active" : "")}>
                  <Terminal size={21} />
                </div>
                <div className="job-information">
                  <div className="job-title">
                    <Action onClick={() => setEditing(j)}>{j.name}</Action>
                    <span
                      className={
                        "status-badge " +
                        (active ? "running" : j.enabled ? "enabled" : "paused")
                      }
                    >
                      {active ? "Running" : j.enabled ? "Scheduled" : "Paused"}
                    </span>
                    {j.pending && (
                      <span className="status-badge">One pending</span>
                    )}
                  </div>
                  <p>{j.prompt}</p>
                  <div className="job-meta">
                    <span>
                      <Clock3 size={13} />
                      {describeSchedules(j.schedules)} · {j.timezone}
                    </span>
                    <span>{j.model || "Pi default model"}</span>
                  </div>
                  <small>
                    {j.enabled
                      ? "Next: " + friendlyTime(j.nextRun)
                      : "Schedule paused"}
                    {last && (
                      <>
                        {" "}
                        · Last run:{" "}
                        <Action
                          className="text-button"
                          onClick={() => onRun(last.id)}
                        >
                          {last.status}
                        </Action>
                      </>
                    )}
                  </small>
                </div>
                <div className="job-controls">
                  {active ? (
                    <Button variant="outline" onClick={() => onRun(active.id)}>
                      <LoaderCircle size={14} className="spin" />
                      View run
                    </Button>
                  ) : (
                    <Button
                      variant="outline"
                      disabled={busy === j.id}
                      onClick={() => run(j)}
                    >
                      <Play size={14} />
                      Run now
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={"Edit " + j.name}
                    onClick={() => setEditing(j)}
                  >
                    <Settings2 size={16} />
                  </Button>
                </div>
              </article>
            );
          })}
        </div>
      )}
      <p className="page-footnote">
        Up to {snapshot.settings.concurrency} jobs can run at once. Each job runs
        one at a time and catches up once after sleep. Failed runs aren’t retried
        automatically.
      </p>
      {editing && (
        <JobEditor
          initial={editing}
          onClose={() => setEditing(null)}
          refresh={refresh}
        />
      )}
    </div>
  );
}
function JobEditor({
  initial,
  onClose,
  refresh,
}: {
  initial: Job;
  onClose: () => void;
  refresh: () => Promise<void>;
}) {
  const [job, setJob] = useState(() => structuredClone(initial)),
    [pi, setPi] = useState<PiInfo | null>(null),
    [loading, setLoading] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const set = <K extends keyof Job>(k: K, v: Job[K]) =>
    setJob((j) => ({ ...j, [k]: v }));
  const { guard } = useDraftGuard();
  const dirty = JSON.stringify(job) !== JSON.stringify(initial);
  useDraftProtection(dirty, busy);
  const close = () => guard(onClose);
  const probeRequest = useRef(0);
  const probe = async (provider = job.provider, model = job.model) => {
    const request = ++probeRequest.current;
    setLoading(true);
    setError("");
    try {
      const info = await api<PiInfo>(
          "/pi?provider=" +
            encodeURIComponent(provider) +
            "&model=" +
            encodeURIComponent(model),
        );
      if (request === probeRequest.current) setPi(info);
    } catch (e) {
      if (request === probeRequest.current) setError((e as Error).message);
    } finally {
      if (request === probeRequest.current) setLoading(false);
    }
  };
  useEffect(() => {
    probe();
    return () => { ++probeRequest.current; };
  }, []);
  const levels = (pi?.thinking.levels || []).map((v) =>
    typeof v === "string"
      ? { id: v, name: v }
      : (v as { id?: string; level?: string; name?: string; label?: string }),
  );
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await api("/jobs", "POST", job);
      await refresh();
      onClose();
      toast.success("Job saved");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(v) => !v && close()}>
      <DialogContent className="job-editor">
        <DialogHeader>
          <DialogTitle>
            {job.id ? "Edit scheduled job" : "Your next helpful agent"}
          </DialogTitle>
          <DialogDescription>
            Choose what the agent should do and when it should run.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={save}>
          <div className="job-editor-scroll">
          <fieldset className="job-editor-fields" disabled={busy}>
            <Field label="Job name">
              <Input
                required
                maxLength={120}
                placeholder="Morning planning"
                value={job.name}
                onChange={(e) => set("name", e.target.value)}
              />
            </Field>
            <Field
              label="Prompt"
              hint="Only ask for sources and actions you intend to authorize. The agent can change tasks automatically; every change is attributed."
            >
              <Textarea
                required
                rows={5}
                placeholder="Review the project in this working directory. Add actionable follow-ups to Sift, checking for duplicates first…"
                value={job.prompt}
                onChange={(e) => set("prompt", e.target.value)}
              />
            </Field>
            <Field
              label="Working directory"
              hint="Absolute local path. Blank uses your home directory."
            >
              <Input
                placeholder="/Users/you/projects/your-project"
                value={job.directory}
                onChange={(e) => set("directory", e.target.value)}
              />
            </Field>
            <div className="form-grid">
              <Field
                label="Model"
                hint="Models available in Pi. If your choice is unavailable, the job stops rather than switching models."
              >
                <SearchChoice
                  searchLabel="Search Pi models"
                  value={
                    job.provider && job.model
                      ? job.provider + "::" + job.model
                      : ""
                  }
                  disabled={loading}
                  onValueChange={(value) => {
                    const [provider = "", model = ""] =
                      value.split("::");
                    set("provider", provider);
                    set("model", model);
                    set("thinking", "");
                    probe(provider, model);
                  }}
                  options={[{ value: "", label: "Pi default model" }, ...(pi?.models || []).map(m => ({ value: m.provider + "::" + m.id, label: m.provider + " / " + (m.name || m.id) })), ...(job.model && !pi?.models?.some(m => m.id === job.model && m.provider === job.provider) ? [{ value: job.provider + "::" + job.model, label: job.provider + " / " + job.model + " (unavailable)" }] : [])]}
                />
              </Field>
              <Field label="Thinking">
                <Choice
                  value={job.thinking}
                  disabled={loading || !pi}
                  onValueChange={v => set("thinking", v)}
                  options={[{ value: "", label: "Pi default" }, ...levels.filter(l => l.id || l.level).map(l => ({ value: (l.id || l.level)!, label: l.label || l.name || l.id || l.level! }))]}
                />
              </Field>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => probe()}
              disabled={loading}
            >
              {loading ? (
                <Busy label="Discovering Pi models" />
              ) : (
                <>
                  <RefreshCw size={13} />
                  Refresh models
                </>
              )}
            </Button>
            <JobSchedules value={job.schedules} onChange={(v) => set("schedules", v)} />
            <div className="form-grid">
              <Field label="Timezone">
                <TimezoneChoice value={job.timezone} onValueChange={v => set("timezone", v)} />
              </Field>
              <Field label="Timeout (minutes)">
                <Input
                  type="number"
                  min="1"
                  max="1440"
                  value={job.timeoutMinutes}
                  onChange={(e) =>
                    set("timeoutMinutes", Number(e.target.value))
                  }
                />
              </Field>
            </div>
            <label className="checkbox-field">
              <Checkbox
                checked={job.includeImages}
                onCheckedChange={(v) => set("includeImages", v === true)}
              />
              <span>
                Include Today’s task images in model input
                <small>
                  Sends up to 8 images (under 5 MB each) to the
                  chosen model.
                </small>
              </span>
            </label>
            <label className="checkbox-field">
              <Checkbox
                checked={job.enabled}
                onCheckedChange={(v) => set("enabled", v === true)}
              />
              <span>
                Run on schedule
                <small>
                  Manual Run now works while scheduling is paused.
                </small>
              </span>
            </label>
            {job.id && (
              <div className="memory-section">
                <div>
                  <strong>Remembered context</strong>
                  <p>
                    Each run remembers this job’s earlier work. Changing the
                    prompt or model keeps that memory.
                  </p>
                </div>
                <Confirm
                  title="Reset job memory"
                  description="The next run starts without this job’s remembered context. Past runs stay available, and existing task changes are not undone."
                  action={async () => {
                    await api("/jobs/" + job.id + "/reset", "POST", {});
                    await refresh();
                    onClose();
                  }}
                >
                  {(open) => (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy || dirty}
                      onClick={open}
                    >
                      <RotateCcw size={14} />
                      Reset
                    </Button>
                  )}
                </Confirm>
              </div>
            )}
            {error && (
              <div className="error" role="alert">
                {error}
              </div>
            )}
          </fieldset>
          </div>
          <DialogFooter>
            {initial.id && (
              <Confirm
                title="Delete job"
                description={`“${initial.name}” stops running and its remembered context is deleted. Past runs stay in Run history.`}
                destructive
                action={async () => {
                  await api("/jobs/" + initial.id + "?revision=" + initial.revision, "DELETE");
                  await refresh();
                  onClose();
                  toast.success("Job deleted");
                }}
              >
                {(open) => (
                  <Button type="button" variant="ghost" className="job-delete" disabled={busy} onClick={open}>
                    <Trash2 size={14} />
                    Delete job
                  </Button>
                )}
              </Confirm>
            )}
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={close}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? <Busy label="Saving" /> : "Save job"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function Runs({
  snapshot,
  selected,
  onSelect,
  refresh,
  catalog = [],
  onOpenTask,
}: {
  snapshot: Snapshot;
  selected: string;
  onSelect: (id: string) => void;
  refresh: () => Promise<void>;
  catalog?: CatalogIcon[];
  onOpenTask?: (task: Task) => void;
}) {
  const [detail, setDetail] = useState<{
      run: Run;
      entries: RunEntry[];
    } | null>(null),
    [error, setError] = useState("");
  const lookups = useMemo(() => ({ tasks: snapshot.tasks, columns: snapshot.columns, projects: snapshot.projects, tags: snapshot.tags }), [snapshot.tasks, snapshot.columns, snapshot.projects, snapshot.tags]);
  const running = detail?.run.status === "running";
  const items = useMemo(() => (detail ? itemsFromRunEntries(detail.entries, running) : []), [detail, running]);
  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    let stopped = false;
    const load = () =>
      api<typeof detail>("/runs/" + selected)
        .then((d) => {
          if (!stopped) setDetail(d);
        })
        .catch((e) => {
          if (!stopped) setError(e.message);
        });
    load();
    const timer = setInterval(load, 1500);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [selected]);
  const sorted = [...snapshot.runs].sort((a, b) =>
    b.startedAt.localeCompare(a.startedAt),
  );
  return (
    <div className="page-body runs-page">
      <header className="page-heading">
        <div>
          <h1>Run history</h1>
          <p>What your agents did, and what needs attention.</p>
        </div>
      </header>
      {!sorted.length ? (
        <Empty icon={History} title="A record of real work.">
          Run a scheduled job to see its live text, tool activity, and outcome
          here. Runs are never invented.
        </Empty>
      ) : (
        <div className={"runs-layout " + (selected ? "has-selection" : "")}>
          <div className="run-list">
            {sorted.map((r) => (
              <Action
                key={r.id}
                className={"run-row " + (selected === r.id ? "selected" : "")}
                onClick={() => {
                  setDetail(null);
                  setError("");
                  onSelect(r.id);
                }}
              >
                <span className={"run-status-dot " + r.status} />
                <div>
                  <strong>{r.jobName}</strong>
                  <span>{friendlyTime(r.startedAt)}</span>
                </div>
                <span className={"status-badge " + r.status}>
                  {r.status.replaceAll("-", " ")}
                </span>
              </Action>
            ))}
          </div>
          <section className="run-detail" aria-label="Run details">
            {selected && (
              <Button
                className="mobile-only"
                variant="ghost"
                onClick={() => onSelect("")}
              >
                Back to runs
              </Button>
            )}
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            {detail ? (
              <>
                <header>
                  <div>
                    <h2>{detail.run.jobName}</h2>
                    <p>
                      {detail.run.model || "Pi default"} ·{" "}
                      {friendlyTime(detail.run.startedAt)}
                    </p>
                  </div>
                  {detail.run.status === "running" ? (
                    <Button
                      variant="outline"
                      onClick={async () => {
                        await api("/runs/" + selected + "/cancel", "POST", {});
                        await refresh();
                      }}
                    >
                      <Square size={13} />
                      Cancel
                    </Button>
                  ) : snapshot.jobs.some((j) => j.id === detail.run.jobId) && (
                    <Button
                      variant="outline"
                      onClick={async () => {
                        try {
                          const r = await api<Run>(
                            "/jobs/" + detail.run.jobId + "/run",
                            "POST",
                            {},
                          );
                          await refresh();
                          onSelect(r.id);
                        } catch (e) {
                          toast.error((e as Error).message);
                        }
                      }}
                    >
                      <Play size={13} />
                      Run again
                    </Button>
                  )}
                </header>
                <div key={detail.run.id} className="run-content" role="region" aria-label="Agent transcript" tabIndex={0} aria-live="off">
                {detail.run.error && (() => {
                  const failure = describePiError(detail.run.error);
                  return (
                    <div className="error" role="alert">
                      {failure.text}
                      {failure.detail && <PiErrorDetail detail={failure.detail} />}
                    </div>
                  );
                })()}
                <div className="run-transcript">
                  <Transcript key={detail.run.id} items={items} lookups={lookups} catalog={catalog} onOpenTask={onOpenTask} onOpenRun={onSelect} live={running} />
                  {!detail.entries.length && (
                    <p className="muted">
                      {detail.run.status === "running"
                        ? "Connecting to local Pi…"
                        : "No detailed log entries are available. Older detailed logs expire according to retention settings."}
                    </p>
                  )}
                </div>
                {detail.run.status === "running" && (
                  <Busy label="Agent working" />
                )}
                {detail.run.summary && detail.run.status !== "running" && (
                  <details>
                    <summary>Retained summary</summary>
                    <AgentMarkdown className="run-summary" text={detail.run.summary} />
                  </details>
                )}
                <div className="task-origin">
                  <span>{detail.run.id}</span>
                  <span>Session: {detail.run.sessionId}</span>
                </div>
                </div>
              </>
            ) : !selected ? (
              <Empty icon={Terminal} title="Choose a run">
                Inspect what happened without leaving your workspace.
              </Empty>
            ) : (
              <Busy label="Loading run" />
            )}
          </section>
        </div>
      )}
    </div>
  );
}
