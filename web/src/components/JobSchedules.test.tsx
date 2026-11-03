import { describe, expect, it } from "vitest";
import { describeSchedule, describeSchedules } from "./JobSchedules";

describe("schedule summaries", () => {
  it("reads each kind of schedule the way a person would say it", () => {
    expect(describeSchedule({ type: "daily", schedule: "09:00" })).toBe("Every day at 09:00");
    expect(describeSchedule({ type: "weekdays", schedule: "17:30", weekdays: [5, 1, 2, 3, 4] })).toBe("Weekdays at 17:30");
    expect(describeSchedule({ type: "weekdays", schedule: "10:00", weekdays: [6, 0] })).toBe("Weekends at 10:00");
    expect(describeSchedule({ type: "weekdays", schedule: "08:15", weekdays: [3, 1, 3] })).toBe("Mon, Wed at 08:15");
    expect(describeSchedule({ type: "interval", schedule: "2h" })).toBe("Every 2h");
    expect(describeSchedule({ type: "cron", schedule: "0 9 * * 1-5" })).toBe("Cron 0 9 * * 1-5");
  });
  it("lists up to three schedules and counts the rest", () => {
    const four = ["1h", "2h", "3h", "4h"].map(schedule => ({ type: "interval", schedule }));
    expect(describeSchedules(four.slice(0, 3))).toBe("Every 1h · Every 2h · Every 3h");
    expect(describeSchedules(four)).toBe("Every 1h · Every 2h · +2 more");
  });
});
