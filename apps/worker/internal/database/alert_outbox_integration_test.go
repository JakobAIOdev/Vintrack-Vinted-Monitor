package database

import (
	"context"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	"vintrack-worker/internal/model"
)

func TestAlertOutboxAgainstPostgres(t *testing.T) {
	databaseURL := os.Getenv("ALERT_OUTBOX_INTEGRATION_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("ALERT_OUTBOX_INTEGRATION_DATABASE_URL is not set")
	}
	store, err := NewStore(databaseURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	suffix := time.Now().UnixNano()
	userID := fmt.Sprintf("alert-test-%d", suffix)
	if _, err := store.db.ExecContext(ctx, `
		INSERT INTO "User" (id, email, role) VALUES ($1, $2, 'free')`,
		userID, fmt.Sprintf("%s@example.test", userID)); err != nil {
		t.Fatal(err)
	}
	var monitorID int
	if err := store.db.QueryRowContext(ctx, `
		INSERT INTO monitors (
			"userId", name, query, status, region, discord_webhook,
			webhook_active, notifications_enabled
		) VALUES ($1, 'Alert test', 'shoes', 'active', 'de', $2, TRUE, TRUE)
		RETURNING id`, userID, "https://discord.test/api/webhooks/id/token").Scan(&monitorID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = store.db.Exec(`UPDATE monitors SET status = 'paused' WHERE "userId" = $1`, userID)
		_, _ = store.db.Exec(`DELETE FROM alert_notifications WHERE idempotency_key LIKE $1`, fmt.Sprintf("alert-test:%d:%%", suffix))
		_, _ = store.db.Exec(`DELETE FROM "User" WHERE id = $1`, userID)
	})

	request := model.AlertNotificationRequest{
		UserID: userID, MonitorID: monitorID, ItemID: 991,
		Kind: "item_match", DedupeUserItem: true,
		IdempotencyKey: fmt.Sprintf("alert-test:%d:first", suffix),
		ExpiresAt:      time.Now().Add(time.Hour),
		DiscordTarget:  "https://discord.test/api/webhooks/id/token",
		Payload:        model.AlertNotificationPayload{Version: 1, Kind: "item_match", MonitorName: "Alert test", Item: &model.Item{ID: 991, MonitorID: monitorID}},
	}

	const contenders = 8
	var wg sync.WaitGroup
	results := make(chan bool, contenders)
	errors := make(chan error, contenders)
	for i := 0; i < contenders; i++ {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			candidate := request
			candidate.IdempotencyKey = fmt.Sprintf("alert-test:%d:%d", suffix, index)
			created, err := store.EnqueueAlertNotification(ctx, candidate)
			results <- created
			errors <- err
		}(i)
	}
	wg.Wait()
	close(results)
	close(errors)
	createdCount := 0
	for created := range results {
		if created {
			createdCount++
		}
	}
	for err := range errors {
		if err != nil {
			t.Fatal(err)
		}
	}
	if createdCount != 1 {
		t.Fatalf("created notifications = %d, want 1", createdCount)
	}

	delivery, err := store.ClaimAlertDelivery(ctx, "test-claim-1")
	if err != nil || delivery == nil {
		t.Fatalf("claim = %#v, %v", delivery, err)
	}
	if delivery.AttemptCount != 1 || delivery.CurrentFingerprint != delivery.DestinationFingerprint {
		t.Fatalf("unexpected delivery: %#v", delivery)
	}
	if retried, err := store.RetryAlertDelivery(ctx, *delivery, "rate_limited", "test 429", time.Now().Add(-time.Second)); err != nil || !retried {
		t.Fatalf("retry = %v, %v", retried, err)
	}
	var retryStatus string
	var retryAt time.Time
	if err := store.db.QueryRowContext(ctx, `SELECT status, next_attempt_at FROM alert_deliveries WHERE id = $1`, delivery.ID).Scan(&retryStatus, &retryAt); err != nil {
		t.Fatal(err)
	}
	if retryStatus != "retrying" || retryAt.After(time.Now()) {
		t.Fatalf("stored retry status=%q at=%s", retryStatus, retryAt)
	}
	delivery, err = store.ClaimAlertDelivery(ctx, "test-claim-2")
	if err != nil || delivery == nil || delivery.AttemptCount != 2 {
		t.Fatalf("retry claim = %#v, %v", delivery, err)
	}
	if completed, err := store.CompleteAlertDelivery(ctx, *delivery); err != nil || !completed {
		t.Fatalf("complete = %v, %v", completed, err)
	}

	// The oldest delivery for a destination must hold FIFO, while a different
	// destination can still be claimed in parallel. An expired lease must be
	// recoverable by another worker.
	queue := func(key string, itemID int64, target string) {
		t.Helper()
		candidate := request
		candidate.DedupeUserItem = false
		candidate.ItemID = itemID
		candidate.IdempotencyKey = fmt.Sprintf("alert-test:%d:%s", suffix, key)
		candidate.DiscordTarget = target
		candidate.Payload.Item = &model.Item{ID: itemID, MonitorID: monitorID}
		created, err := store.EnqueueAlertNotification(ctx, candidate)
		if err != nil || !created {
			t.Fatalf("enqueue %s = %v, %v", key, created, err)
		}
	}
	targetA := "https://discord.test/api/webhooks/a/token"
	targetB := "https://discord.test/api/webhooks/b/token"
	queue("fifo-a-1", 992, targetA)
	queue("fifo-a-2", 993, targetA)
	queue("parallel-b", 994, targetB)

	firstA, err := store.ClaimAlertDelivery(ctx, "lease-a-1")
	if err != nil || firstA == nil || firstA.ItemID != 992 {
		t.Fatalf("first FIFO claim = %#v, %v", firstA, err)
	}
	parallelB, err := store.ClaimAlertDelivery(ctx, "lease-b")
	if err != nil || parallelB == nil || parallelB.ItemID != 994 {
		t.Fatalf("parallel destination claim = %#v, %v", parallelB, err)
	}
	if completed, err := store.CompleteAlertDelivery(ctx, *parallelB); err != nil || !completed {
		t.Fatalf("complete parallel destination = %v, %v", completed, err)
	}
	if _, err := store.db.ExecContext(ctx, `
		UPDATE alert_deliveries SET lease_until = NOW() - INTERVAL '1 second'
		WHERE id = $1`, firstA.ID); err != nil {
		t.Fatal(err)
	}
	recoveredA, err := store.ClaimAlertDelivery(ctx, "lease-a-2")
	if err != nil || recoveredA == nil || recoveredA.ID != firstA.ID || recoveredA.AttemptCount != 2 {
		t.Fatalf("recovered lease = %#v, %v", recoveredA, err)
	}
	if completed, err := store.CompleteAlertDelivery(ctx, *recoveredA); err != nil || !completed {
		t.Fatalf("complete recovered lease = %v, %v", completed, err)
	}
	secondA, err := store.ClaimAlertDelivery(ctx, "lease-a-3")
	if err != nil || secondA == nil || secondA.ItemID != 993 {
		t.Fatalf("second FIFO claim = %#v, %v", secondA, err)
	}
	if completed, err := store.CompleteAlertDelivery(ctx, *secondA); err != nil || !completed {
		t.Fatalf("complete second FIFO delivery = %v, %v", completed, err)
	}

	if err := store.OpenOrUpdateProxyIncident(ctx, monitorID, "www.vinted.de", "free", time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	if err := store.OpenOrUpdateProxyIncident(ctx, monitorID, "www.vinted.de", "free", time.Now().Add(2*time.Second)); err != nil {
		t.Fatal(err)
	}
	if err := store.CloseProxyIncident(ctx, monitorID, "recovered"); err != nil {
		t.Fatal(err)
	}
	var waits int
	var reason string
	if err := store.db.QueryRowContext(ctx, `
		SELECT wait_count, end_reason FROM monitor_proxy_incidents
		WHERE monitor_id = $1 ORDER BY id DESC LIMIT 1`, monitorID).Scan(&waits, &reason); err != nil {
		t.Fatal(err)
	}
	if waits != 2 || reason != "recovered" {
		t.Fatalf("incident waits=%d reason=%q", waits, reason)
	}
}
