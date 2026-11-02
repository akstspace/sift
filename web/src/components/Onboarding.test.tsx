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
function mount(storageReady = true) {
  const props = { settings: snapshotFixture().settings, storageReady, onFinish: vi.fn(async () => {}), onCreateJob: vi.fn() };
  return { ...render(<Onboarding {...props} />, { wrapper: TestProviders }), props, user: userEvent.setup() };
}
describe("opt-in onboarding", () => {
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
