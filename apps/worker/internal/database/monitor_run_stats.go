package database

import (
	"fmt"
	"sort"
	"strings"
	"time"

	"vintrack-worker/internal/model"
)

// Monitor runs used to be written one row per check, with a FOR EACH ROW trigger
// folding each row into monitor_run_hourly_stats. At a few hundred monitors on a
// short interval that is hundreds of inserts per second, and because all checks
// of one monitor in one hour collide on a single aggregate row it also produced
// hundreds of thousands of dead tuples per hour on a table holding a few hundred
// live rows.
//
// The fold now happens in memory here and is written as one multi-row upsert per
// flush. monitor_runs keeps only rows an operator can act on; see
// monitorRunCarriesDetail.
const (
	defaultMonitorRunStatsFlushSeconds = 15
	minMonitorRunStatsFlushSeconds     = 5
	maxMonitorRunStatsFlushSeconds     = 300

	// Thirteen bound parameters per row, well inside the 65535 limit.
	monitorRunStatsUpsertChunkSize = 400
)

// monitorRunStatsKey identifies exactly one row of monitor_run_hourly_stats.
type monitorRunStatsKey struct {
	monitorID   int
	fetchSource string
	bucketHour  time.Time
}

// monitorRunStatsDelta accumulates one key's changes between flushes. Each field
// mirrors a column the dropped trigger maintained, so rows written before and
// after this change stay directly comparable.
type monitorRunStatsDelta struct {
	checkCount          int64
	successfulCount     int64
	failedCount         int64
	newItemCount        int64
	durationTotalMS     int64
	durationSampleCount int64
	lastCheckedAt       time.Time
	latestError         string
	latestErrorAt       time.Time
	latestStatusCode    int
}

type monitorRunStatsRow struct {
	key   monitorRunStatsKey
	delta monitorRunStatsDelta
}

// add folds a single run into the delta using the same accounting the database
// trigger used.
func (d *monitorRunStatsDelta) add(run model.MonitorRun, checkedAt time.Time) {
	d.checkCount++
	switch run.Status {
	case "success":
		d.successfulCount++
	case "failed":
		d.failedCount++
	}
	d.newItemCount += int64(run.NewItemCount)

	// The detail insert stored duration_ms as NULLIF(value, 0), so a zero
	// duration was never a sample. Counting it here would drag the reported
	// average check speed down with no visible error.
	if run.DurationMS > 0 {
		d.durationTotalMS += int64(run.DurationMS)
		d.durationSampleCount++
	}

	if checkedAt.After(d.lastCheckedAt) {
		d.lastCheckedAt = checkedAt
	}
	if run.ErrorMessage != "" && !checkedAt.Before(d.latestErrorAt) {
		d.latestError = run.ErrorMessage
		d.latestErrorAt = checkedAt
		d.latestStatusCode = run.StatusCode
	}
}

// mergeFrom folds another delta into this one. Used to return a failed flush to
// the live map instead of discarding the counts.
func (d *monitorRunStatsDelta) mergeFrom(other monitorRunStatsDelta) {
	d.checkCount += other.checkCount
	d.successfulCount += other.successfulCount
	d.failedCount += other.failedCount
	d.newItemCount += other.newItemCount
	d.durationTotalMS += other.durationTotalMS
	d.durationSampleCount += other.durationSampleCount
	if other.lastCheckedAt.After(d.lastCheckedAt) {
		d.lastCheckedAt = other.lastCheckedAt
	}
	if other.latestError != "" && !other.latestErrorAt.Before(d.latestErrorAt) {
		d.latestError = other.latestError
		d.latestErrorAt = other.latestErrorAt
		d.latestStatusCode = other.latestStatusCode
	}
}

// monitorRunCarriesDetail reports whether a run is worth keeping as its own row.
//
// Successful checks that found nothing are the overwhelming majority and carry
// no information the hourly aggregate does not already hold. Failures and
// successes that produced new items are what an operator actually looks at.
func monitorRunCarriesDetail(run model.MonitorRun) bool {
	return run.Status != "success" || run.NewItemCount > 0
}

func monitorRunStatsFlushInterval() time.Duration {
	seconds := envInt("MONITOR_RUN_STATS_FLUSH_SECONDS", defaultMonitorRunStatsFlushSeconds)
	if seconds < minMonitorRunStatsFlushSeconds {
		seconds = minMonitorRunStatsFlushSeconds
	}
	if seconds > maxMonitorRunStatsFlushSeconds {
		seconds = maxMonitorRunStatsFlushSeconds
	}
	return time.Duration(seconds) * time.Second
}

