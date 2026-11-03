package sift

import (
	"testing"
	"time"
)

func TestDSTSchedules(t *testing.T) {
	cases := []struct{ kind, spec, after, want string }{
		{"daily", "02:30", "2026-03-08T06:00:00Z", "2026-03-08T07:00:00Z"},
		{"daily", "01:30", "2026-11-01T04:00:00Z", "2026-11-01T05:30:00Z"},
		{"daily", "01:30", "2026-11-01T05:31:00Z", "2026-11-02T06:30:00Z"},
		{"cron", "30 2 * * *", "2026-03-08T06:00:00Z", "2026-03-08T07:00:00Z"},
		{"cron", "30 1 * * *", "2026-11-01T05:31:00Z", "2026-11-02T06:30:00Z"},
		{"cron", "* * * * *", "2026-11-01T06:30:30Z", "2026-11-01T07:00:00Z"},
	}
	for _, c := range cases {
		t.Run(c.kind+c.after, func(t *testing.T) {
			after, _ := time.Parse(time.RFC3339, c.after)
			next, e := nextJob(Job{Schedules: []JobSchedule{{Type: c.kind, Schedule: c.spec}}, Timezone: "America/New_York"}, after)
			if e != nil || next.UTC().Format(time.RFC3339) != c.want {
				t.Fatalf("got %v (%v), want %s", next, e, c.want)
			}
		})
	}
}

func TestSchedulesWithoutPossibleOccurrencesAreRefused(t *testing.T) {
	after := time.Date(2026, 11, 2, 12, 0, 0, 0, time.UTC)
	for _, job := range []Job{
		{Schedules: []JobSchedule{{Type: "weekdays", Schedule: "09:00", Weekdays: []int{}}}, Timezone: "UTC"},
		{Schedules: []JobSchedule{{Type: "cron", Schedule: "0 9 31 2 *"}}, Timezone: "UTC"},
	} {
		next, err := nextJob(job, after)
		if err == nil || !next.IsZero() {
			t.Fatal("impossible schedule returned a runnable occurrence", job, next, err)
		}
	}
}
func TestWeekdaysAndIntervals(t *testing.T) {
	after := time.Date(2026, 11, 6, 20, 0, 0, 0, time.UTC)
	n, e := nextJob(Job{Schedules: []JobSchedule{{Type: "weekdays", Schedule: "09:00", Weekdays: []int{1, 2, 3, 4, 5}}}, Timezone: "UTC"}, after)
	if e != nil || n.Day() != 9 || n.Hour() != 9 {
		t.Fatal(n, e)
	}
	n, e = nextJob(Job{Schedules: []JobSchedule{{Type: "interval", Schedule: "30m"}}, Timezone: "UTC"}, after)
	if e != nil || n.Sub(after) != 30*time.Minute {
		t.Fatal(n, e)
	}
}
