import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { api, upload } from "../api";
import { newTask, type HistoryEntry, type Snapshot, type Task } from "../types";
import { catalogFixture, deferred, snapshotFixture, taskFixture, TestProviders } from "../test/fixtures";
import { TaskDetail } from "./TaskDetail";
import { useDraftGuard } from "./DraftGuard";
import type { ComponentProps } from "react";
const preference = vi.hoisted(() => ({ reduced: false }));
vi.mock("motion/react", async original => ({ ...await original<typeof import("motion/react")>(), useReducedMotion: () => preference.reduced }));

vi.mock("../api", async importOriginal => ({ ...await importOriginal<typeof import("../api")>(), api: vi.fn(), upload: vi.fn() }));
const apiMock = vi.mocked(api), uploadMock = vi.mocked(upload);
function GuardedSheet(props: ComponentProps<typeof TaskDetail>) {
  const { guard } = useDraftGuard();
  return <TaskDetail {...props} onOpen={task => guard(() => props.onOpen(task))} />;
}
beforeEach(() => { preference.reduced = false; apiMock.mockReset(); uploadMock.mockReset(); apiMock.mockImplementation(async path => path.includes("duplicates") ? [] : { history: [] }); });

function mount(initial = taskFixture(), overrides: Partial<Snapshot> = {}, history: HistoryEntry[] = []) {
  const props = {
    initial, snapshot: snapshotFixture({ tasks: [initial], ...overrides }), catalog: catalogFixture,
    onClose: vi.fn(), onSave: vi.fn(async (task: Task) => ({ ...task, revision: task.revision + 1 })),
    onOpen: vi.fn(), onAddChild: vi.fn(), refresh: vi.fn(async () => {}),
  };
  apiMock.mockImplementation(async path => path.includes("duplicates") ? [] : { history });
  const view = render(<GuardedSheet {...props} />, { wrapper: TestProviders });
  return { ...view, props, user: userEvent.setup() };
}
const save = () => screen.getByRole("button", { name: "Save changes" });
const editTitle = () => fireEvent.click(screen.getByRole("button", { name: "Edit task title" }));

