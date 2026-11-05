import { describe, expect, it } from "vitest";
import type { ActivityCheck, ActivityEntry } from "../types";
import {
  CATEGORIES, spanLabel, addDays, categoryOf, clock, coverageLabel, dayOf, dayTitle, dayView, duration, lanes, minuteOf, nextCheckLabel,
  offsetAt, partOf, ribbonHours, sections, subtract, union, weekOf, zoned,
} from "./model";

const t = (iso: string) => new Date(iso).valueOf();
const MIN = 60_000, HOUR = 60 * MIN;
const c = (iso: string) => clock(t(iso), "UTC");
let n = 0;
export const entry = (start: string, end: string, overrides: Partial<ActivityEntry> = {}): ActivityEntry => ({
  id: "act_" + ++n, start, end, title: "Session " + n, summary: "", category: "code", source: "github", link: "", taskId: "", sourceKey: "",
  actor: "job:job_activity", createdAt: start, updatedAt: start, revision: 1, ...overrides,
});
const check = (from: string, to: string): ActivityCheck => ({ id: "chk_" + ++n, from, to, runId: "run", at: to });

describe("time in the workspace timezone", () => {
  it("finds offsets, days and minutes in named zones", () => {
    expect(offsetAt(t("2026-11-04T12:00:00Z"), "UTC")).toBe(0);
    expect(offsetAt(t("2026-11-04T12:00:00Z"), "Asia/Kolkata")).toBe(330);
    expect(offsetAt(t("2026-07-04T12:00:00Z"), "America/New_York")).toBe(-240);
    expect(offsetAt(t("2026-11-04T12:00:00Z"), "Not/AZone")).toBe(-new Date(t("2026-11-04T12:00:00Z")).getTimezoneOffset());
    expect(new Date(zoned("2026-11-04", 9 * 60, "Asia/Kolkata")).toISOString()).toBe("2026-11-04T03:30:00.000Z");
    // The spring-forward gap and the fall-back overlap both land on a real instant.
    expect(new Date(zoned("2026-03-08", 0, "America/New_York")).toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(new Date(zoned("2026-11-01", 12 * 60, "America/New_York")).toISOString()).toBe("2026-11-01T17:00:00.000Z");
    expect(dayOf(t("2026-11-04T20:00:00Z"), "Asia/Kolkata")).toBe("2026-11-05");
    expect(dayOf(t("2026-11-04T02:00:00Z"), "America/New_York")).toBe("2026-11-03");
    expect(minuteOf(t("2026-11-04T03:30:00Z"), "Asia/Kolkata")).toBe(9 * 60);
    expect(minuteOf(t("2026-11-04T23:59:00Z"), "UTC")).toBe(23 * 60 + 59);
  });
  it("moves between days and weeks", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(weekOf("2026-11-04")).toBe("2026-11-02");
    expect(weekOf("2026-11-02")).toBe("2026-11-02");
    expect(weekOf("2026-11-08")).toBe("2026-11-02");
  });
  it("formats clocks, days and durations", () => {
    expect(clock(t("2026-11-04T09:05:00Z"), "UTC")).toMatch(/09:05|9:05/);
    expect(clock(t("2026-11-04T09:05:00Z"), "Bad/Zone")).toBeTruthy();
    expect(dayTitle("2026-11-04")).toMatch(/Wednesday/);
    expect(dayTitle("2026-11-04", { weekday: "short" })).toMatch(/Wed/);
    expect(duration(20_000)).toBe("under a minute");
    expect(duration(45 * MIN)).toBe("45m");
    expect(duration(2 * HOUR)).toBe("2h");
    expect(duration(75 * MIN)).toBe("1h 15m");
  });
  it("names categories, falling back to Other", () => {
    expect(categoryOf("review").label).toBe("Reviewing");
    expect(categoryOf("gardening")).toBe(CATEGORIES[CATEGORIES.length - 1]);
    expect(partOf(4 * 60)).toBe("night");
    expect(partOf(9 * 60)).toBe("morning");
    expect(partOf(13 * 60)).toBe("afternoon");
    expect(partOf(19 * 60)).toBe("evening");
  });
});

