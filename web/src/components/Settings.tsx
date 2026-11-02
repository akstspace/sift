import { useEffect, useRef, useState } from "react";
import { Input } from "./ui/input";
import { Choice } from "./Choice";
import { TimezoneChoice } from "./SearchChoice";
import { Checkbox } from "./ui/checkbox";
import {
  IconDownload as ArrowDownToLine,
  IconUpload as ArrowUpFromLine,
  IconBell as Bell,
  IconCheck as Check,
  IconDownload as Download,
  IconExternalLink as ExternalLink,
  IconDatabase as HardDrive,
  IconPlus as Plus,
  IconRefresh as RefreshCw,
  IconShieldCheck as ShieldCheck,
  IconTerminal2 as Terminal,
  IconTrash as Trash2,
} from "@tabler/icons-react";
import { toast } from "sonner";
import { api, friendlyTime } from "../api";
import type { Column, Settings as SettingsType, Snapshot } from "../types";
import { Button, Busy, Confirm, CopyButton, Field } from "./shared";
import { InstallApp } from "./InstallApp";
import { TagManager } from "./Organization";
import { UPDATE_CHANGED, type UpdateResult } from "./UpdateNotice";
import { useDraftGuard, useDraftProtection } from "./DraftGuard";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "./ui/alert-dialog";