describe("task sheet read, draft, and save contracts", () => {
  it("dismisses an unchanged sheet from its backdrop and retains the selected archived project", async () => {
    preference.reduced = true;
    const { props, user } = mount(taskFixture({ project: "archived" }), { projects: [{ id: "archived", name: "Archived reference", color: "sea", icon: "folder", archived: true }, { id: "other", name: "Hidden archive", color: "sea", icon: "folder", archived: true }] });
    await user.click(screen.getByRole("combobox", { name: "Project" }));
    expect(screen.getByRole("option", { name: "Archived reference" })).toBeDefined(); expect(screen.queryByRole("option", { name: "Hidden archive" })).toBeNull();
    await user.keyboard("{Escape}");
    fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: null } }); expect(uploadMock).not.toHaveBeenCalled();
    await user.pointer({ target: document.querySelector(".detail-backdrop")!, keys: "[MouseLeft]" });
    expect(props.onClose).toHaveBeenCalledOnce();
  });
  it("persists explicit focus changes and explains unnamed local images and history updates", async () => {
    const task = taskFixture({ description: "![](/api/images/img_" + "a".repeat(32) + ")" });
    const history: HistoryEntry = { id: 1, kind: "task", entityId: task.id, actor: "user", reason: "", at: task.updatedAt, before: { ...task, revision: 0 }, after: task };
    const { props, user } = mount(task, {}, [history]);
    expect(screen.getByRole("img", { name: "Task attachment" })).toBeDefined(); expect(await screen.findByText("Updated this task")).toBeDefined();
    await user.click(screen.getByRole("combobox", { name: "Focus" })); await user.click(screen.getByRole("option", { name: "Backlog only" }));
    await user.click(save()); expect(props.onSave).toHaveBeenCalledWith(expect.objectContaining({ today: false }));
  });
  it("keeps an optional blank description read-first and enters writing only by explicit action", async () => {
    const { user } = mount(taskFixture({ description: "" }));
    expect(screen.getByText("No description yet.")).toBeDefined();
    expect(screen.queryByRole("textbox", { name: "Markdown description" })).toBeNull();
    await user.click(screen.getByRole("tab", { name: "Edit description" }));
    expect(screen.getByRole("textbox", { name: "Markdown description" })).toBeDefined();
  });
  it("survives unavailable history and duplicate discovery without erasing the task", async () => {
    const task = taskFixture(); const view = mount(task);
    view.unmount(); apiMock.mockRejectedValue(new Error("Discovery unavailable"));
    render(<GuardedSheet {...view.props} />, { wrapper: TestProviders });
    await waitFor(() => expect(apiMock.mock.calls.some(([p]) => p.includes("duplicates"))).toBe(true));
    expect(screen.getByRole("heading", { name: task.title })).toBeDefined(); expect(screen.queryByRole("heading", { name: "Potential duplicates" })).toBeNull();
  });
  it("opens with a focused heading and Markdown preview, without an editing field", async () => {
    const { props } = mount(taskFixture({ description: "**Useful context** [Evidence](https://example.com)" }));
    expect(screen.queryByRole("textbox", { name: "Task title" })).toBeNull();
    expect(screen.getByText("Useful context").tagName).toBe("STRONG");
    expect(screen.getByRole("link", { name: "Evidence" }).getAttribute("rel")).toBe("noopener noreferrer");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: props.initial.title })));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" })); expect(props.onClose).toHaveBeenCalledOnce();
  });
  it("starts new tasks in writing mode and includes an unsubmitted checklist item on save", async () => {
    const { props, user } = mount(newTask());
    const create = screen.getByRole("button", { name: "Create task" }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    await user.type(screen.getByRole("textbox", { name: "Task title" }), "New useful task");
    await user.type(screen.getByRole("textbox", { name: "Markdown description" }), "Draft **context**");
    await user.type(screen.getByRole("textbox", { name: "New checklist item" }), "  Pending step  ");
    await user.click(create);
    await waitFor(() => expect(props.onClose).toHaveBeenCalledOnce());
    expect(props.onSave.mock.calls[0][0]).toMatchObject({ title: "New useful task", description: "Draft **context**", checklist: [{ title: "Pending step", done: false }] });
  });
  it("keeps the draft when dismissal is cancelled, and closes only after explicit discard", async () => {
    const { props, user } = mount(); editTitle();
    await user.type(screen.getByRole("textbox", { name: "Task title" }), " changed");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(props.onClose).not.toHaveBeenCalled();
    expect((screen.getByRole("textbox", { name: "Task title" }) as HTMLTextAreaElement).value).toContain("changed");
    await user.click(screen.getByRole("button", { name: "Close" }));
    await user.click(screen.getByRole("button", { name: "Discard changes" })); expect(props.onClose).toHaveBeenCalledOnce();
  });
  it("does not dismiss the sheet when Escape cancels an existing rename", async () => {
    const { props, user } = mount(); await user.click(screen.getByRole("button", { name: "Edit task title" }));
    await user.type(screen.getByRole("textbox", { name: "Task title" }), " discard{Escape}");
    expect(props.onClose).not.toHaveBeenCalled(); expect(screen.getByRole("heading", { name: props.initial.title })).toBeDefined();
    await user.keyboard("{Escape}"); expect(props.onClose).toHaveBeenCalledOnce();
  });
  it("shows failed saves and prevents duplicate submission or dismissal while saving", async () => {
    const { props } = mount(); const pending = deferred<Task>(); props.onSave.mockReturnValue(pending.promise);
    fireEvent.click(save()); fireEvent.submit(document.querySelector(".detail-form")!);
    expect(props.onSave).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" })); expect(props.onClose).not.toHaveBeenCalled();
    await act(async () => pending.reject(new Error("Disk is read-only")));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Disk is read-only");
    expect((save() as HTMLButtonElement).disabled).toBe(false);
  });
  it("preserves a conflicted draft and loads the current revision only after discard", async () => {
    const { props, rerender, user } = mount(); editTitle();
    await user.type(screen.getByRole("textbox", { name: "Task title" }), " draft");
    const current = { ...props.initial, title: "External winner", revision: 2 };
    rerender(<GuardedSheet {...props} snapshot={{ ...props.snapshot, tasks: [current] }} />);
    expect((save() as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("alert").textContent).toContain("Your draft is preserved");
    await user.click(screen.getByRole("button", { name: "Load latest version" }));
    expect(props.onSave).not.toHaveBeenCalled(); await user.click(screen.getByRole("button", { name: "Discard changes" }));
    expect((screen.getByRole("textbox", { name: "Task title" }) as HTMLTextAreaElement).value).toBe("External winner");
    expect((save() as HTMLButtonElement).disabled).toBe(false);
  });
  it("modifies tags and checklist independently, including Enter/Add/removal and pending steps", async () => {
    const task = taskFixture({ checklist: [{ id: "one", title: "First", done: false }, { id: "two", title: "Second", done: true }] });
    const { props, user } = mount(task, { tags: [{ id: "tag_1", name: "Research", color: "blue", archived: false, icon: "circle-check" }] });
    await user.click(screen.getByRole("button", { name: "Research" })); await user.click(screen.getByRole("button", { name: "Research" }));
    await user.click(screen.getByRole("checkbox", { name: "Complete First" }));
    await user.clear(screen.getAllByRole("textbox", { name: "Checklist item" })[0]);
    await user.type(screen.getAllByRole("textbox", { name: "Checklist item" })[0], "Renamed step");
    await user.click(screen.getAllByRole("button", { name: "Remove checklist item" })[1]);
    const input = screen.getByRole("textbox", { name: "New checklist item" });
    await user.type(input, "{Enter}Added by Enter{Enter}Added by button");
    await user.click(within(document.querySelector(".checklist") as HTMLElement).getByRole("button", { name: "Add" }));
    await user.click(save());
    const saved = props.onSave.mock.calls[0][0];
    expect(saved.tags).toEqual([]); expect(saved.checklist.map(c => [c.title, c.done])).toEqual([["Renamed step", true], ["Added by Enter", false], ["Added by button", false]]);
  });
  it("opens real subtasks/parents and never offers a second child level", async () => {
    const parent = taskFixture(), child = taskFixture({ id: "tsk_child", title: "Child", parentId: parent.id, status: "done" });
    const { props, user, unmount } = mount(parent, { tasks: [parent, child] });
    await user.click(screen.getByRole("button", { name: "Child" })); expect(props.onOpen).toHaveBeenCalledWith(child);
    await user.click(within(screen.getByRole("heading", { name: "Subtasks" }).parentElement!).getByRole("button", { name: "Add" })); expect(props.onAddChild).toHaveBeenCalledWith(parent.id);
    unmount(); const childView = mount(child, { tasks: [parent, child] });
    expect(screen.queryByRole("heading", { name: "Subtasks" })).toBeNull();
    await childView.user.click(screen.getByRole("button", { name: parent.title })); expect(childView.props.onOpen).toHaveBeenCalledWith(parent);
  });
  it.each([false, true])("confirms reversible deletion/restoration, deleted=%s", async deleted => {
    const { props, user } = mount(taskFixture({ deletedAt: deleted ? "2026-01-01T00:00:00Z" : "" }));
    const title = deleted ? "Restore task" : "Delete task";
    await user.click(screen.getByRole("button", { name: title }));
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: title }));
    await waitFor(() => expect(props.onClose).toHaveBeenCalled());
    expect(!!props.onSave.mock.calls[0][0].deletedAt).toBe(!deleted);
  });
  it("displays merge provenance and blocks saving a merged source", () => {
    mount(taskFixture({ mergedInto: "tsk_survivor", source: "" }));
    expect(screen.getByText(/Merged into tsk_survivor/)).toBeDefined();
    expect(screen.getByText("Source: manual")).toBeDefined(); expect((save() as HTMLButtonElement).disabled).toBe(true);
  });
  it("saves full task properties, civil dates, and parent assignment without native selects", async () => {
    const parent = taskFixture({ id: "parent", title: "Parent project task" }), task = taskFixture();
    const { props, user } = mount(task, { tasks: [task, parent], projects: [{ id: "p", name: "Project evidence", color: "sea", icon: "folder", archived: false }] });
    for (const [label, name] of [["Status", "In progress"], ["Priority", "High"], ["Project", "Project evidence"], ["Focus", "Today"], ["Parent task", parent.title]]) {
      await user.click(screen.getByRole("combobox", { name: label })); await user.click(await screen.findByRole("option", { name }));
    }
    for (const label of ["Due date", "Snooze until"]) {
      await user.click(screen.getByRole("button", { name: label })); await user.click(screen.getByRole("button", { name: "Today" }));
    }
    await user.click(save());
    expect(props.onSave.mock.calls[0][0]).toMatchObject({ status: "progress", priority: "high", project: "p", today: true, parentId: parent.id, dueDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), snoozedUntil: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
  });
  it("opens attachments by their stored names and invokes the local picker only on request", async () => {
    const task = taskFixture({ attachments: ["img_named"] });
    const { user } = mount(task, { attachments: [{ id: "img_named", name: "Research image", mime: "image/png", size: 3, hash: "fixture", width: 1, height: 1 }] });
    const picker = document.querySelector<HTMLInputElement>('input[type="file"]')!, click = vi.spyOn(picker, "click");
    await user.click(screen.getByRole("button", { name: "Attach image" })); expect(click).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Research image" })); expect(screen.getByRole("img", { name: "Full-size task attachment" }).getAttribute("src")).toBe("/api/images/img_named");
  });
  it("ignores history and suggestions that arrive after the sheet is unmounted", async () => {
    const history = deferred<{ history: HistoryEntry[] }>(), suggestions = deferred<[]>();
    const { unmount } = mount();
    // The first history call is already resolved; new title triggers a deferred suggestion.
    apiMock.mockImplementation(path => path.includes("duplicates") ? suggestions.promise : history.promise);
    await waitFor(() => expect(apiMock.mock.calls.some(([path]) => path.includes("duplicates"))).toBe(true));
    unmount(); await act(async () => { history.resolve({ history: [] }); suggestions.resolve([]); });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("safe local media and catalog icons", () => {
  it("preserves the Markdown image target when history arrives between pointer-down and click", async () => {
    const task = taskFixture({ description: `![Safe](/api/images/img_${"a".repeat(32)})` });
    const view = mount(task); view.unmount();
    const history = deferred<{ history: HistoryEntry[] }>();
    apiMock.mockImplementation(path => path.includes("duplicates") ? Promise.resolve([]) : history.promise);
    render(<GuardedSheet {...view.props} />, { wrapper: TestProviders });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: task.title })));
    const imageButton = screen.getByRole("button", { name: "Safe" });
    await view.user.pointer({ target: imageButton, keys: "[MouseLeft>]" });
    await act(async () => history.resolve({ history: [] }));
    expect(screen.getByRole("button", { name: "Safe" })).toBe(imageButton);
    await view.user.pointer({ keys: "[/MouseLeft]" });
    expect(await screen.findByRole("dialog", { name: "Task image" })).toBeDefined();
    await view.user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "Task details" })).toBeDefined();
  });
  it("blocks external Markdown images while allowing local images and a full-size viewer", async () => {
    const id = "img_" + "a".repeat(32);
    const { user } = mount(taskFixture({ description: `![Safe](/api/images/${id})\n\n![Blocked](https://example.com/track.png)` }));
    expect(screen.getByText("[External image blocked]")).toBeDefined(); expect(screen.queryByRole("img", { name: "Blocked" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Read the research notes" })));
    await user.click(screen.getByRole("button", { name: "Safe" }));
    expect(await screen.findByRole("dialog", { name: "Task image" })).toBeDefined();
    await user.keyboard("{Escape}"); expect(screen.queryByRole("dialog", { name: "Task image" })).toBeNull();
  });
  it("retains earlier successful uploads when a later file fails, and removes only the selected attachment", async () => {
    const { props, user } = mount();
    uploadMock.mockResolvedValueOnce({ attachment: { id: "img_first" }, url: "/api/images/img_first" } as Awaited<ReturnType<typeof upload>>).mockRejectedValueOnce(new Error("Unsupported image"));
    const picker = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    fireEvent.change(picker, { target: { files: [new File(["png"], "[first].png", { type: "image/png" }), new File(["svg"], "bad.svg")] } });
    expect((await screen.findByRole("alert")).textContent).toBe("Unsupported image");
    expect(document.querySelectorAll(".attachment-grid img")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Task attachment" })); await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Remove attachment" })); await user.click(save());
    expect(props.onSave.mock.calls[0][0].attachments).toEqual([]);
    expect(props.onSave.mock.calls[0][0].description).toContain("![first.png]");
  });
  it.each(["paste", "drop"])("intakes local files through %s without importing remote text", async event => {
    const { props, user } = mount(); const file = new File(["png"], "evidence.png", { type: "image/png" });
    uploadMock.mockResolvedValue({ attachment: { id: "img_local" }, url: "/api/images/img_local" } as Awaited<ReturnType<typeof upload>>);
    const form = document.querySelector(".detail-form")!;
    if (event === "paste") { fireEvent.paste(form, { clipboardData: { files: [file] } }); }
    else { fireEvent.dragOver(form, { dataTransfer: { types: ["Files"] } }); fireEvent.drop(form, { dataTransfer: { files: [file] } }); }
    await waitFor(() => expect(document.querySelector(".attachment-grid img")).not.toBeNull());
    await user.click(save()); expect(props.onSave.mock.calls[0][0].attachments).toEqual(["img_local"]);
    expect(uploadMock).toHaveBeenCalledWith(file);
  });
  it("ignores empty/nonimage intake and selects only an offline catalog icon", async () => {
    const { props, user } = mount(); const form = document.querySelector(".detail-form")!;
    fireEvent.paste(form, { clipboardData: { files: [new File(["x"], "notes.txt", { type: "text/plain" })] } });
    fireEvent.dragOver(form, { dataTransfer: { types: ["text/plain"] } }); fireEvent.drop(form, { dataTransfer: { files: [] } });
    fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: [] } }); expect(uploadMock).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Choose task icon" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Choose an icon" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Choose task icon" }));
    await user.type(screen.getByRole("textbox", { name: "Search icon catalog" }), "inbox");
    await user.click(screen.getByRole("button", { name: "Mail" })); await user.click(save());
    expect(props.onSave.mock.calls[0][0].icon).toBe("mail");
  });
});

