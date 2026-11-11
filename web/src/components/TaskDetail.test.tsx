import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { api, upload } from "../api";
import { newTask, type HistoryEntry, type Snapshot, type Task } from "../types";
import { catalogFixture, jobFixture, deferred, snapshotFixture, taskFixture, TestProviders } from "../test/fixtures";
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
  it("asks for a Done reason on save, preserves the draft on cancel, and retries a failed completion", async () => {
    const { props, user } = mount();
    await user.click(screen.getByRole("combobox", { name: "Status" })); await user.click(screen.getByRole("option", { name: "Done" }));
    await user.click(save()); expect(props.onSave).not.toHaveBeenCalled();
    await user.click(within(screen.getByRole("dialog", { name: "Mark task Done" })).getByRole("button", { name: "Cancel" }));
    expect(props.onClose).not.toHaveBeenCalled(); expect(screen.getByRole("combobox", { name: "Status" }).textContent).toBe("Done");
    await user.click(save()); await user.type(screen.getByRole("textbox", { name: "Done reason" }), "Checked the delivered work");
    props.onSave.mockRejectedValueOnce(Error("Active subtasks remain"));
    await user.click(screen.getByRole("button", { name: "Mark Done" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Active subtasks remain");
    await user.click(screen.getByRole("button", { name: "Mark Done" }));
    await waitFor(() => expect(props.onClose).toHaveBeenCalledOnce());
    expect(props.onSave).toHaveBeenLastCalledWith(expect.objectContaining({ status: "done" }), "Checked the delivered work");
  });
  it("saves a completion with a blank optional reason once, without asking again", async () => {
    const { props, user } = mount();
    await user.click(screen.getByRole("combobox", { name: "Status" })); await user.click(screen.getByRole("option", { name: "Done" }));
    await user.click(save());
    await user.click(within(screen.getByRole("dialog", { name: "Mark task Done" })).getByRole("button", { name: "Mark Done" }));
    await waitFor(() => expect(props.onClose).toHaveBeenCalledOnce());
    expect(props.onSave).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: "done" }), "");
    expect(screen.queryByRole("dialog", { name: "Mark task Done" })).toBeNull();
  });
  it("asks for a reason when creating directly in Done but not editing an already completed task", async () => {
    const fresh = newTask(); fresh.status = "done";
    const view = mount(fresh); await view.user.type(screen.getByRole("textbox", { name: "Task title" }), "Already completed");
    await view.user.click(screen.getByRole("button", { name: "Create task" }));
    expect(view.props.onSave).not.toHaveBeenCalled();
    await view.user.type(screen.getByRole("textbox", { name: "Done reason" }), "Finished before recording");
    await view.user.click(screen.getByRole("button", { name: "Mark Done" }));
    await waitFor(() => expect(view.props.onClose).toHaveBeenCalledOnce()); view.unmount();
    const done = mount(taskFixture({ status: "done" })); await done.user.click(save());
    expect(done.props.onSave).toHaveBeenCalledOnce(); expect(screen.queryByRole("dialog", { name: "Mark task Done" })).toBeNull();
  });
  it("posts a comment without saving task edits and renders it as safe attributed activity without Undo", async () => {
    const { props, user } = mount(); editTitle();
    await user.type(screen.getByRole("textbox", { name: "Task title" }), " unsaved");
    const comment = screen.getByRole("textbox", { name: "Add a comment" });
    await user.type(comment, "<script>not executable</script>\nA useful update");
    apiMock.mockImplementation(async path => path.endsWith("/comments") ? { id: 42, kind: "comment", entityId: props.initial.id, actor: "user", reason: "<script>not executable</script>\nA useful update", at: "2026-11-02T12:00:00Z" } : path.includes("duplicates") ? [] : { history: [] });
    fireEvent.keyDown(comment, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect((comment as HTMLTextAreaElement).value).toBe(""));
    expect(apiMock).toHaveBeenCalledWith("/tasks/tsk_test/comments", "POST", { text: "<script>not executable</script>\nA useful update", requestId: expect.any(String) });
    expect(props.onSave).not.toHaveBeenCalled(); expect(props.onClose).not.toHaveBeenCalled();
    const activity = screen.getByRole("list", { name: "Task activity" });
    expect(activity.textContent).toContain("You"); expect(activity.textContent).toContain("A useful update"); expect(activity.querySelector("script")).toBeNull();
    expect(within(activity).queryByRole("button", { name: "Undo history entry 42" })).toBeNull();
    expect((screen.getByRole("textbox", { name: "Task title" }) as HTMLTextAreaElement).value).toContain("unsaved");
  });
  it("asks the person to review an agent's status change, and clears it on Looks good", async () => {
    const before = taskFixture({ revision: 1 }), after = taskFixture({ status: "done", revision: 2, agentChange: "chat" });
    const change: HistoryEntry = { id: 7, kind: "task", entityId: after.id, actor: "chat", reason: "CI passed at dc2ea74", at: "2026-11-03T16:00:00Z", before, after };
    const { props, user } = mount(after, {}, [change]);
    const line = (await screen.findByText("CI passed at dc2ea74", { selector: ".agent-review-reason" })).closest(".agent-review") as HTMLElement;
    expect(line.textContent).toContain("Sift moved this to Done");
    apiMock.mockImplementation(async path => path.endsWith("/review") ? { ...after, agentChange: undefined } : path.includes("duplicates") ? [] : { history: [change] });
    await user.click(within(line).getByRole("button", { name: "Looks good" }));
    expect(apiMock).toHaveBeenCalledWith("/tasks/" + after.id + "/review", "POST", {});
    expect(props.refresh).toHaveBeenCalled();
    // Undo goes through the same confirmation as Activity.
    await user.click(within(line).getByRole("button", { name: "Undo" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Undo change" }));
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith("/undo/7", "POST", {}));
    expect(props.onClose).toHaveBeenCalled();
  });
  it("keeps the review line when reviewing fails, and hides Undo once newer changes exist", async () => {
    const after = taskFixture({ status: "done", revision: 3, agentChange: "job:job_1" });
    const change: HistoryEntry = { id: 8, kind: "task", entityId: after.id, actor: "job:job_1", reason: "", at: "2026-11-03T16:00:00Z", before: taskFixture(), after: { ...after, revision: 2 } };
    const { user } = mount(after, { jobs: [jobFixture({ id: "job_1", name: "Morning planning" })] }, [change]);
    const line = (await screen.findByText("Morning planning", { selector: ".agent-review strong" })).closest(".agent-review") as HTMLElement;
    expect(line.textContent).toContain("Morning planning moved this to Done.");
    expect(within(line).queryByRole("button", { name: "Undo" })).toBeNull();
    apiMock.mockImplementation(async path => { if (path.endsWith("/review")) throw new Error("Reviews paused during backup/update"); return path.includes("duplicates") ? [] : { history: [change] }; });
    await user.click(within(line).getByRole("button", { name: "Looks good" }));
    expect((await within(line).findByRole("alert")).textContent).toBe("Reviews paused during backup/update");
    expect((within(line).getByRole("button", { name: "Looks good" }) as HTMLButtonElement).disabled).toBe(false);
  });
  it("shows no review line for a task without an unreviewed agent change", async () => {
    mount(taskFixture({ status: "done", agentChange: "chat", deletedAt: "2026-11-03T16:00:00Z" }));
    await screen.findByRole("list", { name: "Task activity" }).catch(() => {});
    expect(document.querySelector(".agent-review")).toBeNull();
  });
  it("says why Save did nothing right beside Save, until that's dealt with", async () => {
    const { props, user } = mount(); const input = screen.getByRole("textbox", { name: "Add a comment" });
    await user.type(input, "Draft note");
    await user.click(save());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Post or clear your comment before saving task changes.");
    // Outside the scrolling task, just above the actions: visible wherever the task is scrolled to.
    expect(alert.closest(".detail-scroll")).toBeNull();
    expect(alert.nextElementSibling?.tagName).toBe("FOOTER");
    await user.clear(input);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(props.onSave).not.toHaveBeenCalled();
  });
  it("lets an unadded tag's refusal go once the tag is cleared or added", async () => {
    const { props, user } = mount(taskFixture(), { tags: [{ id: "tag_1", name: "Research", color: "blue", archived: false, icon: "tag" }] });
    const input = screen.getByRole("textbox", { name: "New tag name" });
    await user.type(input, "release");
    await user.click(save());
    expect((await screen.findByRole("alert")).textContent).toBe("Add or clear the new tag before saving task changes.");
    await user.clear(input);
    expect(screen.queryByRole("alert")).toBeNull();
    // A new tag is asked about at the next Save, not while it's typed.
    await user.type(input, "research");
    expect(screen.queryByRole("alert")).toBeNull();
    await user.click(save());
    expect((await screen.findByRole("alert")).textContent).toContain("Add or clear the new tag");
    // Adding it (here, reusing the existing tag) settles it too.
    await user.type(input, "{Enter}");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(props.onSave).not.toHaveBeenCalled();
  });
  it("preserves a failed comment and reuses its request ID on retry, protecting unposted comments", async () => {
    const { props, user } = mount(); const input = screen.getByRole("textbox", { name: "Add a comment" });
    expect((screen.getByRole("button", { name: "Post comment" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(input, { key: "Enter", metaKey: true }); expect(props.onSave).not.toHaveBeenCalled();
    await user.type(input, "Context to retain");
    await user.click(save()); expect((await screen.findByRole("alert")).textContent).toContain("Post or clear"); expect(props.onSave).not.toHaveBeenCalled();
    apiMock.mockImplementation(async path => { if (path.endsWith("/comments")) throw Error("Connection lost"); return path.includes("duplicates") ? [] : { history: [] }; });
    await user.click(screen.getByRole("button", { name: "Post comment" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Connection lost"); expect((input as HTMLTextAreaElement).value).toBe("Context to retain");
    const first = apiMock.mock.calls.find(([path]) => path.endsWith("/comments"))![2];
    await user.click(screen.getByRole("button", { name: "Cancel" })); expect(screen.getByRole("alertdialog")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    const pending = deferred<HistoryEntry>(); apiMock.mockImplementation(async path => path.endsWith("/comments") ? pending.promise : path.includes("duplicates") ? [] : { history: [] });
    fireEvent.click(screen.getByRole("button", { name: "Post comment" })); fireEvent.keyDown(input, { key: "Enter", metaKey: true });
    expect(apiMock.mock.calls.filter(([path]) => path.endsWith("/comments"))).toHaveLength(2);
    expect(apiMock.mock.calls.filter(([path]) => path.endsWith("/comments"))[1][2]).toEqual(first);
    await act(async () => pending.resolve({ id: 5, kind: "comment", actor: "user", entityId: props.initial.id, reason: "Context to retain", at: "" }));
  });
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
  it("explains unnamed local images and history updates, and offers no Focus choice", async () => {
    const task = taskFixture({ description: "![](/api/images/img_" + "a".repeat(32) + ")" });
    const history: HistoryEntry = { id: 1, kind: "task", entityId: task.id, actor: "user", reason: "", at: task.updatedAt, before: { ...task, revision: 0 }, after: task };
    mount(task, {}, [history]);
    expect(screen.getByRole("img", { name: "Task attachment" })).toBeDefined(); expect(await screen.findByText("Updated this task")).toBeDefined();
    expect(screen.queryByRole("combobox", { name: "Focus" })).toBeNull();
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
  it("creates a tag where it is used, reuses same-named tags, and keeps archived tags only where applied", async () => {
    const task = taskFixture({ tags: ["tag_old"] });
    const { props, user } = mount(task, { tags: [{ id: "tag_1", name: "Research", color: "blue", archived: false, icon: "tag" }, { id: "tag_old", name: "Legacy", color: "slate", archived: true, icon: "tag" }, { id: "tag_hidden", name: "Hidden", color: "slate", archived: true, icon: "tag" }] });
    expect(screen.getByRole("button", { name: "Legacy" })).toBeDefined(); expect(screen.queryByRole("button", { name: "Hidden" })).toBeNull();
    const input = screen.getByRole("textbox", { name: "New tag name" }), add = within(input.parentElement!).getByRole("button", { name: "Add" });
    expect((add as HTMLButtonElement).disabled).toBe(true);
    await user.type(input, " research {Enter}");
    expect(apiMock).not.toHaveBeenCalledWith("/tags", "POST", expect.anything()); expect((input as HTMLInputElement).value).toBe("");
    apiMock.mockImplementation(async (path, method) => path === "/tags" && method === "POST" ? { id: "tag_new", name: "Waiting", color: "slate", archived: false, icon: "tag" } : path.includes("duplicates") ? [] : { history: [] });
    await user.type(input, "Waiting"); await user.click(add);
    await waitFor(() => expect(props.refresh).toHaveBeenCalledOnce());
    expect(apiMock).toHaveBeenCalledWith("/tags", "POST", { id: "", name: "Waiting", color: "slate", icon: "tag", archived: false });
    await user.click(save());
    expect(props.onSave.mock.calls[0][0].tags).toEqual(["tag_old", "tag_1", "tag_new"]);
  });
  it("keeps a typed tag recoverable when creation fails or the task is saved first", async () => {
    const { props, user } = mount();
    expect(screen.getByRole("textbox", { name: "New tag name" }).getAttribute("placeholder")).toBe("Add the first tag…");
    const input = screen.getByRole("textbox", { name: "New tag name" });
    await user.type(input, "Blocked");
    await user.click(save()); expect(props.onSave).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toBe("Add or clear the new tag before saving task changes.");
    const pending = deferred<unknown>(); apiMock.mockImplementation(async (path, method) => path === "/tags" && method === "POST" ? pending.promise : path.includes("duplicates") ? [] : { history: [] });
    fireEvent.keyDown(input, { key: "Enter" }); fireEvent.keyDown(input, { key: "Enter" });
    expect(apiMock.mock.calls.filter(([path]) => path === "/tags")).toHaveLength(1);
    expect(screen.getByText("Adding")).toBeDefined();
    await act(async () => pending.reject(new Error("Tag name already used")));
    expect((await screen.findByRole("alert")).textContent).toBe("Tag name already used");
    expect((input as HTMLInputElement).value).toBe("Blocked");
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
  it("reopens an archived task without discarding history and handles a failed save", async () => {
    const task = taskFixture({ status: "done", archivedAt: "2026-01-12T00:00:00Z", completedAt: "2026-01-02T00:00:00Z" });
    const { props, user } = mount(task);
    expect(screen.getByText(/Reopen this task to return it to All tasks/)).toBeDefined();
    props.onSave.mockRejectedValueOnce(new Error("Workspace busy"));
    await user.click(screen.getByRole("button", { name: "Reopen task" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Workspace busy");
    expect(props.onClose).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Reopen task" }));
    await waitFor(() => expect(props.onClose).toHaveBeenCalledOnce());
    expect(props.onSave).toHaveBeenLastCalledWith(expect.objectContaining({ id: task.id, status: "open", revision: task.revision, archivedAt: task.archivedAt }), "Reopen archived task");
  });
  it("saves full task properties, civil dates, and parent assignment without native selects", async () => {
    const parent = taskFixture({ id: "parent", title: "Parent project task" }), task = taskFixture();
    const { props, user } = mount(task, { tasks: [task, parent], projects: [{ id: "p", name: "Project evidence", color: "sea", icon: "folder", archived: false }] });
    for (const [label, name] of [["Status", "In progress"], ["Priority", "High"], ["Project", "Project evidence"], ["Parent task", parent.title]]) {
      await user.click(screen.getByRole("combobox", { name: label })); await user.click(await screen.findByRole("option", { name }));
    }
    for (const label of ["Due date", "Snooze until"]) {
      // Named by its label, then what it shows.
      await user.click(screen.getByRole("button", { name: new RegExp(`^${label} (Set due date|Set date)$`) })); await user.click(screen.getByRole("button", { name: "Today" }));
    }
    await user.click(save());
    expect(props.onSave.mock.calls[0][0]).toMatchObject({ status: "progress", priority: "high", project: "p", parentId: parent.id, dueDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), snoozedUntil: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
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
  it("switches between side panel and full page without losing what's in it", async () => {
    const onViewChange = vi.fn();
    const task = taskFixture();
    const props = { initial: task, snapshot: snapshotFixture({ tasks: [task] }), catalog: catalogFixture, onClose: vi.fn(), onSave: vi.fn(async (t: Task) => t), onOpen: vi.fn(), onAddChild: vi.fn(), refresh: vi.fn(async () => {}), onViewChange };
    const view = render(<GuardedSheet {...props} view="panel" />, { wrapper: TestProviders });
    const user = userEvent.setup();
    editTitle(); await user.type(screen.getByRole("textbox", { name: "Task title" }), " soon");
    const description = screen.getByRole("heading", { name: "Description" });
    await user.click(screen.getByRole("button", { name: "Open as full page" }));
    expect(onViewChange).toHaveBeenCalledWith("page");
    view.rerender(<GuardedSheet {...props} view="page" />);
    const sheet = screen.getByRole("dialog", { name: "Task details" });
    expect(sheet.className).toContain("is-page");
    // The same parts carry over, unsaved title and all.
    expect(description.isConnected).toBe(true);
    expect((screen.getByRole("textbox", { name: "Task title" }) as HTMLTextAreaElement).value).toContain(" soon");
    await user.click(within(sheet).getByRole("button", { name: "Open as side panel" }));
    expect(onViewChange).toHaveBeenLastCalledWith("panel");
    view.unmount();
    // A phone's panel already fills the screen: no switch, whatever was chosen.
    const media = vi.mocked(window.matchMedia), wide = media.getMockImplementation()!;
    media.mockImplementation(query => ({ ...wide(query), matches: true }));
    try {
      render(<GuardedSheet {...props} view="page" />, { wrapper: TestProviders });
      expect(screen.getByRole("dialog", { name: "Task details" }).className).not.toContain("is-page");
      expect(screen.queryByRole("button", { name: /Open as/ })).toBeNull();
    } finally { media.mockImplementation(wide); }
  });
  it("lays a wide full page out beside its properties and names the task once its title scrolls away", async () => {
    const watchers: IntersectionObserverCallback[] = [];
    vi.stubGlobal("IntersectionObserver", class { constructor(cb: IntersectionObserverCallback) { watchers.push(cb); } observe() {} disconnect() {} });
    const task = taskFixture({ title: "Fix staging CI" });
    const props = { initial: task, snapshot: snapshotFixture({ tasks: [task] }), catalog: catalogFixture, onClose: vi.fn(), onSave: vi.fn(async (t: Task) => t), onOpen: vi.fn(), onAddChild: vi.fn(), refresh: vi.fn(async () => {}), onViewChange: vi.fn() };
    const scrollAway = (away: boolean) => act(() => watchers.at(-1)!([{ isIntersecting: !away } as IntersectionObserverEntry], {} as IntersectionObserver));
    const named = () => document.querySelector(".detail-top-task .is-shown")?.textContent ?? null;
    const view = render(<GuardedSheet {...props} view="panel" />, { wrapper: TestProviders });
    const properties = () => screen.getByRole("group", { name: "Properties" });
    // The panel keeps its order: properties, the task, then where it sits among other tasks.
    expect(within(properties()).queryByText("Parent task")).toBeNull();
    expect(screen.getByText("Parent task").compareDocumentPosition(screen.getByRole("heading", { name: "Subtasks" })) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    // The panel never repeats the title: the board behind it shows which task is open.
    scrollAway(true);
    expect(named()).toBeNull();
    const media = vi.mocked(window.matchMedia), narrow = media.getMockImplementation()!;
    media.mockImplementation(query => ({ ...narrow(query), matches: query === "(min-width: 920px)" }));
    try {
      view.rerender(<GuardedSheet {...props} view="page" />);
      expect(within(properties()).getByText("Parent task")).toBeTruthy();
      expect(named()).toBe("Fix staging CI");
      expect(document.querySelector(".detail-top-task")!.getAttribute("aria-hidden")).toBe("true");
      scrollAway(false);
      expect(named()).toBeNull();
    } finally { media.mockImplementation(narrow); }
  });
  it("keeps the place being read when switching views", async () => {
    const task = taskFixture();
    const props = { initial: task, snapshot: snapshotFixture({ tasks: [task] }), catalog: catalogFixture, onClose: vi.fn(), onSave: vi.fn(async (t: Task) => t), onOpen: vi.fn(), onAddChild: vi.fn(), refresh: vi.fn(async () => {}), onViewChange: vi.fn() };
    // A stand-in layout: the panel stacks title, properties, then content; the page puts the properties beside the content.
    const proto = HTMLElement.prototype, top = Object.getOwnPropertyDescriptor(proto, "offsetTop")!, height = Object.getOwnPropertyDescriptor(proto, "offsetHeight")!;
    const place = (el: HTMLElement) => {
      const onPage = !!el.closest(".is-page"), parent = el.parentElement!, index = [...parent.children].indexOf(el);
      if (el.classList.contains("task-page-head")) return [0, 100];
      if (parent.classList.contains("task-page-side")) return [(onPage ? 0 : 100) + index * 60, 60];
      if (parent.classList.contains("task-page-body")) return [100 + (onPage ? 0 : parent.parentElement!.querySelector(".task-page-side")!.children.length * 60) + index * 200, 200];
      return [0, 0];
    };
    Object.defineProperty(proto, "offsetTop", { configurable: true, get(this: HTMLElement) { return place(this)[0]; } });
    Object.defineProperty(proto, "offsetHeight", { configurable: true, get(this: HTMLElement) { return place(this)[1]; } });
    try {
      const view = render(<GuardedSheet {...props} view="panel" />, { wrapper: TestProviders });
      const user = userEvent.setup();
      const box = document.querySelector<HTMLElement>(".detail-scroll")!, side = box.querySelector<HTMLElement>(".task-page-side")!;
      const body = [...box.querySelector(".task-page-body")!.children] as HTMLElement[];
      expect(body.length).toBeGreaterThan(2);
      // Reading the third part of the content in the panel: it stays 20px above the top on the page.
      box.scrollTop = body[2].offsetTop + 20;
      await user.click(screen.getByRole("button", { name: "Open as full page" }));
      side.style.position = "sticky";
      view.rerender(<GuardedSheet {...props} view="page" />);
      expect(box.scrollTop).toBe(body[2].offsetTop + 20);
      // On the page the pinned properties are always in view; the content being read decides.
      box.scrollTop = body[1].offsetTop + 10;
      await user.click(screen.getByRole("button", { name: "Open as side panel" }));
      side.style.position = "";
      view.rerender(<GuardedSheet {...props} view="panel" />);
      expect(box.scrollTop).toBe(body[1].offsetTop + 10);
      // Properties being read in the panel sit beside the title on the page, at its top.
      box.scrollTop = 120;
      await user.click(screen.getByRole("button", { name: "Open as full page" }));
      side.style.position = "sticky";
      view.rerender(<GuardedSheet {...props} view="page" />);
      expect(box.scrollTop).toBe(0);
    } finally {
      Object.defineProperty(proto, "offsetTop", top);
      Object.defineProperty(proto, "offsetHeight", height);
    }
  });
  it("keeps the time editor's submit, shortcut, paste and cancel to itself", async () => {
    const { props, user } = mount(taskFixture({ id: "tsk_ci", title: "Fix staging CI" }), { jobs: [jobFixture({ id: "job_activity", kind: "activity" })] });
    const page = { entries: [], checks: [], gaps: [], tracker: null, defaultPrompt: "", defaultTimes: [], categories: [], lookbackDays: 7 };
    apiMock.mockImplementation(async path => path.includes("duplicates") ? [] : path.startsWith("/activity?task=") ? page : path === "/activity" ? {} : { history: [] });
    // The task has an unsaved change behind the editor.
    editTitle(); await user.type(screen.getByRole("textbox", { name: "Task title" }), " today");
    await user.click(await screen.findByRole("button", { name: "Add time" }));
    let dialog = await screen.findByRole("dialog", { name: "Add activity" });
    // Cancelling an untouched editor doesn't ask about the task's draft.
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add activity" })).toBeNull());
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Add time" }));
    dialog = await screen.findByRole("dialog", { name: "Add activity" });
    const what = within(dialog).getByRole("textbox", { name: "What you did" });
    await user.type(what, "Paired on the deploy");
    // Pasting an image into the editor doesn't attach it to the task.
    fireEvent.paste(within(dialog).getByRole("textbox", { name: "Details" }), { clipboardData: { files: [new File(["png"], "shot.png", { type: "image/png" })] } });
    fireEvent.drop(within(dialog).getByRole("textbox", { name: "Details" }), { dataTransfer: { files: [new File(["png"], "shot.png", { type: "image/png" })] } });
    expect(uploadMock).not.toHaveBeenCalled();
    // A session the service turns down doesn't save the task either.
    const reads = apiMock.getMockImplementation()!;
    apiMock.mockImplementationOnce(async () => { throw Error("Linked task not found"); });
    fireEvent.keyDown(what, { key: "Enter", metaKey: true });
    expect((await within(dialog).findByRole("alert")).textContent).toBe("Linked task not found");
    expect(props.onSave).not.toHaveBeenCalled();
    apiMock.mockImplementation(reads);
    fireEvent.keyDown(what, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith("/activity", "POST", expect.objectContaining({ entry: expect.objectContaining({ title: "Paired on the deploy", taskId: "tsk_ci" }) })));
    expect(props.onSave).not.toHaveBeenCalled();
    // The panel's own shortcut still saves the task.
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Task title" }), { key: "Enter", metaKey: true });
    await waitFor(() => expect(props.onSave).toHaveBeenCalledOnce());
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
