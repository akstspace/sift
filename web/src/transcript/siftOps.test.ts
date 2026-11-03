import { describe, expect, it } from "vitest";
import { describeSiftOp, parseSiftCommand, parseSiftOutput, shellWords, type Lookups, type SiftCall } from "./siftOps";
import { snapshotFixture, taskFixture } from "../test/fixtures";

const snap = snapshotFixture({
  tasks: [taskFixture({ id: "task_1", title: "Pay rent" }), taskFixture({ id: "task_2", title: "Renamed live", status: "done" }), taskFixture({ id: "task_p", title: "Parent task" })],
  projects: [{ id: "proj_home", name: "Home", color: "blue", archived: false, icon: "" }],
  tags: [{ id: "tag_bills", name: "Bills", color: "rose", archived: false, icon: "" }],
});
const lookups: Lookups = { tasks: snap.tasks, columns: snap.columns, projects: snap.projects, tags: snap.tags };
const sift = (args: string) => parseSiftCommand(`"/Users/me/.local/bin/sift" --data "/Users/me/Library/Application Support/Sift" ${args}`)!;
const ok = (data: unknown) => ({ ok: true as const, data });

describe("recognizing a Sift call", () => {
  it("splits shell words with quotes and escapes", () => {
    expect(shellWords(`sift tasks add --title 'Pay rent' --reason "It's \\"due\\" \\$5" a\\ b ""`)).toEqual(["sift", "tasks", "add", "--title", "Pay rent", "--reason", `It's "due" $5`, "a b", ""]);
    expect(shellWords("sift help \\\nnext")).toEqual(["sift", "help", "next"]);
    expect(shellWords("sift tasks list 2>&1")).toEqual(["sift", "tasks", "list"]);
    expect(shellWords("  ")).toEqual([]);
  });
  it.each([
    "sift tasks list | jq .", "sift tasks list && echo", "sift tasks list; ls", "sift tasks list > out.json",
    "echo $(sift tasks list)", "sift tasks add --title \"$HOME\"", "sift tasks add --title 'open", "sift tasks add --title \"open",
    "sift tasks list 2>&1 | head", "sift tasks *", "sift `x`", "# sift tasks list",
  ])("leaves a compound command alone: %s", command => {
    expect(parseSiftCommand(command)).toBeNull();
  });
  it("finds Sift by its file name, after environment assignments, with flags as the CLI reads them", () => {
    const call = parseSiftCommand(`TZ=UTC NO_COLOR=1 ./sift-development-chat --data /d tasks update task_1 --revision=3 --today --status done --tags= --tags bills --wait`)!;
    expect(call.pos).toEqual(["tasks", "update", "task_1"]);
    expect(call.flags).toMatchObject({ data: "/d", revision: "3", today: "true", status: "done", tags: "bills", wait: "true" });
    expect(call.lists.tags).toEqual(["", "bills"]);
    expect(parseSiftCommand("sift --json")).toBeNull();
    expect(parseSiftCommand("sifter tasks list")).toBeNull();
    expect(parseSiftCommand("ls")).toBeNull();
    expect(parseSiftCommand(undefined)).toBeNull();
    expect(parseSiftCommand("")).toBeNull();
    expect(parseSiftCommand("sift help --verbose")?.flags.verbose).toBe("true");
  });
  it("reads Sift's JSON and its errors", () => {
    expect(parseSiftOutput(undefined, false)).toBeNull();
    expect(parseSiftOutput('{"a":1}\n', false)).toEqual({ ok: true, data: { a: 1 } });
    expect(parseSiftOutput("sift: Task not found\n\nCommand exited with code 1", true)).toEqual({ ok: false, error: "Task not found" });
    expect(parseSiftOutput("warning\nsift: Revision changed (exit code 1)", true)).toEqual({ ok: false, error: "Revision changed" });
    expect(parseSiftOutput("Sift 0.1.6", false)).toEqual({ ok: true, data: undefined });
    expect(parseSiftOutput("boom", true)).toEqual({ ok: false, error: "boom" });
    expect(parseSiftOutput("", true)).toEqual({ ok: false, error: "The command failed" });
  });
});

