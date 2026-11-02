import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { api, localDate } from "./api";
import { catalogFixture, deferred, jobFixture, snapshotFixture, taskFixture } from "./test/fixtures";
import type { PiInfo, Run, Settings, Snapshot, Task } from "./types";
import App from "./App";
const preference = vi.hoisted(() => ({ reduced: false }));
vi.mock("motion/react", async original => ({ ...await original<typeof import("motion/react")>(), useReducedMotion: () => preference.reduced }));
vi.mock("./api", async original => ({ ...await original<typeof import("./api")>(), api: vi.fn() }));
const mock = vi.mocked(api);
class Events {
  static instances: Events[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  listeners = new Map<string, () => void>();
  close = vi.fn();
  constructor(public url: string) { Events.instances.push(this); }
  addEventListener(name: string, fn: () => void) { this.listeners.set(name, fn); }
}
let current: Snapshot;
beforeEach(() => {
  preference.reduced = false;
  localStorage.clear(); document.documentElement.classList.remove("dark");
  Events.instances = []; vi.stubGlobal("EventSource", Events); mock.mockReset(); current = snapshotFixture();
  mock.mockImplementation(async (path, method, body) => {
    if (path === "/snapshot") return current;
    if (path === "/health") return { storage: { ready: true, version: "fixture" } };
    if (path === "/icons") return catalogFixture;
    if (path.startsWith("/pi")) return { connected: true, version: "fixture", path: "/fixture/pi", models: [], thinking: { levels: [] }, state: {} } satisfies PiInfo;
    if (path.startsWith("/runs/")) return { run: current.runs.find(run => run.id === path.split("/")[2]), entries: [] };
    if (path === "/settings" && method === "PUT") { current = { ...current, settings: body as Settings }; return body; }
    if (path === "/backups" || path.includes("duplicates")) return [];
    if (path.startsWith("/history")) return [];
    if (path.startsWith("/tasks") && (method === "PUT" || method === "POST")) {
      const value = (body as { task: Task }).task;
      const task = { ...value, id: value.id || "created_task", revision: value.revision + 1 };
      current = { ...current, tasks: [...current.tasks.filter(t => t.id !== task.id), task] }; return { task };
    }
    if (path.startsWith("/tasks/")) return { history: [] };
    if (path.startsWith("/notifications/") && method === "POST") { current = { ...current, notifications: current.notifications.map(n => ({ ...n, read: true })) }; return {}; }
    return {};
  });
});
async function mount(snapshot = current) {
  current = snapshot; const result = render(<App />); const user = userEvent.setup();
  await screen.findByRole("button", { name: "Backlog" });
  await act(async () => Events.instances.at(-1)?.onopen?.());
  return { ...result, user };
}
async function choose(label: string, name: string) {
  fireEvent.click(screen.getByRole("combobox", { name: label })); fireEvent.click(await screen.findByRole("option", { name }));
}
describe("workspace integration", () => {
  it("passes real storage errors into onboarding and clears them when health recovers", async () => {
    current = snapshotFixture({ settings: { ...current.settings, onboarded: false } });
    const request = mock.getMockImplementation()!, interval = vi.spyOn(globalThis, "setInterval");
    let health = { ready: false, error: "RustFS exited; inspect rustfs.log" };
    mock.mockImplementation(async (path, ...args) => path === "/health" ? { storage: health } : request(path, ...args));
    render(<App />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Connections" }));
    expect((await screen.findByRole("alert")).textContent).toContain("RustFS exited");
    health = { ready: true, error: "" };
    const tick = interval.mock.calls.find(([, delay]) => delay === 15000)![0] as () => void;
    await act(async () => tick());
    expect(await screen.findByRole("status", { name: "Image storage ready" })).toBeDefined();
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it("keeps malformed historical dates out of Today's completed count and includes only eligible civil dates", async () => {
    preference.reduced = true;
    const tasks = [
      taskFixture({ id: "invalid", title: "Invalid historical date", today: true, status: "done", updatedAt: "invalid" }),
      taskFixture({ id: "upcoming", title: "Future deadline", today: false, dueDate: "2099-01-01" }),
      taskFixture({ id: "waiting", title: "Future snooze", today: false, snoozedUntil: "2099-01-01" }),
      taskFixture({ id: "ordinary", title: "Ordinary backlog", today: false }),
      taskFixture({ id: "finished", title: "Finished today", today: true, status: "done", updatedAt: new Date().toISOString() }),
    ];
    const { user } = await mount(snapshotFixture({ tasks }));
    expect(screen.getByRole("button", { name: "Finished today" })).toBeDefined();
    for (const task of tasks.slice(0, 4)) expect(screen.queryByRole("button", { name: task.title })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Backlog" }));
    expect(await screen.findByRole("button", { name: "Ordinary backlog" })).toBeDefined();
  });
  it("retains an open project route after that project disappears from a newer snapshot", async () => {
    const { user } = await mount(snapshotFixture({ projects: [{ id: "gone", name: "Temporary project", color: "sea", icon: "folder", archived: false }] }));
    await user.click(screen.getByRole("button", { name: "Temporary project" }));
    await screen.findByRole("heading", { name: "Temporary project", level: 1 });
    current = { ...current, projects: [] };
    await act(async () => Events.instances.at(-1)?.listeners.get("reset")?.());
    expect(await screen.findByRole("heading", { name: "Project", level: 1 })).toBeDefined();
  });
  it("counts multiple active jobs without inventing or replaying runs", async () => {
    const job = jobFixture(), run: Run = { id: "one", jobId: job.id, jobName: job.name, status: "running", startedAt: "2026-01-01", endedAt: "", summary: "", error: "", model: "fixture", sessionId: "fixture", job };
    await mount(snapshotFixture({ runs: [run, { ...run, id: "two", jobId: "other", jobName: "Other job" }] }));
    expect(screen.getByText("2 agents working")).toBeDefined();
    expect(mock.mock.calls.some(([path]) => path.endsWith("/run"))).toBe(false);
  });
  it("refreshes health on the clock, tolerates unavailable discovery, and reports a confirmed stream outage", async () => {
    const interval = vi.spyOn(globalThis, "setInterval"), timeout = vi.spyOn(globalThis, "setTimeout");
    const request = mock.getMockImplementation()!;
    mock.mockImplementation(async (path, ...args) => { if (path === "/icons" || path === "/health") throw Error("Discovery unavailable"); return request(path, ...args); });
    const { unmount } = await mount();
    const source = Events.instances.at(-1)!;
    act(() => source.onerror?.());
    const warning = timeout.mock.calls.find(([, delay]) => delay === 4000)![0] as () => void;
    act(() => warning());
    expect(screen.getByText(/Connection interrupted\. Your current view is preserved/)).toBeDefined();
    const tick = interval.mock.calls.find(([, delay]) => delay === 15000)![0] as () => void;
    await act(async () => tick());
    expect(mock.mock.calls.filter(([p]) => p === "/health")).toHaveLength(2);
    fireEvent.click(within(document.querySelector('[data-slot="sidebar-inner"]')!).getByRole("button", { name: "New task" }));
    expect(screen.getByRole("dialog", { name: "New task" })).toBeDefined();
    unmount();
  });
  it("respects system appearance changes and never sends desktop notifications without permission", async () => {
    let listener: (() => void) | undefined;
    const media = { matches: true, media: "(prefers-color-scheme: dark)", addEventListener: vi.fn((_name, fn) => { listener = fn; }), removeEventListener: vi.fn() };
    vi.stubGlobal("matchMedia", vi.fn((query: string) => query === media.media ? media : { ...media, matches: false, addEventListener: vi.fn() }));
    const meta = document.createElement("meta"); meta.name = "theme-color"; document.head.append(meta);
    const notify = vi.fn(); Object.defineProperty(notify, "permission", { value: "denied" }); vi.stubGlobal("Notification", notify);
    const { unmount } = await mount(snapshotFixture({ settings: { ...current.settings, theme: "system", desktopNotifications: true }, notifications: [{ id: "recent", title: "Permission evidence", message: "Only in-app", at: new Date().toISOString(), read: false }] }));
    expect(document.documentElement.style.colorScheme).toBe("dark"); expect(meta.content).toBe("#18191B");
    act(() => { media.matches = false; listener?.(); });
    expect(document.documentElement.style.colorScheme).toBe("light"); expect(meta.content).toBe("#EBE9E4"); expect(notify).not.toHaveBeenCalled();
    unmount(); meta.remove();
  });
  it("revisits setup and hands an explicitly requested first job into the actual editor", async () => {
    const { user } = await mount(); await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(await screen.findByRole("button", { name: "Revisit setup" }));
    await user.click(await screen.findByRole("button", { name: "Your workspace" }));
    await user.click(await screen.findByRole("button", { name: "Set up an agent" }));
    expect(await screen.findByRole("dialog", { name: "Your next helpful agent" })).toBeDefined();
  });
  it("routes active work and job actions to real run details, sorted newest-first", async () => {
    const job = jobFixture();
    const run: Run = { id: "run", jobId: job.id, jobName: job.name, status: "running", startedAt: "2026-01-02", endedAt: "", summary: "", error: "", model: "fixture", sessionId: job.sessionId, job };
    const { user } = await mount(snapshotFixture({ jobs: [job], runs: [run, { ...run, id: "older", status: "succeeded", startedAt: "2026-01-01" }] }));
    await user.click(screen.getByRole("button", { name: job.name + " working" })); expect(await screen.findByRole("region", { name: "Run details" })).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Agents" })); await user.click(await screen.findByRole("button", { name: "View run" }));
    expect(await screen.findByRole("heading", { name: "Run history", level: 1 })).toBeDefined();
  });
  it("keeps empty Trash explicit and sorts multiple notifications without inventing activity", async () => {
    const { user } = await mount(snapshotFixture({ notifications: [{ id: "old", title: "Earlier result", message: "Earlier", at: "2026-01-01", read: true }, { id: "new", title: "Newer result", message: "Newer", at: "2026-01-02", read: true }] }));
    await user.click(screen.getByRole("button", { name: "Trash" })); expect(await screen.findByRole("heading", { name: "Nothing in Trash." })).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Notifications" })); expect([...document.querySelectorAll(".notification-list strong")].map(e => e.textContent)).toEqual(["Newer result", "Earlier result"]);
  });
  it("coalesces stream bursts, avoids overlapping snapshots, and cancels pending refresh on unmount", async () => {
    const { unmount } = await mount(), source = Events.instances.at(-1)!;
    const pending = deferred<Snapshot>(); mock.mockReturnValueOnce(pending.promise);
    await act(async () => { source.listeners.get("reset")?.(); source.onopen?.(); source.onerror?.(); });
    const requests = mock.mock.calls.filter(([p]) => p === "/snapshot").length;
    await act(async () => { source.listeners.get("change")?.(); source.listeners.get("change")?.(); });
    unmount(); await act(async () => pending.resolve(current));
    expect(mock.mock.calls.filter(([p]) => p === "/snapshot")).toHaveLength(requests); expect(source.close).toHaveBeenCalledOnce();
  });
  it("shows initial connection failures and reconnects without losing the startup state", async () => {
    mock.mockImplementation(async path => { if (path === "/snapshot") throw Error("Service unavailable"); return []; });
    render(<App />); expect(await screen.findByText("Cannot connect to your local workspace.")).toBeDefined();
    mock.mockImplementation(async path => path === "/snapshot" ? current : path === "/icons" ? catalogFixture : { storage: { ready: true } });
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" })); expect(await screen.findByRole("button", { name: "Backlog" })).toBeDefined();
  });
  it("renders loading while the first real snapshot is pending and routes first-time setup", async () => {
    const pending = deferred<Snapshot>(); mock.mockImplementation(async path => path === "/snapshot" ? pending.promise : []);
    render(<App />); expect(screen.getByRole("status").textContent).toBe("Opening your workspace");
    await act(async () => pending.resolve(snapshotFixture({ settings: { ...current.settings, onboarded: false, theme: "dark" } })));
    expect(await screen.findByRole("button", { name: "Find your focus" })).toBeDefined();
    expect(Events.instances).toHaveLength(1);
  });
  it("keeps Today, snooze, completion-date, and trash scopes distinct", async () => {
    const today = localDate("UTC"), stamp = new Date().toISOString();
    const tasks = [taskFixture({ id: "today", title: "Today focus", today: true }), taskFixture({ id: "overdue", title: "Due evidence", dueDate: "2001-01-01" }), taskFixture({ id: "wake", title: "Woken task", snoozedUntil: "2001-01-01" }), taskFixture({ id: "future", title: "Not yet", today: true, snoozedUntil: "2099-01-01" }), taskFixture({ id: "done", title: "Finished today", today: true, status: "done", updatedAt: stamp }), taskFixture({ id: "old", title: "Finished before", today: true, status: "done" }), taskFixture({ id: "trash", title: "Recoverable", deletedAt: stamp }), taskFixture({ id: "merged", title: "Merged hidden", mergedInto: "today" })];
    const { user } = await mount(snapshotFixture({ tasks }));
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("1");
    for (const name of ["Today focus", "Due evidence", "Woken task", "Finished today"]) expect(screen.getByRole("button", { name })).toBeDefined();
    for (const name of ["Not yet", "Finished before", "Recoverable", "Merged hidden"]) expect(screen.queryByRole("button", { name })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Backlog" })); expect(await screen.findByRole("button", { name: "Finished before" })).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Trash" })); await screen.findByRole("heading", { name: "Trash" });
    await user.click(screen.getByRole("button", { name: /Recoverable/ })); expect(await screen.findByRole("button", { name: "Restore task" })).toBeDefined();
    expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
  it("combines search, priority, tag, due, and status filters and can clear every constraint", async () => {
    const task = taskFixture({ today: true, priority: "high", tags: ["research"], dueDate: "2001-01-01" });
    const { user } = await mount(snapshotFixture({ tasks: [task], tags: [{ id: "research", name: "Research", color: "sea", archived: false, icon: "circle-check" }] }));
    await user.type(screen.getByRole("textbox", { name: "Search all tasks" }), "research"); await screen.findByRole("heading", { name: "Backlog", level: 1 });
    await user.click(screen.getByRole("button", { name: "Filters" }));
    await choose("Filter priority", "High"); await choose("Filter tags", "Research"); await choose("Filter due date", "Overdue"); await choose("Filter status", "Open");
    expect(screen.getByRole("button", { name: task.title })).toBeDefined();
    await choose("Filter due date", "No due date"); expect(screen.getByRole("heading", { name: "No tasks match this view." })).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Clear search & filters" })); expect(screen.getByRole("button", { name: task.title })).toBeDefined();
    await user.type(screen.getByRole("textbox", { name: "Search all tasks" }), "no matching task");
    await user.click(screen.getByRole("button", { name: "Clear search" }));
    await choose("Filter due date", "Due today"); await user.click(screen.getByRole("button", { name: "Clear" })); expect(screen.getByRole("button", { name: task.title })).toBeDefined();
  });
  it("creates and saves a Today task with keyboard shortcuts; read-first editing stays explicit", async () => {
    const { user } = await mount(); fireEvent.keyDown(window, { key: "n" });
    const title = await screen.findByRole("textbox", { name: "Task title" }); await user.type(title, "Created through the workspace");
    fireEvent.keyDown(document.querySelector(".detail-form")!, { key: "Enter", metaKey: true });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New task" })).toBeNull());
    const task = await screen.findByRole("button", { name: "Created through the workspace" }); await user.click(task);
    expect(await screen.findByRole("heading", { name: "Created through the workspace" })).toBeDefined(); expect(screen.queryByRole("textbox", { name: "Task title" })).toBeNull();
    expect(current.tasks[0]).toMatchObject({ today: true, status: "open", revision: 1 });
    await user.keyboard("{Escape}"); await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.keyDown(window, { key: "k", ctrlKey: true }); expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Search all tasks" }));
  });
  it("preserves a dirty task during navigation and adopts external SSE changes as conflicts", async () => {
    const task = taskFixture({ today: true }); const { user } = await mount(snapshotFixture({ tasks: [task] }));
    await user.click(screen.getByRole("button", { name: task.title })); await user.click(screen.getByRole("button", { name: "Edit task title" }));
    await user.type(screen.getByRole("textbox", { name: "Task title" }), " draft");
    current = { ...current, tasks: [{ ...task, revision: 2, title: "External revision" }] };
    await act(async () => { Events.instances.at(-1)?.listeners.get("change")?.(); });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Your draft is preserved"));
    await user.click(screen.getByRole("button", { name: "Cancel" })); await user.click(screen.getByRole("button", { name: "Keep editing" }));
    expect((screen.getByRole("textbox", { name: "Task title" }) as HTMLTextAreaElement).value).toContain("draft");
    await user.click(screen.getByRole("button", { name: "Cancel" })); await user.click(screen.getByRole("button", { name: "Discard changes" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.click(screen.getByRole("button", { name: "Backlog" })); expect(await screen.findByRole("button", { name: "External revision" })).toBeDefined();
  });
  it("reports refresh failure while retaining tasks and allows a deliberate retry", async () => {
    const task = taskFixture({ today: true }); const { user, unmount } = await mount(snapshotFixture({ tasks: [task] }));
    mock.mockRejectedValueOnce(new Error("Service stopped")); await act(async () => Events.instances.at(-1)?.listeners.get("reset")?.());
    expect(await screen.findByText("Couldn’t refresh your workspace. Your current view is preserved.")).toBeDefined(); expect(screen.getByRole("button", { name: task.title })).toBeDefined();
    const first = Events.instances.at(-1)!; await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByText(/Couldn’t refresh/)).toBeNull()); expect(first.close).toHaveBeenCalledOnce();
    unmount(); expect(Events.instances.at(-1)?.close).toHaveBeenCalledOnce();
  });
  it("routes real organization, agents, history, settings, project, and help surfaces", async () => {
    const { user } = await mount(snapshotFixture({ projects: [{ id: "p", name: "Project research", archived: false, color: "sea", icon: "folder" }], tasks: [taskFixture({ project: "p" })] }));
    await user.click(screen.getByRole("button", { name: "Projects & tags" })); expect(await screen.findByRole("heading", { name: "Projects & tags" })).toBeDefined();
    await user.click(within(document.querySelector(".organization-page")!).getByRole("button", { name: "Project research" }));
    expect(await screen.findByRole("heading", { name: "Project research" })).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Agents" })); expect(await screen.findByRole("heading", { name: "Agents" })).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Run history" })); expect(await screen.findByText("A record of real work.")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Settings" })); expect(await screen.findByRole("button", { name: "Save preferences" })).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Help and shortcuts" })); expect(screen.getByRole("dialog", { name: "A little orientation" })).toBeDefined();
    await user.keyboard("{Escape}"); await user.click(screen.getByRole("link", { name: "Sift home" })); expect(await screen.findByRole("heading", { name: "Today", level: 1 })).toBeDefined();
    fireEvent.keyDown(window, { key: "?" }); expect(screen.getByRole("dialog", { name: "A little orientation" })).toBeDefined();
  });
  it("persists sidebar/theme choices and marks only real notifications as read", async () => {
    const { user } = await mount(snapshotFixture({ notifications: [{ id: "n", title: "Backup evidence", message: "Local only", at: "2026-01-01T00:00:00Z", read: false }] }));
    await user.click(screen.getByRole("button", { name: "Collapse sidebar" })); expect(localStorage.getItem("sift.sidebar")).toBe("collapsed");
    await user.click(screen.getByRole("button", { name: "Expand sidebar" })); expect(localStorage.getItem("sift.sidebar")).toBe("expanded");
    await user.click(screen.getByRole("button", { name: "Change theme" })); await waitFor(() => expect(document.documentElement.classList.contains("dark")).toBe(true));
    await user.click(screen.getByRole("button", { name: "1 unread notifications" }));
    await user.click(screen.getByRole("button", { name: "Mark notification read" })); await waitFor(() => expect(mock).toHaveBeenCalledWith("/notifications/n/read", "POST", {}));
    expect(current.notifications[0].read).toBe(true);
  });
  it("reports task mutation failures without pretending completion succeeded", async () => {
    const task = taskFixture({ today: true }); const { user } = await mount(snapshotFixture({ tasks: [task] }));
    const error = vi.spyOn(toast, "error").mockReturnValue(1); mock.mockRejectedValueOnce(new Error("Active children block completion"));
    await user.click(screen.getByRole("button", { name: "Complete " + task.title }));
    await waitFor(() => expect(error).toHaveBeenCalledWith("Active children block completion")); expect(current.tasks[0].status).toBe("open");
  });
  it("undoes the exact saved revision and reports unavailable history and failed history fetches", async () => {
    const task = taskFixture({ today: true }), success = vi.spyOn(toast, "success"), error = vi.spyOn(toast, "error").mockReturnValue(1);
    const { user } = await mount(snapshotFixture({ tasks: [task] }));
    await user.click(screen.getByRole("button", { name: "Complete " + task.title }));
    await waitFor(() => expect(success).toHaveBeenCalledWith("Task completed", expect.anything()));
    const undo = success.mock.calls.at(-1)![1]!.action;
    if (!undo || typeof undo !== "object" || !("onClick" in undo)) throw Error("Expected an actionable Undo toast");
    mock.mockResolvedValueOnce([{ id: 21, entityId: "different", after: { revision: 2 } }, { id: 22, entityId: task.id, after: { revision: 2 } }]);
    await act(async () => undo.onClick({} as React.MouseEvent<HTMLButtonElement>)); expect(mock).toHaveBeenCalledWith("/undo/22", "POST", {});
    mock.mockResolvedValueOnce([]); await act(async () => undo.onClick({} as React.MouseEvent<HTMLButtonElement>)); expect(error).toHaveBeenLastCalledWith(expect.stringContaining("no longer available"));
    mock.mockRejectedValueOnce(new Error("History unavailable")); await act(async () => undo.onClick({} as React.MouseEvent<HTMLButtonElement>)); expect(error).toHaveBeenLastCalledWith("History unavailable");
    await user.click(screen.getByRole("button", { name: "Backlog" }));
    await user.click(await screen.findByRole("button", { name: "Reopen " + task.title })); await waitFor(() => expect(success).toHaveBeenCalledWith("Task updated", expect.anything()));
  });
  it("retains sidebar defaults with blocked storage and reports preference errors", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw Error("Blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw Error("Blocked"); });
    const error = vi.spyOn(toast, "error").mockReturnValue(1), { user } = await mount();
    await user.click(screen.getByRole("button", { name: "Collapse sidebar" })); expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeDefined();
    mock.mockRejectedValueOnce(new Error("Theme not saved")); await user.click(screen.getByRole("button", { name: "Change theme" }));
    await waitFor(() => expect(error).toHaveBeenCalledWith("Theme not saved"));
    await user.click(screen.getByRole("radio", { name: "List view" })); await waitFor(() => expect(current.settings.view).toBe("list"));
    await user.click(screen.getByRole("radio", { name: "List view" })); expect(current.settings.view).toBe("list");
    mock.mockRejectedValueOnce(new Error("View not saved")); await user.click(screen.getByRole("radio", { name: "Kanban view" }));
    await waitFor(() => expect(error).toHaveBeenCalledWith("View not saved"));
  });
  it("creates project-scoped tasks without changing their project when cancelled", async () => {
    const { user } = await mount(snapshotFixture({ projects: [{ id: "p", name: "Research project", archived: false, color: "sea", icon: "folder" }] }));
    await user.click(screen.getByRole("button", { name: "Research project" })); await screen.findByRole("heading", { name: "Research project", level: 1 });
    await user.click(within(document.querySelector(".page-heading")!).getByRole("button", { name: "New task" }));
    expect(screen.getByRole("combobox", { name: "Project" }).textContent).toBe("Research project");
    await user.click(screen.getByRole("button", { name: "Cancel" })); await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.click(screen.getByRole("button", { name: "Backlog" }));
    await screen.findByRole("heading", { name: "Backlog", level: 1 });
    expect(current.tasks).toEqual([]);
  });
  it("creates project-scoped children and protects real parent navigation", async () => {
    const parent = taskFixture({ project: "p" }), child = taskFixture({ id: "child", title: "Full child task", parentId: parent.id, project: "p" });
    const { user } = await mount(snapshotFixture({ projects: [{ id: "p", name: "Research project", archived: false, color: "sea", icon: "folder" }], tasks: [parent, child] }));
    await user.click(screen.getByRole("button", { name: "Backlog" }));
    await screen.findByRole("heading", { name: "Backlog", level: 1 });
    await user.click(await screen.findByRole("button", { name: parent.title }));
    await user.click(within((await screen.findByRole("heading", { name: "Subtasks" })).parentElement!).getByRole("button", { name: "Add" }));
    expect(await screen.findByRole("button", { name: "Create task" })).toBeDefined(); expect(screen.getByRole("button", { name: parent.title })).toBeDefined();
    expect(screen.getByRole("combobox", { name: "Project" }).textContent).toBe("Research project");
    await user.click(screen.getByRole("button", { name: "Cancel" })); await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.click(screen.getByRole("button", { name: child.title }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: parent.title }));
    expect(await screen.findByRole("heading", { name: parent.title })).toBeDefined();
  });
  it("shows actual recent notifications once and toggles the persisted theme in both directions", async () => {
    const notify = vi.fn(); Object.defineProperty(notify, "permission", { value: "granted" }); vi.stubGlobal("Notification", notify);
    const recent = { id: "recent", title: "Recent evidence", message: "Authorized local result", at: new Date().toISOString(), read: false };
    const { user } = await mount(snapshotFixture({ settings: { ...current.settings, desktopNotifications: true, theme: "dark" }, notifications: [recent] }));
    expect(notify).toHaveBeenCalledWith(recent.title, { body: recent.message, icon: "/icon-192.png" });
    await user.click(screen.getByRole("button", { name: "Change theme" })); await waitFor(() => expect(current.settings.theme).toBe("light"));
    await user.click(screen.getByRole("button", { name: "Change theme" })); await waitFor(() => expect(current.settings.theme).toBe("dark"));
    expect(notify).toHaveBeenCalledOnce();
  });
});
