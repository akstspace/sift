import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { api } from "../api";
import { catalogFixture, jobFixture, snapshotFixture, taskFixture, TestProviders } from "../test/fixtures";
import type { ActivityEntry, ActivityPage, Snapshot, Task } from "../types";
import { dayTitle } from "./model";
import { linkParts } from "./SessionRow";
import { TaskTime } from "./TaskTime";
import { sourceOf } from "./sources";

vi.mock("../api", async original => ({ ...await original<typeof import("../api")>(), api: vi.fn() }));
const mock = vi.mocked(api);

const NOW = "2026-11-05T15:00:00Z";
const TASK = taskFixture({ id: "tsk_ci", title: "Fix staging CI" });
const MERGED = taskFixture({ id: "tsk_cdn", title: "CDN upload timeouts", mergedInto: "tsk_ci" });
const TRACKER = jobFixture({ id: "job_activity", kind: "activity" });
const entry = (id: string, start: string, end: string, overrides: Partial<ActivityEntry> = {}): ActivityEntry => ({
  id, start, end, title: "Session " + id, summary: "", category: "code", source: "github", link: "", taskId: "tsk_ci", sourceKey: "",
  actor: "job:job_activity", createdAt: start, updatedAt: start, revision: 1, ...overrides,
});
const page = (entries: ActivityEntry[]): ActivityPage => ({ entries, checks: [], gaps: [], tracker: null, defaultPrompt: "", defaultTimes: [], categories: [], lookbackDays: 7 });

let entries: ActivityEntry[] = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date(NOW) });
  entries = [];
  mock.mockReset();
  mock.mockImplementation(async (path, method, body) => path.startsWith("/activity?task=") ? page(entries)
    : method === "PUT" ? { ...(body as { entry: ActivityEntry }).entry, revision: (body as { expectedRevision: number }).expectedRevision + 1 } : {});
});
afterEach(() => { vi.useRealTimers(); });

function mount({ task = TASK, snapshot = {}, onOpenDay }: { task?: Task; snapshot?: Partial<Snapshot>; onOpenDay?: (day: string) => void } = {}) {
  const props = { refresh: vi.fn(async () => {}), onOpenTask: vi.fn(), onOpenDay };
  const snap = (cursor: number) => snapshotFixture({ cursor, tasks: [TASK, MERGED], jobs: [TRACKER], ...snapshot });
  const view = render(<TaskTime task={task} snapshot={snap(1)} catalog={catalogFixture} {...props} />, { wrapper: TestProviders });
  const update = (cursor: number) => view.rerender(<TaskTime task={task} snapshot={snap(cursor)} catalog={catalogFixture} {...props} />);
  return { ...view, props, update, user: userEvent.setup() };
}
const section = () => screen.findByRole("region", { name: "Time spent" });
const titles = () => screen.queryAllByRole("article").map(a => a.getAttribute("aria-labelledby") && document.getElementById(a.getAttribute("aria-labelledby")!)?.textContent);