describe("describing what a Sift call did", () => {
  it("shows an added task with what it was given, and a pending verb while it runs", () => {
    const call = sift("tasks add --title 'Renew passport' --today --priority high --due-date 2026-11-14 --project proj_home --tags tag_bills,tag_x --status open --parent task_p --attachment img_1");
    const pending = describeSiftOp(call, null, lookups);
    expect(pending.verb).toBe("Adding task…");
    expect(pending.tasks).toEqual([{ id: "", title: "Renew passport" }]);
    const op = describeSiftOp(call, ok({ task: { id: "task_new", title: "Renew passport", status: "open" }, potentialDuplicates: [{}, {}] }), lookups);
    expect(op).toMatchObject({ verb: "Added task", emphasis: "change", icon: "task", detail: "2 possible duplicates" });
    expect(op.tasks[0]).toMatchObject({ id: "task_new", title: "Renew passport" });
    expect(op.changes).toEqual(["Added to Today", expect.stringMatching(/^Due \w+, \w+ 14|^Due/), "High priority", "In Home", "Tagged Bills, tag_x", "Under “Parent task”", "Attached an image"]);
    expect(describeSiftOp(sift("tasks add --file task.json --priority none"), ok({ task: { id: "t" } }), lookups).changes).toEqual(["From a file"]);
  });
  it("names the change an update made", () => {
    const update = (flags: string, task: Record<string, unknown> = { id: "task_1", title: "Pay rent" }) => describeSiftOp(sift("tasks update task_1 --revision 2 " + flags), ok({ task }), lookups);
    expect(update("--status done --reason 'Paid'", { id: "task_1", status: "done" })).toMatchObject({ verb: "Completed task", changes: [], quote: "Paid" });
    expect(update("--status progress")).toMatchObject({ verb: "Moved to In progress", changes: [] });
    expect(update("--status mystery --title X")).toMatchObject({ verb: "Updated task", changes: ["Renamed to “X”", "Moved to mystery"] });
    expect(update("--today=false --due-date= --snoozed-until 2026-11-20 --project= --tags= --parent= --description x --icon mail").changes)
      .toEqual(["Removed from Today", "Removed due date", expect.stringMatching(/^Snoozed until/), "Removed from project", "Removed tags", "Made top-level", "Edited notes", "Changed icon"]);
    expect(update("--snoozed-until= --due-date soon --parent task_zz --file t.json").changes).toEqual(["Due soon", "Unsnoozed", "Under “task_zz”"]);
    expect(update("--file t.json").changes).toEqual(["Updated from a file"]);
    // The workspace's current title wins over what the command printed.
    expect(describeSiftOp(sift("tasks update task_2 --revision 1 --title Old"), ok({ task: { id: "task_2", title: "Old" } }), lookups).tasks[0].title).toBe("Renamed live");
  });
  it("keeps only the error when a change failed", () => {
    const failed = describeSiftOp(sift("tasks update task_missing --revision 1 --title Nope"), { ok: false, error: "Task not found" }, lookups);
    expect(failed).toMatchObject({ verb: "Couldn’t update task", error: "Task not found", changes: [], tasks: [], emphasis: "change" });
    expect(describeSiftOp(sift("tasks update task_1 --revision 1 --title Nope"), { ok: false, error: "Revision changed" }, lookups).tasks.map(t => t.id)).toEqual(["task_1"]);
    expect(describeSiftOp(sift("tasks list"), { ok: false, error: "Service is unavailable" }, lookups)).toMatchObject({ verb: "Looked through tasks — it failed", emphasis: "change" });
  });
  it("summarizes reads quietly", () => {
    const list = describeSiftOp(sift("tasks list"), ok([{ id: "task_1", title: "Pay rent" }, { id: "x", title: "Gone" }, null]), lookups);
    expect(list).toMatchObject({ verb: "Looked through tasks", emphasis: "read", icon: "read", detail: "2 tasks" });
    expect(describeSiftOp(sift("tasks tree"), ok({ not: "a list" }), lookups).detail).toBeUndefined();
    expect(describeSiftOp(sift("tasks search rent due"), ok([{ id: "task_1" }]), lookups)).toMatchObject({ verb: "Searched for “rent due”", icon: "search", detail: "1 result" });
    expect(describeSiftOp(sift("tasks search rent"), null, lookups).verb).toBe("Searching for “rent”…");
    expect(describeSiftOp(sift("tasks search"), ok([]), lookups).verb).toBe("Searched tasks");
    const get = describeSiftOp(sift("tasks get task_1"), ok({ task: { id: "task_1", title: "Pay rent" }, history: [{}, {}, {}] }), lookups);
    expect(get).toMatchObject({ verb: "Read task", detail: "3 changes in history" });
    expect(describeSiftOp(sift("tasks get task_9"), ok({}), lookups).tasks).toEqual([{ id: "task_9", title: "", snapshot: undefined }]);
    expect(describeSiftOp(sift("tasks comments task_1"), ok([{}, {}]), lookups)).toMatchObject({ verb: "Read comments", icon: "comment", detail: "2 comments" });
    expect(describeSiftOp(sift("tasks comments task_1"), ok({}), lookups).detail).toBeUndefined();
  });
  it("shows duplicate checks with what they found", () => {
    expect(describeSiftOp(sift("tasks duplicates --title 'Pay rent'"), ok([{ id: "task_1", title: "Pay rent" }, null]), lookups)).toMatchObject({ verb: "Checked for duplicates of “Pay rent”", detail: "1 possible duplicate" });
    expect(describeSiftOp(sift("tasks duplicates --title 'Pay rent'"), ok([]), lookups).detail).toBe("None found");
    expect(describeSiftOp(sift("tasks duplicates --title 'Pay rent'"), null, lookups).verb).toBe("Checking for duplicates of “Pay rent”…");
    expect(describeSiftOp(sift("tasks duplicates --id task_1"), ok({}), lookups)).toMatchObject({ verb: "Checked for duplicates", detail: "None found", tasks: [] });
  });
  it("shows comments, merges, and the reason given", () => {
    expect(describeSiftOp(sift("tasks comment task_1 --text 'Called them'"), ok({ id: 5 }), lookups)).toMatchObject({ verb: "Commented on", quote: "Called them", icon: "comment", emphasis: "change" });
    const merge = describeSiftOp(sift("tasks merge task_2 --into task_1 --reason Same"), ok({ merged: { id: "task_2" }, task: { id: "task_1" } }), lookups);
    expect(merge).toMatchObject({ verb: "Merged tasks", icon: "merge", quote: "Same" });
    expect(merge.tasks.map(t => t.id)).toEqual(["task_2", "task_1"]);
    expect(describeSiftOp(sift("tasks merge task_2 --into task_1"), null, lookups).tasks.map(t => t.id)).toEqual(["task_2", "task_1"]);
  });
  it("shows projects, tags, jobs, and runs", () => {
    expect(describeSiftOp(sift("projects add --name Home --color blue"), ok({ id: "p", name: "Home", color: "blue" }), lookups)).toMatchObject({ verb: "Added project", icon: "project", entity: { name: "Home", color: "blue" } });
    expect(describeSiftOp(sift("tags update --id t --name Bills --color rose"), ok({}), lookups)).toMatchObject({ verb: "Updated tag", icon: "tag", entity: { name: "Bills", color: "rose" } });
    expect(describeSiftOp(sift("tags add"), ok({}), lookups).entity).toBeUndefined();
    expect(describeSiftOp(sift("projects list"), ok([{}, {}]), lookups)).toMatchObject({ verb: "Looked at projects", detail: "2 projects", emphasis: "read" });
    expect(describeSiftOp(sift("tags list"), ok([{}]), lookups).detail).toBe("1 tag");
    expect(describeSiftOp(sift("jobs add --file j.json --schedule 'daily 09:00'"), ok({ id: "job_1", name: "Morning" }), lookups)).toMatchObject({ verb: "Scheduled a job", icon: "job", entity: { name: "Morning" } });
    expect(describeSiftOp(sift("jobs run job_1"), ok({ id: "run_1", jobName: "Morning" }), lookups)).toMatchObject({ verb: "Started a job", runId: "run_1", entity: { name: "Morning" } });
    expect(describeSiftOp(sift("jobs list"), ok([{}]), lookups).detail).toBe("1 job");
    expect(describeSiftOp(sift("runs get run_9"), ok({}), lookups)).toMatchObject({ verb: "Read a run", icon: "run", runId: "run_9" });
    expect(describeSiftOp(sift("runs list"), ok([{}, {}]), lookups).detail).toBe("2 runs");
  });
  it.each<[string, string, string]>([
    ["images upload a.png", "Uploaded an image", "image"],
    ["undo 42", "Undid a change", "undo"],
    ["history task_1", "Read history", "read"],
    ["icons search email", "Searched icons for “email”", "search"],
    ["icons", "Searched icons", "search"],
    ["help", "Read Sift help", "read"],
    ["schema", "Read Sift’s schema", "read"],
    ["columns list", "Read columns", "read"],
    ["models", "Checked Pi models", "read"],
    ["version", "Checked Sift’s version", "read"],
    ["backup", "Backed up the workspace", "sift"],
    ["mystery thing", "Ran sift mystery thing", "read"],
  ])("names %s", (args, verb, icon) => {
    expect(describeSiftOp(sift(args), ok(args.startsWith("history") ? [{}] : {}), lookups)).toMatchObject({ verb, icon });
  });
  it("uses progressive verbs while running", () => {
    expect(describeSiftOp(sift("icons search email"), null, lookups).verb).toBe("Searching icons for “email”…");
    expect(describeSiftOp(sift("mystery"), null, lookups).verb).toBe("Running sift mystery…");
    expect(describeSiftOp(sift("history task_1"), ok({}), lookups).detail).toBeUndefined();
    const call: SiftCall = { pos: ["tasks", "add"], flags: {}, lists: {} };
    expect(describeSiftOp(call, ok({}), lookups).tasks).toEqual([]);
  });
});