// buildMonitorRunStatsUpsert renders one multi-row upsert.
//
// Two invariants the caller must uphold:
//
//   - At most one row per conflict key. PostgreSQL rejects a statement that would
//     affect the same row twice, so rows must come from a map keyed exactly like
//     the conflict target.
//   - Rows are sorted here so concurrent writers take row locks in the same
//     order and cannot deadlock against each other.
func buildMonitorRunStatsUpsert(rows []monitorRunStatsRow) (string, []interface{}) {
	if len(rows) == 0 {
		return "", nil
	}

	sorted := make([]monitorRunStatsRow, len(rows))
	copy(sorted, rows)
	sort.Slice(sorted, func(i, j int) bool {
		if sorted[i].key.monitorID != sorted[j].key.monitorID {
			return sorted[i].key.monitorID < sorted[j].key.monitorID
		}
		if sorted[i].key.fetchSource != sorted[j].key.fetchSource {
			return sorted[i].key.fetchSource < sorted[j].key.fetchSource
		}
		return sorted[i].key.bucketHour.Before(sorted[j].key.bucketHour)
	})

	var statement strings.Builder
	statement.WriteString(`
		INSERT INTO monitor_run_hourly_stats (
			monitor_id, fetch_source, bucket_hour,
			check_count, successful_check_count, failed_check_count,
			new_item_count, duration_total_ms, duration_sample_count,
			last_checked_at, latest_error, latest_error_at, latest_status_code
		) VALUES `)

	args := make([]interface{}, 0, len(sorted)*13)
	for index, row := range sorted {
		if index > 0 {
			statement.WriteString(", ")
		}
		base := index * 13
		statement.WriteString(fmt.Sprintf(
			"($%d,$%d,$%d,$%d,$%d,$%d,$%d,$%d,$%d,$%d,$%d,$%d,$%d)",
			base+1, base+2, base+3, base+4, base+5, base+6, base+7,
			base+8, base+9, base+10, base+11, base+12, base+13,
		))

		lastCheckedAt := row.delta.lastCheckedAt
		if lastCheckedAt.IsZero() {
			lastCheckedAt = row.key.bucketHour
		}

		args = append(args,
			row.key.monitorID,
			row.key.fetchSource,
			row.key.bucketHour,
			row.delta.checkCount,
			row.delta.successfulCount,
			row.delta.failedCount,
			row.delta.newItemCount,
			row.delta.durationTotalMS,
			row.delta.durationSampleCount,
			lastCheckedAt,
			nilIfEmpty(row.delta.latestError),
			nilIfZeroTime(row.delta.latestErrorAt),
			nilIfZero(int64(row.delta.latestStatusCode)),
		)
	}

	// The CASE blocks mirror the dropped trigger exactly so a bucket written by
	// the old trigger and one written here are indistinguishable.
	statement.WriteString(`
		ON CONFLICT (monitor_id, fetch_source, bucket_hour) DO UPDATE SET
			check_count            = monitor_run_hourly_stats.check_count            + EXCLUDED.check_count,
			successful_check_count = monitor_run_hourly_stats.successful_check_count + EXCLUDED.successful_check_count,
			failed_check_count     = monitor_run_hourly_stats.failed_check_count     + EXCLUDED.failed_check_count,
			new_item_count         = monitor_run_hourly_stats.new_item_count         + EXCLUDED.new_item_count,
			duration_total_ms      = monitor_run_hourly_stats.duration_total_ms      + EXCLUDED.duration_total_ms,
			duration_sample_count  = monitor_run_hourly_stats.duration_sample_count  + EXCLUDED.duration_sample_count,
			last_checked_at        = GREATEST(monitor_run_hourly_stats.last_checked_at, EXCLUDED.last_checked_at),
			latest_error = CASE
				WHEN EXCLUDED.latest_error_at IS NOT NULL
					 AND (monitor_run_hourly_stats.latest_error_at IS NULL
						  OR EXCLUDED.latest_error_at >= monitor_run_hourly_stats.latest_error_at)
				THEN EXCLUDED.latest_error
				ELSE monitor_run_hourly_stats.latest_error END,
			latest_error_at = CASE
				WHEN EXCLUDED.latest_error_at IS NOT NULL
					 AND (monitor_run_hourly_stats.latest_error_at IS NULL
						  OR EXCLUDED.latest_error_at >= monitor_run_hourly_stats.latest_error_at)
				THEN EXCLUDED.latest_error_at
				ELSE monitor_run_hourly_stats.latest_error_at END,
			latest_status_code = CASE
				WHEN EXCLUDED.latest_error_at IS NOT NULL
					 AND (monitor_run_hourly_stats.latest_error_at IS NULL
						  OR EXCLUDED.latest_error_at >= monitor_run_hourly_stats.latest_error_at)
				THEN EXCLUDED.latest_status_code
				ELSE monitor_run_hourly_stats.latest_status_code END`)

	return statement.String(), args
}

func nilIfZeroTime(value time.Time) interface{} {
	if value.IsZero() {
		return nil
	}
	return value
}