describe("time spent on a task", () => {
  it("stays out of the way without tracking or sessions", async () => {
    const { container, unmount } = mount({ snapshot: { jobs: [] } });
    await waitFor(() => expect(mock).toHaveBeenCalledWith("/activity?task=tsk_ci"));
    expect(container.innerHTML).toBe("");
    unmount();
    // A merged task can't take new time, so with nothing on it there's nothing to say.
    const merged = mount({ task: MERGED });
    await waitFor(() => expect(mock).toHaveBeenCalledWith("/activity?task=tsk_cdn"));
    expect(merged.container.innerHTML).toBe("");
  });

  it("says when time can't be read, tries again, and keeps what it has when a later read fails", async () => {
    const reads = mock.getMockImplementation()!;
    mock.mockImplementation(async (...args) => { if (String(args[0]).startsWith("/activity?task=")) throw Error("offline"); return reads(...args); });
    const { user, update } = mount();
    const region = await section();
    expect(within(region).getByRole("alert").textContent).toContain("Time spent couldn’t be read.");
    entries = [entry("a", "2026-11-05T09:00:00Z", "2026-11-05T10:00:00Z")];
    mock.mockImplementation(reads);
    await user.click(within(region).getByRole("button", { name: "Try again" }));
    expect(await within(region).findByText("1 session today")).toBeDefined();
    mock.mockImplementation(async (...args) => { if (String(args[0]).startsWith("/activity?task=")) throw Error("offline"); return reads(...args); });
    update(2);
    await waitFor(() => expect(mock).toHaveBeenCalledTimes(3));
    expect(within(region).getByText("1 session today")).toBeDefined();
    expect(within(region).queryByRole("alert")).toBeNull();
  });

  it("says nothing is recorded yet when tracking is on, and adds time to the task", async () => {
    const { user, props } = mount();
    const region = await section();
    expect(within(region).getByText(/Nothing recorded yet/)).toBeDefined();
    await user.click(within(region).getByRole("button", { name: "Add time" }));
    const dialog = await screen.findByRole("dialog", { name: "Add activity" });
    expect(within(dialog).getByText(dayTitle("2026-11-05"))).toBeDefined();
    expect(within(dialog).getByRole("combobox", { name: "Task" }).textContent).toContain("Fix staging CI");
    await user.type(within(dialog).getByRole("textbox", { name: "What you did" }), "Paired on the deploy script");
    await user.click(within(dialog).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(mock).toHaveBeenCalledWith("/activity", "POST", expect.objectContaining({ entry: expect.objectContaining({ title: "Paired on the deploy script", taskId: "tsk_ci" }) })));
    expect(props.refresh).toHaveBeenCalled();
  });

  it("totals overlapping sessions once, by day and by kind of work, and opens a day", async () => {
    entries = [
      entry("a", "2026-11-05T09:00:00Z", "2026-11-05T10:00:00Z", { category: "review" }),
      entry("b", "2026-11-05T09:30:00Z", "2026-11-05T10:15:00Z"),
      entry("c", "2026-11-04T14:00:00Z", "2026-11-04T14:25:00Z", { category: "meeting", source: "calendar" }),
    ];
    const onOpenDay = vi.fn();
    const { user } = mount({ onOpenDay });
    const region = await section();
    expect(within(region).getByText("1h 40m")).toBeDefined();
    expect(within(region).getByText("3 sessions on 2 days")).toBeDefined();
    // Coding and Reviewing overlap: each kind counts its own time, the total counts it once.
    expect(within(region).getByText("Sessions that overlap count once in the total.")).toBeDefined();
    const legend = within(region).getByRole("list", { name: "By kind of work" });
    expect(within(legend).getAllByRole("listitem").map(li => li.textContent)).toEqual(["Coding45m", "Reviewing1h", "Meetings25m"]);
    expect(region.querySelectorAll(".task-time-bar > span")).toHaveLength(3);
    const today = within(region).getByRole("region", { name: "Today" });
    expect(within(today).getByText("1h 15m")).toBeDefined();
    expect(titles()).toEqual(["Session b", "Session a", "Session c"]);
    expect(within(region).getByRole("region", { name: "Yesterday" })).toBeDefined();
    await user.click(within(region).getByRole("button", { name: `Yesterday, ${dayTitle("2026-11-04")}: open in My activity` }));
    expect(onOpenDay).toHaveBeenCalledWith("2026-11-04");
    // Sessions on this task don't link back to it.
    expect(within(region).queryByRole("button", { name: "Fix staging CI" })).toBeNull();
    expect(within(region).queryByRole("button", { name: /earlier/ })).toBeNull();
  });

  it("shows whole days up to four sessions, then the rest on request", async () => {
    const at = (day: number, hour: number) => `2026-10-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00Z`;
    entries = [
      entry("e1", at(30, 9), at(30, 10)), entry("e2", at(30, 11), at(30, 12)),
      entry("e3", at(29, 9), at(29, 10)), entry("e4", at(29, 11), at(29, 12)), entry("e5", at(29, 13), at(29, 14)),
      entry("e6", at(28, 9), at(28, 10)),
      entry("e7", "2025-12-30T09:00:00Z", "2025-12-30T09:30:00Z"),
    ];
    const { user, update } = mount();
    const region = await section();
    expect(within(region).getByText("6h 30m")).toBeDefined();
    // Days stay whole: the second day takes it past four.
    expect(titles()).toEqual(["Session e2", "Session e1", "Session e5", "Session e4", "Session e3"]);
    expect(within(region).getByRole("heading", { level: 4, name: dayTitle("2026-10-30", { weekday: "short", day: "numeric", month: "short" }) })).toBeDefined();
    const more = within(region).getByRole("button", { name: "Show 2 earlier sessions" });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    await user.click(more);
    await waitFor(() => expect(titles()).toHaveLength(7));
    expect(within(region).getByRole("heading", { level: 4, name: dayTitle("2025-12-30", { weekday: "short", day: "numeric", month: "short", year: "numeric" }) })).toBeDefined();
    expect(within(region).getByRole("button", { name: "Show fewer" }).getAttribute("aria-expanded")).toBe("true");
    await user.click(within(region).getByRole("button", { name: "Show fewer" }));
    await waitFor(() => expect(titles()).toHaveLength(5));
    // One fewer earlier session after a live change.
    entries = entries.filter(e => e.id !== "e7");
    update(2);
    expect(await within(region).findByRole("button", { name: "Show 1 earlier session" })).toBeDefined();
  });

  it("counts sessions from tasks merged into it, and says where they came from", async () => {
    entries = [
      entry("m", "2026-11-02T10:00:00Z", "2026-11-02T10:25:00Z", { taskId: "tsk_cdn", category: "message", source: "slack" }),
      entry("n", "2026-11-03T10:00:00Z", "2026-11-03T10:00:00Z", { taskId: "tsk_gone" }),
    ];
    mount();
    const region = await section();
    expect(within(region).getByText("2 sessions on 2 days")).toBeDefined();
    expect(within(region).queryByText(/overlap/)).toBeNull();
    expect(within(region).getByText("From “CDN upload timeouts”")).toBeDefined();
    expect(within(region).getByText("From “a merged task”")).toBeDefined();
    expect(within(region).queryByRole("button", { name: "CDN upload timeouts" })).toBeNull();
  });

  it("names a single day, and leaves the total out when every session is a moment", async () => {
    entries = [entry("x", "2026-11-03T10:00:00Z", "2026-11-03T10:00:00Z")];
    const { update } = mount();
    const region = await section();
    expect(within(region).getByText("1 session on " + dayTitle("2026-11-03", { weekday: "short", day: "numeric", month: "short" }))).toBeDefined();
    expect(region.querySelector(".task-time-summary strong")).toBeNull();
    expect(region.querySelector(".task-time-bar")).toBeNull();
    // Without a way to open My activity, a day is just its name.
    expect(within(region).queryByRole("button", { name: /Nov/ })).toBeNull();
    entries = [entry("y", "2026-11-04T10:00:00Z", "2026-11-04T10:00:30Z")];
    update(2);
    expect(await within(region).findByText("1 session yesterday")).toBeDefined();
    expect(within(region).getByText("<1m")).toBeDefined();
  });

  it("edits, unlinks (with undo) and removes a session from the task", async () => {
    entries = [entry("a", "2026-11-03T09:10:00Z", "2026-11-03T10:25:00Z", { title: "Fixed staging CI" })];
    const success = vi.spyOn(toast, "success").mockImplementation(() => "");
    const { user, props } = mount();
    const region = await section();
    const row = within(region).getByRole("article", { name: "Fixed staging CI" });
    await user.click(within(row).getByRole("button", { name: "More for Fixed staging CI" }));
    await user.click(await screen.findByRole("menuitem", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit activity" });
    expect(within(dialog).getByText(new RegExp(dayTitle("2026-11-03")))).toBeDefined();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await user.click(within(row).getByRole("button", { name: "More for Fixed staging CI" }));
    await user.click(await screen.findByRole("menuitem", { name: "Unlink task" }));
    await waitFor(() => expect(mock).toHaveBeenCalledWith("/activity/a", "PUT", { entry: expect.objectContaining({ taskId: "" }), expectedRevision: 1 }));
    expect(props.refresh).toHaveBeenCalled();
    expect(success).toHaveBeenCalledWith("Unlinked from this task", expect.anything());
    const undo = (success.mock.calls.at(-1)![1] as unknown as { action: { onClick: () => void } }).action;
    undo.onClick();
    await waitFor(() => expect(mock).toHaveBeenCalledWith("/activity/a", "PUT", { entry: expect.objectContaining({ taskId: "tsk_ci" }), expectedRevision: 2 }));

    await user.click(within(row).getByRole("button", { name: "More for Fixed staging CI" }));
    await user.click(await screen.findByRole("menuitem", { name: "Remove" }));
    const confirm = await screen.findByRole("alertdialog");
    await user.click(within(confirm).getByRole("button", { name: /Remove/ }));
    await waitFor(() => expect(mock).toHaveBeenCalledWith("/activity/a?revision=1", "DELETE"));
  });

  it("moves with hover, and opens nothing for a deleted task's own sessions", async () => {
    entries = [entry("a", "2026-11-05T09:00:00Z", "2026-11-05T10:00:00Z")];
    const deleted = taskFixture({ id: "tsk_ci", title: "Fix staging CI", deletedAt: "2026-11-05T12:00:00Z" });
    mount({ task: deleted });
    const region = await section();
    // A deleted task keeps its time but takes no more.
    expect(within(region).queryByRole("button", { name: "Add time" })).toBeNull();
    const row = within(region).getByRole("article");
    act(() => { row.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })); });
    await waitFor(() => expect(row.className).toContain("is-hovered"));
    act(() => { row.dispatchEvent(new MouseEvent("mouseout", { bubbles: true })); });
    await waitFor(() => expect(row.className).not.toContain("is-hovered"));
  });
});

