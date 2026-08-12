package database

import (
	"strings"
	"testing"
	"time"

	"vintrack-worker/internal/model"
)

func TestDeltaCountsOutcomesLikeTheReplacedTrigger(t *testing.T) {
	now := time.Date(2026, 8, 12, 10, 30, 0, 0, time.UTC)
	var delta monitorRunStatsDelta

	delta.add(model.MonitorRun{Status: "success", DurationMS: 400, NewItemCount: 2}, now)
	delta.add(model.MonitorRun{Status: "success", DurationMS: 600}, now)
	delta.add(model.MonitorRun{Status: "failed", DurationMS: 200, StatusCode: 429, ErrorMessage: "rate limited"}, now)
	// Neither 'success' nor 'failed', so it counts as a check and nothing else.
	delta.add(model.MonitorRun{Status: "skipped"}, now)

	if delta.checkCount != 4 {
		t.Fatalf("checkCount = %d, want 4", delta.checkCount)
	}
	if delta.successfulCount != 2 {
		t.Fatalf("successfulCount = %d, want 2", delta.successfulCount)
	}
	if delta.failedCount != 1 {
		t.Fatalf("failedCount = %d, want 1", delta.failedCount)
	}
	if delta.newItemCount != 2 {
		t.Fatalf("newItemCount = %d, want 2", delta.newItemCount)
	}
	if delta.durationTotalMS != 1200 {
		t.Fatalf("durationTotalMS = %d, want 1200", delta.durationTotalMS)
	}
}

// The detail insert stored duration_ms as NULLIF(value, 0) and the trigger only
// counted non-NULL durations as samples. Counting zeros here would silently drag
// the reported average check speed down.
func TestDeltaExcludesZeroDurationsFromTheSampleCount(t *testing.T) {
	now := time.Date(2026, 8, 12, 10, 0, 0, 0, time.UTC)
	var delta monitorRunStatsDelta

	delta.add(model.MonitorRun{Status: "success", DurationMS: 0}, now)
	delta.add(model.MonitorRun{Status: "success", DurationMS: 500}, now)

	if delta.durationSampleCount != 1 {
		t.Fatalf("durationSampleCount = %d, want 1", delta.durationSampleCount)
	}
	if delta.durationTotalMS != 500 {
		t.Fatalf("durationTotalMS = %d, want 500", delta.durationTotalMS)
	}
	if average := delta.durationTotalMS / delta.durationSampleCount; average != 500 {
		t.Fatalf("average duration = %d, want 500", average)
	}
}

func TestDeltaKeepsTheMostRecentError(t *testing.T) {
	base := time.Date(2026, 8, 12, 10, 0, 0, 0, time.UTC)
	var delta monitorRunStatsDelta

	delta.add(model.MonitorRun{Status: "failed", StatusCode: 500, ErrorMessage: "older"}, base)
	delta.add(model.MonitorRun{Status: "failed", StatusCode: 429, ErrorMessage: "newer"}, base.Add(time.Minute))
	// An earlier failure arriving out of order must not overwrite the newer one.
	delta.add(model.MonitorRun{Status: "failed", StatusCode: 502, ErrorMessage: "stale"}, base.Add(-time.Minute))

	if delta.latestError != "newer" {
		t.Fatalf("latestError = %q, want %q", delta.latestError, "newer")
	}
	if delta.latestStatusCode != 429 {
		t.Fatalf("latestStatusCode = %d, want 429", delta.latestStatusCode)
	}
	if !delta.latestErrorAt.Equal(base.Add(time.Minute)) {
		t.Fatalf("latestErrorAt = %s, want %s", delta.latestErrorAt, base.Add(time.Minute))
	}
}

func TestDeltaSuccessDoesNotClearAnEarlierError(t *testing.T) {
	base := time.Date(2026, 8, 12, 10, 0, 0, 0, time.UTC)
	var delta monitorRunStatsDelta

	delta.add(model.MonitorRun{Status: "failed", StatusCode: 429, ErrorMessage: "rate limited"}, base)
	delta.add(model.MonitorRun{Status: "success", DurationMS: 300}, base.Add(time.Minute))

	if delta.latestError != "rate limited" {
		t.Fatalf("latestError = %q, want the earlier failure to survive", delta.latestError)
	}
	if !delta.lastCheckedAt.Equal(base.Add(time.Minute)) {
		t.Fatalf("lastCheckedAt = %s, want the later success", delta.lastCheckedAt)
	}
}

func TestMergeFromIsAdditiveAndKeepsTheNewerError(t *testing.T) {
	base := time.Date(2026, 8, 12, 10, 0, 0, 0, time.UTC)
	first := monitorRunStatsDelta{
		checkCount: 3, successfulCount: 2, failedCount: 1, newItemCount: 4,
		durationTotalMS: 900, durationSampleCount: 3, lastCheckedAt: base,
		latestError: "older", latestErrorAt: base, latestStatusCode: 500,
	}
	second := monitorRunStatsDelta{
		checkCount: 2, successfulCount: 2, durationTotalMS: 400, durationSampleCount: 2,
		lastCheckedAt: base.Add(time.Minute),
		latestError:   "newer", latestErrorAt: base.Add(time.Minute), latestStatusCode: 429,
	}

	first.mergeFrom(second)

	if first.checkCount != 5 || first.successfulCount != 4 || first.failedCount != 1 {
		t.Fatalf("counters did not merge additively: %+v", first)
	}
	if first.durationTotalMS != 1300 || first.durationSampleCount != 5 {
		t.Fatalf("duration did not merge additively: %+v", first)
	}
	if first.latestError != "newer" || first.latestStatusCode != 429 {
		t.Fatalf("newer error should win: %+v", first)
	}
	if !first.lastCheckedAt.Equal(base.Add(time.Minute)) {
		t.Fatalf("lastCheckedAt = %s, want the later timestamp", first.lastCheckedAt)
	}
}

