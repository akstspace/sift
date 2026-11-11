import { expect, it } from "vitest";
import { newTask } from "./types";
import { cn } from "./lib/utils";
it("creates isolated editable task drafts with at most an explicit parent", () => {
  const a = newTask(), b = newTask("tsk_parent");
  expect(a.parentId).toBe(""); expect(b.parentId).toBe("tsk_parent");
  expect(a).toMatchObject({ status: "open", priority: "none", revision: 0, source: "user" });
  expect(a).not.toHaveProperty("today");
  a.tags.push("local"); expect(b.tags).toEqual([]);
  expect(a.checklist).not.toBe(b.checklist); expect(a.attachments).not.toBe(b.attachments);
});
it("merges conditional utility classes", () => {
  expect(cn("p-2", false && "hidden", "p-4")).toBe("p-4");
});