describe("moving sessions off the task", () => {
  it("names where a session went, and gives a merged task's session back to this one", async () => {
    entries = [entry("m", "2026-11-02T10:00:00Z", "2026-11-02T10:25:00Z", { taskId: "tsk_cdn", title: "Asked about CDN timeouts" })];
    const other = taskFixture({ id: "tsk_web", title: "Web release" });
    const success = vi.spyOn(toast, "success").mockImplementation(() => "");
    const { user } = mount({ snapshot: { tasks: [TASK, MERGED, other] } });
    const region = await section();
    await user.click(within(region).getByRole("button", { name: "More for Asked about CDN timeouts" }));
    await user.click(await screen.findByRole("menuitem", { name: "Change task" }));
    await user.click(await screen.findByRole("option", { name: /Web release/ }));
    await waitFor(() => expect(success).toHaveBeenCalledWith("Moved to “Web release”", expect.anything()));
    (success.mock.calls.at(-1)![1] as unknown as { action: { onClick: () => void } }).action.onClick();
    await waitFor(() => expect(mock).toHaveBeenCalledWith("/activity/m", "PUT", { entry: expect.objectContaining({ taskId: "tsk_ci" }), expectedRevision: 2 }));
    // A failed save says so on its own and offers nothing to undo.
    success.mockClear();
    const error = vi.spyOn(toast, "error").mockImplementation(() => "");
    const reads = mock.getMockImplementation()!;
    mock.mockImplementation(async (...args) => { if (args[1] === "PUT") throw Error("This activity changed; read it again before saving"); return reads(...args); });
    await user.click(within(region).getByRole("button", { name: "More for Asked about CDN timeouts" }));
    await user.click(await screen.findByRole("menuitem", { name: "Unlink task" }));
    await waitFor(() => expect(error).toHaveBeenCalledWith("This activity changed; read it again before saving"));
    expect(success).not.toHaveBeenCalled();
  });
});

