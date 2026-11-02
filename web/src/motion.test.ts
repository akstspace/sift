import { describe, expect, it } from "vitest";
import { cardMotion, pageDirection, pageMotion, pageOrder, projectTitleId, taskSheetMotion } from "./motion";
describe("deterministic motion contracts", () => {
  it.each([true, false])("removes spatial movement with reduced=%s", mobile => {
    const sheet = taskSheetMotion(true, mobile);
    expect(sheet.initial).toEqual({ opacity: 0, x: 0, scale: 1 });
    expect(sheet.exit.x).toBe(0); expect(sheet.exit.scale).toBe(1);
    expect(sheet.animate.transition).toEqual({ duration: 0.12 });
  });
  it.each([true, false])("makes the mobile=%s sheet opaque before it stops travelling", mobile => {
    const sheet = taskSheetMotion(false, mobile);
    expect(sheet.initial.x).toBe(mobile ? 36 : 64);
    expect(sheet.initial.scale).toBe(mobile ? 1 : 0.985);
    expect(sheet.exit.x).toBe(mobile ? 28 : 40);
    expect(sheet.exit.scale).toBe(mobile ? 1 : 0.99);
    const { duration, opacity } = sheet.animate.transition as { duration: number; opacity: { duration: number } };
    expect(opacity.duration).toBeLessThan(duration / 2);
  });
  it("drifts sibling pages along sidebar order and keeps project changes vertical", () => {
    const page = pageMotion(false);
    expect(page.enter({ sign: 1, depth: false })).toEqual({ opacity: 0, x: 14 });
    expect(page.enter({ sign: -1, depth: false })).toEqual({ opacity: 0, x: -14 });
    expect(page.enter({ sign: 1, depth: true })).toMatchObject({ opacity: 0, y: 14 });
    expect(page.enter({ sign: -1, depth: true })).toMatchObject({ opacity: 0, y: -6 });
    expect(page.exit({ sign: 1, depth: false })).toMatchObject({ opacity: 0, x: -10 });
    expect(page.exit({ sign: 1, depth: true })).toMatchObject({ opacity: 0, y: -6 });
    expect(page.exit({ sign: -1, depth: true })).toMatchObject({ opacity: 0, y: 10 });
    expect(page.visible).toMatchObject({ opacity: 1, x: 0, y: 0, scale: 1 });
  });
  it("cross-fades without travel when motion is reduced", () => {
    const page = pageMotion(true);
    for (const d of [{ sign: 1, depth: false }, { sign: -1, depth: true }] as const) {
      expect(page.enter(d)).toEqual({ opacity: 0 });
      expect(page.exit(d)).toEqual({ opacity: 0, transition: { duration: 0.08 } });
    }
    expect(page.visible.transition).toEqual({ duration: 0.14 });
  });
  it("derives direction from the route hierarchy before sidebar order", () => {
    expect(pageDirection({ page: "organization", project: "" }, { page: "backlog", project: "p" })).toEqual({ sign: 1, depth: true });
    expect(pageDirection({ page: "backlog", project: "p" }, { page: "organization", project: "" })).toEqual({ sign: -1, depth: true });
    expect(pageDirection({ page: "backlog", project: "p" }, { page: "today", project: "" })).toEqual({ sign: -1, depth: false });
    expect(pageDirection({ page: "today", project: "" }, { page: "jobs", project: "" })).toEqual({ sign: 1, depth: false });
    expect(pageOrder).toContain("organization");
  });
  it.each([true, false])("lets arriving cards settle with reduced=%s", reduced => {
    const card = cardMotion(reduced);
    expect(card.initial).toEqual(reduced ? { opacity: 0 } : { opacity: 0, y: -6, scale: 0.98 });
    expect(card.exit.opacity).toBe(0); expect(card.exit.scale).toBe(reduced ? 1 : 0.98);
  });
  it("names shared project titles by stable project ID", () => {
    expect(projectTitleId("project_1")).toBe("project-title:project_1");
  });
});
