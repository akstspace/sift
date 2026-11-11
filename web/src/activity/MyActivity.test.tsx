import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { api } from "../api";
import { catalogFixture, jobFixture, snapshotFixture, taskFixture, TestProviders } from "../test/fixtures";
import type { ActivityCheck, ActivityEntry, ActivityPage, Job, PiInfo, Run, Snapshot } from "../types";
import { MyActivity } from "./MyActivity";
import { clock, dayTitle } from "./model";

const preference = vi.hoisted(() => ({ reduced: false }));
vi.mock("motion/react", async original => ({ ...await original<typeof import("motion/react")>(), useReducedMotion: () => preference.reduced }));
vi.mock("../api", async original => ({ ...await original<typeof import("../api")>(), api: vi.fn() }));
const mock = vi.mocked(api);

const NOW = "2026-11-04T13:00:00Z";
const DEFAULT = "Find out what I worked on.";
const TIMES = ["12:30", "17:30", "22:00"];
const c = (iso: string) => clock(new Date(iso).valueOf(), "UTC");
const pi: PiInfo = { connected: true, version: "fixture", path: "/fixture/pi", models: [{ id: "sol", name: "Sol", provider: "tokenplex", reasoning: true, input: ["text"], contextWindow: 128000 }], thinking: {}, state: {} };

const tracker = (overrides: Partial<Job> = {}) => jobFixture({
  id: "job_activity", kind: "activity", name: "My activity", prompt: DEFAULT, since: "2026-11-02T00:00:00Z", enabled: true,
  nextRun: "2026-11-04T17:30:00Z", schedules: TIMES.map(schedule => ({ type: "daily", schedule })), ...overrides,
});
const entry = (id: string, start: string, end: string, overrides: Partial<ActivityEntry> = {}): ActivityEntry => ({
  id, start, end, title: "Session " + id, summary: "", category: "code", source: "github", link: "", taskId: "", sourceKey: "",
  actor: "job:job_activity", createdAt: start, updatedAt: start, revision: 1, ...overrides,
});
const ENTRIES = [
  entry("a5", "2026-11-04T08:00:00Z", "2026-11-04T08:30:00Z", { title: "Drafted the release notes", category: "writing", source: "docs", taskId: "tsk_merged" }),
  entry("a1", "2026-11-04T09:10:00Z", "2026-11-04T10:25:00Z", { title: "Fixed staging CI", summary: "Merged **#412**.", taskId: "tsk_ci", link: "https://github.com/acme/web/pull/412" }),
  entry("a2", "2026-11-04T10:30:00Z", "2026-11-04T11:00:00Z", { title: "Platform standup", category: "meeting", source: "calendar", actor: "user" }),
  entry("a3", "2026-11-04T11:05:00Z", "2026-11-04T11:25:00Z", { title: "Replied to Maya", category: "message", source: "slack", edited: true, taskId: "tsk_done" }),
  entry("a4", "2026-11-04T11:30:00Z", "2026-11-04T11:45:00Z", { title: "Read the RFC", category: "research", source: "", taskId: "tsk_gone" }),
  entry("b1", "2026-11-03T09:00:00Z", "2026-11-03T10:00:00Z", { title: "Reviewed the onboarding PR", category: "review" }),
];
const check = (from: string, to: string): ActivityCheck => ({ id: "chk_" + from, from, to, runId: "run_old", at: to });
const CHECKS = [check("2026-11-02T00:00:00Z", "2026-11-04T12:00:00Z")];
const TASKS = [
  taskFixture({ id: "tsk_ci", title: "Fix staging CI", updatedAt: "2026-11-04T10:00:00Z" }),
  taskFixture({ id: "tsk_done", title: "Ship the release", status: "done" }),
  taskFixture({ id: "tsk_gone", title: "Old idea", deletedAt: "2026-11-03T00:00:00Z" }),
  taskFixture({ id: "tsk_merged", title: "Release notes", mergedInto: "tsk_ci" }),
  taskFixture({ id: "tsk_offsite", title: "Plan the Q4 offsite" }),
  taskFixture({ id: "tsk_finished", title: "Finished chore", status: "done" }),
];

let weeks: Record<string, { entries: ActivityEntry[]; checks: ActivityCheck[] }>;
let job: Job | null;
const page = (from: string): ActivityPage => ({
  ...(weeks[from] || { entries: [], checks: [] }), gaps: [], tracker: job, defaultPrompt: DEFAULT, defaultTimes: TIMES,
  categories: ["code", "review", "meeting", "message", "admin", "research", "writing", "other"], lookbackDays: 7,
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date(NOW) });
  preference.reduced = false;
  job = tracker();
  weeks = { "2026-11-02": { entries: ENTRIES, checks: CHECKS } };
  mock.mockReset();
  mock.mockImplementation(async (path: string) => {
    if (path.startsWith("/activity?")) return page(new URLSearchParams(path.split("?")[1]).get("from") || "");
    if (path === "/pi") return pi;
    return {};
  });
});
afterEach(() => { vi.useRealTimers(); });