interface Update {
  current: string;
  latest: string;
  available: boolean;
  url: string;
  error: string;
  checkedAt: string;
  installed?: string;
  restartRequired?: boolean;
}
export function Settings({
  snapshot,
  refresh,
  onSettings,
  onOnboard,
}: {
  snapshot: Snapshot;
  refresh: () => Promise<void>;
  onSettings: (s: SettingsType) => Promise<void>;
  onOnboard: () => void;
}) {
  const [draft, setDraft] = useState(snapshot.settings),
    [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [result, setResult] = useState(""),
    [health, setHealth] = useState<{
      storage: { ready: boolean; error: string; version: string };
      dataDir: string;
      piPath: string;
    } | null>(null),
    [backups, setBackups] = useState<
      { name: string; size: number; at: string }[]
    >([]),
    [update, setUpdate] = useState<Update | null>(null),
    [column, setColumn] = useState(""),
    [move, setMove] = useState<Record<string, string>>({}),
    [names, setNames] = useState<Record<string, string>>({}),
    [restoreFile, setRestoreFile] = useState<File | null>(null);
  const restore = useRef<HTMLInputElement>(null);
  const { guard } = useDraftGuard();
  // Server-maintained backup timestamps are not unsaved user preferences.
  const preferenceKeys: (keyof SettingsType)[] = ["theme", "timezone", "concurrency", "timeoutMinutes", "checkUpdates", "desktopNotifications", "backupRetention", "trashRetentionDays", "logRetentionDays", "autoArchiveDays"];
  const preferencesDirty = preferenceKeys.some(key => draft[key] !== snapshot.settings[key]);
  const dirty = preferencesDirty || !!column.trim() || snapshot.columns.some(c => names[c.id] !== undefined && names[c.id] !== c.name);
  useDraftProtection(dirty, !!busy);
  const previousSettings = useRef(snapshot.settings);
  useEffect(() => {
    const previous = previousSettings.current;
    previousSettings.current = snapshot.settings;
    setDraft(current => {
      const next = { ...snapshot.settings };
      for (const key of preferenceKeys) {
        if (current[key] !== previous[key]) Object.assign(next, { [key]: current[key] });
      }
      return next;
    });
  }, [snapshot.settings]);
  useEffect(() => {
    api<typeof health>("/health")
      .then(setHealth)
      .catch(() => {});
    api<typeof backups>("/backups")
      .then(setBackups)
      .catch(() => {});
    api<Update>("/update")
      .then(setUpdate)
      .catch(() => {});
  }, []);
  const action = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError("");
    setResult("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  const set = <K extends keyof SettingsType>(key: K, value: SettingsType[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));
  const setup = async (key: string, overwrite = false) => {
    const r = await api<{ note?: string; path: string; installed: boolean }>(
      "/setup/" + key,
      "POST",
      { overwrite },
    );
    if (!r.installed) throw Error(r.note || "Setup was not completed. No existing installation was changed.");
    setResult(
      "Installed: " + r.path +
        (r.note ? " · " + r.note : ""),
    );
  };
  const notify = async () => {
    if (!("Notification" in window))
      throw Error("Desktop notifications are not available in this browser.");
    const permission = await window.Notification.requestPermission();
    if (permission !== "granted")
      throw Error(
        "Notifications were not allowed. You can enable them in browser settings.",
      );
    set("desktopNotifications", true);
  };
  return (
    <div className="page-body settings-page">
      <header className="page-heading">
        <div>
          <h1>Settings</h1>
          <p>Local tools. Deliberate choices.</p>
        </div>
        <Button variant="outline" onClick={() => guard(onOnboard)}>
          Revisit setup
        </Button>
      </header>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {result && (
        <div className="notice success" role="status">
          <Check size={16} />
          {result}
        </div>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          action("save", async () => {
            await onSettings(draft);
            toast.success("Preferences saved");
          });
        }}
      >
        <section className="settings-section">
          <div>
            <h2>Your workspace</h2>
            <p>Appearance, daily boundaries, and agent limits.</p>
          </div>
          <div className="settings-controls">
            <div className="form-grid">
              <Field label="Appearance">
                <Choice value={draft.theme} onValueChange={v => set("theme", v)} options={[{ value: "system", label: "Follow system" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} />
              </Field>
              <Field label="Timezone">
                <TimezoneChoice value={draft.timezone} onValueChange={v => set("timezone", v)} />
              </Field>
              <Field label="Parallel jobs">
                <Input
                  type="number"
                  min={1}
                  max={16}
                  value={draft.concurrency}
                  onChange={(e) => set("concurrency", +e.target.value)}
                />
              </Field>
              <Field label="Default timeout (minutes)">
                <Input
                  type="number"
                  min={1}
                  max={1440}
                  value={draft.timeoutMinutes}
                  onChange={(e) => set("timeoutMinutes", +e.target.value)}
                />
              </Field>
            </div>
            <label className="checkbox-field">
              <Checkbox
                checked={draft.checkUpdates}
                onCheckedChange={(v) => set("checkUpdates", v === true)}
              />
              <span>
                Check for Sift updates
                <small>
                  At startup and daily. Updates are never applied automatically.
                </small>
              </span>
            </label>
            <label className="checkbox-field">
              <Checkbox
                checked={draft.desktopNotifications}
                onCheckedChange={(v) =>
                  v === true
                    ? action("notifications", notify)
                    : set("desktopNotifications", false)
                }
              />
              <span>
                Desktop notifications
                <small>In-app notifications are always available.</small>
              </span>
            </label>
            <Button type="submit" disabled={!!busy}>
              {busy === "save" ? <Busy label="Saving" /> : "Save preferences"}
            </Button>
          </div>
        </section>
        <section className="settings-section">
          <div>
            <h2>Recovery & retention</h2>
            <p>
              Daily local backups include tasks, images, history, and job
              memory. Pi credentials are excluded.
            </p>
          </div>
          <div className="settings-controls">
            <div className="form-grid">
              <Field label="Archive completed tasks after (days)" hint="Default: 7 days after completion. Use 0 to turn off. Archived tasks stay in Archive indefinitely; reopen them to restore.">
                <Input type="number" min={0} max={3650} value={draft.autoArchiveDays} onChange={e => set("autoArchiveDays", +e.target.value)} />
              </Field>
              <Field label="Daily backups to keep">
                <Input
                  type="number"
                  min={1}
                  max={100}
                  value={draft.backupRetention}
                  onChange={(e) => set("backupRetention", +e.target.value)}
                />
              </Field>
              <Field label="Trash retention (days)">
                <Input
                  type="number"
                  min={1}
                  max={3650}
                  value={draft.trashRetentionDays}
                  onChange={(e) => set("trashRetentionDays", +e.target.value)}
                />
              </Field>
              <Field label="Detailed logs (days)">
                <Input
                  type="number"
                  min={1}
                  max={3650}
                  value={draft.logRetentionDays}
                  onChange={(e) => set("logRetentionDays", +e.target.value)}
                />
              </Field>
            </div>
            <small>
              Run summaries and task history are kept indefinitely. Save
              preferences to apply retention changes.
            </small>
            <div className="button-row">
              <Button
                type="button"
                variant="outline"
                disabled={!!busy}
                onClick={() =>
                  action("backup", async () => {
                    await api("/backups", "POST", {});
                    setBackups(await api("/backups"));
                    await refresh();
                    toast.success("Backup created");
                  })
                }
              >
                <ArrowDownToLine size={15} />
                Create backup
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={!!busy}
                onClick={() => restore.current?.click()}
              >
                <ArrowUpFromLine size={15} />
                Restore backup
              </Button>
              <Input
                hidden
                ref={restore}
                type="file"
                accept=".zip"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (!f) return;
                  guard(() => setRestoreFile(f));
                }}
              />
            </div>
            {busy === "backup" && <Busy label="Backing up local data" />}
            <small>
              Last successful backup:{" "}
              {friendlyTime(snapshot.settings.lastBackup)}
            </small>
            {snapshot.settings.backupError && (
              <div className="error">{snapshot.settings.backupError}</div>
            )}
            <ul className="backup-list">
              {backups.slice(0, 14).map((b) => (
                <li key={b.name}>
                  <a
                    href={"/api/backups/" + encodeURIComponent(b.name)}
                    download
                  >
                    <Download size={14} />
                    <span>{friendlyTime(b.at)}</span>
                    <span>{(b.size / 1024 / 1024).toFixed(1)} MB</span>
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </section>
      </form>
      <section className="settings-section">
        <div>
          <h2>Workflow columns</h2>
          <p>
            Only you manage columns. Done is the single completion state; every
            other column is active work.
          </p>
        </div>
        <div className="settings-controls">
          <div className="column-settings">
            {[...snapshot.columns]
              .sort((a, b) => a.order - b.order)
              .map((c, i, columns) => (
                <div key={c.id}>
                  <span className={"status-dot " + c.color} />
                  <Input
                    aria-label={"Name for " + c.name}
                    value={names[c.id] ?? c.name}
                    onChange={(e) =>
                      setNames({ ...names, [c.id]: e.target.value })
                    }
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!!busy || (names[c.id] ?? c.name) === c.name}
                    onClick={() =>
                      action("column", async () => {
                        await api("/columns", "POST", {
                          ...c,
                          name: names[c.id],
                        });
                        await refresh();
                      })
                    }
                  >
                    Save
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={i === 0 || !!busy}
                    aria-label={"Move " + c.name + " up"}
                    onClick={() =>
                      action("column", async () => {
                        const prev = columns[i - 1];
                        await api("/columns", "POST", {
                          ...prev,
                          order: c.order,
                        });
                        await api("/columns", "POST", {
                          ...c,
                          order: prev.order,
                        });
                        await refresh();
                      })
                    }
                  >
                    Up
                  </Button>
                  {!["open", "done"].includes(c.id) && (
                    <>
                      <Choice
                        aria-label={"Move tasks from " + c.name + " to"}
                        value={move[c.id] || ""}
                        onValueChange={(v) =>
                          setMove({ ...move, [c.id]: v })
                        }
                        options={[{ value: "", label: "Move tasks to…" }, ...snapshot.columns.filter(v => v.id !== c.id).map(v => ({ value: v.id, label: v.name }))]}
                      />
                      <Confirm
                        title="Remove column"
                        description="All tasks in this column move to the selected destination. Task completion rules still apply."
                        action={async () => {
                          await api(
                            "/columns/" + c.id + "?moveTo=" + move[c.id],
                            "DELETE",
                          );
                          await refresh();
                        }}
                      >
                        {(open) => (
                          <Button
                            variant="ghost"
                            size="icon"
                            disabled={!move[c.id]}
                            aria-label={"Remove " + c.name}
                            onClick={open}
                          >
                            <Trash2 size={14} />
                          </Button>
                        )}
                      </Confirm>
                    </>
                  )}
                </div>
              ))}
          </div>
          <div className="button-row">
            <Input
              aria-label="New column name"
              placeholder="New active column…"
              value={column}
              onChange={(e) => setColumn(e.target.value)}
            />
            <Button
              variant="outline"
              disabled={!column.trim() || !!busy}
              onClick={() =>
                action("column", async () => {
                  await api<Column>("/columns", "POST", {
                    name: column,
                    color: "slate",
                  });
                  setColumn("");
                  await refresh();
                })
              }
            >
              <Plus size={15} />
              Add
            </Button>
          </div>
        </div>
      </section>
      <TagManager snapshot={snapshot} refresh={refresh} />
      <section className="settings-section">
        <div>
          <h2>Local connections</h2>
          <p>
            Connect your terminal and agents, or keep Sift running at login.
            Each option is up to you.
          </p>
        </div>
        <div className="settings-controls">
          <div className="health-line">
            <HardDrive size={17} />
            <strong>Image storage</strong>
            <span className={health?.storage.ready ? "success" : "error-text"}>
              {health?.storage.ready
                ? "Ready"
                : health?.storage.error ? "Unavailable" : "Checking…"}
            </span>
          </div>
          {health?.storage.error && <div className="error" role="alert">
            <div>
              <p>Image storage is unavailable. Restart Sift to try again. You can continue without images.</p>
              <details><summary>Technical details</summary><p className="break-anywhere">{health.storage.error}</p></details>
            </div>
          </div>}
          <details>
            <summary>Connection details</summary>
            <p className="small break-anywhere">Data folder: {health?.dataDir || "Loading…"}</p>
            <p className="small break-anywhere">Pi location: {health?.piPath || "Loading…"}</p>
          </details>
          <div className="button-row">
            {["cli", "skill", "startup"].map((k) => (
              <Button
                variant="outline"
                key={k}
                disabled={!!busy}
                onClick={() => action(k, () => setup(k))}
              >
                {k === "cli"
                  ? "Install CLI"
                  : k === "skill"
                    ? "Install agent skill"
                    : "Start at login"}
              </Button>
            ))}
          </div>
          <Confirm
            title="Replace Sift skill"
            description="Replace the installed Sift skill, including any changes you made to it. Other agent settings stay unchanged."
            action={() => setup("skill", true)}
          >
            {(open) => (
              <Button
                variant="ghost"
                className="self-start"
                size="sm"
                onClick={open}
              >
                Refresh / replace an existing skill
              </Button>
            )}
          </Confirm>
          <div className="command-line">
            <code>sift help</code>
            <CopyButton text="sift help" />
          </div>
          <div className="command-line">
            <code>sift schema</code>
            <CopyButton text="sift schema" />
          </div>
          <p className="small muted">
            CLI installed in ~/.local/bin? Ensure that folder is on PATH in your
            terminal. Sift does not edit your shell configuration.
          </p>
          <Confirm
            title="Update local Pi"
            description="Update Pi on this computer. This may affect other agents that use Pi. Finish or cancel active Sift jobs before continuing."
            action={async () => {
              await api("/pi/update", "POST", {});
              toast.success("Pi update completed");
            }}
          >
            {(open) => (
              <Button variant="outline" className="self-start" onClick={open}>
                <Terminal size={15} />
                Update Pi
              </Button>
            )}
          </Confirm>
        </div>
      </section>
      <section className="settings-section">
        <div>
          <h2>Sift, on your Dock</h2>
          <p>
            An app-sized home for your work. The local service is still
            required.
          </p>
        </div>
        <div className="settings-controls">
          <InstallApp />
        </div>
      </section>
      <section className="settings-section">
        <div>
          <h2>Sift updates</h2>
          <p>
            Choose when to install a new version.
          </p>
        </div>
        <div className="settings-controls">
          <div className="health-line">
            <ShieldCheck size={18} />
            <strong>Sift {snapshot.version}</strong>
          </div>
          {update?.error && <p className="muted small">{update.error}</p>}
          {update?.restartRequired ? (
            <p>
              Version {update.installed || update.latest} is installed. Restart
              Sift from the notice at the top of the window to start using it.
            </p>
          ) : update?.available && (
            <p>
              Version {update.latest} is available.{" "}
              <a href={update.url} target="_blank" rel="noreferrer">
                Release notes
                <ExternalLink size={12} />
              </a>
            </p>
          )}
          <div className="button-row">
            <Button
              variant="outline"
              disabled={!!busy}
              onClick={() =>
                action("check", async () =>
                  setUpdate(await api<Update>("/update/check", "POST", {})),
                )
              }
            >
              <RefreshCw size={14} className={busy === "check" ? "spin" : ""} />
              Check now
            </Button>
            {update?.available && !update.restartRequired && (
              <Confirm
                title="Apply Sift update"
                description="Sift backs up your workspace, installs the update, and restarts. Finish or cancel active jobs first."
                action={async () => {
                  const installed = await api<UpdateResult>("/update/apply", "POST", {});
                  setUpdate({ ...update, installed: installed.installed, restartRequired: true });
                  window.dispatchEvent(new CustomEvent(UPDATE_CHANGED, { detail: { restarting: !!installed.restarting } }));
                  setResult(
                    installed.restarting
                      ? "Update installed. Sift is restarting; this page reloads on its own."
                      : "Update installed. Use Restart to update at the top of the window to finish.",
                  );
                }}
              >
                {(open) => (
                  <Button onClick={open}>Apply {update.latest}</Button>
                )}
              </Confirm>
            )}
          </div>
        </div>
      </section>
      <AlertDialog open={!!restoreFile} onOpenChange={open => { if (!open && !busy) setRestoreFile(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restore this workspace?</AlertDialogTitle>
            <AlertDialogDescription>Restore “{restoreFile?.name}”. Current data is backed up first. This replaces the workspace, including job memory. Jobs are paused for review afterward.</AlertDialogDescription>
          </AlertDialogHeader>
          {error && <p className="error" role="alert">{error}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={!!busy}>Cancel</AlertDialogCancel>
            <Button variant="destructive" disabled={!!busy} onClick={() => action("restore", async () => {
              const r = await fetch("/api/restore", { method: "POST", headers: { "X-Sift-Request": "1" }, body: restoreFile });
              if (!r.ok) {
                const detail = await r.json().catch(() => null);
                throw Error(detail?.error || "Restore failed. Check that this is a complete Sift backup and try again.");
              }
              setRestoreFile(null);
              setDraft(snapshot.settings); setNames({}); setColumn("");
              await refresh();
              toast.success("Workspace restored. Jobs are paused for review.");
            })}>{busy === "restore" ? <Busy label="Restoring" /> : "Restore backup"}</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
