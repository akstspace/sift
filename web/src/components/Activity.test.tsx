import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Activity, describeChange, whenLabel, type ActivityLookups } from "./Activity";
import { actorName } from "./AgentBadge";
import { shortUrl } from "./AgentMarkdown";
import { jobFixture, snapshotFixture, taskFixture } from "../test/fixtures";
import type { HistoryEntry } from "../types";

const lookups: ActivityLookups = {
  ...snapshotFixture({
    projects: [{ id: "prj_home", name: "Home", color: "blue", archived: false, icon: "" }],
    tags: [{ id: "tag_bills", name: "Bills", color: "red", archived: false, icon: "" }, { id: "tag_old", name: "Old", color: "red", archived: false, icon: "" }],
    jobs: [jobFixture({ id: "job_1", name: "Morning planning" })],
  }),
};
const now = new Date(2026, 10, 3, 22, 0);
const local = (h: number, m: number, day = 3, month = 10, year = 2026) => new Date(year, month, day, h, m).toISOString();

describe("activity helpers", () => {
  it("names who acted", () => {
    expect(actorName("user", [])).toEqual({ name: "You", kind: "you" });
    expect(actorName("", [])).toEqual({ name: "You", kind: "you" });
    expect(actorName("chat", [])).toEqual({ name: "Sift", kind: "sift" });
    expect(actorName("job:job_1", lookups.jobs)).toEqual({ name: "Morning planning", kind: "job" });
    expect(actorName("job:job_gone", lookups.jobs)).toEqual({ name: "A deleted job", kind: "job" });
    expect(actorName("local-agent", [])).toEqual({ name: "Local agent", kind: "agent" });
    expect(actorName("codex", [])).toEqual({ name: "codex", kind: "agent" });
  });
  it("says when, relative to now", () => {
    expect(whenLabel(new Date(now.valueOf() - 30000).toISOString(), now)).toBe("Just now");
    expect(whenLabel(local(21, 59, 3), now)).toBe("1 min ago");
    expect(whenLabel(local(21, 48, 3), now)).toBe("12 min ago");
    expect(whenLabel(local(9, 5, 3), now)).toMatch(/^Today, 0?9:05/);
    expect(whenLabel(local(9, 5, 2), now)).toMatch(/^Yesterday, /);
    expect(whenLabel(local(9, 5, 20, 9), now)).toMatch(/20/);
    expect(whenLabel(local(9, 5, 20, 9), now)).not.toMatch(/2026/);
    expect(whenLabel(local(9, 5, 20, 9, 2025), now)).toMatch(/2025/);
    expect(whenLabel(local(23, 0, 3), now)).toMatch(/^Today, /);
    expect(whenLabel("not a date", now)).toBe("not a date");
    expect(whenLabel(local(21, 59, 3))).toBeTypeOf("string");
  });
  it("describes what a change did", () => {
    const before = taskFixture({ tags: ["tag_old"], checklist: [{ id: "c1", title: "A", done: false }], attachments: ["att_1", "att_2"] });
    expect(describeChange(undefined, before, lookups)).toEqual([]);
    expect(describeChange(before, before, lookups)).toEqual([]);
    expect(describeChange(before, {
      ...before, deletedAt: "x", mergedInto: "tsk_2", archivedAt: "x", status: "done", title: "New", priority: "high", today: false,
      dueDate: "2026-11-14", snoozedUntil: "2026-11-05", project: "prj_home", tags: ["tag_bills"], parentId: "tsk_parent",
      description: "More", checklist: [{ id: "c1", title: "A", done: true }, { id: "c2", title: "B", done: false }], attachments: [], icon: "home",
    }, lookups)).toEqual([
      "Deleted", "Merged into another task", "Archived", "Moved to Done", "Renamed", "High priority", "Removed from Today",
      expect.stringMatching(/^Due (Nov 14|14 Nov)$/), expect.stringMatching(/^Snoozed until (Nov 5|5 Nov)$/), "Project: Home", "Tagged Bills", "Untagged Old",
      "Made a subtask", "Edited description", "Checklist 1/2", "Removed 2 images", "Changed icon",
    ]);
    const changed = { ...before, today: false, deletedAt: "x", archivedAt: "x", priority: "urgent", dueDate: "2026-11-14", snoozedUntil: "2026-11-05", project: "prj_gone", parentId: "tsk_parent", tags: ["tag_new"] };
    expect(describeChange(changed, {
      ...changed, deletedAt: "", archivedAt: "", status: "mystery", priority: "none", today: true, dueDate: "", snoozedUntil: "",
      project: "", parentId: "", checklist: [], attachments: ["att_1", "att_2", "att_3"],
    }, lookups)).toEqual([
      "Restored", "Unarchived", "Moved to mystery", "No priority", "Added to Today", "No due date", "Unsnoozed", "No project",
      "Made top-level", "Cleared checklist", "Added an image",
    ]);
    expect(describeChange(before, { ...before, attachments: ["att_1", "att_2", "att_3", "att_4"], project: "prj_gone", dueDate: "soon" }, lookups))
      .toEqual(["Due soon", "Project: prj_gone", "Added 2 images"]);
    expect(describeChange(before, { ...before, attachments: ["att_1"] }, lookups)).toEqual(["Removed an image"]);
    const bare = { ...before, tags: undefined, checklist: undefined, attachments: undefined } as unknown as typeof before;
    expect(describeChange(bare, bare, lookups)).toEqual([]);
  });
  it("shortens long bare addresses", () => {
    expect(shortUrl("https://www.example.com/")).toBe("example.com");
    expect(shortUrl("mailto:a@b.co")).toBe("a@b.co");
    const runs = shortUrl("https://github.com/akaike-byob/akaike-chat/actions/runs/41615249361");
    expect(runs).toBe("github.com/akaike-byob/akaike-c…/41615249361");
    const mail = shortUrl("https://mail.google.com/mail/u/akshay.t@akaiketech.com/#all/1a1613e7980f63e3");
    expect(mail).toBe("mail.google.com/mail/u/aks…/1a1613e7980f63e3");
    const opaque = shortUrl("https://example.com/" + "a".repeat(60));
    expect(opaque).toBe("example.com/" + "a".repeat(18) + "…" + "a".repeat(13));
    for (const s of [runs, mail, opaque]) expect(s.length).toBeLessThanOrEqual(44);
  });
});

