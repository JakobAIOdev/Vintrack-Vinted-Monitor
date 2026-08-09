package scraper

import (
	"testing"
	"time"

	"vintrack-worker/internal/model"
)

func TestMonitorQuietHoursActiveOvernight(t *testing.T) {
	location, err := time.LoadLocation("Europe/Berlin")
	if err != nil {
		t.Fatal(err)
	}
	monitor := model.Monitor{
		QuietHoursEnabled:     true,
		QuietHoursStartMinute: 23 * 60,
		QuietHoursEndMinute:   7 * 60,
		QuietHoursMode:        "pause",
		QuietHoursTimezone:    "Europe/Berlin",
	}

	tests := []struct {
		name string
		hour int
		want bool
	}{
		{name: "before window", hour: 22, want: false},
		{name: "at start", hour: 23, want: true},
		{name: "after midnight", hour: 3, want: true},
		{name: "at end", hour: 7, want: false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			now := time.Date(2026, time.July, 21, tc.hour, 0, 0, 0, location)
			if got := monitorQuietHoursActive(monitor, now); got != tc.want {
				t.Fatalf("monitorQuietHoursActive() = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestMonitorQuietHoursActiveDaytimeAndTimezone(t *testing.T) {
	monitor := model.Monitor{
		QuietHoursEnabled:     true,
		QuietHoursStartMinute: 12 * 60,
		QuietHoursEndMinute:   13 * 60,
		QuietHoursTimezone:    "Europe/Berlin",
	}

	// 10:30 UTC is 12:30 in Berlin during summer time.
	now := time.Date(2026, time.July, 21, 10, 30, 0, 0, time.UTC)
	if !monitorQuietHoursActive(monitor, now) {
		t.Fatal("expected timezone conversion to place monitor in quiet hours")
	}
}

func TestMonitorQuietHoursActiveForUKTimezone(t *testing.T) {
	monitor := model.Monitor{
		QuietHoursEnabled:     true,
		QuietHoursStartMinute: 22 * 60,
		QuietHoursEndMinute:   23 * 60,
		QuietHoursTimezone:    "Europe/London",
	}

	// 21:30 UTC is 22:30 in London during British Summer Time.
	now := time.Date(2026, time.July, 21, 21, 30, 0, 0, time.UTC)
	if !monitorQuietHoursActive(monitor, now) {
		t.Fatal("expected UK timezone conversion to place monitor in quiet hours")
	}
}

func TestSupportedMemberTimezonesLoad(t *testing.T) {
	timezones := []string{
		"Europe/Berlin",
		"Europe/Paris",
		"Europe/Rome",
		"Europe/Madrid",
		"Europe/Amsterdam",
		"Europe/Warsaw",
		"Europe/Lisbon",
		"Europe/Brussels",
		"Europe/Vienna",
		"Europe/Luxembourg",
		"Europe/London",
		"Europe/Dublin",
		"Europe/Prague",
		"Europe/Bratislava",
		"Europe/Vilnius",
		"Europe/Stockholm",
		"Europe/Copenhagen",
		"Europe/Bucharest",
		"Europe/Budapest",
		"Europe/Zagreb",
		"Europe/Helsinki",
	}

	for _, timezone := range timezones {
		t.Run(timezone, func(t *testing.T) {
			if _, err := time.LoadLocation(timezone); err != nil {
				t.Fatalf("time.LoadLocation(%q): %v", timezone, err)
			}
		})
	}
}

func TestMonitorQueryIntervalUsesSlowDelayOnlyInsideWindow(t *testing.T) {
	location, err := time.LoadLocation("Europe/Berlin")
	if err != nil {
		t.Fatal(err)
	}
	monitor := model.Monitor{
		QueryDelayMs:          1500,
		QuietHoursEnabled:     true,
		QuietHoursStartMinute: 23 * 60,
		QuietHoursEndMinute:   7 * 60,
		QuietHoursMode:        "slow",
		QuietHoursDelayMs:     60_000,
		QuietHoursTimezone:    "Europe/Berlin",
	}

	inside := time.Date(2026, time.July, 21, 2, 0, 0, 0, location)
	if got := monitorQueryInterval(monitor, inside); got != time.Minute {
		t.Fatalf("inside quiet hours interval = %s, want 1m", got)
	}

	outside := time.Date(2026, time.July, 21, 12, 0, 0, 0, location)
	if got := monitorQueryInterval(monitor, outside); got != 1500*time.Millisecond {
		t.Fatalf("outside quiet hours interval = %s, want 1.5s", got)
	}
}

func TestMonitorQueryIntervalStopsAtQuietHoursEnd(t *testing.T) {
	location, err := time.LoadLocation("Europe/Berlin")
	if err != nil {
		t.Fatal(err)
	}
	monitor := model.Monitor{
		QueryDelayMs:          1500,
		QuietHoursEnabled:     true,
		QuietHoursStartMinute: 23 * 60,
		QuietHoursEndMinute:   7 * 60,
		QuietHoursMode:        "slow",
		QuietHoursDelayMs:     60 * 60 * 1000,
		QuietHoursTimezone:    "Europe/Berlin",
	}

	now := time.Date(2026, time.July, 21, 6, 59, 30, 0, location)
	if got := monitorQueryInterval(monitor, now); got != 30*time.Second {
		t.Fatalf("interval near quiet-hours end = %s, want 30s", got)
	}
}

func TestMonitorQuietHoursInvalidConfigurationIsInactive(t *testing.T) {
	monitor := model.Monitor{
		QuietHoursEnabled:     true,
		QuietHoursStartMinute: 60,
		QuietHoursEndMinute:   120,
		QuietHoursTimezone:    "Mars/Olympus_Mons",
	}
	if monitorQuietHoursActive(monitor, time.Now()) {
		t.Fatal("invalid timezone unexpectedly activated quiet hours")
	}
}

func TestPrepareQuietHoursResumeSkipsOnlyStartupBehavior(t *testing.T) {
	monitor := model.Monitor{}
	prepareQuietHoursResume(&monitor)
	if !monitor.SuppressStartupNotice {
		t.Fatal("quiet-hours resume did not suppress the duplicate startup notice")
	}
	if !monitor.ResumeAfterQuietHours {
		t.Fatal("quiet-hours resume did not enable immediate item notifications")
	}
}
