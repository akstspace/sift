import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { api } from "../api";
import { catalogFixture, taskFixture, TestProviders } from "../test/fixtures";
import type { ActivityEntry } from "../types";
import { SessionEditor, blankEntry } from "./SessionEditor";
import { dayTitle } from "./model";

vi.mock("../api", async original => ({ ...await original<typeof import("../api")>(), api: vi.fn() }));
const mock = vi.mocked(api);
beforeEach(() => { mock.mockReset(); mock.mockResolvedValue({}); });

const NOW = new Date("2026-11-04T13:00:00Z").valueOf();
const entry = (overrides: Partial<ActivityEntry> = {}): ActivityEntry => ({
  id: "a1", start: "2026-11-03T09:10:00Z", end: "2026-11-03T10:25:00Z", title: "Fixed staging CI", summary: "", category: "", source: "", link: "",
  taskId: "", sourceKey: "", actor: "user", createdAt: "", updatedAt: "", revision: 2, ...overrides,
});
const tasks = [
  taskFixture({ id: "tsk_ci", title: "Fix staging CI" }),
  taskFixture({ id: "tsk_done", title: "Ship the release", status: "done" }),
  taskFixture({ id: "tsk_old", title: "Archived", archivedAt: "2026-10-01T00:00:00Z" }),
];
function mount(e = entry(), now = NOW) {
  const props = { onClose: vi.fn(), refresh: vi.fn(async () => {}) };
  render(<SessionEditor entry={e} tz="UTC" now={now} tasks={tasks} catalog={catalogFixture} {...props} />, { wrapper: TestProviders });
  return { props, user: userEvent.setup(), dialog: screen.getByRole("dialog") };
}

