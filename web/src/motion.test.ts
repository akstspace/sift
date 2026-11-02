import { describe, expect, it } from "vitest";
import { pageMotion, pageOrder, taskSheetMotion } from "./motion";
describe("deterministic motion contracts", () => {
  it.each([true, false])("removes spatial movement with reduced=%s", mobile => {
    const sheet = taskSheetMotion(true, mobile);
    expect(sheet.initial).toEqual({ opacity: 0, x: 0, scale: 1 });
    expect(sheet.exit.x).toBe(0); expect(sheet.exit.scale).toBe(1);
    expect(sheet.animate.transition.duration).toBe(0.1);
  });
  it.each([true, false])("coordinates mobile=%s sheet opening and closing", mobile => {
    const sheet = taskSheetMotion(false, mobile);
    expect(sheet.initial.x).toBe(mobile ? 40 : 80);
    expect(sheet.initial.scale).toBe(mobile ? 1 : 0.985);
    expect(sheet.exit.x).toBe(mobile ? 32 : 56);
    expect(sheet.exit.scale).toBe(mobile ? 1 : 0.99);
    expect(sheet.animate.transition.duration).toBe(0.34);
  });
  it.each([true, false])("provides directional route transitions reduced=%s", reduced => {
    const page = pageMotion(reduced);
    expect(page.enter(1).x).toBe(reduced ? 0 : 18); expect(page.enter(-1).x).toBe(reduced ? 0 : -18);
    expect(page.exit(1)).toBeDefined(); expect(page.exit(-1)).toBeDefined();
    expect(page.visible.opacity).toBe(1); expect(pageOrder).toContain("today");
  });
});