function mount({ jobs = job ? [job] : [], runs = [] as Run[], day = "", snapshot = {} as Partial<Snapshot> } = {}) {
  const props = { refresh: vi.fn(async () => {}), onOpenTask: vi.fn(), onOpenRun: vi.fn(), onDay: vi.fn() };
  const base = snapshotFixture({ jobs, runs, tasks: TASKS, ...snapshot });
  let setSnap!: (s: Snapshot) => void;
  function Harness() {
    const [current, setDay] = useState(day);
    const [snap, set] = useState(base);
    setSnap = set;
    return <MyActivity snapshot={snap} refresh={props.refresh} catalog={catalogFixture} onOpenTask={props.onOpenTask} onOpenRun={props.onOpenRun}
      day={current} onDay={d => { props.onDay(d); setDay(d); }} />;
  }
  const view = render(<Harness />, { wrapper: TestProviders });
  return { ...view, props, user: userEvent.setup(), base, update: (s: Partial<Snapshot>) => act(() => setSnap({ ...base, ...s })) };
}
const run = (overrides: Partial<Run> = {}): Run => ({
  id: "run_1", jobId: "job_activity", jobName: "My activity", status: "running", startedAt: "2026-11-04T12:59:00Z", endedAt: "", summary: "", error: "",
  model: "", sessionId: "", job: tracker(), ...overrides,
});
const calls = (path: string, method?: string) => mock.mock.calls.filter(([p, m]) => p === path && (!method || m === method));
const row = (title: string) => screen.getByRole("article", { name: title });
const startsWith = (prefix: string) => (name: string) => name.startsWith(prefix);
const ready = () => screen.findByRole("article", { name: "Fixed staging CI" });
const feedGone = (title: string) => waitFor(() => expect(screen.queryByRole("article", { name: title })).toBeNull());

describe("setting up My activity", () => {
  beforeEach(() => { job = null; });
  it("starts tracking with the default prompt and times, then fills in today", async () => {
    const { props, user } = mount();
    expect(screen.getByText("Opening My activity")).toBeDefined();
    expect(await screen.findByRole("heading", { name: "See where your day went." })).toBeDefined();
    const prompt = screen.getByRole("textbox", { name: "What Sift looks at" }) as HTMLTextAreaElement;
    expect(prompt.value).toBe(DEFAULT);
    expect(screen.queryByRole("button", { name: "Restore default" })).toBeNull();
    await user.type(prompt, " Skip email.");
    await user.click(screen.getByRole("button", { name: "Restore default" }));
    expect(prompt.value).toBe(DEFAULT);
    await user.click(screen.getByRole("button", { name: "Add a time" }));
    expect((screen.getByLabelText("Check 4") as HTMLInputElement).value).toBe("09:00");
    await user.click(screen.getByRole("button", { name: "Remove the 22:00 check" }));
    fireEvent.change(screen.getByLabelText("Check 1"), { target: { value: "13:00" } });
    await user.click(screen.getByRole("button", { name: /Uses Pi’s default model/ }));
    await waitFor(() => expect(calls("/pi")).toHaveLength(1));
    fireEvent.click(await screen.findByRole("combobox", { name: "Model" }));
    fireEvent.click(await screen.findByRole("option", { name: "tokenplex / Sol" }));
    expect((screen.getByRole("checkbox", { name: /Fill in today so far/ }) as HTMLButtonElement).getAttribute("aria-checked")).toBe("true");
    await user.click(screen.getByRole("button", { name: /Start tracking/ }));
    await waitFor(() => expect(props.refresh).toHaveBeenCalled());
    expect(calls("/activity/tracker", "PUT")[0][2]).toEqual(expect.objectContaining({
      prompt: DEFAULT, enabled: true, backfill: true, timezone: "UTC", revision: 0, provider: "tokenplex", model: "sol",
      schedules: [{ type: "daily", schedule: "09:00" }, { type: "daily", schedule: "13:00" }, { type: "daily", schedule: "17:30" }],
    }));
    expect(calls("/activity/check", "POST")).toHaveLength(1);
  });
  it("caps check times at six and keeps tracking on when the first check can't start", async () => {
    const info = vi.spyOn(toast, "info").mockImplementation(() => "");
    mock.mockImplementation(async (path: string) => {
      if (path.startsWith("/activity?")) return page("");
      if (path === "/activity/check") throw Error("A check is already running");
      return {};
    });
    const { props, user } = mount();
    await screen.findByRole("heading", { name: "See where your day went." });
    for (let i = 0; i < 3; i++) await user.click(screen.getByRole("button", { name: "Add a time" }));
    expect(screen.queryByRole("button", { name: "Add a time" })).toBeNull();
    await user.click(screen.getByRole("button", { name: /Start tracking/ }));
    await waitFor(() => expect(props.refresh).toHaveBeenCalled());
    expect(info).toHaveBeenCalledWith(expect.stringContaining("A check is already running"));
  });
  it("explains a failed start and can skip filling in today", async () => {
    mock.mockImplementation(async (path: string) => {
      if (path.startsWith("/activity?")) return page("");
      if (path === "/activity/tracker") throw Error("Activity tracking is already set up");
      return {};
    });
    const { props, user } = mount();
    await screen.findByRole("heading", { name: "See where your day went." });
    await user.click(screen.getByRole("checkbox", { name: /Fill in today so far/ }));
    await user.click(screen.getByRole("button", { name: /Start tracking/ }));
    expect((await screen.findByRole("alert")).textContent).toBe("Activity tracking is already set up");
    expect((screen.getByRole("button", { name: /Start tracking/ }) as HTMLButtonElement).disabled).toBe(false);
    expect(props.refresh).not.toHaveBeenCalled();
    expect(calls("/activity/check")).toHaveLength(0);
  });
  it("says when My activity can't be read", async () => {
    preference.reduced = true;
    mock.mockImplementation(async () => { throw Error("Sift isn't running"); });
    mount();
    expect((await screen.findByRole("alert")).textContent).toBe("Sift isn't running");
  });
});

