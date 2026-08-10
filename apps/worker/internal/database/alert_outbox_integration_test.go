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
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	suffix := time.Now().UnixNano()
	userID := fmt.Sprintf("alert-test-%d", suffix)
	initialTarget := fmt.Sprintf("https://discord.test/api/webhooks/%d/initial", suffix)
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
		RETURNING id`, userID, initialTarget).Scan(&monitorID); err != nil {
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
		DiscordTarget:  initialTarget,
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
		var status string
		var due, unexpired, processingBlocked, orderedBlocked bool
		diagnosticErr := store.db.QueryRowContext(ctx, `
			SELECT d.status, d.next_attempt_at <= NOW(), n.expires_at > NOW(),
				EXISTS (
					SELECT 1 FROM alert_deliveries active
					WHERE active.destination_fingerprint = d.destination_fingerprint
					  AND active.id <> d.id AND active.status = 'processing'
					  AND active.lease_until > NOW()
				),
				EXISTS (
					SELECT 1
					FROM alert_deliveries older
					JOIN alert_notifications older_n ON older_n.id = older.notification_id
					WHERE older.destination_fingerprint = d.destination_fingerprint
					  AND older_n.expires_at > NOW()
					  AND (
						CASE WHEN older_n.kind = 'item_match' THEN 0 ELSE 1 END,
						older.created_at, older.id
					  ) < (
						CASE WHEN n.kind = 'item_match' THEN 0 ELSE 1 END,
						d.created_at, d.id
					  )
					  AND older.status IN ('pending', 'processing', 'retrying')
				)
			FROM alert_deliveries d
			JOIN alert_notifications n ON n.id = d.notification_id
			WHERE n.user_id = $1 AND n.item_id = $2`, userID, request.ItemID).Scan(
			&status, &due, &unexpired, &processingBlocked, &orderedBlocked,
		)
		t.Fatalf(
			"claim = %#v, %v; diagnostic status=%q due=%v unexpired=%v processingBlocked=%v orderedBlocked=%v err=%v",
			delivery, err, status, due, unexpired, processingBlocked, orderedBlocked, diagnosticErr,
		)
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
	targetA := fmt.Sprintf("https://discord.test/api/webhooks/%d/a", suffix)
	targetB := fmt.Sprintf("https://discord.test/api/webhooks/%d/b", suffix)
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
	if recovered, err := store.RecoverExpiredAlertDeliveryLeases(ctx); err != nil || recovered != 1 {
		t.Fatalf("recover expired leases = %d, %v", recovered, err)
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

	targetC := fmt.Sprintf("https://discord.test/api/webhooks/%d/c", suffix)
	targetD := fmt.Sprintf("https://discord.test/api/webhooks/%d/d", suffix)
	queue("batch-c-1", 995, targetC)
	queue("batch-c-2", 996, targetC)
	queue("batch-d", 997, targetD)
	batch, err := store.ClaimAlertDeliveries(ctx, "batch-claim", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(batch) != 2 {
		t.Fatalf("batch claims = %d, want one oldest delivery per destination", len(batch))
	}
	claimedItems := map[int64]bool{}
	for _, delivery := range batch {
		claimedItems[delivery.ItemID] = true
		if completed, err := store.CompleteAlertDelivery(ctx, delivery); err != nil || !completed {
			t.Fatalf("complete batch delivery = %v, %v", completed, err)
		}
	}
	if !claimedItems[995] || !claimedItems[997] || claimedItems[996] {
		t.Fatalf("batch broke destination FIFO: %v", claimedItems)
	}
	nextC, err := store.ClaimAlertDelivery(ctx, "batch-c-next")
	if err != nil || nextC == nil || nextC.ItemID != 996 {
		t.Fatalf("next destination C claim = %#v, %v", nextC, err)
	}
	if completed, err := store.CompleteAlertDelivery(ctx, *nextC); err != nil || !completed {
		t.Fatalf("complete next C delivery = %v, %v", completed, err)
	}

	// Operational status notices must never hold a fresh item alert behind them
	// for the same destination. FIFO still applies within item alerts and within
	// status notices, but item_match is the latency-sensitive class.
	targetE := fmt.Sprintf("https://discord.test/api/webhooks/%d/e", suffix)
	statusRequest := request
	statusRequest.ItemID = 0
	statusRequest.Kind = "monitor_started"
	statusRequest.DedupeUserItem = false
	statusRequest.IdempotencyKey = fmt.Sprintf("alert-test:%d:status-before-item", suffix)
	statusRequest.DiscordTarget = targetE
	statusRequest.Payload = model.AlertNotificationPayload{
		Version: 1,
		Kind:    "monitor_started",
	}
	if created, err := store.EnqueueAlertNotification(ctx, statusRequest); err != nil || !created {
		t.Fatalf("enqueue status before item = %v, %v", created, err)
	}
	queue("priority-item", 998, targetE)

	priorityItem, err := store.ClaimAlertDelivery(ctx, "priority-item")
	if err != nil || priorityItem == nil || priorityItem.ItemID != 998 || priorityItem.Kind != "item_match" {
		t.Fatalf("priority item claim = %#v, %v", priorityItem, err)
	}
	if completed, err := store.CompleteAlertDelivery(ctx, *priorityItem); err != nil || !completed {
		t.Fatalf("complete priority item = %v, %v", completed, err)
	}
	deferredStatus, err := store.ClaimAlertDelivery(ctx, "deferred-status")
	if err != nil || deferredStatus == nil || deferredStatus.Kind != "monitor_started" {
		t.Fatalf("deferred status claim = %#v, %v", deferredStatus, err)
	}
	if completed, err := store.CompleteAlertDelivery(ctx, *deferredStatus); err != nil || !completed {
		t.Fatalf("complete deferred status = %v, %v", completed, err)
	}

	// Terminal history must not participate in the due-claim plan. This models
	// the production shape that exposed connection starvation after ~50k rows.
	perfPrefix := fmt.Sprintf("alert-test:%d:perf:", suffix)
	if _, err := store.db.ExecContext(ctx, `
		WITH notifications AS (
			INSERT INTO alert_notifications (
				user_id, monitor_id, item_id, kind, payload_version, payload,
				idempotency_key, expires_at
			)
			SELECT $1, $2, 1000000 + value, 'item_match', 1,
				jsonb_build_object('version', 1, 'kind', 'item_match'),
				$3 || 'terminal:' || value, NOW() + INTERVAL '1 hour'
			FROM generate_series(1, 50000) AS value
			RETURNING id
		)
		INSERT INTO alert_deliveries (
			notification_id, channel, status, destination_fingerprint,
			completed_at
		)
		SELECT id, 'discord', 'sent', LPAD(id::text, 64, '0'), NOW()
		FROM notifications`, userID, monitorID, perfPrefix); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.ExecContext(ctx, `
		WITH notifications AS (
			INSERT INTO alert_notifications (
				user_id, monitor_id, item_id, kind, payload_version, payload,
				idempotency_key, expires_at
			)
			SELECT $1, $2, 2000000 + value, 'item_match', 1,
				jsonb_build_object('version', 1, 'kind', 'item_match'),
				$3 || 'burst:' || value, NOW() + INTERVAL '1 hour'
			FROM generate_series(1, 32) AS value
			RETURNING id
		)
		INSERT INTO alert_deliveries (
			notification_id, channel, destination_fingerprint
		)
		SELECT id, 'discord', LPAD((id + 50000)::text, 64, '0')
		FROM notifications`, userID, monitorID, perfPrefix); err != nil {
		t.Fatal(err)
	}
	claimStarted := time.Now()
	perfBatch, err := store.ClaimAlertDeliveries(ctx, "perf-batch", 32)
	claimDuration := time.Since(claimStarted)
	if err != nil || len(perfBatch) != 32 {
		t.Fatalf("performance batch = %d, %v", len(perfBatch), err)
	}
	if claimDuration >= 250*time.Millisecond {
		t.Fatalf("batch claim with terminal history took %s, want <250ms", claimDuration)
	}
	for _, delivery := range perfBatch {
		if completed, err := store.CompleteAlertDelivery(ctx, delivery); err != nil || !completed {
			t.Fatalf("complete performance delivery = %v, %v", completed, err)
		}
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
