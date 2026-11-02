import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { TestProviders } from "../test/fixtures";
import { page, RESTART_GIVE_UP_MS, RESTART_POLL_MS, UPDATE_CHANGED, UpdateNotice, type UpdateStatus } from "./UpdateNotice";
vi.mock("../api", async original => ({ ...await original<typeof import("../api")>(), api: vi.fn() }));
const mock = vi.mocked(api);
const status = (over: Partial<UpdateStatus> = {}): UpdateStatus => ({ current: "0.1.2", latest: "v0.1.3", available: true, url: "https://github.com/akstspace/sift/releases/tag/v0.1.3", error: "", checkedAt: "2026-11-02T00:00:00Z", restartRequired: false, ...over });
let reload: ReturnType<typeof vi.spyOn>;
beforeEach(() => { mock.mockReset(); reload = vi.spyOn(page, "reload").mockImplementation(() => {}); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); reload.mockRestore(); });
function mount(value: UpdateStatus | Error, runningAgents = 0) {
  mock.mockImplementation(async path => { if (path === "/update") { if (value instanceof Error) throw value; return value; } return {}; });
  const user = userEvent.setup({ advanceTimers: ms => { if (vi.isFakeTimers()) vi.advanceTimersByTime(ms); } });
  return { ...render(<UpdateNotice version="0.1.2" runningAgents={runningAgents} />, { wrapper: TestProviders }), user };
}
describe("update notice", () => {
  it.each([status({ available: false }), new Error("offline")])("stays out of the way when there is nothing to do (%#)", async value => {
    const { container } = mount(value);
    await waitFor(() => expect(mock).toHaveBeenCalledWith("/update"));
    expect(container.textContent).toBe("");
  });
  it("installs the available release and then offers a restart that reloads once the new Sift answers", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { user } = mount(status());
    await user.click(await screen.findByRole("button", { name: "Sift 0.1.3 is available" }));
    expect(screen.getByRole("heading", { name: "Sift 0.1.3 is available" })).toBeDefined();
    expect(screen.getByRole("link", { name: "What’s new" }).getAttribute("href")).toBe("https://github.com/akstspace/sift/releases/tag/v0.1.3");
    await user.click(screen.getByRole("button", { name: "Install update" }));
    expect(mock).toHaveBeenCalledWith("/update/apply", "POST", {});
    expect(await screen.findByRole("heading", { name: "Sift 0.1.3 is installed" })).toBeDefined();
    const fetch = vi.fn()
      .mockRejectedValueOnce(new TypeError("connection refused"))
      .mockResolvedValueOnce({ status: 200, ok: true, json: async () => ({ version: "0.1.2" }) })
      .mockResolvedValueOnce({ status: 401, ok: false, json: async () => ({}) });
    vi.stubGlobal("fetch", fetch);
    await user.click(screen.getByRole("button", { name: "Restart now" }));
    expect(mock).toHaveBeenCalledWith("/restart", "POST", {});
    expect(screen.getByRole("button", { name: "Restarting Sift" })).toBeDefined();
    await user.keyboard("{Escape}"); expect(screen.getByRole("heading", { name: "Sift 0.1.3 is installed" })).toBeDefined();
    for (let i = 0; i < 3; i++) await act(async () => { await vi.advanceTimersByTimeAsync(RESTART_POLL_MS); });
    expect(fetch).toHaveBeenCalledTimes(3); expect(fetch).toHaveBeenCalledWith("/api/health", { cache: "no-store" });
    expect(reload).toHaveBeenCalledOnce();
  });
  it("follows Sift's own restart after installing, without asking to restart", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { user } = mount(status());
    mock.mockImplementation(async path => path === "/update" ? status() : path === "/update/apply" ? { installed: "v0.1.3", restartRequired: true, restarting: true } : {});
    const fetch = vi.fn().mockRejectedValueOnce(new TypeError("connection refused")).mockResolvedValueOnce({ status: 401, ok: false, json: async () => ({}) });
    vi.stubGlobal("fetch", fetch);
    await user.click(await screen.findByRole("button", { name: "Sift 0.1.3 is available" }));
    expect(screen.getByText(/Installing backs up your workspace first, then Sift restarts/)).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Install update" }));
    expect(await screen.findByRole("button", { name: "Restarting Sift" })).toBeDefined();
    expect(screen.getByText("Sift is restarting into the new version. This page reloads on its own.")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Restart now" })).toBeNull();
    expect(mock).not.toHaveBeenCalledWith("/restart", "POST", {});
    for (let i = 0; i < 2; i++) await act(async () => { await vi.advanceTimersByTimeAsync(RESTART_POLL_MS); });
    expect(reload).toHaveBeenCalledOnce();
  });
  it("waits for the restart Settings started, once, even if told twice", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mount(status());
    await screen.findByRole("button", { name: "Sift 0.1.3 is available" });
    const fetch = vi.fn().mockResolvedValue({ status: 200, ok: true, json: async () => ({ version: "0.1.3" }) });
    vi.stubGlobal("fetch", fetch);
    await act(async () => {
      window.dispatchEvent(new CustomEvent(UPDATE_CHANGED, { detail: { restarting: true } }));
      window.dispatchEvent(new CustomEvent(UPDATE_CHANGED, { detail: { restarting: true } }));
    });
    expect(screen.getByRole("button", { name: "Restarting Sift" })).toBeDefined();
    await act(async () => { await vi.advanceTimersByTimeAsync(RESTART_POLL_MS); });
    expect(fetch).toHaveBeenCalledOnce();
    expect(reload).toHaveBeenCalledOnce();
  });
  it("treats a new version answering as the restart having finished", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { user } = mount(status({ installed: "v0.1.3", restartRequired: true }));
    await user.click(await screen.findByRole("button", { name: "Restart to finish updating to 0.1.3" }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 200, ok: true, json: async () => ({ version: "0.1.3" }) }));
    await user.click(screen.getByRole("button", { name: "Restart now" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(RESTART_POLL_MS); });
    expect(reload).toHaveBeenCalledOnce();
  });
  it("explains a restart that never comes back and lets the person try again", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { user } = mount(status({ installed: "v0.1.3", restartRequired: true }));
    await user.click(await screen.findByRole("button", { name: "Restart to finish updating to 0.1.3" }));
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("connection refused")));
    await user.click(screen.getByRole("button", { name: "Restart now" }));
    await user.keyboard("{Escape}");
    await act(async () => { await vi.advanceTimersByTimeAsync(RESTART_GIVE_UP_MS + RESTART_POLL_MS * 2); });
    // The panel reopens so the explanation is seen even if it was dismissed.
    expect(screen.getByRole("alert").textContent).toContain("hasn’t come back yet");
    expect((screen.getByRole("button", { name: "Restart now" }) as HTMLButtonElement).disabled).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
  it("keeps install and restart failures visible without losing the offer", async () => {
    const { user } = mount(status());
    await user.click(await screen.findByRole("button", { name: "Sift 0.1.3 is available" }));
    mock.mockRejectedValueOnce(new Error("Release checksum does not match; installation refused"));
    await user.click(screen.getByRole("button", { name: "Install update" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Release checksum does not match; installation refused");
    expect(screen.getByRole("button", { name: "Install update" })).toBeDefined();
    mock.mockImplementation(async path => path === "/update" ? status({ installed: "v0.1.3", restartRequired: true }) : {});
    await act(async () => { window.dispatchEvent(new Event(UPDATE_CHANGED)); });
    expect(await screen.findByRole("heading", { name: "Sift 0.1.3 is installed" })).toBeDefined();
    mock.mockRejectedValueOnce(new Error("Wait for running agents or maintenance to finish, then restart"));
    await user.click(screen.getByRole("button", { name: "Restart now" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Wait for running agents or maintenance to finish, then restart");
    await user.click(screen.getByRole("button", { name: "Later" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Sift 0.1.3 is installed" })).toBeNull());
  });
  it.each([[1, "An agent is running. Install once it finishes, or cancel it first."], [2, "2 agents are running. Install once they finish, or cancel them first."]])("waits for %i running agent(s) before installing", async (count, message) => {
    const { user } = mount(status(), count);
    await user.click(await screen.findByRole("button", { name: "Sift 0.1.3 is available" }));
    expect(screen.getByText(message)).toBeDefined();
    expect((screen.getByRole("button", { name: "Install update" }) as HTMLButtonElement).disabled).toBe(true);
  });
  it("rechecks periodically and stops when removed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { unmount } = mount(status({ available: false }));
    await waitFor(() => expect(mock).toHaveBeenCalledTimes(1));
    await act(async () => { await vi.advanceTimersByTimeAsync(30 * 60 * 1000); });
    expect(mock).toHaveBeenCalledTimes(2);
    unmount(); await act(async () => { await vi.advanceTimersByTimeAsync(30 * 60 * 1000); });
    expect(mock).toHaveBeenCalledTimes(2);
  });
});