describe("link labels", () => {
  it("keep the host and path, and the last segment apart so it stays in view", () => {
    expect(linkParts("https://www.github.com/acme/web/pull/412/files?diff=split#diff-4f0a")).toEqual(["github.com/acme/web/pull/412", "/files"]);
    expect(linkParts("https://github.com/acme/infra/pull/88/")).toEqual(["github.com/acme/infra/pull", "/88"]);
    expect(linkParts("https://docs.example.com/")).toEqual(["docs.example.com", ""]);
    expect(linkParts("https://example.com/a/" + "x".repeat(30))).toEqual(["example.com/a/" + "x".repeat(30), ""]);
    expect(linkParts("mailto:maya@example.com")).toEqual(["maya@example.com", ""]);
    expect(linkParts("not a url/at all")).toEqual(["not a url", "/at all"]);
  });
});

describe("sources", () => {
  it("names known sources and gives unknown ones a tidy label", () => {
    const cases: [string, string][] = [
      ["GitHub", "GitHub"], ["gh", "GitHub"], ["pull request", "GitHub"], ["commits", "Git"], ["repository", "Git"], ["slack", "Slack"],
      ["Gmail", "Email"], ["e-mail", "Email"], ["zoom", "Calendar"], ["meetings", "Calendar"], ["chrome", "Browser"], ["zsh", "Terminal"],
      ["google docs", "Docs"], ["notes", "Docs"], ["notion", "Notion"], ["figma", "Figma"], ["sift", "Sift"], ["manual", "You"],
      ["GitLab", "GitLab"], ["bitbucket", "Bitbucket"], ["MS Teams", "Teams"], ["discord", "Discord"], ["chat", "Chat"], ["messages", "Chat"],
      ["linear", "Linear"], ["  ", "Activity"],
    ];
    for (const [source, label] of cases) expect(sourceOf(source).label, source).toBe(label);
    const Sift = sourceOf("sift").icon;
    const { container } = render(<Sift size={14} />);
    expect(container.querySelector("svg")).not.toBeNull();
    const Default = sourceOf("sift").icon;
    render(<Default />);
  });
});