describe("spans", () => {
  it("merges overlaps and drops empty spans", () => {
    expect(union([{ from: 5, to: 9 }, { from: 0, to: 3 }, { from: 2, to: 6 }, { from: 7, to: 7 }])).toEqual([{ from: 0, to: 9 }]);
    expect(union([{ from: 0, to: 1 }, { from: 2, to: 3 }])).toEqual([{ from: 0, to: 1 }, { from: 2, to: 3 }]);
  });
  it("finds what's left uncovered, ignoring slivers", () => {
    const span = { from: 0, to: 10 * HOUR };
    expect(subtract(span, [])).toEqual([span]);
    expect(subtract(span, [{ from: HOUR, to: 2 * HOUR }, { from: 3 * HOUR, to: 11 * HOUR }])).toEqual([{ from: 0, to: HOUR }, { from: 2 * HOUR, to: 3 * HOUR }]);
    expect(subtract(span, [{ from: -HOUR, to: 0 }, { from: 30_000, to: 10 * HOUR }])).toEqual([]);
    expect(subtract({ from: 0, to: HOUR }, [{ from: 2 * HOUR, to: 3 * HOUR }])).toEqual([{ from: 0, to: HOUR }]);
  });
  it("puts overlapping sessions on up to three lanes", () => {
    const m = (from: number, to: number) => ({ from: from * MIN, to: to * MIN });
    expect(lanes([m(0, 10), m(5, 15), m(6, 8), m(7, 9), m(20, 20)])).toEqual([0, 1, 2, 2, 0]);
  });
});

