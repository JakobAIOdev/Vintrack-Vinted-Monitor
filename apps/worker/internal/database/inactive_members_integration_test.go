package database

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"testing"
	"time"
)

func TestEvaluateInactiveMemberPolicyAgainstPostgres(t *testing.T) {
	if os.Getenv("VINTRACK_DATABASE_INTEGRATION_TEST") != "true" {
		t.Skip("set VINTRACK_DATABASE_INTEGRATION_TEST=true to run")
	}
	db, err := sql.Open("postgres", os.Getenv("DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	suffix := time.Now().UnixNano()
	revision := fmt.Sprintf("inactive-policy-test-%d", suffix)
	freeUserID := fmt.Sprintf("inactive-free-%d", suffix)
	premiumUserID := fmt.Sprintf("inactive-premium-%d", suffix)
	oldActivity := time.Now().UTC().Add(-30 * 24 * time.Hour)
	for _, user := range []struct{ id, role string }{{freeUserID, "free"}, {premiumUserID, "premium"}} {
		if _, err := db.ExecContext(ctx, `
			INSERT INTO "User" (id, email, role, "createdAt", last_dashboard_seen_at)
			VALUES ($1, $2, $3, $4, $4)`, user.id, user.id+"@example.test", user.role, oldActivity); err != nil {
			t.Fatal(err)
		}
	}

	insertMonitor := func(userID, name, status, source string) int {
		t.Helper()
		var id int
		if err := db.QueryRowContext(ctx, `
			INSERT INTO monitors ("userId", name, query, status, proxy_source)
			VALUES ($1, $2, '', $3, $4) RETURNING id`, userID, name, status, source).Scan(&id); err != nil {
			t.Fatal(err)
		}
		return id
	}
	freeMonitorID := insertMonitor(freeUserID, "Inactive free", "active", "free")
	serverMonitorID := insertMonitor(freeUserID, "Inactive server", "active", "server")
	manualPausedID := insertMonitor(freeUserID, "Manual pause", "paused", "free")
	premiumMonitorID := insertMonitor(premiumUserID, "Premium free", "active", "free")
	var targetID, scheduleID, priceWatchID int64
	if err := db.QueryRowContext(ctx, `
		INSERT INTO price_watch_targets (region, item_id, canonical_url)
		VALUES ('de', $1, $2) RETURNING id`, suffix, fmt.Sprintf("https://www.vinted.de/items/%d-test", suffix)).Scan(&targetID); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRowContext(ctx, `
		INSERT INTO price_watch_schedules (target_id, transport_key, transport_kind)
		VALUES ($1, 'shared', 'shared') RETURNING id`, targetID).Scan(&scheduleID); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRowContext(ctx, `
		INSERT INTO price_watches (user_id, target_id, schedule_id, status, notifications_enabled)
		VALUES ($1, $2, $3, 'active', FALSE) RETURNING id`, freeUserID, targetID, scheduleID).Scan(&priceWatchID); err != nil {
		t.Fatal(err)
	}

	var previousPolicy, previousRuntime sql.NullString
	_ = db.QueryRowContext(ctx, `SELECT value FROM app_settings WHERE key = $1`, inactiveMemberPolicyKey).Scan(&previousPolicy)
	_ = db.QueryRowContext(ctx, `SELECT value FROM app_settings WHERE key = $1`, inactiveMemberRuntimeKey).Scan(&previousRuntime)
	t.Cleanup(func() {
		_, _ = db.Exec(`DELETE FROM audit_events WHERE action = 'system.inactive_member_monitors_paused' AND metadata->>'revision' = $1`, revision)
		_, _ = db.Exec(`DELETE FROM "User" WHERE id IN ($1, $2)`, freeUserID, premiumUserID)
		_, _ = db.Exec(`DELETE FROM price_watch_targets WHERE id = $1`, targetID)
		restore := func(key string, previous sql.NullString) {
			if previous.Valid {
				_, _ = db.Exec(`INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, key, previous.String)
			} else {
				_, _ = db.Exec(`DELETE FROM app_settings WHERE key = $1`, key)
			}
		}
		restore(inactiveMemberPolicyKey, previousPolicy)
		restore(inactiveMemberRuntimeKey, previousRuntime)
	})

	policyJSON, _ := json.Marshal(InactiveMemberPolicy{
		Enabled: true, Revision: revision, Duration: 1, DurationUnit: "weeks",
		MonitorScope: "free_proxy", IncludePriceWatches: true, Roles: []string{"free"}, EnabledAt: oldActivity.Format(time.RFC3339Nano),
	})
	if _, err := db.ExecContext(ctx, `
		INSERT INTO app_settings (key, value) VALUES ($1, $2)
		ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, inactiveMemberPolicyKey, string(policyJSON)); err != nil {
		t.Fatal(err)
	}

	store := &Store{db: db}
	result, err := store.EvaluateInactiveMemberPolicy(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if result.NewlyPausedMonitorCount != 1 || result.NewlyPausedPriceWatchCount != 1 || result.NewlyPausedMemberCount != 1 {
		t.Fatalf("newly paused = %d monitors / %d Price Watches / %d members", result.NewlyPausedMonitorCount, result.NewlyPausedPriceWatchCount, result.NewlyPausedMemberCount)
	}
	var watchStatus string
	var stoppedReason sql.NullString
	if err := db.QueryRowContext(ctx, `SELECT status, stopped_reason FROM price_watches WHERE id = $1`, priceWatchID).Scan(&watchStatus, &stoppedReason); err != nil {
		t.Fatal(err)
	}
	if watchStatus != "paused" || stoppedReason.String != "inactive_member" {
		t.Fatalf("Price Watch status = %q / %q", watchStatus, stoppedReason.String)
	}
	for id, want := range map[int]string{
		freeMonitorID: "inactivity_paused", serverMonitorID: "active",
		manualPausedID: "paused", premiumMonitorID: "active",
	} {
		var got string
		if err := db.QueryRowContext(ctx, `SELECT status FROM monitors WHERE id = $1`, id).Scan(&got); err != nil {
			t.Fatal(err)
		}
		if got != want {
			t.Errorf("monitor %d status = %q, want %q", id, got, want)
		}
	}
	var statusNotificationCount int
	if err := db.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM alert_notifications
		WHERE monitor_id IN ($1, $2, $3, $4)
		  AND kind IN ('monitor_paused', 'monitor_started')`, freeMonitorID, serverMonitorID, manualPausedID, premiumMonitorID).Scan(&statusNotificationCount); err != nil {
		t.Fatal(err)
	}
	if statusNotificationCount != 0 {
		t.Fatalf("status notifications = %d, want 0", statusNotificationCount)
	}
}
