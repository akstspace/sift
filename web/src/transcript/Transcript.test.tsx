import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Transcript, contextLabel, formatDuration, toolLine, type TranscriptProps } from "./Transcript";
import type { Item, ToolState } from "./model";
import type { Lookups } from "./siftOps";
import { catalogFixture, snapshotFixture, taskFixture } from "../test/fixtures";

const snap = snapshotFixture({
  tasks: [
    taskFixture({ id: "task_1", title: "Pay rent", status: "progress" }),
    taskFixture({ id: "task_trash", title: "Old idea", deletedAt: "2026-01-01T00:00:00Z" }),
    taskFixture({ id: "task_merged", title: "Rent again", mergedInto: "task_1" }),
    taskFixture({ id: "task_arch", title: "Last year", archivedAt: "2026-01-01T00:00:00Z", status: "done" }),
  ],
  projects: [{ id: "proj_home", name: "Home", color: "blue", archived: false, icon: "" }],
});
const lookups: Lookups = { tasks: snap.tasks, columns: snap.columns, projects: snap.projects, tags: snap.tags };
const SIFT = `"/Users/me/.local/bin/sift" --data "/d"`;
const tool = (over: Partial<ToolState>): Item => ({ kind: "tool", key: over.id || "t", tool: { id: "t", name: "bash", args: {}, status: "done", ...over } });
const show = (items: Item[], props: Partial<TranscriptProps> = {}) => render(<Transcript items={items} lookups={lookups} catalog={catalogFixture} {...props} />);