func TestMonitorRunCarriesDetail(t *testing.T) {
	cases := []struct {
		name string
		run  model.MonitorRun
		want bool
	}{
		{"routine success with nothing found", model.MonitorRun{Status: "success"}, false},
		{"success that found items", model.MonitorRun{Status: "success", NewItemCount: 1}, true},
		{"failure", model.MonitorRun{Status: "failed"}, true},
		{"failure carrying an error", model.MonitorRun{Status: "failed", ErrorMessage: "boom"}, true},
		{"unknown status", model.MonitorRun{Status: "skipped"}, true},
		// Items returned by the catalog are not the same as new items; only new
		// ones are worth a detail row.
		{"success that only saw known items", model.MonitorRun{Status: "success", ItemCount: 96}, false},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := monitorRunCarriesDetail(testCase.run); got != testCase.want {
				t.Fatalf("monitorRunCarriesDetail = %v, want %v", got, testCase.want)
			}
		})
	}
}

func TestBuildMonitorRunStatsUpsertBindsEveryColumn(t *testing.T) {
	bucket := time.Date(2026, 8, 12, 10, 0, 0, 0, time.UTC)
	rows := []monitorRunStatsRow{
		{
			key:   monitorRunStatsKey{monitorID: 7, fetchSource: "canonical", bucketHour: bucket},
			delta: monitorRunStatsDelta{checkCount: 12, lastCheckedAt: bucket.Add(time.Minute)},
		},
		{
			key:   monitorRunStatsKey{monitorID: 3, fetchSource: "canonical", bucketHour: bucket},
			delta: monitorRunStatsDelta{checkCount: 5, lastCheckedAt: bucket},
		},
	}

	statement, args := buildMonitorRunStatsUpsert(rows)

	if len(args) != len(rows)*13 {
		t.Fatalf("bound %d args, want %d", len(args), len(rows)*13)
	}
	if !strings.Contains(statement, "$26") {
		t.Fatalf("statement is missing the last placeholder:\n%s", statement)
	}
	if !strings.Contains(statement, "ON CONFLICT (monitor_id, fetch_source, bucket_hour) DO UPDATE") {
		t.Fatalf("statement is missing the conflict target:\n%s", statement)
	}
	// Rows must be sorted so concurrent writers take row locks in one order.
	if args[0] != 3 {
		t.Fatalf("first bound monitor id = %v, want the lowest id 3", args[0])
	}
	if args[13] != 7 {
		t.Fatalf("second bound monitor id = %v, want 7", args[13])
	}
}

func TestBuildMonitorRunStatsUpsertNullsEmptyErrorFields(t *testing.T) {
	bucket := time.Date(2026, 8, 12, 10, 0, 0, 0, time.UTC)
	rows := []monitorRunStatsRow{{
		key:   monitorRunStatsKey{monitorID: 1, fetchSource: "canonical", bucketHour: bucket},
		delta: monitorRunStatsDelta{checkCount: 1, lastCheckedAt: bucket},
	}}

	_, args := buildMonitorRunStatsUpsert(rows)

	if args[10] != nil {
		t.Fatalf("latest_error = %v, want nil when no error was recorded", args[10])
	}
	if args[11] != nil {
		t.Fatalf("latest_error_at = %v, want nil when no error was recorded", args[11])
	}
	if args[12] != nil {
		t.Fatalf("latest_status_code = %v, want nil when no error was recorded", args[12])
	}
}

func TestBuildMonitorRunStatsUpsertHandlesAnEmptyBatch(t *testing.T) {
	statement, args := buildMonitorRunStatsUpsert(nil)
	if statement != "" || args != nil {
		t.Fatalf("empty batch should render nothing, got %q with %v", statement, args)
	}
}

func TestMonitorRunStatsFlushIntervalIsClamped(t *testing.T) {
	t.Setenv("MONITOR_RUN_STATS_FLUSH_SECONDS", "1")
	if got := monitorRunStatsFlushInterval(); got != minMonitorRunStatsFlushSeconds*time.Second {
		t.Fatalf("interval = %s, want the lower clamp", got)
	}

	t.Setenv("MONITOR_RUN_STATS_FLUSH_SECONDS", "99999")
	if got := monitorRunStatsFlushInterval(); got != maxMonitorRunStatsFlushSeconds*time.Second {
		t.Fatalf("interval = %s, want the upper clamp", got)
	}

	t.Setenv("MONITOR_RUN_STATS_FLUSH_SECONDS", "not a number")
	if got := monitorRunStatsFlushInterval(); got != defaultMonitorRunStatsFlushSeconds*time.Second {
		t.Fatalf("interval = %s, want the default", got)
	}
}