describe("a day", () => {
  const now = t("2026-11-04T13:00:00Z");
  const since = "2026-11-02T00:00:00Z";
  it("collects sessions, checked time and what's still open", () => {
    const entries = [
      entry("2026-11-04T09:10:00Z", "2026-11-04T10:25:00Z", { taskId: "tsk_a" }),
      entry("2026-11-04T10:00:00Z", "2026-11-04T10:30:00Z", { category: "meeting", taskId: "tsk_a" }),
      entry("2026-11-04T11:00:00Z", "2026-11-04T11:00:00Z", { category: "message" }),
      entry("2026-11-03T23:30:00Z", "2026-11-04T00:30:00Z", { category: "writing" }),
      entry("2026-11-03T09:00:00Z", "2026-11-03T10:00:00Z"),
    ];
    const view = dayView("2026-11-04", "UTC", entries, [check("2026-11-03T00:00:00Z", "2026-11-04T12:00:00Z")], { now, since, autoFrom: t(since) });
    expect(view.sessions.map(s => s.title)).toEqual([entries[3].title, entries[0].title, entries[1].title, entries[2].title]);
    expect(view.total).toBe(30 * MIN + 80 * MIN);
    expect(view.categories.map(c => [c.id, c.total])).toEqual([["code", 75 * MIN], ["meeting", 30 * MIN], ["writing", 30 * MIN]]);
    expect(view.tasks).toEqual(["tsk_a"]);
    expect(view.checked).toEqual([{ from: view.start, to: t("2026-11-04T12:00:00Z") }]);
    expect(view.gaps).toEqual([{ from: t("2026-11-04T12:00:00Z"), to: now, kind: "next" }]);
    expect(view.future).toBe(false);
    expect(view.beforeTracking).toBe(false);
    expect(coverageLabel(view, "UTC", now)).toBe(`Checked ${c("2026-11-04T00:00:00Z")}–${c("2026-11-04T12:00:00Z")}`);
  });
  it("splits open time into a running check, scheduled and older stretches", () => {
    const view = dayView("2026-11-04", "UTC", [], [], {
      now, autoFrom: t("2026-11-04T06:00:00Z"),
      running: [{ from: "2026-11-04T08:00:00Z", to: "2026-11-04T09:00:00Z" }],
    });
    expect(view.gaps.map(g => [new Date(g.from).toISOString().slice(11, 16), new Date(g.to).toISOString().slice(11, 16), g.kind])).toEqual([
      ["00:00", "06:00", "older"], ["06:00", "08:00", "next"], ["08:00", "09:00", "running"], ["09:00", "13:00", "next"],
    ]);
    expect(coverageLabel(view, "UTC", now)).toBe("Checking now");
    const brief = dayView("2026-11-04", "UTC", [], [], { now, running: [{ from: "2026-11-04T12:59:30Z", to: "2026-11-04T13:00:00Z" }] });
    expect(brief.gaps.map(g => g.kind)).toEqual(["next"]);
    const older = dayView("2026-11-04", "UTC", [], [], { now, autoFrom: now + HOUR });
    expect(older.gaps.map(g => g.kind)).toEqual(["older"]);
    expect(coverageLabel(older, "UTC", now)).toBe("Not checked yet");
  });
  it("knows days before tracking and days still to come", () => {
    const before = dayView("2026-11-01", "UTC", [], [], { now, since });
    expect(before.beforeTracking).toBe(true);
    expect(before.gaps).toEqual([]);
    const reading = dayView("2026-11-01", "UTC", [], [], { now, since, autoFrom: t(since), running: [{ from: "2026-11-01T00:00:00Z", to: "2026-11-02T00:00:00Z" }] });
    expect(reading.beforeTracking).toBe(false);
    expect(reading.gaps).toEqual([{ from: t("2026-11-01T00:00:00Z"), to: t("2026-11-02T00:00:00Z"), kind: "running" }]);
    const added = dayView("2026-11-01", "UTC", [entry("2026-11-01T09:00:00Z", "2026-11-01T10:00:00Z", { actor: "user" })], [], { now, since, autoFrom: t(since) });
    expect(added.beforeTracking).toBe(false);
    expect(added.gaps.map(g => g.kind)).toEqual(["older"]);
    const checkedBefore = dayView("2026-11-01", "UTC", [], [check("2026-11-01T00:00:00Z", "2026-11-02T00:00:00Z")], { now, since });
    expect(checkedBefore.beforeTracking).toBe(false);
    expect(coverageLabel(checkedBefore, "UTC", now)).toBe("Whole day checked");
    const future = dayView("2026-11-05", "UTC", [], [], { now });
    expect(future.future).toBe(true);
    expect(coverageLabel(future, "UTC", now)).toBe("");
  });
  it("describes how much of a day was checked", () => {
    const today = (checks: ActivityCheck[], running?: { from: string; to: string }[]) => dayView("2026-11-04", "UTC", [], checks, { now, running });
    expect(coverageLabel(today([check("2026-11-04T00:00:00Z", "2026-11-04T13:00:00Z")]), "UTC", now)).toBe("Checked until " + c("2026-11-04T13:00:00Z"));
    expect(coverageLabel(today([check("2026-11-04T00:00:00Z", "2026-11-04T11:00:00Z")], [{ from: "2026-11-04T11:00:00Z", to: "2026-11-04T13:00:00Z" }]), "UTC", now)).toBe("Checked until " + c("2026-11-04T11:00:00Z"));
    expect(coverageLabel(today([check("2026-11-04T06:00:00Z", "2026-11-04T11:00:00Z")]), "UTC", now)).toBe(`Checked ${c("2026-11-04T06:00:00Z")}–${c("2026-11-04T11:00:00Z")}`);
    expect(coverageLabel(today([check("2026-11-04T01:00:00Z", "2026-11-04T02:00:00Z"), check("2026-11-04T05:00:00Z", "2026-11-04T06:00:00Z")]), "UTC", now)).toBe("Partly checked");
    const yesterday = dayView("2026-11-03", "UTC", [], [check("2026-11-03T06:00:00Z", "2026-11-04T06:00:00Z")], { now });
    expect(coverageLabel(yesterday, "UTC", now)).toBe("Checked from " + c("2026-11-03T06:00:00Z"));
    const late = dayView("2026-11-03", "UTC", [], [check("2026-11-03T00:00:00Z", "2026-11-03T18:30:00Z")], { now });
    expect(coverageLabel(late, "UTC", now)).toBe(`Checked ${c("2026-11-03T00:00:00Z")}–${c("2026-11-03T18:30:00Z")}`);
  });
  it("sizes the ribbon to the day's sessions and now", () => {
    const plain = dayView("2026-11-04", "UTC", [], [], { now: t("2026-11-06T00:00:00Z") });
    expect(ribbonHours(plain, "UTC", t("2026-11-06T00:00:00Z"))).toEqual([8, 20]);
    const wide = dayView("2026-11-04", "UTC", [entry("2026-11-04T06:20:00Z", "2026-11-04T21:10:00Z")], [], { now });
    expect(ribbonHours(wide, "UTC", t("2026-11-04T22:30:00Z"))).toEqual([6, 23]);
    const across = dayView("2026-11-04", "UTC", [entry("2026-11-03T22:00:00Z", "2026-11-05T01:00:00Z")], [], { now });
    expect(ribbonHours(across, "UTC", now)).toEqual([0, 24]);
    const instant = dayView("2026-11-04", "UTC", [entry("2026-11-04T00:00:00Z", "2026-11-04T00:00:00Z"), entry("2026-11-03T23:00:00Z", "2026-11-03T23:00:00Z")], [], { now });
    expect(instant.sessions).toHaveLength(1);
    expect(ribbonHours(instant, "UTC", now)).toEqual([0, 20]);
    const midnight = dayView("2026-11-04", "UTC", [entry("2026-11-04T10:00:00Z", "2026-11-04T10:00:00Z")], [], { now });
    expect(ribbonHours(midnight, "UTC", now)).toEqual([8, 20]);
  });
});

