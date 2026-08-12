package scraper

import (
	"strings"
	"sync"
	"time"
	_ "time/tzdata"

	"vintrack-worker/internal/model"
)

const defaultQuietHoursTimezone = "Europe/Berlin"

// Go does not cache time.LoadLocation, and with the embedded tzdata every call
// re-reads and inflates the zoneinfo archive. Quiet-hours checks run several
// times per monitor tick plus once per monitor on every manager sync, so the
// small set of distinct timezone names is worth memoising.
var (
	quietHoursLocationMu sync.RWMutex
	quietHoursLocations  = make(map[string]*time.Location)
)

func quietHoursLocation(timezone string) (*time.Location, error) {
	quietHoursLocationMu.RLock()
	location, ok := quietHoursLocations[timezone]
	quietHoursLocationMu.RUnlock()
	if ok {
		return location, nil
	}

	location, err := time.LoadLocation(timezone)
	if err != nil {
		return nil, err
	}

	quietHoursLocationMu.Lock()
	quietHoursLocations[timezone] = location
	quietHoursLocationMu.Unlock()
	return location, nil
}

func monitorQuietHoursActive(m model.Monitor, now time.Time) bool {
	if !m.QuietHoursEnabled || m.QuietHoursStartMinute < 0 || m.QuietHoursStartMinute > 1439 || m.QuietHoursEndMinute < 0 || m.QuietHoursEndMinute > 1439 || m.QuietHoursStartMinute == m.QuietHoursEndMinute {
		return false
	}

	timezone := strings.TrimSpace(m.QuietHoursTimezone)
	if timezone == "" {
		timezone = defaultQuietHoursTimezone
	}
	location, err := quietHoursLocation(timezone)
	if err != nil {
		return false
	}

	local := now.In(location)
	minute := local.Hour()*60 + local.Minute()
	if m.QuietHoursStartMinute < m.QuietHoursEndMinute {
		return minute >= m.QuietHoursStartMinute && minute < m.QuietHoursEndMinute
	}

	return minute >= m.QuietHoursStartMinute || minute < m.QuietHoursEndMinute
}

func monitorScheduledPause(m model.Monitor, now time.Time) bool {
	return monitorQuietHoursActive(m, now) && strings.EqualFold(strings.TrimSpace(m.QuietHoursMode), "pause")
}

func monitorQueryInterval(m model.Monitor, now time.Time) time.Duration {
	delayMs := m.QueryDelayMs
	if monitorQuietHoursActive(m, now) && strings.EqualFold(strings.TrimSpace(m.QuietHoursMode), "slow") {
		delayMs = m.QuietHoursDelayMs
	}
	interval := time.Duration(resolveQueryDelayMs(delayMs)) * time.Millisecond
	if untilEnd, ok := durationUntilQuietHoursEnd(m, now); ok && untilEnd < interval {
		return untilEnd
	}
	return interval
}

func durationUntilQuietHoursEnd(m model.Monitor, now time.Time) (time.Duration, bool) {
	if !monitorQuietHoursActive(m, now) {
		return 0, false
	}

	timezone := strings.TrimSpace(m.QuietHoursTimezone)
	if timezone == "" {
		timezone = defaultQuietHoursTimezone
	}
	location, err := quietHoursLocation(timezone)
	if err != nil {
		return 0, false
	}

	local := now.In(location)
	end := time.Date(
		local.Year(),
		local.Month(),
		local.Day(),
		m.QuietHoursEndMinute/60,
		m.QuietHoursEndMinute%60,
		0,
		0,
		location,
	)
	if m.QuietHoursStartMinute > m.QuietHoursEndMinute && local.Hour()*60+local.Minute() >= m.QuietHoursStartMinute {
		end = end.AddDate(0, 0, 1)
	}
	remaining := end.Sub(now)
	if remaining <= 0 {
		return 0, false
	}
	return remaining, true
}
