import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { deferred, jobFixture, snapshotFixture, TestProviders } from "../test/fixtures";
import type { PiInfo, Run } from "../types";
import { Jobs, Runs } from "./Jobs";
import { toast } from "sonner";
vi.mock("../api", async original => ({ ...await original<typeof import("../api")>(), api: vi.fn() }));
const mock = vi.mocked(api);
const pi: PiInfo = { connected: true, version: "fixture", path: "/fixture/pi", models: [{ id: "reasoner", name: "Reasoner", provider: "fixture", reasoning: true, input: ["text"], contextWindow: 128000 }], thinking: { levels: ["off", { id: "high", name: "High" }, { level: "medium", label: "Medium" }] }, state: {} };
beforeEach(() => { mock.mockReset(); mock.mockImplementation(async path => path.startsWith("/pi") ? pi : {}); });
function mount(jobs = [jobFixture()], create = false) {
  const props = { snapshot: snapshotFixture({ jobs }), refresh: vi.fn(async () => {}), create, onCreated: vi.fn(), onRun: vi.fn() };
  return { ...render(<Jobs {...props} />, { wrapper: TestProviders }), props, user: userEvent.setup() };
}
async function choice(label: string, option: string) {
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("combobox", { name: label }));
  fireEvent.click(await screen.findByRole("option", { name: option }));
}
describe("scheduled jobs without model prompts", () => {
  it("preserves RPC level IDs and unnamed models without substituting defaults", async () => {
    mock.mockResolvedValue({ ...pi, models: [{ ...pi.models[0], name: "" }], thinking: { levels: [{ id: "deep" }, { level: "extended" }, {}] } });
    const { user } = mount(); await user.click(screen.getByRole("button", { name: "Morning planning" }));
    await screen.findByRole("button", { name: "Refresh models" }); await choice("Model", "fixture / reasoner");
    await screen.findByRole("button", { name: "Refresh models" }); await choice("Thinking", "extended");
    expect(screen.getByRole("combobox", { name: "Thinking" }).textContent).toBe("extended");
    await choice("Thinking", "deep"); expect(screen.getByRole("combobox", { name: "Thinking" }).textContent).toBe("deep");
  });
  it.each([false, true])("ignores discovery from a closed editor, old failure=%s", async failure => {
    const slow = deferred<PiInfo>(); mock.mockReturnValueOnce(slow.promise).mockResolvedValue(pi);
    const { user } = mount(); await user.click(screen.getByRole("button", { name: "Morning planning" }));
    expect((screen.getByRole("button", { name: "Discovering Pi models" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Morning planning" }));
    await screen.findByRole("button", { name: "Refresh models" });
    await choice("Model", "fixture / Reasoner");
    await screen.findByRole("button", { name: "Refresh models" });
    await act(async () => failure ? slow.reject(Error("Stale discovery failure")) : slow.resolve({ ...pi, models: [] }));
    expect(screen.queryByText("Stale discovery failure")).toBeNull();
    expect(screen.getByRole("combobox", { name: "Model" }).textContent).toBe("fixture / Reasoner");
  });
  it("prevents duplicate job saves while persistence is pending", async () => {
    const { user, props } = mount(); await user.click(screen.getByRole("button", { name: "Morning planning" })); await screen.findByRole("button", { name: "Refresh models" });
    const pending = deferred<unknown>(); mock.mockReturnValueOnce(pending.promise);
    const form = screen.getByRole("textbox", { name: "Job name" }).closest("form")!; fireEvent.submit(form); fireEvent.submit(form);
    expect(mock.mock.calls.filter(([p]) => p === "/jobs")).toHaveLength(1); await act(async () => pending.resolve({})); expect(props.refresh).toHaveBeenCalledOnce();
  });
  it("shows a truthful empty state and creates a paused, image-excluding job", async () => {
    const { props, user } = mount([]); await user.click(screen.getByRole("button", { name: "Set up your first job" }));
    await user.type(screen.getByRole("textbox", { name: "Job name" }), "Review authorized work");
    await user.type(screen.getByRole("textbox", { name: "Prompt" }), "Read only the authorized project");
    await user.type(screen.getByRole("textbox", { name: "Working directory" }), "/fixture");
    await user.click(screen.getByRole("button", { name: "Save job" }));
    await waitFor(() => expect(props.refresh).toHaveBeenCalled());
    expect(mock).toHaveBeenCalledWith("/jobs", "POST", expect.objectContaining({ enabled: false, includeImages: false, directory: "/fixture", timeoutMinutes: 30, schedules: [{ type: "daily", schedule: "09:00" }] }));
    expect(mock.mock.calls.some(([path]) => path.endsWith("/run"))).toBe(false);
  });
  it("honors parent-requested creation once and protects unsaved prompts", async () => {
    const { props, user } = mount([], true); expect(props.onCreated).toHaveBeenCalledOnce();
    await user.type(screen.getByRole("textbox", { name: "Prompt" }), "Unsaved instructions");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByRole("dialog")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Discard changes" })); expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("edits all schedule kinds and explicit per-job model/image/enable choices", async () => {
    const { user } = mount(); await user.click(screen.getByRole("button", { name: "Morning planning" }));
    await screen.findByRole("button", { name: "Refresh models" });
    await choice("Repeats", "Selected weekdays"); await user.click(screen.getByRole("button", { name: "Mon" })); await user.click(screen.getByRole("button", { name: "Sun" }));
    expect(screen.getAllByRole("button", { pressed: true }).map(b => b.textContent)).toEqual(["Sun", "Tue", "Wed", "Thu", "Fri"]);
    await choice("Repeats", "Repeating interval"); expect((screen.getByRole("textbox", { name: "Interval" }) as HTMLInputElement).value).toBe("1h");
    expect(screen.queryByRole("group", { name: "Days" })).toBeNull();
    await choice("Repeats", "Advanced cron"); expect((screen.getByRole("textbox", { name: "Cron expression" }) as HTMLInputElement).value).toBe("0 9 * * 1-5");
    await user.clear(screen.getByRole("textbox", { name: "Cron expression" })); await user.type(screen.getByRole("textbox", { name: "Cron expression" }), "30 10 * * *");
    await choice("Model", "fixture / Reasoner"); await screen.findByRole("button", { name: "Refresh models" });
    await choice("Thinking", "High");
    await user.click(screen.getByRole("checkbox", { name: /Include Today/ })); await user.click(screen.getByRole("checkbox", { name: /Run on schedule/ }));
    fireEvent.change(screen.getByRole("spinbutton", { name: "Timeout (minutes)" }), { target: { value: "45" } });
    await user.click(screen.getByRole("button", { name: "Save job" }));
    await waitFor(() => expect(mock).toHaveBeenCalledWith("/jobs", "POST", expect.objectContaining({ provider: "fixture", model: "reasoner", thinking: "high", enabled: true, includeImages: true, schedules: [{ type: "cron", schedule: "30 10 * * *" }], timeoutMinutes: 45, sessionId: "session_test" })));
  });
  it("adds, edits, and removes several schedules, keeping focus on the list", async () => {
    const { user } = mount(); await user.click(screen.getByRole("button", { name: "Morning planning" }));
    await screen.findByRole("button", { name: "Refresh models" });
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).queryByRole("button", { name: /Remove schedule/ })).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Add schedule" }));
    const second = within(dialog).getByRole("group", { name: "Schedule 2" });
    await waitFor(() => expect(document.activeElement).toBe(within(second).getByRole("textbox", { name: "Local time" })));
    await user.type(within(second).getByRole("textbox", { name: "Local time" }), "17:30");
    fireEvent.click(within(second).getByRole("combobox", { name: "Repeats" })); fireEvent.click(await screen.findByRole("option", { name: "Selected weekdays" }));
    expect((within(second).getByRole("textbox", { name: "Local time" }) as HTMLInputElement).value).toBe("09:00");
    await user.clear(within(second).getByRole("textbox", { name: "Local time" })); await user.type(within(second).getByRole("textbox", { name: "Local time" }), "17:30");
    await user.click(within(second).getByRole("button", { name: "Sat" }));
    await user.click(within(dialog).getByRole("button", { name: "Add schedule" }));
    const third = within(dialog).getByRole("group", { name: "Schedule 3" });
    fireEvent.click(within(third).getByRole("combobox", { name: "Repeats" })); fireEvent.click(await screen.findByRole("option", { name: "Repeating interval" }));
    await user.clear(within(third).getByRole("textbox", { name: "Interval" })); await user.type(within(third).getByRole("textbox", { name: "Interval" }), "4h");
    // Removing the middle schedule moves focus to the one that takes its place.
    await user.click(within(second).getByRole("button", { name: "Remove schedule 2" }));
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Remove schedule 2" })));
    expect(mock.mock.calls.some(([path]) => path === "/jobs")).toBe(false); // removing never submits the form
    expect((within(within(dialog).getByRole("group", { name: "Schedule 2" })).getByRole("textbox", { name: "Interval" }) as HTMLInputElement).value).toBe("4h");
    await user.click(within(dialog).getByRole("button", { name: "Add schedule" }));
    await user.type(within(within(dialog).getByRole("group", { name: "Schedule 3" })).getByRole("textbox", { name: "Local time" }), "21:00");
    await user.click(within(dialog).getByRole("button", { name: "Save job" }));
    await waitFor(() => expect(mock).toHaveBeenCalledWith("/jobs", "POST", expect.objectContaining({ schedules: [{ type: "daily", schedule: "09:00" }, { type: "interval", schedule: "4h" }, { type: "daily", schedule: "21:00" }] })));
  });
  it("removes down to one schedule, then focuses Add schedule, and stops adding at the limit", async () => {
    const full = Array.from({ length: 20 }, (_, i) => ({ type: "interval", schedule: `${i + 1}h` }));
    const { user } = mount([jobFixture({ schedules: [{ type: "daily", schedule: "09:00" }, { type: "weekdays", schedule: "18:00", weekdays: [0, 6] }] }), jobFixture({ id: "full", name: "Every hour or so", schedules: full })]);
    expect(screen.getByText("Every day at 09:00 · Weekends at 18:00 · UTC")).toBeDefined();
    expect(screen.getByText("Every 1h · Every 2h · +18 more · UTC")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Morning planning" })); await screen.findByRole("button", { name: "Refresh models" });
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Remove schedule 1" }));
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Add schedule" })));
    expect(within(dialog).queryByRole("button", { name: /Remove schedule/ })).toBeNull();
    expect(within(dialog).getAllByRole("button", { pressed: true }).map(b => b.textContent)).toEqual(["Sun", "Sat"]);
    await user.click(within(dialog).getByRole("button", { name: "Cancel" })); await user.click(screen.getByRole("button", { name: "Discard changes" }));
    await user.click(screen.getByRole("button", { name: "Every hour or so" })); await screen.findByRole("button", { name: "Refresh models" });
    expect((within(screen.getByRole("dialog")).getByRole("button", { name: "Add schedule" }) as HTMLButtonElement).disabled).toBe(true);
  });
  it("deletes a job only after confirmation, with its revision", async () => {
    const { props, user } = mount([jobFixture({ revision: 4 })]);
    const success = vi.spyOn(toast, "success").mockReturnValue(1);
    await user.click(screen.getByRole("button", { name: "New job" }));
    expect(within(screen.getByRole("dialog")).queryByRole("button", { name: "Delete job" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Morning planning" })); await screen.findByRole("button", { name: "Refresh models" });
    await user.click(screen.getByRole("button", { name: "Delete job" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Delete job" });
    expect(within(confirm).getByText("“Morning planning” stops running and its remembered context is deleted. Past runs stay in Run history.")).toBeDefined();
    await user.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(mock.mock.calls.some(([, method]) => method === "DELETE")).toBe(false);
    mock.mockRejectedValueOnce(new Error("Cancel the current run before deleting this job"));
    await user.click(screen.getByRole("button", { name: "Delete job" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete job" }));
    expect((await within(screen.getByRole("alertdialog")).findByRole("alert")).textContent).toBe("Cancel the current run before deleting this job");
    expect(props.refresh).not.toHaveBeenCalled();
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete job" }));
    await waitFor(() => expect(mock).toHaveBeenLastCalledWith("/jobs/job_test?revision=4", "DELETE"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(props.refresh).toHaveBeenCalledOnce(); expect(success).toHaveBeenCalledWith("Job deleted");
    success.mockRestore();
  });
  it("surfaces discovery and save errors without substituting models", async () => {
    mock.mockRejectedValue(new Error("Pi unavailable")); const { user } = mount([jobFixture({ provider: "missing", model: "exact-model" })]);
    await user.click(screen.getByRole("button", { name: "Morning planning" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Pi unavailable");
    expect(screen.getByRole("combobox", { name: "Model" }).textContent).toContain("exact-model (unavailable)");
    await user.click(screen.getByRole("button", { name: "Refresh models" }));
    await user.click(screen.getByRole("button", { name: "Save job" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Pi unavailable");
  });
  it("refreshes the actual RPC-discovered models on request", async () => {
    const first = deferred<PiInfo>(); mock.mockReturnValueOnce(first.promise);
    const { user } = mount(); await user.click(screen.getByRole("button", { name: "Morning planning" }));
    await act(async () => first.resolve(pi)); await user.click(screen.getByRole("button", { name: "Refresh models" }));
    expect(mock.mock.calls.filter(([path]) => path.startsWith("/pi"))).toHaveLength(2);
  });
  it("resets only remembered context after confirmation and preserves history", async () => {
    const { props, user } = mount(); await user.click(screen.getByRole("button", { name: "Morning planning" }));
    await user.click(screen.getByRole("button", { name: "Reset" })); expect(mock).not.toHaveBeenCalledWith("/jobs/job_test/reset", "POST", {});
    await user.click(screen.getByRole("button", { name: "Reset job memory" }));
    await waitFor(() => expect(props.refresh).toHaveBeenCalled()); expect(mock).toHaveBeenCalledWith("/jobs/job_test/reset", "POST", {});
  });
  it("runs only on request and surfaces a failure rather than replaying", async () => {
    const { props, user } = mount([jobFixture({ enabled: true, provider: "fixture", model: "reasoner", schedules: [{ type: "interval", schedule: "2h" }] })]);
    mock.mockResolvedValueOnce({ id: "run_requested" });
    await user.click(screen.getByRole("button", { name: "Run now" })); await waitFor(() => expect(props.onRun).toHaveBeenCalledWith("run_requested"));
    const error = vi.spyOn(toast, "error").mockReturnValue(1); mock.mockRejectedValueOnce(new Error("Exact model unavailable"));
    await user.click(screen.getByRole("button", { name: "Run now" })); await waitFor(() => expect(error).toHaveBeenCalledWith("Exact model unavailable"));
    expect(props.onRun).toHaveBeenCalledTimes(1);
  });
  it("routes running and last-run history, preserves one pending trigger, and edits from the explicit icon", async () => {
    const job = jobFixture({ pending: true }); const view = mount([job]);
    const run: Run = { id: "running", jobId: job.id, jobName: job.name, status: "running", startedAt: "2026-01-02", endedAt: "", summary: "", error: "", model: "fixture", sessionId: job.sessionId, job };
    view.rerender(<Jobs {...view.props} snapshot={snapshotFixture({ jobs: [job], runs: [run, { ...run, id: "old", status: "succeeded", startedAt: "2026-01-01" }] })} />);
    expect(screen.getByText("One pending")).toBeDefined(); await view.user.click(screen.getByRole("button", { name: "View run" })); expect(view.props.onRun).toHaveBeenLastCalledWith(run.id);
    await view.user.click(screen.getByRole("button", { name: "running" })); expect(view.props.onRun).toHaveBeenLastCalledWith(run.id);
    await view.user.click(screen.getByRole("button", { name: "Edit " + job.name })); await screen.findByRole("button", { name: "Refresh models" });
    await view.user.keyboard("{Escape}"); expect(screen.queryByRole("dialog")).toBeNull();
    await view.user.click(screen.getByRole("button", { name: "New job" }));
    await view.user.click(screen.getByRole("combobox", { name: "Timezone" }));
    await view.user.type(screen.getByRole("combobox", { name: "Search timezones" }), "Asia/Tokyo");
    await view.user.click(await screen.findByRole("option", { name: "Asia/Tokyo" }));
    expect(screen.getByRole("combobox", { name: "Timezone" }).textContent).toBe("Asia/Tokyo");
  });
});

describe("real run history presentation", () => {
  const run = (overrides: Partial<Run> = {}): Run => ({ id: "run_test", jobId: "job_test", jobName: "Morning planning", status: "succeeded", startedAt: "2026-01-01T09:00:00Z", endedAt: "2026-01-01T09:01:00Z", summary: "Evidence retained", error: "", model: "fixture/reasoner", sessionId: "session_test", job: jobFixture(), ...overrides });
  function runs(selected = "", values = [run()]) {
    const props = { snapshot: snapshotFixture({ runs: values, jobs: [jobFixture()] }), selected, onSelect: vi.fn(), refresh: vi.fn(async () => {}) };
    return { ...render(<Runs {...props} />, { wrapper: TestProviders }), props, user: userEvent.setup() };
  }
  it("does not invent runs and lets a person choose a real record", async () => {
    const empty = runs("", []); expect(screen.getByText("A record of real work.")).toBeDefined(); empty.unmount();
    const { props, user } = runs(); expect(screen.getByText("Choose a run")).toBeDefined();
    await user.click(screen.getByRole("button", { name: /Morning planning/ })); expect(props.onSelect).toHaveBeenCalledWith("run_test");
  });
  it("sorts multiple real records newest-first and ignores failures from a previous selection", async () => {
    const slow = deferred<unknown>(); mock.mockReturnValueOnce(slow.promise);
    const view = runs("run_test", [run(), run({ id: "new", startedAt: "2026-01-02T09:00:00Z", jobName: "Newer job" })]);
    expect(document.querySelector(".run-row strong")?.textContent).toBe("Newer job");
    mock.mockResolvedValueOnce({ run: run({ id: "new" }), entries: [] }); view.rerender(<Runs {...view.props} selected="new" />);
    await act(async () => slow.reject(new Error("Stale failure"))); expect(screen.queryByText("Stale failure")).toBeNull();
  });
  it("renders text, tools, errors, and retained summary; Run again is explicit", async () => {
    mock.mockResolvedValueOnce({ run: run({ error: "Original warning" }), entries: [{ type: "text", text: "Real text" }, { type: "tool", text: "read local file" }] });
    const { props, user } = runs("run_test"); expect(await screen.findByText("Real text")).toBeDefined(); expect(screen.getByText("read local file")).toBeDefined();
    expect(screen.getByText("Evidence retained")).toBeDefined(); expect(screen.getByRole("alert").textContent).toBe("Original warning");
    mock.mockResolvedValueOnce({ id: "run_new" }); await user.click(screen.getByRole("button", { name: "Run again" }));
    await waitFor(() => expect(props.onSelect).toHaveBeenCalledWith("run_new"));
    await user.click(screen.getByRole("button", { name: "Back to runs" })); expect(props.onSelect).toHaveBeenCalledWith("");
  });
  it("shows an agent's reply as formatted Markdown, even when streamed in pieces", async () => {
    mock.mockResolvedValueOnce({ run: run({ summary: "### Summary\n- **One** thing" }), entries: [{ type: "text", text: "Created **23 tasks**.\n\n##" }, { type: "text", text: "# Today\n1. **Deliver** exports\n2. Triage `crash`" }, { type: "tool", text: "Running read" }, { type: "text", text: "Done." }] });
    runs("run_test");
    const transcript = await screen.findByRole("region", { name: "Agent transcript" });
    await within(transcript).findByRole("heading", { name: "Today", level: 5 });
    expect(within(transcript).getByText("23 tasks").tagName).toBe("STRONG");
    expect([...transcript.querySelectorAll(".run-transcript ol > li")].map(li => li.textContent)).toEqual(["Deliver exports", "Triage crash"]);
    expect(transcript.querySelector(".run-transcript li code")?.textContent).toBe("crash");
    expect(transcript.querySelector(".run-log")?.textContent).toBe("Running read");
    expect(transcript.querySelector(".run-transcript")?.textContent).not.toMatch(/[#*`]/);
    expect(within(transcript.querySelector(".run-summary") as HTMLElement).getByRole("heading", { name: "Summary", level: 5 })).toBeDefined();
  });
  it("shows running connection state and cancels only the selected run", async () => {
    mock.mockResolvedValueOnce({ run: run({ status: "running", model: "" }), entries: [] });
    const { props, user } = runs("run_test"); expect(await screen.findByText("Connecting to local Pi…")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Cancel" })); await waitFor(() => expect(props.refresh).toHaveBeenCalled());
    expect(mock).toHaveBeenCalledWith("/runs/run_test/cancel", "POST", {});
  });
  it("keeps long transcripts focusable and preserves reading position when new output arrives", async () => {
    const entries = Array.from({ length: 80 }, (_, i) => ({ type: "text", text: `Output ${i + 1}\n` }));
    const detail = { run: run({ status: "running" }), entries };
    mock.mockResolvedValue(detail);
    const interval = vi.spyOn(globalThis, "setInterval");
    const { user } = runs("run_test");
    const transcript = await screen.findByRole("region", { name: "Agent transcript" });
    expect(transcript.tabIndex).toBe(0);
    expect(transcript.getAttribute("aria-live")).toBe("off");
    expect(within(transcript).queryByRole("heading")).toBeNull();
    expect(within(transcript).queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(transcript.textContent).toContain("Output 80");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.tab();
    expect(document.activeElement).toBe(transcript);
    transcript.scrollTop = 240;
    mock.mockResolvedValue({ ...detail, entries: [...entries, { type: "text", text: "New output" }] });
    const poll = interval.mock.calls.find(([, delay]) => delay === 1500)![0] as () => Promise<void>;
    await act(async () => { await poll(); });
    expect(await screen.findByText(/New output/)).toBeDefined();
    expect(screen.getByRole("region", { name: "Agent transcript" })).toBe(transcript);
    expect(transcript.scrollTop).toBe(240);
    expect(document.activeElement).toBe(transcript);
  });
  it("shows load failures and expires only detailed logs, not summaries", async () => {
    mock.mockRejectedValueOnce(new Error("Record unavailable")); const view = runs("run_test");
    expect((await screen.findByRole("alert")).textContent).toBe("Record unavailable"); view.unmount();
    mock.mockResolvedValueOnce({ run: run(), entries: [] }); runs("run_test");
    expect(await screen.findByText(/Older detailed logs expire/)).toBeDefined();
  });
  it("keeps a deleted job's runs readable without offering to run it again", async () => {
    mock.mockResolvedValue({ run: run(), entries: [{ type: "text", text: "Kept after deletion" }] });
    const props = { snapshot: snapshotFixture({ runs: [run()], jobs: [] }), selected: "run_test", onSelect: vi.fn(), refresh: vi.fn(async () => {}) };
    render(<Runs {...props} />, { wrapper: TestProviders });
    expect(await screen.findByText("Kept after deletion")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Run again" })).toBeNull();
  });
  it("does not let an older run response replace a newer selection", async () => {
    const slow = deferred<{ run: Run; entries: { type: string; text: string }[] }>(); mock.mockReturnValueOnce(slow.promise);
    const view = runs("run_test"); mock.mockResolvedValueOnce({ run: run({ id: "new" }), entries: [{ type: "text", text: "Current result" }] });
    view.rerender(<Runs {...view.props} selected="new" />); expect(await screen.findByText("Current result")).toBeDefined();
    await act(async () => slow.resolve({ run: run(), entries: [{ type: "text", text: "Stale result" }] }));
    expect(screen.queryByText("Stale result")).toBeNull();
    const error = vi.spyOn(toast, "error").mockReturnValue(1); mock.mockRejectedValueOnce(new Error("Cannot repeat"));
    await view.user.click(screen.getByRole("button", { name: "Run again" })); await waitFor(() => expect(error).toHaveBeenCalledWith("Cannot repeat"));
  });
});
