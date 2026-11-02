import type { ReactNode } from "react";
import { DraftGuardProvider } from "../components/DraftGuard";
import { TooltipProvider } from "../components/ui/tooltip";
import { newTask, type CatalogIcon, type Job, type Snapshot, type Task } from "../types";

export const taskFixture = (overrides: Partial<Task> = {}): Task => ({
  ...newTask(), id: "tsk_test", title: "Read the research notes", revision: 1,
  createdAt: "2026-01-02T12:00:00Z", updatedAt: "2026-01-02T12:00:00Z", ...overrides,
});
export const jobFixture = (overrides: Partial<Job> = {}): Job => ({
  id: "job_test", name: "Morning planning", prompt: "Review the authorized project",
  directory: "/fixture", provider: "", model: "", thinking: "", scheduleType: "daily",
  schedule: "09:00", timezone: "UTC", enabled: false, timeoutMinutes: 30,
  sessionId: "session_test", nextRun: "", lastRun: "", pending: false,
  includeImages: false, revision: 1, ...overrides,
});
export const snapshotFixture = (overrides: Partial<Snapshot> = {}): Snapshot => ({
  cursor: 1, version: "0.1.0-test", tasks: [], projects: [], tags: [], jobs: [], runs: [],
  attachments: [], notifications: [], columns: [
    { id: "open", name: "Open", color: "slate", order: 0 },
    { id: "progress", name: "In progress", color: "blue", order: 1 },
    { id: "done", name: "Done", color: "green", order: 2 },
  ], settings: {
    id: "app", onboarded: true, timezone: "UTC", theme: "light", view: "board",
    concurrency: 3, timeoutMinutes: 30, checkUpdates: false, desktopNotifications: false,
    backupRetention: 14, logRetentionDays: 30, trashRetentionDays: 30,
    lastBackup: "", backupError: "",
  }, ...overrides,
});
export const catalogFixture: CatalogIcon[] = [
  { id: "circle-check", name: "Circle Check", category: "System", aliases: ["task"], symbol: "ti-circle-check" },
  { id: "mail", name: "Mail", category: "Communication", aliases: ["email", "inbox"], symbol: "ti-mail" },
];
export function TestProviders({ children }: { children: ReactNode }) {
  return <TooltipProvider><DraftGuardProvider>{children}</DraftGuardProvider></TooltipProvider>;
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