describe("the feed", () => {
  const now = t("2026-11-04T21:00:00Z");
  it("lists sessions and open time most recent first by part of day, marking long quiet stretches", () => {
    const entries = [
      entry("2026-11-04T03:00:00Z", "2026-11-04T03:30:00Z"),
      entry("2026-11-04T09:00:00Z", "2026-11-04T10:00:00Z"),
      entry("2026-11-04T12:30:00Z", "2026-11-04T13:00:00Z"),
      entry("2026-11-04T18:00:00Z", "2026-11-05T01:00:00Z"),
    ];
    const view = dayView("2026-11-04", "UTC", entries, [check("2026-11-04T00:00:00Z", "2026-11-04T16:00:00Z")], {
      now, running: [{ from: "2026-11-04T16:00:00Z", to: "2026-11-04T21:00:00Z" }],
    });
    const parts = sections(view, "UTC");
    expect(parts.map(p => [p.part, p.rows.map(r => r.kind), p.total / MIN])).toEqual([
      ["evening", ["session"], 360],
      ["afternoon", ["session"], 30],
      ["morning", ["quiet", "session"], 60],
      ["night", ["quiet", "session"], 30],
    ]);
    // The check in progress isn't in a part of the day; the feed shows it on its own.
    expect(view.gaps.map(g => g.kind)).toEqual(["running"]);
  });
  it("puts open time above a session that starts with it", () => {
    const view = dayView("2026-11-04", "UTC", [entry("2026-11-04T12:00:00Z", "2026-11-04T12:30:00Z")], [check("2026-11-04T00:00:00Z", "2026-11-04T12:00:00Z")], { now });
    expect(sections(view, "UTC").flatMap(p => p.rows.map(r => r.kind))).toEqual(["gap", "session"]);
  });
  it("doesn't call unchecked time quiet", () => {
    const view = dayView("2026-11-04", "UTC", [entry("2026-11-04T08:00:00Z", "2026-11-04T08:30:00Z"), entry("2026-11-04T11:00:00Z", "2026-11-04T11:30:00Z")], [], { now });
    expect(sections(view, "UTC").flatMap(p => p.rows.map(r => r.kind))).toEqual(["session", "session", "gap"]);
  });
});

describe("next check", () => {
  const now = t("2026-11-04T13:00:00Z");
  it("says when, relative to today", () => {
    expect(nextCheckLabel("", "UTC", now)).toBe("");
    expect(nextCheckLabel("2026-11-04T17:30:00Z", "UTC", now)).toBe(c("2026-11-04T17:30:00Z"));
    expect(nextCheckLabel("2026-11-05T12:30:00Z", "UTC", now)).toBe("tomorrow " + c("2026-11-05T12:30:00Z"));
    expect(nextCheckLabel("2026-11-09T12:30:00Z", "UTC", now)).toMatch(/^Mon.* /);
  });
});

describe("spans in words", () => {
  it("names the whole day, open ends and plain ranges", () => {
    const now = t("2026-11-04T13:00:00Z");
    const today = dayView("2026-11-04", "UTC", [], [], { now });
    const yesterday = dayView("2026-11-03", "UTC", [], [], { now });
    expect(spanLabel({ from: yesterday.start, to: yesterday.end }, yesterday, "UTC", now)).toBe("Whole day");
    expect(spanLabel({ from: t("2026-11-03T18:30:00Z"), to: yesterday.end }, yesterday, "UTC", now)).toBe(c("2026-11-03T18:30:00Z") + "–midnight");
    expect(spanLabel({ from: t("2026-11-04T09:00:00Z"), to: now - 30_000 }, today, "UTC", now)).toBe(c("2026-11-04T09:00:00Z") + "–now");
    // Tracking that began a moment ago: the time before it ends at that moment.
    expect(spanLabel({ from: today.start, to: now - 30_000, kind: "older" }, today, "UTC", now)).toBe(`${c("2026-11-04T00:00:00Z")}–${clock(now - 30_000, "UTC")}`);
    expect(spanLabel({ from: t("2026-11-04T09:00:00Z"), to: t("2026-11-04T10:00:00Z") }, today, "UTC", now)).toBe(`${c("2026-11-04T09:00:00Z")}–${c("2026-11-04T10:00:00Z")}`);
  });
});