describe("transcript", () => {
  it("shows what the person sent, with images and what Sift shared", () => {
    const { container } = show([
      { kind: "user", key: "u1", text: "Plan my day", images: [{ type: "image", data: "AAAA", mimeType: "image/png" }, { type: "image", mimeType: "image/png" }], context: "Page: Today. Open task: Pay rent (task_1).", pending: true },
      { kind: "user", key: "u2", text: "", images: [{ type: "image", data: "BB", mimeType: "image/jpeg" }] },
    ]);
    expect(screen.getByText("Plan my day")).toBeDefined();
    expect(screen.getAllByRole("img", { name: "Attached image 1" }).map(i => i.getAttribute("src"))).toEqual(["data:image/png;base64,AAAA", "data:image/jpeg;base64,BB"]);
    expect(container.querySelector(".image-omitted")?.textContent).toBe("Image");
    expect(screen.getByText("Today · Pay rent").closest(".user-context")?.getAttribute("title")).toBe("Page: Today. Open task: Pay rent (task_1).");
    expect(screen.getByText("Sift shared:")).toBeDefined();
    expect(container.querySelector(".user-message.pending")).not.toBeNull();
    expect(container.querySelectorAll(".user-bubble")).toHaveLength(1);
  });
  it("reads what Sift shared as a short label", () => {
    expect(contextLabel("Page: Today. Open task: Pay rent (task_1).")).toBe("Today · Pay rent");
    expect(contextLabel("Page: Project Home. Searching for: rent.")).toBe("Project Home");
    expect(contextLabel("Open run: Morning (run_1).")).toBe("Open run: Morning (run_1).");
  });
  it("collapses thinking until asked, and says so when it's hidden", () => {
    show([
      { kind: "thinking", key: "a", text: "Weighing options", streaming: false },
      { kind: "thinking", key: "b", text: "", redacted: true },
      { kind: "thinking", key: "c", text: "Still going", streaming: true },
    ]);
    expect(screen.queryByText("Weighing options")).toBeNull();
    const thought = screen.getByRole("button", { name: "Thought" });
    expect(thought.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(thought);
    expect(thought.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Weighing options")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Thinking hidden" }));
    expect(screen.getByText("The model’s provider doesn’t share its thinking.")).toBeDefined();
    expect(screen.getByText("Thinking…").className).toBe("shimmer");
  });
  it("renders replies as Markdown and errors as alerts", () => {
    const { container } = show([
      { kind: "text", key: "x", text: "**Done** — three tasks", streaming: true },
      { kind: "notice", key: "n1", tone: "error", text: "Rate limited" },
      { kind: "notice", key: "n2", tone: "info", text: "Stopped" },
    ]);
    expect(container.querySelector(".agent-markdown.streaming strong")?.textContent).toBe("Done");
    expect(screen.getByRole("alert").textContent).toBe("Rate limited");
    expect(screen.getByText("Stopped").closest(".transcript-notice")?.getAttribute("role")).toBeNull();
  });
  it("explains a provider's refusal and keeps its words behind Details", () => {
    show([{ kind: "notice", key: "e", tone: "error", text: "The model’s provider didn’t accept Pi’s sign-in (Invalid bearer token). Sign in again in Pi, or choose another model.", detail: '401 {"error":{"message":"Invalid bearer token"}}' }]);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Sign in again in Pi");
    const toggle = within(alert).getByRole("button", { name: "Details" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(alert.querySelector("code")).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(alert.querySelector("code")?.textContent).toBe('401 {"error":{"message":"Invalid bearer token"}}');
  });
  it("animates only what arrives after it opens", () => {
    const first: Item = { kind: "text", key: "a", text: "Earlier" };
    const { container, rerender } = show([first], { live: true });
    expect(container.querySelector(".t-item.live")).toBeNull();
    rerender(<Transcript items={[first, { kind: "text", key: "b", text: "New" }]} lookups={lookups} catalog={catalogFixture} live />);
    expect([...container.querySelectorAll(".t-item")].map(n => n.className)).toEqual(["t-item t-text", "t-item live t-text"]);
    rerender(<Transcript items={[first, { kind: "text", key: "b", text: "New" }, { kind: "text", key: "c", text: "Static" }]} lookups={lookups} catalog={catalogFixture} />);
    expect(container.querySelectorAll(".t-item.live")).toHaveLength(0);
  });
  it("updates an item only when what it shows changes", () => {
    const items = (over: Partial<Record<string, unknown>> = {}): Item[] => [
      { kind: "user", key: "u", text: "Hi", images: [], ...over.user as object },
      { kind: "text", key: "t", text: "Hello", ...over.text as object },
      { kind: "notice", key: "n", tone: "info", text: "Stopped", ...over.notice as object },
      { kind: "tool", key: "tl", tool: { id: "tl", name: "read", args: { path: "/a/notes.md" }, status: "running", ...over.tool as object } },
    ];
    const { rerender, container } = show(items());
    const again = (next: Item[], extra: Partial<TranscriptProps> = {}) => rerender(<Transcript items={next} lookups={lookups} catalog={catalogFixture} {...extra} />);
    again(items());
    again(items({ user: { pending: true }, text: { text: "Hello there" }, notice: { tone: "error" }, tool: { status: "done", durationMs: 1500 } }));
    expect(screen.getByText("Hello there")).toBeDefined();
    expect(screen.getByRole("alert").textContent).toBe("Stopped");
    expect(container.querySelector(".user-message.pending")).not.toBeNull();
    expect(screen.getByText("2s")).toBeDefined();
    // A quick tool doesn't show its time.
    again(items({ tool: { status: "done", durationMs: 40 } }));
    expect(container.querySelector(".tool-time")).toBeNull();
    // A different kind under the same key, or new lookups, renders again.
    again([{ kind: "notice", key: "u", tone: "info", text: "Swapped" }], { lookups: { ...lookups } });
    expect(screen.getByText("Swapped")).toBeDefined();
    again([{ kind: "thinking", key: "u", text: "Hm" }]);
    expect(screen.getByRole("button", { name: "Thought" })).toBeDefined();
  });
});

describe("tool rows", () => {
  it("describes Pi's built-in tools in a line", () => {
    const line = (name: string, args: Record<string, unknown>, summary?: string) => {
      const l = toolLine({ id: "x", name, args, status: "done", summary });
      return [l.verb, l.target, l.title];
    };
    expect(line("bash", { command: "ls -la\nwc -l" })).toEqual(["", "ls -la …", "ls -la\nwc -l"]);
    expect(line("bash", {}, "bash: make")).toEqual(["", "make", "bash: make"]);
    expect(line("bash", { command: "" })).toEqual(["", "bash", ""]);
    expect(line("read", { path: "/a/b/notes.md" })).toEqual(["Read", "notes.md", "/a/b/notes.md"]);
    expect(line("write", { file_path: "/a/out.txt" })).toEqual(["Wrote", "out.txt", "/a/out.txt"]);
    expect(line("edit", { path: "/a/dir/" })).toEqual(["Edited", "dir", "/a/dir/"]);
    expect(line("grep", { pattern: "TODO", path: "src" })).toEqual(["Searched for", "TODO", "TODO in src"]);
    expect(line("find", { path: "/a/src" })).toEqual(["Found", "src", ""]);
    expect(line("find", { pattern: "*.go" })).toEqual(["Found", "*.go", "*.go"]);
    expect(line("ls", {})).toEqual(["Listed", ".", ""]);
    expect(line("web_search", { query: "rent law\nmore" })).toEqual(["web search", "rent law", "rent law\nmore"]);
    expect(line("lookup", { n: 3, city: "Pune" })).toEqual(["lookup", "Pune", "Pune"]);
    expect(line("mcp-tool", { n: 3 }, "mcp-tool: listed")).toEqual(["mcp tool", "listed", "listed"]);
    expect(line("noop", {})).toEqual(["noop", "", ""]);
    // Extension tool names are plain text, never patterns.
    expect(line("c++(", { n: 1 }, "c++(: compiled")).toEqual(["c++(", "compiled", "compiled"]);
    expect(line("a.b", {}, "axb: kept")).toEqual(["", "axb: kept", "axb: kept"]);
    expect(line("read", {}, "Running read")).toEqual(["", "Running read", "Running read"]);
    expect(toolLine({ id: "x", name: "fetch", args: { url: "https://x" }, status: "done" }).icon).toBe(toolLine({ id: "y", name: "web", args: {}, status: "done" }).icon);
  });
  it("formats how long a tool took", () => {
    expect([undefined, -1, 0, 450, 1499, 59000, 61000, 3_725_000].map(formatDuration)).toEqual(["", "", "0.0s", "0.5s", "1s", "59s", "1m 1s", "62m 5s"]);
  });
  it("shows a running tool's latest output and its details on demand", () => {
    const { container } = show([tool({ id: "b", args: { command: "make test" }, status: "running", live: "line 1\nline 2\nline 3\nline 4\n" })]);
    expect(container.querySelector(".tool-tail")?.textContent).toBe("line 2\nline 3\nline 4");
    expect(screen.getByRole("img", { name: "Running" })).toBeDefined();
    const head = screen.getByRole("button", { name: /make test/ });
    fireEvent.click(head);
    expect(head.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector(".tool-tail")).toBeNull();
    expect(container.querySelector(".tool-command")?.textContent).toBe("$ make test");
    expect(container.querySelector(".tool-output")?.textContent).toBe("line 1\nline 2\nline 3\nline 4");
  });
  it.each<[string, Partial<ToolState>, (c: HTMLElement) => void]>([
    ["edits", { name: "edit", args: { path: "/a/x.ts", edits: [{ oldText: "a\nb\n", newText: "c" }, { old_string: "", new_string: "d" }] } }, c => {
      expect(c.querySelector(".tool-path")?.textContent).toBe("/a/x.ts");
      expect([...c.querySelectorAll(".tool-diff")].map(d => d.textContent)).toEqual(["- a\n- b\n+ c\n", "+ d\n"]);
      expect(c.querySelector(".tool-output")).toBeNull();
    }],
    ["a single edit that failed", { name: "edit", args: { path: "/a/x.ts", oldText: "a", newText: "b" }, status: "error", output: "No match" }, c => {
      expect(c.querySelector(".tool-diff")?.textContent).toBe("- a\n+ b\n");
      expect(c.querySelector(".tool-output.error")?.textContent).toBe("No match");
    }],
    ["a written file", { name: "write", args: { path: "/a/n.md", content: "# Notes" }, output: "Wrote 7 bytes" }, c => {
      expect(c.querySelector(".tool-output")?.textContent).toBe("# Notes");
      expect(c.textContent).not.toContain("Wrote 7 bytes");
    }],
    ["a ranged read", { name: "read", args: { path: "/a/n.md", offset: 10, limit: 20 }, output: "text  \n", images: [{ type: "image", data: "PNG", mimeType: "image/png" }, { type: "image", mimeType: "image/png" }] }, c => {
      expect(c.querySelector(".tool-path")?.textContent).toBe("/a/n.md · from line 10 · 20 lines");
      expect(c.querySelector(".tool-output")?.textContent).toBe("text");
      expect(c.querySelectorAll(".tool-image")).toHaveLength(1);
    }],
    ["a bare listing", { name: "ls", args: {} }, c => expect(c.querySelector(".tool-body")?.textContent).toBe("No output")],
    ["another tool's arguments", { name: "web_fetch", args: { url: "https://x" }, status: "error", output: "403" }, c => {
      expect(JSON.parse(c.querySelector(".tool-args")!.textContent!)).toEqual({ url: "https://x" });
      expect(c.querySelector(".tool-output.error")?.textContent).toBe("403");
    }],
    ["an older run's summary", { name: "tool", args: {}, summary: "read local file", status: "unknown" }, c => expect(c.querySelector(".tool-body .tool-path")?.textContent).toBe("read local file")],
    ["a tool still waiting", { name: "custom", args: {}, status: "running" }, c => expect(c.querySelector(".tool-body")?.textContent).toBe("Waiting for output…")],
  ])("shows %s", (_, over, check) => {
    const { container } = show([tool(over)]);
    fireEvent.click(container.querySelector(".tool-head")!);
    check(container);
  });
});

describe("Sift cards", () => {
  it("shows a change with its task, what changed, and the command behind it", () => {
    const onOpenTask = vi.fn();
    const { container } = show([tool({
      args: { command: `${SIFT} tasks update task_1 --revision 3 --today --priority high --reason 'Landlord asked'` },
      output: JSON.stringify({ task: { id: "task_1", title: "Pay rent" } }), durationMs: 900,
    })], { onOpenTask });
    const card = screen.getByRole("region", { name: "Updated task" });
    expect(within(card).getByRole("list", { name: "Changes" }).textContent).toBe("Added to TodayHigh priority");
    expect(card.querySelector(".sift-quote")?.textContent).toBe("Landlord asked");
    expect(within(card).getByRole("img", { name: "Done" })).toBeDefined();
    const chip = within(card).getByRole("button", { name: "Open task Pay rent" });
    expect(chip.textContent).toContain("In progress");
    fireEvent.click(chip);
    expect(onOpenTask).toHaveBeenCalledWith(snap.tasks[0]);
    const toggle = within(card).getByRole("button", { name: "Show command and output" });
    fireEvent.click(toggle);
    expect(within(card).getByRole("button", { name: "Hide command and output" }).getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector(".sift-details .tool-command")?.textContent).toContain("tasks update task_1");
    expect(container.querySelector(".sift-details .tool-output")?.textContent).toContain('"Pay rent"');
  });
  it("shimmers while a change runs and explains a failure", () => {
    const { container, rerender } = show([tool({ args: { command: `${SIFT} tasks add --title 'Renew passport'` }, status: "running" })]);
    expect(screen.getByRole("region", { name: "Adding task…" }).className).toContain("running");
    expect(screen.getByText("Adding task…").className).toBe("shimmer");
    expect(container.querySelector(".task-chip.static")?.textContent).toBe("Renew passport");
    rerender(<Transcript items={[tool({ args: { command: `${SIFT} tasks update task_gone --revision 1 --title X` }, status: "error", output: "sift: Task not found\n\nCommand exited with code 1" })]} lookups={lookups} catalog={catalogFixture} />);
    const card = screen.getByRole("region", { name: "Couldn’t update task" });
    expect(card.className).toContain("failed");
    expect(card.querySelector(".sift-error")?.textContent).toBe("Task not found");
    expect(within(card).queryByRole("img", { name: "Failed" })).toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: "Show command and output" }));
    expect(card.querySelector(".tool-output.error")?.textContent).toContain("Task not found");
  });
  it("shows each task's state in the workspace now", () => {
    const merge = (ids: string[]) => tool({ args: { command: `${SIFT} tasks merge ${ids[0]} --into ${ids[1]}` }, output: JSON.stringify({ merged: { id: ids[0] }, task: { id: ids[1] } }) });
    const { container, rerender } = show([merge(["task_trash", "task_merged"])], { onOpenTask: vi.fn() });
    const state = () => [...container.querySelectorAll(".task-chip")].map(c => [c.tagName, c.querySelector(".chip-state")?.textContent ?? c.querySelector(".chip-status")?.textContent]);
    expect(state()).toEqual([["BUTTON", "In Trash"], ["BUTTON", "Merged"]]);
    rerender(<Transcript items={[merge(["task_arch", "task_nowhere"])]} lookups={lookups} catalog={catalogFixture} onOpenTask={vi.fn()} />);
    expect(state()).toEqual([["BUTTON", "Archived"], ["SPAN", "Not in workspace"]]);
    expect(container.querySelector(".chip-title.done")?.textContent).toBe("Last year");
  });
  it("shows a job it started and links to the run", () => {
    const onOpenRun = vi.fn();
    show([tool({ args: { command: `${SIFT} jobs run job_1` }, output: JSON.stringify({ id: "run_7", jobName: "Morning" }) })], { onOpenRun });
    expect(screen.getByText("Morning").className).toBe("sift-entity");
    fireEvent.click(screen.getByRole("button", { name: "Open in Run history" }));
    expect(onOpenRun).toHaveBeenCalledWith("run_7");
  });
  it("shows a project with its color", () => {
    const { container } = show([tool({ args: { command: `${SIFT} projects add --name Home --color blue` }, output: JSON.stringify({ id: "proj_home", name: "Home", color: "blue" }) })]);
    expect(container.querySelector(".sift-entity .status-dot.blue")).not.toBeNull();
  });
  it("keeps reads quiet, with the tasks they found behind a toggle", () => {
    const many = Array.from({ length: 14 }, (_, i) => ({ id: "task_l" + i, title: "Listed " + i }));
    const { container } = show([tool({ args: { command: `${SIFT} tasks list` }, output: JSON.stringify([{ id: "task_1", title: "Pay rent" }, ...many]) })], { onOpenTask: vi.fn() });
    const row = container.querySelector(".sift-row")!;
    expect(row.textContent).toContain("Looked through tasks");
    expect(row.textContent).toContain("15 tasks");
    expect(container.querySelector(".sift-card")).toBeNull();
    fireEvent.click(within(row as HTMLElement).getByRole("button", { name: /Looked through tasks/ }));
    expect(within(row as HTMLElement).getByRole("list", { name: "Tasks" }).children).toHaveLength(12);
    expect(row.textContent).toContain("and 3 more");
    expect(within(row as HTMLElement).getByRole("button", { name: "Open task Pay rent" })).toBeDefined();
    expect(row.querySelector(".chip-state")?.textContent).toBe("Not in workspace");
  });
  it("links a run that was read", () => {
    const onOpenRun = vi.fn();
    const { container } = show([tool({ args: { command: `${SIFT} runs get run_3` }, output: "{}" }), tool({ id: "t2", args: { command: `${SIFT} tasks get task_1` }, output: "{}" })], { onOpenRun });
    fireEvent.click(screen.getByRole("button", { name: /Read a run/ }));
    fireEvent.click(screen.getByRole("button", { name: "Open in Run history" }));
    expect(onOpenRun).toHaveBeenCalledWith("run_3");
    fireEvent.click(screen.getByRole("button", { name: /Read task/ }));
    // Without a way to open tasks, chips are plain labels.
    expect(container.querySelector(".task-chip.static")?.textContent).toContain("Pay rent");
  });
  it("falls back to a plain row for commands that aren't Sift", () => {
    const { container } = show([tool({ args: { command: "sift tasks list | jq ." } })]);
    expect(container.querySelector(".sift-row, .sift-card")).toBeNull();
    expect(container.querySelector(".tool-target")?.textContent).toBe("sift tasks list | jq .");
  });
});
