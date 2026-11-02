import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { deferred, snapshotFixture, TestProviders } from "../test/fixtures";
import type { Snapshot } from "../types";
import { Settings } from "./Settings";

vi.mock("../api", async original => ({ ...await original<typeof import("../api")>(), api: vi.fn() }));
const mock = vi.mocked(api);
const health = { storage: { ready: true, version: "fixture", error: "" }, dataDir: "/fixture/data", piPath: "/fixture/pi" };
beforeEach(() => {
  mock.mockReset();
  mock.mockImplementation(async path => path === "/health" ? health : path === "/backups" ? [] : {});
});
function mount(snapshot = snapshotFixture()) {
  const props = { snapshot, refresh: vi.fn(async () => {}), onSettings: vi.fn(async () => {}), onOnboard: vi.fn() };
  return { ...render(<Settings {...props} />, { wrapper: TestProviders }), props, user: userEvent.setup() };
}
async function choose(label: string, name: string) {
  fireEvent.click(screen.getByRole("combobox", { name: label }));
  fireEvent.click(await screen.findByRole("option", { name }));
}
describe("deliberate settings and recovery", () => {
  it("keeps routine settings in plain language and connection paths optional", async () => {
    mount(); await screen.findByText("Ready");
    expect(screen.getByRole("heading", { name: "Sift updates" })).toBeDefined();
    expect(document.body.textContent).not.toMatch(/SHA-256|signed-release|GitHub HTTPS|akstspace\/sift|RustFS/);
    const details = screen.getByText("Connection details").closest("details")!;
    expect(details.open).toBe(false);
    fireEvent.click(within(details).getByText("Connection details"));
    expect(details.open).toBe(true);
    expect(details.textContent).toContain("/fixture/data");
    expect(details.textContent).toContain("/fixture/pi");
  });
  it("keeps the restore confirmation open and prevents cancellation during replacement", async () => {
    const pending = deferred<Response>(); vi.stubGlobal("fetch", vi.fn(() => pending.promise));
    const { user } = mount();
    fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: [new File(["archive"], "workspace.zip")] } });
    const dialog = screen.getByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Restore backup" }));
    expect((within(dialog).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
    await user.keyboard("{Escape}"); expect(screen.getByRole("alertdialog")).toBe(dialog);
    await act(async () => pending.resolve(new Response("{}", { status: 200 })));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });
  it("shows the last backup failure with its recovery context", async () => {
    mount(snapshotFixture({ settings: { ...snapshotFixture().settings, backupError: "Disk full: free space, then create another backup" } }));
    expect(screen.getByText("Disk full: free space, then create another backup")).toBeDefined();
  });
  it("explains unsupported desktop notifications and preserves a refusal's actual recovery note", async () => {
    vi.stubGlobal("Notification", undefined); Reflect.deleteProperty(window, "Notification");
    const { user } = mount(); await user.click(screen.getByRole("checkbox", { name: /Desktop notifications/ }));
    expect((await screen.findByRole("alert")).textContent).toContain("not available in this browser");
    mock.mockResolvedValueOnce({ installed: false, note: "Existing local edits must be reviewed" });
    await user.click(screen.getByRole("button", { name: "Install CLI" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Existing local edits must be reviewed"); expect(screen.queryByRole("status")).toBeNull();
    mock.mockResolvedValueOnce({ installed: true, path: "/fixture/sift" });
    await user.click(screen.getByRole("button", { name: "Install CLI" })); expect((await screen.findByRole("status")).textContent).toBe("Installed: /fixture/sift");
  });
  it("reports a restore failure even when the response has no JSON error body", async () => {
    const { user } = mount(); vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => { throw Error("Invalid JSON"); } })));
    fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: [new File(["invalid"], "workspace.zip")] } });
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Restore backup" }));
    expect((await within(screen.getByRole("alertdialog")).findByRole("alert")).textContent).toContain("Restore failed");
  });
  it("survives failed discovery, shows unavailable storage, and reports refused setup without success", async () => {
    mock.mockRejectedValue(new Error("Service unavailable")); const view = mount();
    await waitFor(() => expect(mock).toHaveBeenCalledWith("/update"));
    expect(screen.queryByText("Ready")).toBeNull();
    mock.mockResolvedValue({ installed: false }); await view.user.click(screen.getByRole("button", { name: "Install CLI" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Setup was not completed");
    const picker = document.querySelector<HTMLInputElement>('input[type="file"]')!, click = vi.spyOn(picker, "click");
    await view.user.click(screen.getByRole("button", { name: "Restore backup" })); expect(click).toHaveBeenCalledOnce();
    fireEvent.change(picker, { target: { files: [new File(["archive"], "workspace.zip")] } });
    await view.user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Cancel" })); expect(screen.queryByRole("alertdialog")).toBeNull();
    view.unmount(); mock.mockImplementation(async path => path === "/health" ? { ...health, storage: { ready: false, version: "", error: "Storage stopped" } } : path === "/update" ? { error: "No published release" } : []);
    const storageView = mount();
    expect(await screen.findByText("Unavailable")).toBeDefined(); expect(await screen.findByText("No published release")).toBeDefined();
    const storageAlert = screen.getByRole("alert"), storageDetails = within(storageAlert).getByText("Technical details").closest("details")!;
    expect(storageAlert.textContent).toContain("You can continue without images"); expect(storageDetails.open).toBe(false);
    await storageView.user.click(within(storageDetails).getByText("Technical details"));
    expect(storageDetails.open).toBe(true); expect(storageDetails.textContent).toContain("Storage stopped");
  });
  it("persists timezone changes and explicitly turns desktop notifications back off", async () => {
    const { props, user } = mount(snapshotFixture({ settings: { ...snapshotFixture().settings, desktopNotifications: true } }));
    await user.click(screen.getByRole("combobox", { name: "Timezone" })); await user.type(screen.getByRole("combobox", { name: "Search timezones" }), "Asia/Tokyo");
    await user.click(await screen.findByRole("option", { name: "Asia/Tokyo" })); await user.click(screen.getByRole("checkbox", { name: /Desktop notifications/ }));
    await user.click(screen.getByRole("button", { name: "Save preferences" })); await waitFor(() => expect(props.onSettings).toHaveBeenCalledWith(expect.objectContaining({ timezone: "Asia/Tokyo", desktopNotifications: false })));
  });
  it("saves all preference controls and preserves local changes across backup metadata refresh", async () => {
    const { props, rerender, user } = mount(); await screen.findByText("Ready");
    await choose("Appearance", "Dark");
    for (const [name, value] of [["Parallel jobs", "4"], ["Default timeout (minutes)", "45"], ["Daily backups to keep", "20"], ["Trash retention (days)", "35"], ["Detailed logs (days)", "40"], ["Archive completed tasks after (days)", "0"]]) {
      fireEvent.change(screen.getByRole("spinbutton", { name }), { target: { value } });
    }
    await user.click(screen.getByRole("checkbox", { name: /Check for Sift updates/ }));
    const snapshot: Snapshot = { ...props.snapshot, settings: { ...props.snapshot.settings, lastBackup: "2026-01-02T12:00:00Z" } };
    rerender(<Settings {...props} snapshot={snapshot} />);
    expect(screen.getByRole("combobox", { name: "Appearance" }).textContent).toBe("Dark");
    await user.click(screen.getByRole("button", { name: "Save preferences" }));
    await waitFor(() => expect(props.onSettings).toHaveBeenCalledWith(expect.objectContaining({ theme: "dark", concurrency: 4, timeoutMinutes: 45, backupRetention: 20, trashRetentionDays: 35, logRetentionDays: 40, autoArchiveDays: 0, checkUpdates: true, lastBackup: snapshot.settings.lastBackup })));
  });
  it("protects unsaved preferences before revisiting setup and reports failed persistence", async () => {
    const { props, user } = mount(); props.onSettings.mockRejectedValueOnce(new Error("Read-only workspace"));
    fireEvent.change(screen.getByRole("spinbutton", { name: "Parallel jobs" }), { target: { value: "5" } });
    await user.click(screen.getByRole("button", { name: "Save preferences" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Read-only workspace");
    await user.click(screen.getByRole("button", { name: "Revisit setup" })); expect(props.onOnboard).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    await user.click(screen.getByRole("button", { name: "Revisit setup" })); await user.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(props.onOnboard).toHaveBeenCalledOnce();
  });
  it("creates and lists downloadable backups without treating timestamps as user drafts", async () => {
    const { props, user } = mount(); await screen.findByText("Ready");
    mock.mockImplementation(async (path, method) => path === "/backups" ? method === "POST" ? {} : [{ name: "backup file.zip", size: 1048576, at: "2026-01-01T00:00:00Z" }] : {});
    await user.click(screen.getByRole("button", { name: "Create backup" }));
    const link = await screen.findByRole("link", { name: /1.0 MB/ }); expect(link.getAttribute("href")).toBe("/api/backups/backup%20file.zip");
    await user.click(screen.getByRole("button", { name: "Revisit setup" })); expect(props.onOnboard).toHaveBeenCalledOnce();
  });
  it.each([false, true])("requires explicit restore confirmation and handles success=%s", async success => {
    const { props, user } = mount();
    const fetchMock = vi.fn(async () => ({ ok: success, json: async () => ({ error: "Checksum mismatch" }) })); vi.stubGlobal("fetch", fetchMock);
    const file = new File(["archive"], "workspace.zip", { type: "application/zip" });
    const picker = document.querySelector('input[type="file"]')!;
    fireEvent.change(picker, { target: { files: [] } }); expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.change(picker, { target: { files: [file] } });
    const dialog = await screen.findByRole("alertdialog"); expect(fetchMock).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Restore backup" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/restore", { method: "POST", headers: { "X-Sift-Request": "1" }, body: file }));
    if (success) { await waitFor(() => expect(props.refresh).toHaveBeenCalled()); expect(screen.queryByRole("alertdialog")).toBeNull(); }
    else { expect((await within(dialog).findByRole("alert")).textContent).toBe("Checksum mismatch"); expect(props.refresh).not.toHaveBeenCalled(); }
  });
  it("adds, renames, reorders, and confirms removal of active columns but never offers deleting Open/Done", async () => {
    const { props, user } = mount();
    expect(screen.queryByRole("button", { name: "Remove Open" })).toBeNull(); expect(screen.queryByRole("button", { name: "Remove Done" })).toBeNull();
    await user.type(screen.getByRole("textbox", { name: "New column name" }), "Review"); await user.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(mock).toHaveBeenCalledWith("/columns", "POST", { name: "Review", color: "slate" }));
    const name = screen.getByRole("textbox", { name: "Name for In progress" }); fireEvent.change(name, { target: { value: "Working" } });
    await user.click(within(name.parentElement!).getByRole("button", { name: "Save" }));
    expect(mock).toHaveBeenCalledWith("/columns", "POST", expect.objectContaining({ id: "progress", name: "Working" }));
    await user.click(screen.getByRole("button", { name: "Move In progress up" }));
    await waitFor(() => expect(mock).toHaveBeenCalledWith("/columns", "POST", expect.objectContaining({ id: "progress", order: 0 })));
    await choose("Move tasks from In progress to", "Open"); await user.click(screen.getByRole("button", { name: "Remove In progress" }));
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Remove column" }));
    await waitFor(() => expect(mock).toHaveBeenCalledWith("/columns/progress?moveTo=open", "DELETE")); expect(props.refresh).toHaveBeenCalled();
  });
  it("disables repeated actions while a backup is active", async () => {
    const { user } = mount(); await screen.findByText("Ready"); const pending = deferred<unknown>(); mock.mockReturnValueOnce(pending.promise);
    await user.click(screen.getByRole("button", { name: "Create backup" }));
    expect((screen.getByRole("button", { name: "Create backup" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Install CLI" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => pending.resolve({}));
  });
  it("never installs, overwrites, updates Pi, or applies a Sift release until explicit action", async () => {
    mock.mockImplementation(async path => path === "/health" ? health : path === "/backups" ? [] : path === "/update" || path === "/update/check" ? { available: true, latest: "0.2.0", url: "https://github.com/akstspace/sift/releases/tag/v0.2.0" } : { installed: true, path: "/fixture/skill", note: "Fixture only" });
    const { user } = mount(); await screen.findByRole("button", { name: "Apply 0.2.0" });
    expect(mock.mock.calls.every(([, method]) => !method)).toBe(true);
    await user.click(screen.getByRole("button", { name: "Install agent skill" })); expect((await screen.findByRole("status")).textContent).toContain("Installed: /fixture/skill");
    expect(mock).toHaveBeenCalledWith("/setup/skill", "POST", { overwrite: false });
    await user.click(screen.getByRole("button", { name: "Refresh / replace an existing skill" }));
    await user.click(screen.getByRole("button", { name: "Replace Sift skill" })); await waitFor(() => expect(mock).toHaveBeenCalledWith("/setup/skill", "POST", { overwrite: true }));
    await user.click(screen.getByRole("button", { name: "Update Pi" })); expect(mock).not.toHaveBeenCalledWith("/pi/update", "POST", {});
    expect(screen.getByRole("alertdialog").textContent).toContain("may affect other agents");
    await user.click(screen.getByRole("button", { name: "Update local Pi" })); await waitFor(() => expect(mock).toHaveBeenCalledWith("/pi/update", "POST", {}));
    await user.click(screen.getByRole("button", { name: "Check now" })); await waitFor(() => expect(mock).toHaveBeenCalledWith("/update/check", "POST", {}));
    await user.click(screen.getByRole("button", { name: "Apply 0.2.0" }));
    const confirmation = screen.getByRole("alertdialog");
    expect(confirmation.textContent).toContain("backs up your workspace");
    expect(confirmation.textContent).toContain("Finish or cancel active jobs");
    expect(confirmation.textContent).not.toMatch(/binaries|checksum/);
    await user.click(screen.getByRole("button", { name: "Apply Sift update" }));
    expect(await screen.findByText("Update installed. Use Restart to update at the top of the window to finish.")).toBeDefined();
  });
  it.each(["denied", "granted"])("requests notification permission only after opting in, permission=%s", async permission => {
    const requestPermission = vi.fn(async () => permission); vi.stubGlobal("Notification", { requestPermission });
    const { props, user } = mount(); expect(requestPermission).not.toHaveBeenCalled();
    await user.click(screen.getByRole("checkbox", { name: /Desktop notifications/ }));
    if (permission === "denied") expect((await screen.findByRole("alert")).textContent).toContain("not allowed");
    await user.click(screen.getByRole("button", { name: "Save preferences" }));
    await waitFor(() => expect(props.onSettings).toHaveBeenCalledWith(expect.objectContaining({ desktopNotifications: permission === "granted" })));
  });
});
