import { useEffect, useRef, useState } from "react";
import { IconCircleArrowUp as ArrowUp, IconExternalLink as ExternalLink, IconRotateClockwise as Restart } from "@tabler/icons-react";
import { api } from "../api";
import { Button, Busy } from "./shared";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

export interface UpdateStatus {
  current: string;
  latest: string;
  available: boolean;
  url: string;
  error: string;
  checkedAt: string;
  installed?: string;
  restartRequired: boolean;
}

const plain = (version: string) => version.replace(/^v/, "");
export const RECHECK_MS = 30 * 60 * 1000, RESTART_POLL_MS = 800, RESTART_GIVE_UP_MS = 90 * 1000;
/** Settings dispatches this after installing, so the notice switches to "Restart" at once. */
export const UPDATE_CHANGED = "sift:update-changed";
export const page = { reload: () => window.location.reload() };

/**
 * Shows only when there is something to do: a newer stable release, or an
 * installed one waiting for a restart. Installing backs up the workspace first;
 * restarting reloads this page once the new Sift is serving.
 */
export function UpdateNotice({ version, runningAgents }: { version: string; runningAgents: number }) {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<"" | "install" | "restart">("");
  const [error, setError] = useState("");
  const polling = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => api<UpdateStatus>("/update").then(value => { if (live) setStatus(value); }).catch(() => {});
    load();
    const timer = setInterval(load, RECHECK_MS);
    window.addEventListener(UPDATE_CHANGED, load);
    return () => { live = false; clearInterval(timer); window.removeEventListener(UPDATE_CHANGED, load); if (polling.current) clearTimeout(polling.current); };
  }, []);
  if (!status || (!status.available && !status.restartRequired)) return null;
  const pending = status.restartRequired;
  const target = plain(pending && status.installed ? status.installed : status.latest);
  const install = async () => {
    setBusy("install"); setError("");
    try {
      await api("/update/apply", "POST", {});
      setStatus(s => s && { ...s, installed: s.latest, restartRequired: true });
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(""); }
  };
  const restart = async () => {
    setBusy("restart"); setError("");
    try { await api("/restart", "POST", {}); }
    catch (e) { setError((e as Error).message); setBusy(""); return; }
    // The restarted process issues a new local session, so this page's session
    // stops being accepted: that (or a new version) means Sift is back.
    const giveUp = Date.now() + RESTART_GIVE_UP_MS;
    const poll = async () => {
      try {
        const response = await fetch("/api/health", { cache: "no-store" });
        if (response.status === 401 || (response.ok && (await response.json()).version !== version)) { page.reload(); return; }
      } catch { /* Not listening yet while the process restarts. */ }
      if (Date.now() > giveUp) {
        setBusy("");
        setError("Sift hasn’t come back yet. If you started it from a terminal, run sift serve again.");
        return;
      }
      polling.current = setTimeout(poll, RESTART_POLL_MS);
    };
    polling.current = setTimeout(poll, RESTART_POLL_MS);
  };
  const label = busy === "restart" ? "Restarting Sift" : pending ? `Restart to finish updating to ${target}` : `Sift ${target} is available`;
  return <Popover open={open} onOpenChange={value => { if (busy !== "restart") setOpen(value); }}>
    <PopoverTrigger asChild>
      <Button variant="plain" className="update-notice" aria-label={label}>
        {busy === "restart" ? <Restart size={16} className="spin" /> : <ArrowUp size={16} />}
        <span>{busy === "restart" ? "Restarting…" : pending ? "Restart to update" : "Update available"}</span>
        {busy !== "restart" && <small>{target}</small>}
      </Button>
    </PopoverTrigger>
    <PopoverContent align="end" sideOffset={8} className="update-panel" aria-label="Sift update">
      <h2>{pending ? `Sift ${target} is installed` : `Sift ${target} is available`}</h2>
      <p>
        {pending
          ? "Restart Sift to start using it. This page reloads on its own; schedules pause for a moment."
          : `You’re on ${plain(version)}. Your workspace is backed up before anything changes, and nothing restarts until you choose.`}
      </p>
      {status.url && <a href={status.url} target="_blank" rel="noreferrer">What’s new<ExternalLink size={12} aria-hidden="true" /></a>}
      {runningAgents > 0 && <p>{runningAgents === 1 ? "An agent is" : `${runningAgents} agents are`} running. {pending ? "Restart" : "Install"} once {runningAgents === 1 ? "it finishes" : "they finish"}, or cancel {runningAgents === 1 ? "it" : "them"} first.</p>}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="button-row">
        {busy !== "restart" && <Button type="button" variant="ghost" size="sm" disabled={!!busy} onClick={() => setOpen(false)}>Later</Button>}
        {pending
          ? <Button type="button" size="sm" disabled={!!busy || runningAgents > 0} onClick={restart}>{busy === "restart" ? <Busy label="Restarting" /> : <><Restart size={14} />Restart now</>}</Button>
          : <Button type="button" size="sm" disabled={!!busy || runningAgents > 0} onClick={install}>{busy === "install" ? <Busy label="Installing" /> : <><ArrowUp size={14} />Install update</>}</Button>}
      </div>
    </PopoverContent>
  </Popover>;
}