describe("Activity", () => {
  const entry = (over: Partial<HistoryEntry>): HistoryEntry => ({ id: 1, kind: "task", entityId: "tsk_test", actor: "user", reason: "", at: local(21, 30), ...over });
  it("shows nothing without history", () => {
    const { container } = render(<Activity history={[]} lookups={lookups} />);
    expect(container.innerHTML).toBe("");
  });
  it("shows comments as notes under a pill, and changes as pills, newest first", () => {
    const task = taskFixture();
    const history = [
      entry({ id: 1, after: task }),
      entry({ id: 2, actor: "job:job_1", before: task, after: { ...task, status: "done", priority: "high" }, reason: "CI passed at dc2ea74" }),
      entry({ id: 3, kind: "comment", actor: "chat", reason: "Context check: **no reply** yet. https://github.com/akaike-byob/akaike-chat/actions/runs/41615249361\n\n<script>x</script>" }),
      entry({ id: 4, actor: "local-agent", before: task, after: task }),
      entry({ id: 5, actor: "codex", before: task, after: { ...task, title: "a", priority: "low", today: false, dueDate: "2026-11-20", project: "prj_home", description: "d", icon: "x" } }),
    ];
    render(<Activity history={history} lookups={lookups} now={now} undo={h => <button type="button">Undo {h.id}</button>} />);
    const items = within(screen.getByRole("list", { name: "Task activity" })).getAllByRole("listitem").filter(li => li.classList.contains("activity-entry"));
    expect(items.map(li => li.querySelector(".activity-actor")?.textContent)).toEqual(["codex", "Local agent", "Sift", "Morning planning", "You"]);

    const comment = items[2];
    expect(comment.className).toContain("is-comment");
    expect(within(comment).getByText("Comment").className).toContain("activity-pill");
    expect(within(comment).getByText("no reply").tagName).toBe("STRONG");
    const link = within(comment).getByRole("link");
    expect(link.getAttribute("href")).toBe("https://github.com/akaike-byob/akaike-chat/actions/runs/41615249361");
    expect(link.getAttribute("title")).toBe(link.getAttribute("href"));
    expect(link.textContent).toBe("github.com/akaike-byob/akaike-c…/41615249361");
    expect(comment.querySelector("script")).toBeNull();
    expect(within(comment).queryByRole("button")).toBeNull();
    expect(comment.querySelector(".activity-avatar svg.sift-mono")).not.toBeNull();

    const job = items[3];
    expect(within(within(job).getByRole("list", { name: "Changes" })).getAllByRole("listitem").map(li => li.textContent)).toEqual(["Moved to Done", "High priority"]);
    expect(within(job).getByText("CI passed at dc2ea74").className).toBe("activity-reason");
    expect(within(job).getByRole("button", { name: "Undo 2" })).toBeDefined();

    expect(within(items[1]).getByText("Updated this task")).toBeDefined();
    expect(within(items[4]).getByText("Created this task")).toBeDefined();
    expect(items[4].querySelector(".activity-avatar")?.textContent).toBe("Y");
    expect(within(items[0]).getByText("+1 more")).toBeDefined();
    expect(within(items[0]).getAllByRole("listitem")).toHaveLength(7);
    const time = items[3].querySelector("time")!;
    expect(time.getAttribute("dateTime")).toBe(history[1].at);
    expect(time.textContent).toBe("30 min ago");
    expect(time.getAttribute("title")).toMatch(/2026/);
  });
  it("shows reviews and marks a person's save that settled an agent's change", () => {
    const flagged = taskFixture({ status: "done", agentChange: "chat" });
    render(<Activity now={now} lookups={lookups} history={[
      entry({ id: 1, actor: "chat", before: taskFixture(), after: flagged, reason: "Shipped" }),
      entry({ id: 2, kind: "review", reason: "job:job_1" }),
      entry({ id: 3, before: flagged, after: { ...flagged, agentChange: undefined, priority: "high" } }),
    ]} undo={h => <button type="button">Undo {h.id}</button>} />);
    expect(screen.getByText("Reviewed Morning planning’s change")).toBeDefined();
    expect(screen.queryByText("job:job_1")).toBeNull();
    expect(screen.queryByRole("button", { name: "Undo 2" })).toBeNull();
    const latest = screen.getAllByRole("list", { name: "Changes" })[0];
    expect(within(latest).getAllByRole("listitem").map(li => li.textContent)).toEqual(["High priority", "Reviewed"]);
  });
  it("describes an agent's change even when its history entry is missing", async () => {
    const { AgentReview } = await import("./Activity");
    const reviewed = vi.fn(async () => {});
    render(<AgentReview task={taskFixture({ status: "waiting", agentChange: "codex" })} history={[]} lookups={lookups} onReviewed={reviewed} undo={() => <button type="button">Undo</button>} />);
    expect(document.querySelector(".agent-review")?.textContent).toContain("codex moved this to waiting.");
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    render(<AgentReview task={taskFixture({ status: "done", agentChange: "" })} history={[]} lookups={lookups} onReviewed={reviewed} />);
    expect(document.querySelectorAll(".agent-review")[1].textContent).toContain("You moved this to Done.");
  });
  it("leaves out Undo when it isn't offered", () => {
    render(<Activity history={[entry({ id: 9, after: taskFixture() })]} lookups={lookups} now={now} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(document.querySelector(".activity-undo")).toBeNull();
  });
});
