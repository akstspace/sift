package sift

import (
	"errors"
	"slices"
	"strings"
	"time"

	"github.com/robfig/cron/v3"
)

// maxJobSchedules bounds how many triggers one job can have.
const maxJobSchedules = 20

// cleanSchedule trims the value and keeps weekdays only where they apply,
// sorted and without repeats, so equal schedules compare equal.
func cleanSchedule(sc JobSchedule) JobSchedule {
	sc.Type, sc.Schedule = strings.TrimSpace(sc.Type), strings.TrimSpace(sc.Schedule)
	if sc.Type != "weekdays" {
		sc.Weekdays = nil
		return sc
	}
	days := slices.Clone(sc.Weekdays)
	slices.Sort(days)
	sc.Weekdays = slices.Compact(days)
	return sc
}

func sameSchedule(a, b JobSchedule) bool {
	return a.Type == b.Type && a.Schedule == b.Schedule && slices.Equal(a.Weekdays, b.Weekdays)
}

// numbered names the schedule an error belongs to once a job has several.
func numbered(index, count int, err error) error {
	var apiErr *APIError
	if count < 2 || !errors.As(err, &apiErr) {
		return err
	}
	return invalid("Schedule %d: %s", index+1, apiErr.Message)
}

// normalizeSchedules validates a job's schedules before saving and stores
// them cleaned, so equal schedules compare equal.
func normalizeSchedules(j *Job) error {
	list := j.Schedules
	if len(list) == 0 {
		return invalid("Add at least one schedule")
	}
	if len(list) > maxJobSchedules {
		return invalid("A job can have up to %d schedules", maxJobSchedules)
	}
	out := make([]JobSchedule, 0, len(list))
	for i, raw := range list {
		sc := cleanSchedule(raw)
		if sc.Type != "daily" && sc.Type != "weekdays" && sc.Type != "cron" && sc.Type != "interval" {
			return numbered(i, len(list), invalid("Choose daily, selected weekdays, interval, or cron"))
		}
		if sc.Type == "weekdays" {
			if len(sc.Weekdays) == 0 {
				return numbered(i, len(list), invalid("Choose at least one weekday"))
			}
			if sc.Weekdays[0] < 0 || sc.Weekdays[len(sc.Weekdays)-1] > 6 {
				return numbered(i, len(list), invalid("Invalid weekday"))
			}
		}
		for k, earlier := range out {
			if sameSchedule(earlier, sc) {
				return invalid("Schedule %d repeats schedule %d", i+1, k+1)
			}
		}
		out = append(out, sc)
	}
	j.Schedules = out
	return nil
}

// nextJob returns the earliest occurrence after the given time across all of
// the job's schedules. Occurrences on the same minute are one time, so they
// start one run, and every schedule due by then is consumed by that run.
func nextJob(job Job, after time.Time) (time.Time, error) {
	loc, err := time.LoadLocation(job.Timezone)
	if err != nil {
		return time.Time{}, invalid("Select a valid IANA timezone")
	}
	list := job.Schedules
	if len(list) == 0 {
		return time.Time{}, invalid("Add at least one schedule")
	}
	var earliest time.Time
	for i, sc := range list {
		next, err := nextOccurrence(sc, loc, after)
		if err != nil {
			return time.Time{}, numbered(i, len(list), err)
		}
		if earliest.IsZero() || next.Before(earliest) {
			earliest = next
		}
	}
	return earliest, nil
}

func nextOccurrence(sc JobSchedule, loc *time.Location, after time.Time) (time.Time, error) {
	if sc.Type == "interval" {
		d, e := time.ParseDuration(sc.Schedule)
		if e != nil || d < time.Minute {
			return time.Time{}, invalid("Interval must be at least 1m, for example 30m or 2h")
		}
		return after.Add(d), nil
	}
	spec := sc.Schedule
	if sc.Type == "daily" || sc.Type == "weekdays" {
		clock, e := time.Parse("15:04", spec)
		if e != nil || clock.Format("15:04") != spec {
			return time.Time{}, invalid("Daily schedule must be HH:MM")
		}
		h, m := clock.Hour(), clock.Minute()
		for day := 0; day < 370; day++ {
			date := after.In(loc).AddDate(0, 0, day)
			if sc.Type == "weekdays" && !slices.Contains(sc.Weekdays, int(date.Weekday())) {
				continue
			}
			y, mo, d := date.Date()
			start := time.Date(y, mo, d, 0, 0, 0, 0, loc)
			desired := h*60 + m
			seen := false
			for t := start; t.Before(start.AddDate(0, 0, 1)); t = t.Add(time.Minute) {
				local := t.In(loc)
				minute := local.Hour()*60 + local.Minute()
				if minute < desired {
					continue
				}
				if seen {
					break
				}
				seen = true
				if t.After(after) {
					return t, nil
				}
			}
		}
		return time.Time{}, invalid("Could not calculate next daily occurrence")
	}
	if sc.Type != "cron" {
		return time.Time{}, invalid("Unknown schedule type")
	}
	parser := cron.NewParser(cron.Minute | cron.Hour | cron.Dom | cron.Month | cron.Dow)
	// Evaluate cron against a monotonic wall-clock timeline. A missing local
	// minute maps to the next valid instant; a repeated minute fires only once.
	wall := time.Date(after.In(loc).Year(), after.In(loc).Month(), after.In(loc).Day(), after.In(loc).Hour(), after.In(loc).Minute(), 0, 0, time.UTC)
	plain, err := parser.Parse(spec)
	if err != nil {
		return time.Time{}, invalid("Invalid cron expression: %v", err)
	}
	for attempts := 0; attempts < 10000; attempts++ {
		wall = plain.Next(wall)
		if wall.IsZero() {
			break
		}
		y, mo, d := wall.Date()
		midnight := time.Date(y, mo, d, 0, 0, 0, 0, loc)
		for t := midnight; t.Before(midnight.AddDate(0, 0, 1)); t = t.Add(time.Minute) {
			l := t.In(loc)
			if l.Hour()*60+l.Minute() < wall.Hour()*60+wall.Minute() {
				continue
			}
			if t.After(after) {
				return t, nil
			}
			break
		}
	}
	return time.Time{}, invalid("No cron occurrence found within supported range")
}
