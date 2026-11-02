import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { deferred, snapshotFixture, taskFixture, TestProviders } from "../test/fixtures";
import type { Entity, Snapshot } from "../types";
import { Organization, TagManager } from "./Organization";
vi.mock("../api", async original => ({ ...await original<typeof import("../api")>(), api: vi.fn() }));
const mock = vi.mocked(api);
beforeEach(() => { mock.mockReset(); mock.mockResolvedValue({}); });
const entity = (id: string, archived = false): Entity => ({ id, name: id, color: "blue", archived, icon: "folder" });
const populated = () => snapshotFixture({
  projects: [entity("Project A"), entity("Project B"), entity("Archived", true)], tags: [entity("Tag A"), entity("Tag B")],
  tasks: [taskFixture({ project: "Project A", tags: ["Tag A"] }), taskFixture({ id: "deleted", project: "Project A", tags: ["Tag A"], deletedAt: "2026-01-01" }), taskFixture({ id: "merged", project: "Project A", mergedInto: "tsk_test" }), taskFixture({ id: "archived", project: "Project A", archivedAt: "2026-01-01" })],
});
function mount(snapshot: Snapshot = snapshotFixture()) {
  const props = { snapshot, refresh: vi.fn(async () => {}), onProject: vi.fn() };
  return { ...render(<Organization {...props} />, { wrapper: TestProviders }), props, user: userEvent.setup() };
}
function mountTags(snapshot: Snapshot = snapshotFixture()) {
  const props = { snapshot, refresh: vi.fn(async () => {}) };
  return { ...render(<TagManager {...props} />, { wrapper: TestProviders }), props, user: userEvent.setup() };
}
async function choose(label: string, option: string) {
  fireEvent.click(screen.getByRole("combobox", { name: label }));
  fireEvent.click(await screen.findByRole("option", { name: option }));
}
const rowNames = (region: string) => within(screen.getByRole("region", { name: region })).getAllByRole("button").filter(b => !b.getAttribute("aria-label")?.startsWith("Edit") && !/^New /.test(b.textContent || "")).map(b => b.textContent);
describe("projects page", () => {
  it("dismisses clean editors with Escape and prevents repeated submits while persistence is pending", async () => {
    const { user } = mount(populated()); await user.click(screen.getByRole("button", { name: "Edit Project A" })); await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull(); await user.click(screen.getByRole("button", { name: "Edit Project A" }));
    const pending = deferred<unknown>(); mock.mockReturnValueOnce(pending.promise);
    const form = screen.getByRole("textbox", { name: "Name" }).closest("form")!; fireEvent.submit(form); fireEvent.submit(form);
    expect(mock).toHaveBeenCalledOnce(); await act(async () => pending.resolve({}));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
  it("creates a project with explicit fields and stable server persistence", async () => {
    const { props, user } = mount(); await user.click(screen.getByRole("button", { name: "New project" }));
    expect((screen.getByRole("button", { name: "Save project" }) as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Useful structure");
    await choose("Color", "Green"); await user.click(screen.getByRole("checkbox", { name: /Archived/ }));
    await user.click(screen.getByRole("button", { name: "Save project" }));
    await waitFor(() => expect(props.refresh).toHaveBeenCalledOnce());
    expect(mock).toHaveBeenCalledWith("/projects", "POST", expect.objectContaining({ name: "Useful structure", color: "green", archived: true, icon: "folder" }));
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
  it("lists only projects, counts board tasks, and routes clicks to the project board", async () => {
    const { props, user } = mount(populated());
    expect(screen.queryByRole("button", { name: "Tag A" })).toBeNull(); expect(screen.queryByText("Tags")).toBeNull();
    expect(screen.queryByRole("button", { name: "Archived Archived" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Project A" })); expect(props.onProject).toHaveBeenCalledWith("Project A");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.querySelector(".entity-row .entity-count")?.textContent).toBe("1 task");
    await user.click(screen.getByRole("checkbox", { name: "Show archived" }));
    expect(screen.getByRole("button", { name: "Edit Archived" })).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Archived Archived" }));
    expect(props.onProject).toHaveBeenLastCalledWith("Archived");
  });
  it("teaches the first project and reveals archived-only projects", async () => {
    const { rerender, props, user } = mount();
    expect(screen.getByRole("heading", { name: "Projects", level: 1 })).toBeDefined();
    expect(screen.getByRole("heading", { name: "No projects yet." })).toBeDefined();
    expect(screen.queryByRole("checkbox", { name: "Show archived" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Create a project" }));
    expect(screen.getByRole("dialog", { name: "New project" })).toBeDefined(); await user.keyboard("{Escape}");
    rerender(<Organization {...props} snapshot={snapshotFixture({ projects: [entity("Archived project", true)] })} />);
    expect(screen.getByRole("heading", { name: "No active projects." })).toBeDefined();
    await user.click(within(screen.getByRole("region", { name: "Projects" })).getByRole("button", { name: "Show archived" }));
    await user.click(screen.getByRole("button", { name: "Archived project Archived" }));
    expect(props.onProject).toHaveBeenCalledWith("Archived project");
  });
  it("lists every active project by name with natural numbering instead of stored ID order", () => {
    const { rerender, props } = mount();
    rerender(<Organization {...props} snapshot={snapshotFixture({ projects: Array.from({ length: 12 }, (_, i) => entity("Project " + i)) })} />);
    expect(within(screen.getByRole("region", { name: "Projects" })).getAllByRole("button", { name: /^Project \d+$/ })).toHaveLength(12);
    const named = (id: string, name: string) => ({ ...entity(id), name });
    rerender(<Organization {...props} snapshot={snapshotFixture({ projects: [named("a", "Project 10"), named("b", "project 2"), named("c", "Alpha"), named("d", "Alpha")] })} />);
    expect(rowNames("Projects")).toEqual(["Alpha", "Alpha", "project 2", "Project 10"]);
  });
  it("merges project assignments only after choosing an unarchived survivor and confirming", async () => {
    const { props, user } = mount(populated()); await user.click(screen.getByRole("button", { name: "Edit Project A" }));
    expect((screen.getByRole("button", { name: "Merge" }) as HTMLButtonElement).disabled).toBe(true);
    await choose("Merge into another", "Project B");
    await user.click(screen.getByRole("button", { name: "Merge" }));
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Merge organization" }));
    await waitFor(() => expect(props.refresh).toHaveBeenCalled());
    expect(mock).toHaveBeenCalledWith("/projects/Project A/merge", "POST", { target: "Project B" });
  });
});
describe("tag upkeep in settings", () => {
  it("lists tags by name with live task counts and edits a tag in place", async () => {
    const named = (id: string, name: string) => ({ ...entity(id), name });
    const { user } = mountTags(snapshotFixture({ tags: [named("t1", "zeta"), named("t2", "Beta")], tasks: [taskFixture({ tags: ["t1"] }), taskFixture({ id: "gone", tags: ["t1"], deletedAt: "2026-01-01" })] }));
    expect(rowNames("Tags")).toEqual(["Beta", "zeta"]);
    expect([...document.querySelectorAll(".entity-count")].map(n => n.textContent)).toEqual(["0 tasks", "1 task"]);
    await user.click(screen.getByRole("button", { name: "zeta" }));
    expect(screen.getByRole("dialog", { name: "Edit tag" })).toBeDefined();
  });
  it("creates a tag with explicit fields", async () => {
    const { props, user } = mountTags(); expect(screen.getByText("No tags yet. Add one from any task’s Tags field.")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "New tag" }));
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Waiting");
    await user.click(screen.getByRole("button", { name: "Save tag" }));
    await waitFor(() => expect(props.refresh).toHaveBeenCalledOnce());
    expect(mock).toHaveBeenCalledWith("/tags", "POST", expect.objectContaining({ name: "Waiting", color: "slate", icon: "tag", archived: false }));
  });
  it("keeps archived tags out of the way until asked for", async () => {
    const { user } = mountTags(snapshotFixture({ tags: [entity("Old tag", true)] }));
    expect(screen.getByText("Every tag is archived.")).toBeDefined();
    await user.click(screen.getByRole("checkbox", { name: "Show archived tags" }));
    expect(screen.getByRole("button", { name: "Old tag Archived" })).toBeDefined();
  });
  it("merges tag assignments only after choosing a survivor and confirming", async () => {
    const { props, user } = mountTags(populated()); await user.click(screen.getByRole("button", { name: "Edit Tag A" }));
    await choose("Merge into another", "Tag B");
    await user.click(screen.getByRole("button", { name: "Merge" }));
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Merge organization" }));
    await waitFor(() => expect(props.refresh).toHaveBeenCalled());
    expect(mock).toHaveBeenCalledWith("/tags/Tag A/merge", "POST", { target: "Tag B" });
  });
});