describe("the timeline", () => {
  it("shows the day at a glance and every session, most recent first", async () => {
    const { props, user } = mount();
    await ready();
    expect(within(screen.getByRole("region", { name: "Day at a glance" })).getByText("2h 50m")).toBeDefined();
    expect(screen.getByText(/^Today, /).textContent).toBe("Today, " + dayTitle("2026-11-04"));
    expect(screen.getByText("Next check " + c("2026-11-04T17:30:00Z"))).toBeDefined();
    expect(screen.getByText(`Checked ${c("2026-11-04T00:00:00Z")}–${c("2026-11-04T12:00:00Z")}`)).toBeDefined();
    const stats = screen.getByRole("region", { name: "Day at a glance" });
    expect(within(stats).getByText("5").nextSibling?.textContent).toBe("sessions");
    expect(within(stats).getByText("4").nextSibling?.textContent).toBe("tasks");
    expect(screen.getAllByRole("article").map(a => a.id)).toEqual(["a4", "a3", "a2", "a1", "a5"].map(id => "session-" + id));
    expect(screen.getByRole("region", { name: "Morning" })).toBeDefined();
    expect(within(row("Platform standup")).getByText("Added by you")).toBeDefined();
    expect(within(row("Replied to Maya")).getByText("Edited")).toBeDefined();
    expect(within(row("Fixed staging CI")).getByRole("link").getAttribute("href")).toBe("https://github.com/acme/web/pull/412");
    expect(within(row("Read the RFC")).getByRole("button", { name: "Deleted task" }).hasAttribute("disabled")).toBe(true);
    expect(within(row("Replied to Maya")).getByRole("button", { name: "Ship the release" }).className).toContain("is-done");
    await user.click(within(row("Drafted the release notes")).getByRole("button", { name: "Fix staging CI" }));
    expect(props.onOpenTask).toHaveBeenCalledWith(expect.objectContaining({ id: "tsk_ci" }));
    const gap = screen.getByText("Not checked yet").closest(".gap-row") as HTMLElement;
    expect(within(gap).getByText(`The next check, ${c("2026-11-04T17:30:00Z")}, covers this.`)).toBeDefined();
    expect(within(gap).getByText(`${c("2026-11-04T12:00:00Z")}–now`)).toBeDefined();
    await user.click(within(gap).getByRole("button", { name: "Check now" }));
    await waitFor(() => expect(props.refresh).toHaveBeenCalled());
    expect(calls("/activity/check", "POST")[0][2]).toEqual({});
  });
  it("filters by kind of work, and stops when that kind leaves the day", async () => {
    const { user, update, base } = mount();
    await ready();
    const coding = screen.getByRole("button", { name: /^Coding/ });
    await user.click(coding);
    expect(coding.getAttribute("aria-pressed")).toBe("true");
    await feedGone("Platform standup");
    expect(screen.getAllByRole("article")).toHaveLength(1);
    await user.click(coding);
    expect(await screen.findByRole("article", { name: "Platform standup" })).toBeDefined();
    await user.click(coding);
    await feedGone("Platform standup");
    await user.click(screen.getByRole("button", { name: "Show all" }));
    expect(await screen.findByRole("article", { name: "Platform standup" })).toBeDefined();
    await user.click(screen.getByRole("button", { name: /^Coding/ }));
    await feedGone("Platform standup");
    // Coding alone on the day: the filter hides nothing, so there's no Show all.
    weeks["2026-11-02"] = { entries: [ENTRIES[1], { ...ENTRIES[0], category: "code" }], checks: CHECKS };
    update({ cursor: base.cursor + 1 });
    expect(await screen.findByRole("article", { name: "Drafted the release notes" })).toBeDefined();
    expect(screen.getByRole("button", { name: /^Coding/ }).getAttribute("aria-pressed")).toBe("true");
    await waitFor(() => expect(screen.queryByRole("button", { name: "Show all" })).toBeNull());
    weeks["2026-11-02"] = { entries: ENTRIES, checks: CHECKS };
    update({ cursor: base.cursor + 2 });
    expect(await screen.findByRole("button", { name: "Show all" })).toBeDefined();
    await feedGone("Platform standup");
    weeks["2026-11-02"] = { entries: ENTRIES.filter(e => e.id !== "a1"), checks: CHECKS };
    update({ cursor: base.cursor + 3 });
    expect(await screen.findByRole("article", { name: "Platform standup" })).toBeDefined();
    expect(screen.queryByRole("button", { name: /^Coding/ })).toBeNull();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Show all" })).toBeNull());
  });
  it("links the ribbon and the feed by hover, and reveals a session from the ribbon", async () => {
    const { container } = mount();
    await ready();
    const block = container.querySelectorAll<HTMLElement>(".ribbon-session")[1];
    fireEvent.mouseEnter(block);
    expect(container.querySelector(".ribbon-tip")?.textContent).toContain("Fixed staging CI");
    expect(row("Fixed staging CI").className).toContain("is-hovered");
    fireEvent.click(container.querySelectorAll<HTMLElement>(".ribbon-session")[0]);
    fireEvent.click(block);
    expect(row("Fixed staging CI").className).toContain("is-flash");
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();
    fireEvent.mouseLeave(container.querySelector(".ribbon")!);
    await waitFor(() => expect(container.querySelector(".ribbon-tip")).toBeNull());
    fireEvent.mouseEnter(row("Platform standup"));
    expect(container.querySelectorAll(".ribbon-session")[2].className).toContain("is-hovered");
    expect(container.querySelector(".ribbon-tip")).toBeNull();
    fireEvent.mouseLeave(row("Platform standup"));
    await waitFor(() => expect(row("Fixed staging CI").className).not.toContain("is-flash"), { timeout: 2500 });
  });
  it("expands a long summary", async () => {
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(300);
    const { user } = mount();
    await ready();
    const more = within(row("Fixed staging CI")).getByRole("button", { name: "Show more" });
    await user.click(more);
    expect(more.textContent).toBe("Show less");
    expect(more.getAttribute("aria-expanded")).toBe("true");
  });
  it("moves between days and weeks", async () => {
    const { props, user } = mount();
    await ready();
    const days = screen.getByRole("group", { name: /^Week of / });
    const label = (d: string) => within(days).getByRole("button", { name: startsWith(dayTitle(d)) });
    expect(label("2026-11-04").getAttribute("aria-label")).toBe(dayTitle("2026-11-04") + ", 2h 50m recorded");
    expect(label("2026-11-02").getAttribute("aria-label")).toBe(dayTitle("2026-11-02") + ", nothing recorded");
    expect(label("2026-11-05").hasAttribute("disabled")).toBe(true);
    expect((screen.getByRole("button", { name: "Next week" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(label("2026-11-03"));
    expect(props.onDay).toHaveBeenLastCalledWith("2026-11-03");
    expect(await screen.findByText(/^Yesterday, /)).toBeDefined();
    expect(await screen.findByText("Whole day checked")).toBeDefined();
    expect(await screen.findByRole("article", { name: "Reviewed the onboarding PR" })).toBeDefined();
    fireEvent.keyDown(label("2026-11-03"), { key: "ArrowLeft" });
    expect(await screen.findByText("A quiet day")).toBeDefined();
    fireEvent.keyDown(label("2026-11-02"), { key: "ArrowLeft" });
    expect(props.onDay).toHaveBeenLastCalledWith("2026-11-01");
    expect(await screen.findByText("Before tracking started")).toBeDefined();
    const sunday = within(screen.getByRole("group", { name: /^Week of / })).getByRole("button", { name: startsWith(dayTitle("2026-11-01")) });
    expect(sunday.getAttribute("aria-label")).toBe(dayTitle("2026-11-01") + ", before tracking started");
    await user.click(screen.getByRole("button", { name: /Check this day/ }));
    await waitFor(() => expect(calls("/activity/check", "POST")).toHaveLength(1));
    expect(calls("/activity/check", "POST")[0][2]).toEqual({ from: "2026-11-01T00:00:00.000Z", to: "2026-11-02T00:00:00.000Z" });
    fireEvent.keyDown(sunday, { key: "Enter" });
    await user.click(screen.getByRole("button", { name: "Next week" }));
    expect(props.onDay).toHaveBeenLastCalledWith("");
    await screen.findByText(/^Today, /);
    await user.click(screen.getByRole("button", { name: "Previous week" }));
    expect(props.onDay).toHaveBeenLastCalledWith("2026-10-28");
    await user.click(screen.getByRole("button", { name: "Back to today" }));
    expect(props.onDay).toHaveBeenLastCalledWith("");
    const today = within(await screen.findByRole("group", { name: /^Week of / })).getByRole("button", { name: startsWith(dayTitle("2026-11-04")) });
    props.onDay.mockClear();
    fireEvent.keyDown(today, { key: "ArrowRight" });
    expect(props.onDay).not.toHaveBeenCalled();
  });
  it("opens an older day with its unchecked time", async () => {
    const { props, user } = mount({ jobs: [tracker({ since: "2026-10-01T00:00:00Z" })], day: "2026-10-28" });
    expect(await screen.findByText("More than a week ago, so scheduled checks skip it.")).toBeDefined();
    const old = screen.getByText("More than a week ago, so scheduled checks skip it.").closest(".gap-row") as HTMLElement;
    await user.click(within(old).getByRole("button", { name: "Check now" }));
    await waitFor(() => expect(props.refresh).toHaveBeenCalled());
    expect(calls("/activity/check", "POST")[0][2]).toEqual({ from: "2026-10-28T00:00:00.000Z", to: "2026-10-28T13:00:00.000Z" });
    expect(screen.getByText(`The next check, ${c("2026-11-04T17:30:00Z")}, covers this.`)).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Next week" }));
    expect(props.onDay).toHaveBeenLastCalledWith("");
  });
  it("draws overlapping, instant and spread-out sessions", async () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true, media: "", onchange: null, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn() })));
    weeks["2026-11-02"] = { checks: [], entries: [
      entry("o1", "2026-11-04T09:00:00Z", "2026-11-04T11:00:00Z", { title: "Long build", taskId: "tsk_lost" }),
      entry("o2", "2026-11-04T09:30:00Z", "2026-11-04T10:00:00Z", { title: "Quick call", category: "meeting" }),
      entry("o3", "2026-11-04T12:00:00Z", "2026-11-04T12:00:00Z", { title: "Sent a note", category: "message" }),
      entry("y1", "2026-11-03T01:00:00Z", "2026-11-03T02:00:00Z", { title: "Late fix" }),
      entry("y2", "2026-11-03T22:00:00Z", "2026-11-03T23:00:00Z", { title: "Evening review" }),
    ] };
    const { container, user } = mount({ jobs: [tracker({ since: "" })], snapshot: { tasks: [...TASKS, taskFixture({ id: "tsk_lost", title: "Folded in", mergedInto: "tsk_missing" })] } });
    expect(await screen.findByRole("article", { name: "Long build" })).toBeDefined();
    expect(within(row("Long build")).getByRole("button", { name: "Folded in" })).toBeDefined();
    expect(within(screen.getByRole("region", { name: "Day at a glance" })).getByText("task")).toBeDefined();
    expect(within(row("Sent a note")).queryByText(/–/)).toBeNull();
    expect(container.querySelector<HTMLElement>(".ribbon-track")?.style.getPropertyValue("--lanes")).toBe("2");
    expect(screen.getAllByText("Not checked yet").length).toBeGreaterThan(1);
    await user.click(within(screen.getByRole("group", { name: /^Week of / })).getByRole("button", { name: startsWith(dayTitle("2026-11-03")) }));
    expect(await screen.findByRole("article", { name: "Evening review" })).toBeDefined();
  });
  it("offers to look back at part of a day before tracking began", async () => {
    weeks["2026-10-26"] = { entries: [], checks: [check("2026-11-01T06:00:00Z", "2026-11-01T12:00:00Z")] };
    mount({ day: "2026-11-01" });
    expect((await screen.findAllByText("Before tracking started. Sift can still look back at it.")).length).toBe(2);
  });
  it("ignores a requested day in the future", async () => {
    mount({ day: "2026-11-06" });
    expect(await screen.findByText(/^Today, /)).toBeDefined();
  });
});

