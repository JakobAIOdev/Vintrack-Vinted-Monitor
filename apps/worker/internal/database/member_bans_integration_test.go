package database

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"vintrack-worker/internal/model"
)

func TestMemberBanBackstops(t *testing.T) {
	dsn := os.Getenv("MEMBER_BAN_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("MEMBER_BAN_TEST_DATABASE_URL is not set")
	}
	store, err := NewStore(dsn, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	ctx := context.Background()
	userID := fmt.Sprintf("member-ban-%d", time.Now().UnixNano())
	if _, err := store.db.Exec(`INSERT INTO "User" (id) VALUES ($1)`, userID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = store.db.Exec(`DELETE FROM "User" WHERE id = $1`, userID) })
	var monitorID int
	if err := store.db.QueryRow(`INSERT INTO monitors ("userId", name, query, region, status) VALUES ($1, 'Ban test', 'jacket', 'de', 'active') RETURNING id`, userID).Scan(&monitorID); err != nil {
		t.Fatal(err)
	}
	var targetID, scheduleID int64
	if err := store.db.QueryRow(`INSERT INTO price_watch_targets (region, item_id, canonical_url, updated_at) VALUES ('de', $1, 'https://example.test/item', NOW()) RETURNING id`, time.Now().UnixNano()).Scan(&targetID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = store.db.Exec(`DELETE FROM price_watches WHERE user_id = $1`, userID)
		_, _ = store.db.Exec(`DELETE FROM price_watch_schedules WHERE target_id = $1`, targetID)
		_, _ = store.db.Exec(`DELETE FROM price_watch_targets WHERE id = $1`, targetID)
	})
	if err := store.db.QueryRow(`INSERT INTO price_watch_schedules (target_id, transport_key, transport_kind, updated_at) VALUES ($1, 'shared', 'shared', NOW()) RETURNING id`, targetID).Scan(&scheduleID); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(`INSERT INTO price_watches (user_id, target_id, schedule_id, updated_at) VALUES ($1,$2,$3,NOW())`, userID, targetID, scheduleID); err != nil {
		t.Fatal(err)
	}
	request := model.AlertNotificationRequest{
		UserID: userID, MonitorID: monitorID, Kind: "item_match", IdempotencyKey: userID,
		ExpiresAt: time.Now().Add(time.Minute), Payload: model.AlertNotificationPayload{Version: 1},
		DiscordTarget: "https://example.test/webhook",
	}
	created, err := store.EnqueueAlertNotification(ctx, request)
	if err != nil || !created {
		t.Fatalf("enqueue: %v, %v", created, err)
	}
	t.Cleanup(func() { _, _ = store.db.Exec(`DELETE FROM alert_notifications WHERE idempotency_key = $1`, userID) })
	deliveries, err := store.ClaimAlertDeliveries(ctx, "ban-test-claim", 10)
	if err != nil || len(deliveries) != 1 {
		t.Fatalf("claim: %v, %v", deliveries, err)
	}
	allowed, err := store.AlertDeliveryAllowed(ctx, deliveries[0])
	if err != nil || !allowed {
		t.Fatalf("active delivery denied: %v, %v", allowed, err)
	}
	if _, err := store.db.Exec(`UPDATE "User" SET banned_at = NOW() WHERE id = $1`, userID); err != nil {
		t.Fatal(err)
	}
	// Leave work marked active to verify the durable backstops independently
	// of the admin transaction's pause and cancellation updates.
	monitors, err := store.GetActiveMonitors()
	if err != nil {
		t.Fatal(err)
	}
	for _, monitor := range monitors {
		if monitor.ID == monitorID {
			t.Fatal("banned monitor returned")
		}
	}
	if _, err := store.GetMonitorByID(monitorID); err == nil {
		t.Fatal("banned monitor loaded")
	}
	allowed, err = store.AlertDeliveryAllowed(ctx, deliveries[0])
	if err != nil || allowed {
		t.Fatalf("stale delivery allowed: %v, %v", allowed, err)
	}
	request.IdempotencyKey += ":after-ban"
	created, err = store.EnqueueAlertNotification(ctx, request)
	if err != nil || created {
		t.Fatalf("banned alert enqueued: %v, %v", created, err)
	}
	targets, err := store.ClaimPriceWatchTargets(ctx, "ban-watch-claim", 10, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	for _, target := range targets {
		if target.ID == scheduleID {
			t.Fatal("banned price watch claimed")
		}
	}
}