describe("duplicates and linked history", () => {
  it("debounces suggestions, requires a reason, and merges only after explicit confirmation", async () => {
    const source = taskFixture(), target = taskFixture({ id: "tsk_target", title: "Related research" });
    const { props, user } = mount(source, { tasks: [source, target] });
    const survivor = { ...target, revision: 2 };
    apiMock.mockImplementation(async path => path.endsWith("/merge") ? { task: survivor } : path.includes("duplicates") ? [{ id: target.id, title: target.title, status: "open", score: 0.9, reasons: ["similar title"] }] : { history: [] });
    await screen.findByRole("heading", { name: "Potential duplicates" }); expect(props.onOpen).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Merge" }));
    const merge = screen.getByRole("button", { name: "Merge tasks" }) as HTMLButtonElement; expect(merge.disabled).toBe(true);
    await user.type(screen.getByRole("textbox", { name: "Merge reason" }), "Same evidence"); await user.click(merge);
    await waitFor(() => expect(props.onOpen).toHaveBeenCalledWith(survivor));
    expect(apiMock).toHaveBeenCalledWith("/tasks/tsk_test/merge", "POST", { target: target.id, revision: 1, targetRevision: 1, reason: "Same evidence" });
  });
  it("surfaces a merge failure instead of changing tasks", async () => {
    const target = taskFixture({ id: "tsk_target", title: "Related research" });
    const { props, user } = mount(taskFixture(), { tasks: [taskFixture(), target] });
    const error = vi.spyOn(toast, "error").mockReturnValue(1);
    apiMock.mockImplementation(async path => {
      if (path.endsWith("/merge")) throw new Error("Revision conflict");
      return path.includes("duplicates") ? [{ ...target, score: 1, reasons: [] }] : { history: [] };
    });
    await user.click(await screen.findByRole("button", { name: "Merge" }));
    await user.type(screen.getByRole("textbox", { name: "Merge reason" }), "Same work");
    await user.click(screen.getByRole("button", { name: "Merge tasks" }));
    await waitFor(() => expect(error).toHaveBeenCalledWith("Revision conflict")); expect(props.onOpen).not.toHaveBeenCalled();
  });
  it("opens duplicate suggestions only if their task still exists and can cancel a merge", async () => {
    const source = taskFixture(), target = taskFixture({ id: "target", title: "Related evidence" });
    const { props, user, rerender } = mount(source, { tasks: [source, target] });
    apiMock.mockImplementation(async path => path.includes("duplicates") ? [{ ...target, score: 1, reasons: [] }] : { history: [] });
    await user.click(await screen.findByRole("button", { name: /Related evidence/ })); expect(props.onOpen).toHaveBeenCalledWith(target);
    await user.click(screen.getByRole("button", { name: "Merge" })); await user.keyboard("{Escape}"); expect(screen.queryByRole("dialog", { name: "Merge into this task?" })).toBeNull();
    rerender(<GuardedSheet {...props} snapshot={{ ...props.snapshot, tasks: [source] }} />);
    await user.click(screen.getByRole("button", { name: /Related evidence/ })); expect(props.onOpen).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Merge" }));
    await user.type(screen.getByRole("textbox", { name: "Merge reason" }), "Target disappeared");
    await user.click(screen.getByRole("button", { name: "Merge tasks" }));
    expect(apiMock.mock.calls.some(([path]) => path.endsWith("/merge"))).toBe(false);
  });
  it("renders attribution and confirms History Undo before refreshing and closing", async () => {
    const { props, user } = mount(taskFixture(), {}, [
      { id: 1, kind: "task", entityId: "tsk_test", actor: "user", reason: "", at: "" },
      { id: 2, kind: "task", entityId: "tsk_test", actor: "agent", reason: "Verified evidence", at: "2026-01-02T12:00:00Z", before: taskFixture() },
    ]);
    expect(await screen.findByText("Created this task")).toBeDefined(); expect(screen.getByText("You")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Undo history entry 2" }));
    expect(apiMock).not.toHaveBeenCalledWith("/undo/2", "POST", {});
    await user.click(screen.getByRole("button", { name: "Undo change" }));
    await waitFor(() => expect(props.onClose).toHaveBeenCalled()); expect(props.refresh).toHaveBeenCalled();
  });
});
