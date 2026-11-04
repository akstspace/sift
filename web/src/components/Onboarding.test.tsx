import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { snapshotFixture, TestProviders } from "../test/fixtures";
import { Onboarding } from "./Onboarding";
const preference = vi.hoisted(() => ({ reduced: false }));
vi.mock("motion/react", async original => ({ ...await original<typeof import("motion/react")>(), useReducedMotion: () => preference.reduced }));
vi.mock("../api", async original => ({ ...await original<typeof import("../api")>(), api: vi.fn() }));
const mock = vi.mocked(api);
beforeEach(() => { mock.mockReset(); preference.reduced = false; });
function mount(storageReady = true, storageError = "") {
  const props = { settings: snapshotFixture().settings, storageReady, storageError, onFinish: vi.fn(async () => {}), onCreateJob: vi.fn() };
  return { ...render(<Onboarding {...props} />, { wrapper: TestProviders }), props, user: userEvent.setup() };
}
describe("opt-in onboarding", () => {
  it("shows image storage failures instead of an endless spinner, while keeping setup skippable", async () => {
    const { user } = mount(false, "RustFS exited: exit status 1; inspect /fixture/Application Support/Sift/rustfs.log");
    await user.click(screen.getByRole("button", { name: "Connections" }));
    expect(await screen.findByRole("status", { name: "Image storage unavailable" })).toBeDefined();
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("RustFS exited: exit status 1");
    expect(alert.textContent).toContain("You can continue without images");
    const details = within(alert).getByText("Technical details").closest("details")!;
    expect(details.open).toBe(false);
    await user.click(within(details).getByText("Technical details"));
    expect(details.open).toBe(true);
    expect(screen.queryByRole("status", { name: "Starting image storage" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Continue for now" }));
    expect(await screen.findByText("Give your agents a way in.")).toBeDefined();
    expect(mock).not.toHaveBeenCalled();
  });
  it("uses the configured timezone when the OS omits one, with reduced motion and zero discovered models", async () => {
    preference.reduced = true;
    const resolved = Intl.DateTimeFormat.prototype.resolvedOptions;
    vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockImplementation(function(this: Intl.DateTimeFormat) { return { ...resolved.call(this), timeZone: "" }; });
    mock.mockResolvedValue({ version: "fixture", models: [] });
    const { user, props } = mount(); await user.click(screen.getByRole("button", { name: "Connections" }));
    await user.click(await screen.findByRole("button", { name: "Check Pi" })); expect(await screen.findByText("fixture · 0 configured models")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Your workspace" })); await user.click(await screen.findByRole("button", { name: "Enter workspace" }));
    expect(props.onFinish).toHaveBeenCalledWith(expect.objectContaining({ timezone: props.settings.timezone }));
  });
  it("starts with no installation or model request, and Skip only saves onboarding", async () => {
    const { props, user } = mount(); expect(mock).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Skip setup" }));
    expect(props.onFinish).toHaveBeenCalledWith(expect.objectContaining({ onboarded: true })); expect(props.onCreateJob).not.toHaveBeenCalled();
  });
  it("navigates all steps and discovers Pi without running a prompt", async () => {
    mock.mockResolvedValue({ version: "fixture", models: [{ id: "fixture" }] });
    const { user } = mount(false); await user.click(screen.getByRole("button", { name: "Find your focus" }));
    await user.click(await screen.findByRole("button", { name: "Check Pi" }));
    expect(await screen.findByText("fixture · 1 configured models")).toBeDefined(); expect(mock).toHaveBeenCalledWith("/pi");
    await user.click(screen.getByRole("button", { name: "Recheck" }));
    await user.click(screen.getByRole("button", { name: "Continue" })); await screen.findByText("Give your agents a way in.");
    await user.click(screen.getByRole("button", { name: "Back" })); await screen.findByText("Local by design. Connected on your terms.");
    await user.click(screen.getByRole("button", { name: "Your workspace" })); await screen.findByText("Make this space yours.");
    expect(mock.mock.calls.every(([path]) => path === "/pi")).toBe(true);
  });
  it("keeps Pi errors actionable and allows manual-only setup", async () => {
    mock.mockRejectedValue(new Error("Pi not installed")); const { user } = mount();
    await user.click(screen.getByRole("button", { name: "Connections" }));
    await user.click(await screen.findByRole("button", { name: "Check Pi" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Pi not installed");
    await user.click(screen.getByRole("button", { name: "Continue for now" })); expect(await screen.findByText("Give your agents a way in.")).toBeDefined();
  });
  it("installs only the selected connection, reports refusal, and never silently replaces a skill", async () => {
    const { user } = mount(); await user.click(screen.getByRole("button", { name: "Agent access" }));
    await screen.findByText("Give your agents a way in.");
    mock.mockResolvedValueOnce({ installed: false, note: "Existing local edits" });
    const row = screen.getByText("Teach local agents about Sift").closest(".setup-row") as HTMLElement;
    await user.click(within(row).getByRole("button", { name: "Install" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Existing local edits");
    mock.mockResolvedValueOnce({ installed: false }); await user.click(within(row).getByRole("button", { name: "Install" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Setup could not be completed");
    mock.mockResolvedValueOnce({ installed: true }); await user.click(within(row).getByRole("button", { name: "Install" }));
    await waitFor(() => expect((within(row).getByRole("button", { name: "Installed" }) as HTMLButtonElement).disabled).toBe(true));
    expect(mock.mock.calls.every(([path, method, data]) => path === "/setup/skill" && method === "POST" && JSON.stringify(data) === "{}")).toBe(true);
  });
  it.each([false, true])("finishes only after saving preferences, requested job=%s", async job => {
    const { props, user } = mount(); await user.click(screen.getByRole("button", { name: "Your workspace" })); await screen.findByText("Make this space yours.");
    props.onFinish.mockRejectedValueOnce(new Error("Cannot save setup"));
    await user.click(screen.getByRole("button", { name: job ? "Set up an agent" : "Enter workspace" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Cannot save setup"); expect(props.onCreateJob).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: job ? "Set up an agent" : "Enter workspace" }));
    await waitFor(() => expect(props.onFinish).toHaveBeenCalledTimes(2)); expect(props.onCreateJob).toHaveBeenCalledTimes(job ? 1 : 0);
  });
});

describe("activity tracking during setup", () => {
  const defaults = { entries: [], checks: [], gaps: [], tracker: null, defaultPrompt: "Find out what I worked on.", defaultTimes: ["12:30", "17:30", "22:00"], categories: [], lookbackDays: 7 };
  const openStep = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByRole("button", { name: "Your day" }));
    expect(await screen.findByText("Know where your day went.")).toBeDefined();
    // The step focuses its heading once it has arrived; type after that.
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Know where your day went."), { timeout: 3000 });
  };
  it("stays off unless turned on, and Continue moves on", async () => {
    const { user } = mount();
    await openStep(user);
    expect(screen.getByText("Optional. Off until you turn it on.")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("Make this space yours.")).toBeDefined();
    expect(mock).not.toHaveBeenCalled();
  });
  it("turns tracking on with the edited prompt, filling in today", async () => {
    mock.mockImplementation(async (path: string) => path === "/activity" ? defaults : {});
    const { user } = mount();
    await openStep(user);
    await user.click(screen.getByRole("switch", { name: "Track my activity" }));
    const prompt = await screen.findByRole("textbox", { name: "What Sift looks at" });
    expect((prompt as HTMLTextAreaElement).value).toBe("Find out what I worked on.");
    expect(screen.queryByRole("button", { name: /Uses Pi’s default model/ })).toBeNull();
    await user.type(prompt, " Skip email.");
    await user.click(screen.getByRole("button", { name: "Turn on and continue" }));
    expect(await screen.findByText("Make this space yours.")).toBeDefined();
    expect(mock).toHaveBeenCalledWith("/activity/tracker", "PUT", expect.objectContaining({
      prompt: "Find out what I worked on. Skip email.", enabled: true, backfill: true, revision: 0,
      schedules: ["12:30", "17:30", "22:00"].map(schedule => ({ type: "daily", schedule })),
    }));
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByText("Tracking is on. Change it on My activity.")).toBeDefined();
    expect((screen.getByRole("switch", { name: "Track my activity" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("Make this space yours.")).toBeDefined();
    expect(mock.mock.calls.filter(([path]) => path === "/activity/tracker")).toHaveLength(1);
  });
  it("can turn tracking back off before continuing", async () => {
    preference.reduced = true;
    mock.mockImplementation(async (path: string) => path === "/activity" ? defaults : {});
    const { user } = mount();
    await openStep(user);
    const toggle = screen.getByRole("switch", { name: "Track my activity" });
    await user.click(toggle);
    await screen.findByRole("textbox", { name: "What Sift looks at" });
    await user.click(toggle);
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "What Sift looks at" })).toBeNull());
    await user.click(toggle);
    expect(await screen.findByRole("textbox", { name: "What Sift looks at" })).toBeDefined();
    expect(mock.mock.calls.filter(([path]) => path === "/activity")).toHaveLength(1);
    await user.click(toggle);
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("Make this space yours.")).toBeDefined();
  });
  it("shows tracking that's already on", async () => {
    mock.mockImplementation(async (path: string) => path === "/activity" ? { ...defaults, tracker: { id: "job_activity", kind: "activity", prompt: "Mine", schedules: [], provider: "", model: "", thinking: "", enabled: true } } : {});
    const { user } = mount();
    await openStep(user);
    await user.click(screen.getByRole("switch", { name: "Track my activity" }));
    expect(await screen.findByText("Tracking is on. Change it on My activity.")).toBeDefined();
    expect(screen.queryByRole("textbox", { name: "What Sift looks at" })).toBeNull();
  });
  it("explains when tracking can't be read or saved", async () => {
    mock.mockRejectedValueOnce(new Error("Sift isn't running"));
    const { user } = mount();
    await openStep(user);
    await user.click(screen.getByRole("switch", { name: "Track my activity" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Sift isn't running");
    expect(screen.getByRole("switch", { name: "Track my activity" }).getAttribute("aria-checked")).toBe("false");
    mock.mockImplementation(async (path: string) => {
      if (path === "/activity") return defaults;
      throw new Error("Activity tracking is already set up");
    });
    await user.click(screen.getByRole("switch", { name: "Track my activity" }));
    await screen.findByRole("textbox", { name: "What Sift looks at" });
    await user.click(screen.getByRole("button", { name: "Turn on and continue" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Activity tracking is already set up");
    expect(screen.getByText("Know where your day went.")).toBeDefined();
  });
});

