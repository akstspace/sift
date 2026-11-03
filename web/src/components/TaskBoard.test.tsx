import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { catalogFixture, jobFixture, snapshotFixture, taskFixture, TestProviders } from "../test/fixtures";
import type { Task } from "../types";
import { columnCoordinates, TaskBoard } from "./TaskBoard";
const preference = vi.hoisted(() => ({ reduced: false }));
vi.mock("motion/react", async original => ({ ...await original<typeof import("motion/react")>(), useReducedMotion: () => preference.reduced }));
beforeEach(() => { preference.reduced = false; });

function mount(tasks: Task[] = [], view = "board", allTasks = tasks, filtered = false) {
  const props = { tasks, allTasks, view, columns: snapshotFixture().columns, projects: [{ id: "project", name: "Research", archived: false, color: "sea", icon: "folder" }], catalog: catalogFixture, today: "2026-01-02", onOpen: vi.fn(), onAdd: vi.fn(), onChange: vi.fn(async () => {}) };
  return { ...render(filtered ? <div data-testid="page-transition" style={{ filter: "blur(0px)", transform: "translateX(0px)" }}><TaskBoard {...props} /></div> : <TaskBoard {...props} />, { wrapper: TestProviders }), props, user: userEvent.setup() };
}
describe("whole-card tasks with independent actions", () => {
  it("ignores keyboard movement before drag geometry is available", () => {
    const event = new KeyboardEvent("keydown", { code: "ArrowRight", cancelable: true });
    const result = columnCoordinates(event, { currentCoordinates: { x: 0, y: 0 }, context: { collisionRect: null } } as Parameters<typeof columnCoordinates>[1]);
    expect(result).toBeUndefined(); expect(event.defaultPrevented).toBe(true);
  });
  it("drops a pointer drag outside every column without changing the task", async () => {
    const removeListener = vi.spyOn(document, "removeEventListener");
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function(this: HTMLElement) {
      const column = this.closest(".board-column"), index = column ? [...column.parentElement!.children].indexOf(column) : 0;
      const x = index * 320, y = this.classList.contains("board-column") ? 0 : 60, height = this.classList.contains("board-column") ? 600 : 84;
      return { x, y, top: y, left: x, width: 300, height, right: x + 300, bottom: y + height, toJSON() {} };
    });
    const task = taskFixture(); const { props, user } = mount([task]);
    const title = screen.getByRole("button", { name: task.title });
    await user.pointer([{ target: title, coords: { x: 100, y: 80 }, keys: "[MouseLeft>]" }, { coords: { x: 120, y: 80 } }, { target: document.body, coords: { x: 1800, y: 900 } }, { keys: "[/MouseLeft]" }]);
    expect(document.querySelector(".drag-preview")).toBeNull(); expect(props.onChange).not.toHaveBeenCalled(); expect(props.onOpen).not.toHaveBeenCalled();
    // The mouse sensor retains its click-suppression listener briefly after detach.
    // Wait for actual teardown instead of letting it swallow the next test click.
    await waitFor(() => expect(removeListener).toHaveBeenCalledWith("click", expect.any(Function), { capture: true }));
  });
  it("keeps child expansion usable with reduced motion and unknown project references", async () => {
    preference.reduced = true;
    const parent = taskFixture({ project: "unavailable" }), child = taskFixture({ id: "child", parentId: parent.id, title: "Child" });
    const { user } = mount([parent, child]);
    await user.click(screen.getByRole("button", { name: "Hide subtasks for " + parent.title }));
    await waitFor(() => expect(screen.queryByRole("button", { name: child.title })).toBeNull());
    await user.click(screen.getByRole("button", { name: "Show subtasks for " + parent.title })); expect(screen.getByRole("button", { name: child.title })).toBeDefined();
  });
  it("marks tasks an agent moved with a quiet AI badge until they're reviewed", () => {
    const parent = taskFixture({ title: "Fix staging CI", status: "done", agentChange: "job:job_1" });
    const child = taskFixture({ id: "child", parentId: parent.id, title: "Book the venue", agentChange: "chat" });
    const plain = taskFixture({ id: "plain", title: "Pay rent" });
    const { unmount } = render(<TaskBoard tasks={[parent, child, plain]} allTasks={[parent, child, plain]} view="board" columns={snapshotFixture().columns} projects={[]} catalog={catalogFixture} jobs={[jobFixture({ id: "job_1", name: "Morning planning" })]} today="2026-01-02" onOpen={vi.fn()} onAdd={vi.fn()} onChange={vi.fn(async () => {})} />, { wrapper: TestProviders });
    const badges = [...document.querySelectorAll(".agent-badge")];
    expect(badges.map(b => b.getAttribute("title")).sort()).toEqual([
      "Morning planning changed the status. Open the task to review it.",
      "Sift changed the status. Open the task to review it.",
    ]);
    expect(screen.getByText("Morning planning changed the status. Open the task to review it.").className).toBe("sr-only");
    unmount();
    // Without job names the badge still says it was a job.
    mount([taskFixture({ title: "Unnamed", agentChange: "job:job_gone" })]);
    expect(document.querySelector(".agent-badge")?.getAttribute("title")).toBe("A deleted job changed the status. Open the task to review it.");
  });
  it("offers explicit task creation rather than inventing sample tasks", async () => {
    const { props, user } = mount(); await user.click(screen.getByRole("button", { name: "Create a task" })); expect(props.onAdd).toHaveBeenCalledWith(); expect(props.onOpen).not.toHaveBeenCalled();
  });
  it("opens the full task while completion, reopening, and column creation stay independent", async () => {
    const task = taskFixture({ priority: "urgent", project: "project", attachments: ["img_test"], dueDate: "2026-01-01" });
    const { props, user } = mount([task, taskFixture({ id: "done", title: "Finished", status: "done", dueDate: "2026-01-01" }), taskFixture({ id: "future", title: "Future", dueDate: "2099-01-01" })]);
    await user.click(screen.getByRole("button", { name: task.title })); expect(props.onOpen).toHaveBeenCalledWith(task);
    await user.click(screen.getByRole("button", { name: "Complete " + task.title })); expect(props.onChange).toHaveBeenCalledWith({ ...task, status: "done" }); expect(props.onOpen).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Reopen Finished" })); expect(props.onChange).toHaveBeenCalledWith(expect.objectContaining({ id: "done", status: "open" }));
    await user.click(screen.getByRole("button", { name: "Add task to Open" })); expect(props.onAdd).toHaveBeenCalledWith("open");
    await user.click(within(screen.getByRole("region", { name: "In progress" })).getByRole("button", { name: "Add a task" })); expect(props.onAdd).toHaveBeenCalledWith("progress");
    expect(document.querySelector(".overdue")).not.toBeNull(); expect(screen.getByText("Urgent")).toBeDefined();
  });
  it("groups only live children, lets their actions work, and restores expansion accessibly", async () => {
    const parent = taskFixture(), child = taskFixture({ id: "child", title: "Child evidence", parentId: parent.id }), done = taskFixture({ id: "done_child", title: "Verified child", status: "done", parentId: parent.id });
    const removed = taskFixture({ id: "deleted", title: "Hidden removed child", parentId: parent.id, deletedAt: "2026-01-01" });
    const { props, user } = mount([parent, child, done], "board", [parent, child, done, removed, { ...removed, id: "merged", deletedAt: "", mergedInto: child.id }]);
    expect(document.querySelectorAll(".task-card")).toHaveLength(1); expect(screen.queryByText(removed.title)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Toggle " + child.title })); expect(props.onChange).toHaveBeenCalledWith({ ...child, status: "done" });
    await user.click(screen.getByRole("button", { name: "Toggle " + done.title })); expect(props.onChange).toHaveBeenCalledWith({ ...done, status: "open" });
    await user.click(screen.getByRole("button", { name: child.title })); expect(props.onOpen).toHaveBeenCalledWith(child);
    await user.click(screen.getByRole("button", { name: "Add subtask" })); expect(props.onAdd).toHaveBeenCalledWith(undefined, parent.id);
    await user.click(screen.getByRole("button", { name: "Hide subtasks for " + parent.title }));
    await waitFor(() => expect(screen.queryByRole("button", { name: child.title })).toBeNull());
    await user.click(screen.getByRole("button", { name: "Show subtasks for " + parent.title })); expect(screen.getByRole("button", { name: child.title })).toBeDefined();
  });
  it("keeps matching children visible when their parent is outside the filtered view", () => {
    const parent = taskFixture(), child = taskFixture({ id: "child", title: "Matching child", parentId: parent.id });
    mount([child], "board", [parent, child]); expect(screen.getByRole("button", { name: child.title })).toBeDefined(); expect(screen.queryByRole("button", { name: parent.title })).toBeNull();
  });
  it("bounds large board columns and reveals the next page only on request", async () => {
    const tasks = Array.from({ length: 150 }, (_, i) => taskFixture({ id: "task_" + i, title: "Task " + i }));
    const { user } = mount(tasks); expect(document.querySelectorAll(".task-card")).toHaveLength(70);
    await user.click(screen.getByRole("button", { name: "Show more (80)" })); expect(document.querySelectorAll(".task-card")).toHaveLength(140);
    await user.click(screen.getByRole("button", { name: "Show more (10)" })); expect(document.querySelectorAll(".task-card")).toHaveLength(150);
  });
  it("keeps Enter on a card's title for opening it, never for lifting it", async () => {
    const task = taskFixture(); const { props, user } = mount([task]);
    screen.getByRole("button", { name: task.title }).focus();
    await user.keyboard("{Enter}");
    expect(props.onOpen).toHaveBeenCalledWith(task); expect(document.querySelector(".drag-preview")).toBeNull();
    const card = screen.getByRole("button", { name: task.title }).closest("article")!;
    expect(card.getAttribute("role")).toBeNull(); expect(card.getAttribute("tabindex")).toBeNull();
  });
  it("provides a keyboard lift/cancel handle without opening or changing the task", async () => {
    const task = taskFixture(); const { props, user } = mount([task]);
    const handle = screen.getByRole("button", { name: "Drag " + task.title }); handle.focus();
    await user.keyboard("{Enter}"); expect(document.querySelector(".drag-preview .task-name")?.textContent).toBe(task.title);
    await user.keyboard("{Escape}"); expect(document.querySelector(".drag-preview")).toBeNull(); expect(props.onOpen).not.toHaveBeenCalled(); expect(props.onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: task.title })); expect(props.onOpen).toHaveBeenCalledWith(task);
  });
  it("moves a keyboard-lifted task between actual measured workflow columns and can drop without changing status", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function(this: HTMLElement) {
      const column = this.closest(".board-column"), index = column ? [...column.parentElement!.children].indexOf(column) : 0;
      const x = index * 320, y = this.classList.contains("board-column") ? 0 : 60, height = this.classList.contains("board-column") ? 600 : 84;
      return { x, y, top: y, left: x, width: 300, height, right: x + 300, bottom: y + height, toJSON() {} };
    });
    const task = taskFixture(); const { props, user } = mount([task]);
    const handle = screen.getByRole("button", { name: "Drag " + task.title }); handle.focus();
    await user.keyboard("{Enter}{ArrowDown}{ArrowLeft}{Enter}"); expect(props.onChange).not.toHaveBeenCalled();
    handle.focus(); await user.keyboard("{Enter}{ArrowRight}");
    await waitFor(() => expect(screen.getByRole("region", { name: "In progress" }).classList.contains("drag-over")).toBe(true));
    await user.keyboard("{Enter}"); await waitFor(() => expect(props.onChange).toHaveBeenCalledWith({ ...task, status: "progress" }));
    expect(props.onOpen).not.toHaveBeenCalled();
  });
  it("keeps the fixed drag overlay outside filtered page ancestors and moves only one column", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function(this: HTMLElement) {
      const column = this.closest(".board-column"), index = column ? [...column.parentElement!.children].indexOf(column) : 0;
      // Model the browser's containing block rule, which jsdom does not lay out.
      const fixed = this.style.position === "fixed", contained = !!this.closest('[data-testid="page-transition"]');
      const x = fixed ? parseFloat(this.style.left) + (contained ? 256 : 0) : 302 + index * 372;
      const y = fixed ? parseFloat(this.style.top) + (contained ? 74 : 0) : this.classList.contains("board-column") ? 233 : 281;
      const height = this.classList.contains("board-column") ? 600 : 89;
      return { x, y, top: y, left: x, width: 338, height, right: x + 338, bottom: y + height, toJSON() {} };
    });
    const task = taskFixture(), child = taskFixture({ id: "preview_child", parentId: task.id, title: "Expanded preview child" });
    const { props, user } = mount([task, child], "board", [task, child], true);
    screen.getByRole("button", { name: "Drag " + task.title }).focus();
    await user.keyboard("{Enter}");
    const preview = document.querySelector(".drag-preview")!, overlay = preview.parentElement!.parentElement!;
    expect(preview.parentElement!.hasAttribute("inert")).toBe(true);
    expect(preview.parentElement!.getAttribute("aria-hidden")).toBe("true");
    expect(overlay.style.pointerEvents).toBe("none");
    expect(overlay.style.zIndex).toBe("40");
    expect(overlay.parentElement).toBe(document.body);
    expect(screen.getByTestId("page-transition").contains(overlay)).toBe(false);
    expect(overlay.getBoundingClientRect()).toMatchObject({ left: 302, top: 281 });
    await waitFor(() => expect(screen.getByRole("region", { name: "Open" }).classList.contains("drag-over")).toBe(true));
    await user.keyboard("{ArrowRight}");
    await waitFor(() => expect(screen.getByRole("region", { name: "In progress" }).classList.contains("drag-over")).toBe(true));
    // Stationary means no drag translation; Motion may settle the card at "none".
    expect(["", "none"]).toContain(screen.getByRole("button", { name: task.title }).closest("article")!.style.transform);
    expect(preview.querySelector(".task-check")).not.toBeNull();
    expect(preview.querySelector(".nested-tasks")?.textContent).toContain(child.title);
    await user.keyboard("{Enter}");
    expect(props.onChange).toHaveBeenCalledExactlyOnceWith({ ...task, status: "progress" });
    expect(props.onOpen).not.toHaveBeenCalled();
  });
  it("leaves the pointer source stationary and lifts the complete card with its collapsed subtask state", async () => {
    const removeListener = vi.spyOn(document, "removeEventListener");
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function(this: HTMLElement) {
      const column = this.closest(".board-column"), index = column ? [...column.parentElement!.children].indexOf(column) : 0;
      const x = index * 320, y = this.classList.contains("board-column") ? 0 : 60, height = this.classList.contains("board-column") ? 600 : 84;
      return { x, y, top: y, left: x, width: 300, height, right: x + 300, bottom: y + height, toJSON() {} };
    });
    const task = taskFixture({ priority: "high", project: "project" }), child = taskFixture({ id: "child", title: "Child", parentId: task.id });
    const { props, user } = mount([task, child]);
    await user.click(screen.getByRole("button", { name: "Hide subtasks for " + task.title }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Child" })).toBeNull());
    // Picked up from the card body (its title), not a dedicated grip.
    const title = screen.getByRole("button", { name: task.title }), source = title.closest("article")!;
    await user.pointer([{ target: title, coords: { x: 100, y: 80 }, keys: "[MouseLeft>]" }, { coords: { x: 120, y: 80 } }, { coords: { x: 420, y: 80 } }]);
    const preview = document.querySelector(".drag-preview")!;
    expect(["", "none"]).toContain(source.style.transform);
    expect(preview.querySelector(".task-name")?.textContent).toBe(task.title);
    expect(preview.querySelector(".priority")?.textContent).toBe("High");
    expect(preview.querySelector(".project-label")?.textContent).toBe("Research");
    expect(preview.querySelector(".subtask-toggle")!.getAttribute("aria-expanded")).toBe("false");
    expect(preview.querySelector(".nested-tasks")).toBeNull();
    await user.pointer([{ keys: "[/MouseLeft]" }]);
    expect(document.querySelector(".drag-preview")).toBeNull();
    expect(props.onChange).toHaveBeenCalledExactlyOnceWith({ ...task, status: "progress" });
    expect(props.onOpen).not.toHaveBeenCalled();
    await waitFor(() => expect(removeListener).toHaveBeenCalledWith("click", expect.any(Function), { capture: true }));
  });
  it("virtualizes list rows with a real viewport and keeps status controls independent from opening", async () => {
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function(this: HTMLElement) { return this.classList.contains("task-list") ? 600 : 0; });
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function(this: HTMLElement) { return this.classList.contains("task-list") ? 900 : 0; });
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function(this: HTMLElement) { return this.hasAttribute("data-index") ? 84 : 0; });
    const task = taskFixture({ project: "project" });
    const tasks = [task, ...Array.from({ length: 999 }, (_, i) => taskFixture({ id: "row_" + i, title: "List task " + i }))];
    const { props, user } = mount(tasks, "list");
    expect(await screen.findByRole("button", { name: /Read the research notes.*Research/ })).toBeDefined();
    expect(document.querySelectorAll(".task-card").length).toBeLessThan(30);
    expect(screen.queryByRole("button", { name: "Drag " + task.title })).toBeNull();
    await user.click(screen.getByRole("combobox", { name: "Status for " + task.title }));
    await user.click(await screen.findByRole("option", { name: "In progress" }));
    expect(props.onChange).toHaveBeenCalledWith({ ...task, status: "progress" }); expect(props.onOpen).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /Read the research notes.*Research/ })); expect(props.onOpen).toHaveBeenCalledWith(task);
    const scroll = document.querySelector(".task-list")!;
    fireEvent.scroll(scroll, { target: { scrollTop: 84 * 990 } });
    expect(await screen.findByRole("button", { name: "List task 998" })).toBeDefined();
    expect(screen.queryByRole("button", { name: /Read the research notes.*Research/ })).toBeNull();
  });
});
