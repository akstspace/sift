import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { deferred, snapshotFixture, taskFixture, TestProviders } from "../test/fixtures";
import type { Entity } from "../types";
import { Organization } from "./Organization";
vi.mock("../api", async original => ({ ...await original<typeof import("../api")>(), api: vi.fn() }));
const mock = vi.mocked(api);
beforeEach(() => { mock.mockReset(); mock.mockResolvedValue({}); });
const entity = (id: string, archived = false): Entity => ({ id, name: id, color: "blue", archived, icon: "folder" });
function mount(populated = false) {
  const props = { snapshot: snapshotFixture(populated ? {
    projects: [entity("Project A"), entity("Project B"), entity("Archived", true)], tags: [entity("Tag A"), entity("Tag B")],
    tasks: [taskFixture({ project: "Project A", tags: ["Tag A"] }), taskFixture({ id: "deleted", project: "Project A", deletedAt: "2026-01-01" })],
  } : {}), refresh: vi.fn(async () => {}), onProject: vi.fn() };
  return { ...render(<Organization {...props} />, { wrapper: TestProviders }), props, user: userEvent.setup() };
}
async function choose(label: string, option: string) {
  fireEvent.click(screen.getByRole("combobox", { name: label }));
  fireEvent.click(await screen.findByRole("option", { name: option }));
}
describe("shared projects and tags", () => {
  it("dismisses clean editors with Escape and prevents repeated submits while persistence is pending", async () => {
    const { user } = mount(true); await user.click(screen.getByRole("button", { name: "Edit Project A" })); await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull(); await user.click(screen.getByRole("button", { name: "Edit Project A" }));
    const pending = deferred<unknown>(); mock.mockReturnValueOnce(pending.promise);
    const form = screen.getByRole("textbox", { name: "Name" }).closest("form")!; fireEvent.submit(form); fireEvent.submit(form);
    expect(mock).toHaveBeenCalledOnce(); await act(async () => pending.resolve({}));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
  it.each(["project", "tag"])("creates a %s with explicit fields and stable server persistence", async kind => {
    const { props, user } = mount(); await user.click(screen.getByRole("button", { name: "New " + kind }));
    expect((screen.getByRole("button", { name: "Save " + kind }) as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Useful structure");
    await choose("Color", "Green"); await user.click(screen.getByRole("checkbox", { name: /Archived/ }));
    await user.click(screen.getByRole("button", { name: "Save " + kind }));
    await waitFor(() => expect(props.refresh).toHaveBeenCalledOnce());
    expect(mock).toHaveBeenCalledWith("/" + kind + "s", "POST", expect.objectContaining({ name: "Useful structure", color: "green", archived: true }));
  });
  it("keeps failed saves and unsaved dismissals recoverable", async () => {
    const { user } = mount(); mock.mockRejectedValueOnce(new Error("Cannot persist"));
    await user.click(screen.getByRole("button", { name: "New project" }));
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Draft");
    await user.click(screen.getByRole("button", { name: "Save project" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Cannot persist");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    expect((screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("Draft");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("filters archived entities and routes project clicks without opening an editor", async () => {
    const { props, user } = mount(true);
    expect(screen.queryByRole("button", { name: "Archived Archived" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Project A" })); expect(props.onProject).toHaveBeenCalledWith("Project A");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.querySelector(".entity-row .muted")?.textContent).toBe("1 tasks");
    await user.click(screen.getByRole("checkbox", { name: "Show archived" }));
    expect(screen.getByRole("button", { name: "Edit Archived" })).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Tag A" }));
    expect(screen.getByRole("dialog", { name: "Edit tag" })).toBeDefined();
  });
  it.each(["project", "tag"])("merges %s assignments only after choosing an unarchived survivor and confirming", async kind => {
    const { props, user } = mount(true); await user.click(screen.getByRole("button", { name: "Edit " + (kind === "project" ? "Project A" : "Tag A") }));
    expect((screen.getByRole("button", { name: "Merge" }) as HTMLButtonElement).disabled).toBe(true);
    await choose("Merge into another", kind === "project" ? "Project B" : "Tag B");
    await user.click(screen.getByRole("button", { name: "Merge" }));
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Merge organization" }));
    await waitFor(() => expect(props.refresh).toHaveBeenCalled());
    expect(mock).toHaveBeenCalledWith("/" + kind + "s/" + (kind === "project" ? "Project A" : "Tag A") + "/merge", "POST", { target: kind === "project" ? "Project B" : "Tag B" });
  });
});
