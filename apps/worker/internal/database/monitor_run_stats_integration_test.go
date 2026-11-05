package database

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"testing"
	"time"
)

// A deleted monitor whose task still recorded checks used to make every flush
// of its chunk violate the foreign key. The requeue then held that bucket
// forever and dropped the statistics of all monitors sharing the chunk.
func TestMonitorRunStatsFlushSkipsDeletedMonitors(t *testing.T) {
	databaseURL := os.Getenv("FREE_PROXY_STORE_INTEGRATION_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("FREE_PROXY_STORE_INTEGRATION_DATABASE_URL is not set")
	}
	db, err := sql.Open("postgres", databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	suffix := time.Now().UnixNano()
	userID := fmt.Sprintf("run-stats-test-%d", suffix)
	if _, err := db.ExecContext(ctx, `INSERT INTO "User" (id, email, role) VALUES ($1, $2, 'free')`, userID, userID+"@example.test"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = db.Exec(`DELETE FROM "User" WHERE id = $1`, userID) })
	var liveID, deletedID int
	for _, target := range []*int{&liveID, &deletedID} {
		if err := db.QueryRowContext(ctx, `INSERT INTO monitors ("userId", name, query, status, region)
			VALUES ($1, 'Stats test', 'camera', 'active', 'pl') RETURNING id`, userID).Scan(target); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.ExecContext(ctx, `DELETE FROM monitors WHERE id = $1`, deletedID); err != nil {
		t.Fatal(err)
	}

	store := &Store{db: db, runStats: make(map[monitorRunStatsKey]*monitorRunStatsDelta)}
	bucket := time.Now().UTC().Truncate(time.Hour)
	checkedAt := bucket.Add(5 * time.Minute)
	for _, id := range []int{liveID, deletedID} {
		key := monitorRunStatsKey{monitorID: id, fetchSource: "canonical", bucketHour: bucket}
		delta := &monitorRunStatsDelta{}
		delta.checkCount = 3
		delta.successfulCount = 2
		delta.failedCount = 1
		delta.durationTotalMS = 900
		delta.durationSampleCount = 3
		delta.lastCheckedAt = checkedAt
		delta.latestError = "catalog fetch failed: timeout"
		delta.latestErrorAt = checkedAt
		delta.latestStatusCode = 500
		store.runStats[key] = delta
	}

	store.flushMonitorRunStats()
	store.flushMonitorRunStats() // a second flush must add nothing and stay clean

	if pending := len(store.runStats); pending != 0 {
		t.Fatalf("flush left %d buckets requeued; a deleted monitor poisoned the chunk", pending)
	}
	var checks, failed int64
	var lastChecked, latestErrorAt time.Time
	var latestError string
	var latestStatus int
	if err := db.QueryRowContext(ctx, `SELECT check_count, failed_check_count, last_checked_at, latest_error, latest_error_at, latest_status_code
		FROM monitor_run_hourly_stats WHERE monitor_id = $1 AND fetch_source = 'canonical' AND bucket_hour = $2`, liveID, bucket).
		Scan(&checks, &failed, &lastChecked, &latestError, &latestErrorAt, &latestStatus); err != nil {
		t.Fatalf("live monitor statistics were not written: %v", err)
	}
	if checks != 3 || failed != 1 || latestStatus != 500 || latestError == "" {
		t.Fatalf("unexpected stats: checks=%d failed=%d status=%d error=%q", checks, failed, latestStatus, latestError)
	}
	if !lastChecked.Equal(checkedAt) || !latestErrorAt.Equal(checkedAt) {
		t.Fatalf("timestamps shifted: last_checked_at=%s latest_error_at=%s want %s", lastChecked, latestErrorAt, checkedAt)
	}
	var orphaned int
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM monitor_run_hourly_stats WHERE monitor_id = $1`, deletedID).Scan(&orphaned); err != nil {
		t.Fatal(err)
	}
	if orphaned != 0 {
		t.Fatal("statistics were written for a deleted monitor")
	}
}
