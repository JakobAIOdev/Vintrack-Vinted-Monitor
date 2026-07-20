package database

import (
	"database/sql"
	"fmt"
	"os"
	"testing"
	"time"
)

func TestPruneMonitorTelemetry(t *testing.T) {
	if os.Getenv("VINTRACK_DATABASE_INTEGRATION_TEST") != "true" {
		t.Skip("set VINTRACK_DATABASE_INTEGRATION_TEST=true to run")
	}

	db, err := sql.Open("postgres", os.Getenv("DATABASE_URL"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	defer db.Close()
	if err := db.Ping(); err != nil {
		t.Fatalf("ping database: %v", err)
	}

	userID := fmt.Sprintf("telemetry-retention-test-%d", time.Now().UnixNano())
	if _, err := db.Exec(`INSERT INTO "User" (id, role, monitor_onboarding_status) VALUES ($1, 'free', 'completed')`, userID); err != nil {
		t.Fatalf("create test user: %v", err)
	}
	defer db.Exec(`DELETE FROM "User" WHERE id = $1`, userID)

	var monitorID int
	if err := db.QueryRow(`
		INSERT INTO monitors ("userId", name, query, status)
		VALUES ($1, 'Telemetry retention', '', 'paused')
		RETURNING id`, userID).Scan(&monitorID); err != nil {
		t.Fatalf("create test monitor: %v", err)
	}

	now := time.Now().UTC()
	for _, checkedAt := range []time.Time{now.Add(-25 * time.Hour), now.Add(-23 * time.Hour)} {
		if _, err := db.Exec(`
			INSERT INTO monitor_runs (monitor_id, status, fetch_source, region, checked_at)
			VALUES ($1, 'success', 'canonical', 'de', $2)`, monitorID, checkedAt); err != nil {
			t.Fatalf("create monitor run: %v", err)
		}
	}

	for _, bucketHour := range []time.Time{now.Add(-91 * 24 * time.Hour), now.Add(-89 * 24 * time.Hour)} {
		if _, err := db.Exec(`
			INSERT INTO monitor_run_hourly_stats (
				monitor_id, bucket_hour, fetch_source, last_checked_at
			)
			VALUES ($1, $2, 'retention-test', $2)`, monitorID, bucketHour); err != nil {
			t.Fatalf("create hourly monitor stats: %v", err)
		}
	}

	store := &Store{db: db}
	store.PruneMonitorRuns(24)
	store.PruneMonitorRunStats(90)

	var runCount int
	if err := db.QueryRow(`SELECT COUNT(*) FROM monitor_runs WHERE monitor_id = $1`, monitorID).Scan(&runCount); err != nil {
		t.Fatalf("count monitor runs: %v", err)
	}
	if runCount != 1 {
		t.Fatalf("monitor run count = %d, want 1", runCount)
	}

	var statsCount int
	if err := db.QueryRow(`
		SELECT COUNT(*)
		FROM monitor_run_hourly_stats
		WHERE monitor_id = $1 AND fetch_source = 'retention-test'`, monitorID).Scan(&statsCount); err != nil {
		t.Fatalf("count hourly monitor stats: %v", err)
	}
	if statsCount != 1 {
		t.Fatalf("hourly monitor stats count = %d, want 1", statsCount)
	}
}