describe("editing a session", () => {
  it("saves every field, running past midnight", async () => {
    const success = vi.spyOn(toast, "success").mockImplementation(() => "");
    const { props, user, dialog } = mount();
    expect(within(dialog).queryByText(/checks leave it as you wrote it/)).toBeNull();
    fireEvent.change(within(dialog).getByLabelText("From"), { target: { value: "23:30" } });
    fireEvent.change(within(dialog).getByLabelText("To"), { target: { value: "00:15" } });
    expect(within(dialog).getByText("Ends the next day")).toBeDefined();
    fireEvent.click(within(dialog).getByRole("combobox", { name: "Kind of work" }));
    fireEvent.click(await screen.findByRole("option", { name: "Reviewing" }));
    fireEvent.click(within(dialog).getByRole("combobox", { name: "Task" }));
    expect(screen.queryByRole("option", { name: "Archived" })).toBeNull();
    fireEvent.click(await screen.findByRole("option", { name: "Ship the release (done)" }));
    await user.type(within(dialog).getByRole("textbox", { name: "Details" }), "Looked at **#412**");
    await user.type(within(dialog).getByRole("textbox", { name: "Link" }), "https://github.com/acme/web/pull/412");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(props.onClose).toHaveBeenCalled());
    expect(mock).toHaveBeenCalledWith("/activity/a1", "PUT", {
      entry: expect.objectContaining({
        start: "2026-11-03T23:30:00.000Z", end: "2026-11-04T00:15:00.000Z", category: "review", taskId: "tsk_done",
        summary: "Looked at **#412**", link: "https://github.com/acme/web/pull/412", source: "",
      }),
      expectedRevision: 2,
    });
    expect(props.refresh).toHaveBeenCalled();
    expect(success).toHaveBeenCalledWith("Activity updated");
  });
  it("opens a new session just after midnight on the evening it starts, and saves it as offered", async () => {
    const now = new Date("2026-11-04T00:10:00Z").valueOf();
    const { props, user, dialog } = mount(blankEntry("2026-11-04", "2026-11-04", now, "UTC"), now);
    expect(within(dialog).getByText(dayTitle("2026-11-03"))).toBeDefined();
    expect((within(dialog).getByLabelText("From") as HTMLInputElement).value).toBe("23:40");
    expect((within(dialog).getByLabelText("To") as HTMLInputElement).value).toBe("00:10");
    expect(within(dialog).getByText("Ends the next day")).toBeDefined();
    await user.type(within(dialog).getByRole("textbox", { name: "What you did" }), "Late fix");
    await user.click(within(dialog).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(props.onClose).toHaveBeenCalled());
    expect(mock).toHaveBeenCalledWith("/activity", "POST", { entry: expect.objectContaining({ start: "2026-11-03T23:40:00.000Z", end: "2026-11-04T00:10:00.000Z" }), expectedRevision: 0 });
  });
  it("saves once while a save is on its way, however it's asked for, and not at all when nothing changed", async () => {
    let finish!: () => void;
    mock.mockImplementation(() => new Promise(resolve => { finish = () => resolve({}); }));
    const { props, user, dialog } = mount(blankEntry("2026-11-04", "2026-11-04", NOW, "UTC"));
    const what = within(dialog).getByRole("textbox", { name: "What you did" });
    await user.type(what, "Reviewed the RFC");
    fireEvent.keyDown(what, { key: "Enter", metaKey: true });
    fireEvent.keyDown(within(dialog).getByRole("button", { name: "Close" }), { key: "Enter", ctrlKey: true });
    fireEvent.submit(dialog.querySelector("form")!);
    await waitFor(() => expect(mock).toHaveBeenCalledTimes(1));
    finish();
    await waitFor(() => expect(props.onClose).toHaveBeenCalled());
    expect(mock).toHaveBeenCalledTimes(1);
    mock.mockReset(); mock.mockResolvedValue({});
    const again = mount();
    fireEvent.submit(again.dialog.querySelector("form")!);
    await new Promise(r => setTimeout(r, 20));
    expect(mock).not.toHaveBeenCalled();
  });
  it("moves a session to another day, up to today", async () => {
    const { props, user, dialog } = mount(entry());
    // An existing session opens on the day it started.
    expect(within(dialog).getByText(dayTitle("2026-11-03"))).toBeDefined();
    await user.click(within(dialog).getByRole("button", { name: /^Day/ }));
    // A day is always set, and it can't be after today.
    expect(screen.queryByRole("button", { name: "Clear date" })).toBeNull();
    const typed = screen.getByRole("textbox", { name: "Date (YYYY-MM-DD)" });
    await user.clear(typed); await user.type(typed, "2026-11-05{Enter}");
    expect((await screen.findByRole("alert")).textContent).toMatch(/^Choose .+ or earlier\.$/);
    await user.clear(typed); await user.type(typed, "2026-11-02{Enter}");
    expect(within(dialog).getByText(dayTitle("2026-11-02"))).toBeDefined();
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(props.onClose).toHaveBeenCalled());
    expect(mock).toHaveBeenCalledWith("/activity/a1", "PUT", { entry: expect.objectContaining({ start: "2026-11-02T09:10:00.000Z", end: "2026-11-02T10:25:00.000Z" }), expectedRevision: 2 });
  });
  it("won't save a session that ends in the future, and shows a failed save", async () => {
    const { props, user, dialog } = mount(entry({ start: "2026-11-04T12:00:00Z", end: "2026-11-04T12:30:00Z" }));
    fireEvent.change(within(dialog).getByLabelText("To"), { target: { value: "15:00" } });
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe("A session can’t end in the future.");
    expect(mock).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText("To"), { target: { value: "12:45" } });
    mock.mockRejectedValueOnce(Error("Someone else changed this"));
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe("Someone else changed this");
    expect(props.onClose).not.toHaveBeenCalled();
  });
  it("asks before discarding changes", async () => {
    const { props, user, dialog } = mount(entry({ actor: "job:job_activity", source: "github" }));
    expect(within(dialog).getByText(/checks leave it as you wrote it/)).toBeDefined();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(props.onClose).toHaveBeenCalledOnce();
    await user.type(within(dialog).getByRole("textbox", { name: "What you did" }), " again");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await user.click(await screen.findByRole("button", { name: "Discard changes" }));
    expect(props.onClose).toHaveBeenCalledTimes(2);
    await user.keyboard("{Escape}");
  });
});
