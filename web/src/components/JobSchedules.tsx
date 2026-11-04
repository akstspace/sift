import { useId, useRef } from "react";
import { IconPlus as Plus, IconX as X } from "@tabler/icons-react";
import type { JobSchedule } from "../types";
import { Action, Button, Field, IconButton } from "./shared";
import { Choice } from "./Choice";
import { Input } from "./ui/input";

/** Matches the service's limit on schedules per job. */
export const MAX_SCHEDULES = 20;
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WORKWEEK = [1, 2, 3, 4, 5];
const START: Record<string, string> = { daily: "09:00", weekdays: "09:00", interval: "1h", cron: "0 9 * * 1-5" };
const TYPES = [
  { value: "daily", label: "Every day" },
  { value: "weekdays", label: "Selected weekdays" },
  { value: "interval", label: "Repeating interval" },
  { value: "cron", label: "Advanced cron" },
];
const clock = (type: string) => type === "daily" || type === "weekdays";

function days(list: number[] = []) {
  const set = [...new Set(list)].sort((a, b) => a - b);
  if (set.join() === "1,2,3,4,5") return "Weekdays";
  if (set.join() === "0,6") return "Weekends";
  return set.map((d) => DAYS[d]).join(", ");
}
export function describeSchedule(s: JobSchedule) {
  if (s.type === "daily") return `Every day at ${s.schedule}`;
  if (s.type === "weekdays") return `${days(s.weekdays)} at ${s.schedule}`;
  if (s.type === "interval") return `Every ${s.schedule}`;
  return `Cron ${s.schedule}`;
}
/** "every day at 12:30, 17:30 and 22:00" when every schedule is daily, else the usual summary. */
export function describeDailyTimes(list: JobSchedule[]) {
  if (!list.length || !list.every(s => s.type === "daily")) return describeSchedules(list).toLowerCase();
  const times = list.map(s => s.schedule).sort();
  return "every day at " + (times.length > 1 ? times.slice(0, -1).join(", ") + " and " + times[times.length - 1] : times[0]);
}
/** A short summary for the jobs list; long lists end with a count. */
export function describeSchedules(list: JobSchedule[]) {
  const parts = list.map(describeSchedule);
  return (parts.length > 3 ? [...parts.slice(0, 2), `+${parts.length - 2} more`] : parts).join(" · ");
}

/**
 * Edits a job's schedules. The job runs at whichever comes next; a job keeps
 * at least one, so a lone schedule cannot be removed.
 */
export function JobSchedules({ value, onChange }: { value: JobSchedule[]; onChange: (value: JobSchedule[]) => void }) {
  const heading = useId(), list = useRef<HTMLDivElement>(null);
  const update = (index: number, next: Partial<JobSchedule>) =>
    onChange(value.map((s, i) => (i === index ? { ...s, ...next } : s)));
  // React commits a click's update before the next frame, so the new or
  // remaining row exists when focus moves.
  const focusLater = (selector: string) =>
    requestAnimationFrame(() => list.current?.querySelector<HTMLElement>(selector)?.focus());
  const add = () => {
    onChange([...value, { type: "daily", schedule: "" }]);
    focusLater(`[data-schedule="${value.length}"] input`);
  };
  const remove = (index: number) => {
    onChange(value.filter((_, i) => i !== index));
    const next = Math.min(index, value.length - 2);
    focusLater(value.length > 2 ? `[data-schedule="${next}"] .schedule-remove` : ".schedule-add");
  };
  const many = value.length > 1;
  return (
    <div className="job-schedules" role="group" aria-labelledby={heading} ref={list}>
      <div className="job-schedules-heading">
        <span id={heading}>Schedules</span>
        <small>The job runs at whichever comes next, in the timezone below.</small>
      </div>
      {value.map((s, i) => (
        <fieldset key={i} className="schedule-row" data-schedule={i} aria-label={`Schedule ${i + 1}`}>
          {many && (
            <div className="schedule-row-heading">
              <span>Schedule {i + 1}</span>
              <IconButton label={`Remove schedule ${i + 1}`} className="schedule-remove" onClick={() => remove(i)}>
                <X size={15} />
              </IconButton>
            </div>
          )}
          <div className="form-grid">
            <Field label="Repeats">
              <Choice
                value={s.type}
                onValueChange={(type) =>
                  update(i, {
                    type,
                    schedule: START[type],
                    weekdays: type === "weekdays" ? (s.weekdays?.length ? s.weekdays : WORKWEEK) : undefined,
                  })
                }
                options={TYPES}
              />
            </Field>
            <Field
              label={s.type === "interval" ? "Interval" : s.type === "cron" ? "Cron expression" : "Local time"}
              hint={s.type === "interval" ? "For example 30m or 2h" : s.type === "cron" ? "Minute hour day month weekday" : "24-hour time, HH:mm (for example 09:00)"}
            >
              <Input
                required
                type="text"
                placeholder={clock(s.type) ? "09:00" : undefined}
                pattern={clock(s.type) ? "([01][0-9]|2[0-3]):[0-5][0-9]" : undefined}
                value={s.schedule}
                onChange={(e) => update(i, { schedule: e.target.value })}
              />
            </Field>
          </div>
          {s.type === "weekdays" && (
            <div className="weekday-picker" role="group" aria-label="Days">
              {DAYS.map((d, day) => {
                const on = s.weekdays?.includes(day) ?? false;
                return (
                  <Action
                    type="button"
                    key={d}
                    aria-pressed={on}
                    onClick={() =>
                      update(i, { weekdays: on ? (s.weekdays ?? []).filter((n) => n !== day) : [...(s.weekdays ?? []), day] })
                    }
                  >
                    {d}
                  </Action>
                );
              })}
            </div>
          )}
        </fieldset>
      ))}
      <Button type="button" variant="outline" size="sm" className="schedule-add" disabled={value.length >= MAX_SCHEDULES} onClick={add}>
        <Plus size={14} />
        Add schedule
      </Button>
    </div>
  );
}