describe("checking", () => {
  it("checks now, and tells the person when there's nothing new to check", async () => {
    const info = vi.spyOn(toast, "info").mockImplementation(() => "");
    const error = vi.spyOn(toast, "error").mockImplementation(() => "");
    const { props, user } = mount();
    await ready();
    const button = screen.getAllByRole("button", { name: "Check now" })[0];
    await user.click(button);
    await waitFor(() => expect(props.refresh).toHaveBeenCalledOnce());
    mock.mockImplementationOnce(async () => { throw Error("That time has already been checked"); });
    await user.click(button);
    await waitFor(() => expect(info).toHaveBeenCalledWith("That time has already been checked"));
    mock.mockImplementationOnce(async () => { throw Error("Pi isn't available"); });
    await user.click(button);
    await waitFor(() => expect(error).toHaveBeenCalledWith("Pi isn't available"));
  });
  it("shows a check while it reads, with a way to watch it", async () => {
    const running = run({ windows: [{ from: "2026-11-04T12:00:00Z", to: "2026-11-04T13:00:00Z" }] });
    const { props, user } = mount({ runs: [run({ id: "run_0", status: "succeeded", startedAt: "2026-11-04T08:00:00Z", endedAt: "2026-11-04T08:05:00Z" }), running] });
    expect(await screen.findByText("Sift is reading your activity")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Check now" })).toBeNull();
    await user.click(screen.getByRole("button", { name: /Checking your activity/ }));
    expect(props.onOpenRun).toHaveBeenLastCalledWith("run_1");
    await user.click(screen.getByRole("button", { name: /Watch/ }));
    expect(props.onOpenRun).toHaveBeenCalledTimes(2);
  });
  it("points to a check that needs attention", async () => {
    const { props, user } = mount({ runs: [run({ status: "failed", error: "Model unavailable", endedAt: "2026-11-04T12:31:00Z" })] });
    await user.click(await screen.findByRole("button", { name: /Last check needs attention/ }));
    expect(props.onOpenRun).toHaveBeenCalledWith("run_1");
  });
  it("shows a paused tracker, and one with no next check", async () => {
    const { unmount } = mount({ jobs: [tracker({ enabled: false })], runs: [run({ status: "succeeded", endedAt: "2026-11-04T12:31:00Z" })] });
    expect(await screen.findByText("Paused")).toBeDefined();
    expect(screen.getByText("Paused").getAttribute("title")).toBe("Last checked " + c("2026-11-04T12:31:00Z"));
    expect(await screen.findByText("Check now to fill this in.")).toBeDefined();
    unmount();
    // A pause Sift made says so, and why.
    const sift = mount({ jobs: [tracker({ enabled: false, pausedReason: "Pi: Model unavailable" })], runs: [run({ status: "succeeded", endedAt: "2026-11-04T12:31:00Z" })] });
    expect((await screen.findByText("Paused by Sift")).getAttribute("title")).toBe("Paused by Sift: Pi: Model unavailable\nLast checked " + c("2026-11-04T12:31:00Z"));
    sift.unmount();
    mount({ jobs: [tracker({ nextRun: "" })] });
    expect(await screen.findByText("Scheduled")).toBeDefined();
    expect(screen.getByText("Scheduled").getAttribute("title")).toBe("Not checked yet");
  });
  it("says when a week can't be read", async () => {
    mock.mockImplementation(async () => { throw Error("Database is locked"); });
    mount();
    expect((await screen.findByRole("alert")).textContent).toBe("Database is locked");
    expect(screen.getByText("Reading activity")).toBeDefined();
  });
});

describe("changing sessions", () => {
  it("links a session to a task from search", async () => {
    const { props, user } = mount();
    await ready();
    await user.click(within(row("Platform standup")).getByRole("button", { name: "Link task" }));
    const search = await screen.findByRole("combobox", { name: "Link to a task" });
    const options = screen.getAllByRole("option").map(o => o.textContent);
    expect(options).toEqual(["Fix staging CI", "Plan the Q4 offsite", "Ship the release", "Finished chore"]);
    await user.type(search, "offsite");
    expect(screen.getAllByRole("option")).toHaveLength(1);
    await user.click(screen.getByRole("option", { name: /Plan the Q4 offsite/ }));
    await waitFor(() => expect(props.refresh).toHaveBeenCalled());
    expect(calls("/activity/a2", "PUT")[0][2]).toEqual({ entry: expect.objectContaining({ id: "a2", taskId: "tsk_offsite" }), expectedRevision: 1 });
    await user.click(within(row("Platform standup")).getByRole("button", { name: "Link task" }));
    await user.type(await screen.findByRole("combobox", { name: "Link to a task" }), "nothing like this");
    expect(screen.getByText("No matching tasks.")).toBeDefined();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("combobox", { name: "Link to a task" })).toBeNull());
  });
  it("changes, unlinks and removes from the menu", async () => {
    const success = vi.spyOn(toast, "success").mockImplementation(() => "");
    const error = vi.spyOn(toast, "error").mockImplementation(() => "");
    const { props, user } = mount();
    await ready();
    const more = () => within(row("Fixed staging CI")).getByRole("button", { name: "More for Fixed staging CI" });
    await user.click(more());
    await user.click(await screen.findByRole("menuitem", { name: "Change task" }));
    expect(await screen.findByRole("combobox", { name: "Change the linked task" })).toBeDefined();
    const linked = screen.getByRole("option", { name: /Fix staging CI/ });
    expect(linked.textContent).toContain("Linked");
    expect(linked.getAttribute("aria-selected")).toBe("true");
    await user.click(linked);
    expect(calls("/activity/a1", "PUT")).toHaveLength(0);
    await user.click(more());
    await user.click(await screen.findByRole("menuitem", { name: "Change task" }));
    await user.click(await screen.findByRole("option", { name: /Plan the Q4 offsite/ }));
    await waitFor(() => expect(calls("/activity/a1", "PUT")).toHaveLength(1));
    await user.click(more());
    await user.click(await screen.findByRole("menuitem", { name: "Unlink task" }));
    await waitFor(() => expect(calls("/activity/a1", "PUT")).toHaveLength(2));
    expect(calls("/activity/a1", "PUT")[1][2]).toEqual({ entry: expect.objectContaining({ taskId: "" }), expectedRevision: 1 });
    mock.mockImplementationOnce(async () => { throw Error("Someone else changed this"); });
    await user.click(more());
    await user.click(await screen.findByRole("menuitem", { name: "Unlink task" }));
    await waitFor(() => expect(error).toHaveBeenCalledWith("Someone else changed this"));
    await user.click(within(row("Platform standup")).getByRole("button", { name: "More for Platform standup" }));
    await user.click(await screen.findByRole("menuitem", { name: "Link to a task" }));
    expect(await screen.findByRole("combobox", { name: "Link to a task" })).toBeDefined();
    await user.keyboard("{Escape}");
    await user.click(more());
    await user.click(await screen.findByRole("menuitem", { name: "Remove" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Remove this activity" });
    await user.click(within(confirm).getByRole("button", { name: "Remove this activity" }));
    await waitFor(() => expect(success).toHaveBeenCalledWith("Activity removed"));
    expect(calls("/activity/a1?revision=1", "DELETE")).toHaveLength(1);
    expect(props.refresh).toHaveBeenCalled();
  });
  it("edits a session", async () => {
    const success = vi.spyOn(toast, "success").mockImplementation(() => "");
    const { props, user } = mount();
    await ready();
    await user.click(within(row("Fixed staging CI")).getByRole("button", { name: "More for Fixed staging CI" }));
    await user.click(await screen.findByRole("menuitem", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit activity" });
    expect(within(dialog).getByText(/checks leave it as you wrote it/)).toBeDefined();
    const save = within(dialog).getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    const title = within(dialog).getByRole("textbox", { name: "What you did" });
    await user.clear(title);
    await user.type(title, "Fixed staging CI for good");
    await user.click(save);
    await waitFor(() => expect(success).toHaveBeenCalledWith("Activity updated"));
    expect(calls("/activity/a1", "PUT")[0][2]).toEqual({ entry: expect.objectContaining({ title: "Fixed staging CI for good", start: "2026-11-04T09:10:00.000Z", end: "2026-11-04T10:25:00.000Z", source: "github" }), expectedRevision: 1 });
    expect(props.refresh).toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Edit activity" })).toBeNull();
  });
  it("adds a session of the person's own, today and on an earlier day", async () => {
    const success = vi.spyOn(toast, "success").mockImplementation(() => "");
    const { user } = mount();
    await ready();
    await user.click(screen.getByRole("button", { name: "Add activity" }));
    let dialog = await screen.findByRole("dialog", { name: "Add activity" });
    expect((within(dialog).getByLabelText("From") as HTMLInputElement).value).toBe("12:30");
    expect((within(dialog).getByLabelText("To") as HTMLInputElement).value).toBe("13:00");
    await user.type(within(dialog).getByRole("textbox", { name: "What you did" }), "Paired with Ana");
    await user.click(within(dialog).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(success).toHaveBeenCalledWith("Activity added"));
    expect(calls("/activity", "POST")[0][2]).toEqual({ entry: expect.objectContaining({ id: "", title: "Paired with Ana", source: "you", start: "2026-11-04T12:30:00.000Z", end: "2026-11-04T13:00:00.000Z" }), expectedRevision: 0 });
    await user.click(within(screen.getByRole("group", { name: /^Week of / })).getByRole("button", { name: startsWith(dayTitle("2026-11-03")) }));
    await screen.findByText(/^Yesterday, /);
    await user.click(await screen.findByRole("button", { name: "Add activity" }));
    dialog = await screen.findByRole("dialog", { name: "Add activity" });
    expect((within(dialog).getByLabelText("From") as HTMLInputElement).value).toBe("09:30");
    expect((within(dialog).getByLabelText("To") as HTMLInputElement).value).toBe("10:00");
  });
});

describe("tracking settings", () => {
  it("pauses checks and saves", async () => {
    const success = vi.spyOn(toast, "success").mockImplementation(() => "");
    const { props, user } = mount();
    await ready();
    await user.click(screen.getByRole("button", { name: "Activity tracking settings" }));
    const dialog = await screen.findByRole("dialog", { name: "Activity tracking" });
    const save = within(dialog).getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(within(dialog).queryByRole("checkbox", { name: /Fill in today so far/ })).toBeNull();
    await user.click(within(dialog).getByRole("switch", { name: "Check on schedule" }));
    expect(within(dialog).getByText("Paused. Check now still works.")).toBeDefined();
    await user.click(save);
    await waitFor(() => expect(success).toHaveBeenCalledWith("Activity tracking saved"));
    expect(calls("/activity/tracker", "PUT")[0][2]).toEqual(expect.objectContaining({ enabled: false, revision: 1, timezone: "UTC", backfill: false }));
    expect(props.refresh).toHaveBeenCalled();
  });
  it("shows a failed save and turns tracking off", async () => {
    const success = vi.spyOn(toast, "success").mockImplementation(() => "");
    mock.mockImplementation(async (path: string) => {
      if (path.startsWith("/activity?")) return page(new URLSearchParams(path.split("?")[1]).get("from") || "");
      if (path === "/activity/tracker") throw Error("Someone else changed this");
      return {};
    });
    const { user } = mount({ jobs: [tracker({ provider: "tokenplex", model: "gone" })] });
    await ready();
    await user.click(screen.getByRole("button", { name: "Activity tracking settings" }));
    const dialog = await screen.findByRole("dialog", { name: "Activity tracking" });
    expect(await within(dialog).findByText("tokenplex / gone (unavailable)")).toBeDefined();
    await user.click(within(dialog).getByRole("switch", { name: "Check on schedule" }));
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe("Someone else changed this");
    await user.click(within(dialog).getByRole("button", { name: /Turn off/ }));
    const confirm = await screen.findByRole("alertdialog", { name: "Turn off activity tracking" });
    await user.click(within(confirm).getByRole("button", { name: "Turn off activity tracking" }));
    await waitFor(() => expect(success).toHaveBeenCalledWith("Activity tracking turned off"));
    expect(calls("/jobs/job_activity?revision=1", "DELETE")).toHaveLength(1);
  });
  it("keeps custom schedules and closes without saving", async () => {
    mock.mockImplementation(async (path: string) => {
      if (path.startsWith("/activity?")) return page("2026-11-02");
      if (path === "/pi") throw Error("Pi isn't installed");
      return {};
    });
    const { user } = mount({ jobs: [tracker({ schedules: [{ type: "cron", schedule: "0 9 * * 1-5" }], timezone: "" })] });
    await ready();
    await user.click(screen.getByRole("button", { name: "Activity tracking settings" }));
    const dialog = await screen.findByRole("dialog", { name: "Activity tracking" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Cron expression" }), { target: { value: "0 10 * * 1-5" } });
    expect(within(dialog).queryByRole("button", { name: "Add a time" })).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: /Uses Pi’s default model/ }));
    expect(await within(dialog).findByText(/Pi didn’t answer: Pi isn't installed/)).toBeDefined();
    await user.keyboard("{Escape}");
    await user.click(await screen.findByRole("button", { name: "Discard changes" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Activity tracking" })).toBeNull());
  });
});

describe("with reduced motion", () => {
  beforeEach(() => { preference.reduced = true; });
  it("sets up and moves through the timeline without movement", async () => {
    job = null;
    const first = mount();
    expect(await screen.findByRole("heading", { name: "See where your day went." })).toBeDefined();
    first.unmount();
    job = tracker();
    const { container, user } = mount({ runs: [run({ windows: [{ from: "2026-11-04T12:00:00Z", to: "2026-11-04T13:00:00Z" }] })] });
    await ready();
    expect(screen.getByText("Sift is reading your activity")).toBeDefined();
    fireEvent.click(container.querySelectorAll<HTMLElement>(".ribbon-session")[1]);
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledWith({ block: "center", behavior: "auto" });
    await user.click(screen.getByRole("button", { name: /^Coding/ }));
    await feedGone("Platform standup");
    await user.click(within(screen.getByRole("group", { name: /^Week of / })).getByRole("button", { name: startsWith(dayTitle("2026-11-03")) }));
    expect(await screen.findByRole("article", { name: "Reviewed the onboarding PR" })).toBeDefined();
  });
});
