package database

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"vintrack-worker/internal/model"
)

func TestPriceWatchObservationAgainstPostgres(t *testing.T) {
	databaseURL := os.Getenv("PRICE_WATCH_INTEGRATION_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("PRICE_WATCH_INTEGRATION_DATABASE_URL is not set")
	}
	store, err := NewStore(databaseURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()

	suffix := time.Now().UnixNano()
	userIDs := []string{
		fmt.Sprintf("price-watch-test-%d-a", suffix),
		fmt.Sprintf("price-watch-test-%d-b", suffix),
		fmt.Sprintf("price-watch-test-%d-c", suffix),
	}
	itemID := int64(8_000_000_000 + suffix%100_000_000)
	for _, userID := range userIDs {
		if _, err := store.db.ExecContext(ctx, `
			INSERT INTO "User" (id, email, role)
			VALUES ($1, $2, 'premium')`, userID, fmt.Sprintf("%s@example.test", userID)); err != nil {
			t.Fatal(err)
		}
	}
	var targetID int64
	if err := store.db.QueryRowContext(ctx, `
		INSERT INTO price_watch_targets (region, item_id, canonical_url)
		VALUES ('de', $1, $2)
		RETURNING id`, itemID, fmt.Sprintf("https://www.vinted.de/items/%d-test", itemID)).Scan(&targetID); err != nil {
		t.Fatal(err)
	}
	var scheduleID int64
	if err := store.db.QueryRowContext(ctx, `
		INSERT INTO price_watch_schedules (
			target_id, transport_key, transport_kind, next_check_at
		)
		VALUES ($1, 'shared', 'shared', NOW())
		RETURNING id`, targetID).Scan(&scheduleID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = store.db.Exec(`
			DELETE FROM alert_notifications
			WHERE price_watch_id IN (SELECT id FROM price_watches WHERE target_id = $1)`, targetID)
		_, _ = store.db.Exec(`DELETE FROM price_watch_targets WHERE id = $1`, targetID)
		_, _ = store.db.Exec(`DELETE FROM "User" WHERE id IN ($1, $2, $3)`, userIDs[0], userIDs[1], userIDs[2])
	})

	watchIDs := make([]int64, 0, 3)
	for index := 0; index < 2; index++ {
		var watchID int64
		if err := store.db.QueryRowContext(ctx, `
			INSERT INTO price_watches (
				user_id, target_id, schedule_id, poll_interval_seconds,
				status, notifications_enabled,
				discord_webhook, webhook_active
			)
			VALUES ($1, $2, $3, 300, 'active', TRUE, $4, TRUE)
			RETURNING id`, userIDs[index], targetID, scheduleID, fmt.Sprintf("https://discord.test/api/webhooks/%d/%d", suffix, index)).Scan(&watchID); err != nil {
			t.Fatal(err)
		}
		watchIDs = append(watchIDs, watchID)
	}

	claim := func(token string) model.PriceWatchTarget {
		t.Helper()
		if _, err := store.db.ExecContext(ctx, `
			UPDATE price_watch_schedules SET next_check_at = NOW(), lease_until = NULL, claim_token = NULL
			WHERE id = $1`, scheduleID); err != nil {
			t.Fatal(err)
		}
		targets, err := store.ClaimPriceWatchTargets(ctx, token, 10, 30*time.Second)
		if err != nil {
			t.Fatal(err)
		}
		if len(targets) != 1 || targets[0].ID != scheduleID || targets[0].TargetID != targetID {
			t.Fatalf("claimed targets = %#v", targets)
		}
		return targets[0]
	}
	apply := func(target model.PriceWatchTarget, price int64) (int64, int) {
		t.Helper()
		now := time.Now().UTC()
		eventID, alerts, err := store.ApplyPriceWatchObservation(ctx, PriceWatchObservation{
			ScheduleID:   target.ID,
			TargetID:     target.TargetID,
			ClaimToken:   target.ClaimToken,
			CanonicalURL: target.CanonicalURL,
			Title:        "Integration item",
			ImageURL:     "https://images.example/item.webp",
			PriceMinor:   price,
			CurrencyCode: "EUR",
			ObservedAt:   now,
			NextCheckAt:  now.Add(5 * time.Minute),
		})
		if err != nil {
			t.Fatal(err)
		}
		return eventID, alerts
	}

	baselineTarget := claim("baseline")
	if eventID, alerts := apply(baselineTarget, 10_000); eventID != 0 || alerts != 0 {
		t.Fatalf("baseline generated event=%d alerts=%d", eventID, alerts)
	}
	var armedCount int
	if err := store.db.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM price_watches
		WHERE target_id = $1 AND armed_at IS NOT NULL AND initial_price_minor = 10000`, targetID).Scan(&armedCount); err != nil {
		t.Fatal(err)
	}
	if armedCount != 2 {
		t.Fatalf("armed watches = %d, want 2", armedCount)
	}

	var newWatchID int64
	if err := store.db.QueryRowContext(ctx, `
		INSERT INTO price_watches (
			user_id, target_id, schedule_id, poll_interval_seconds,
			status, notifications_enabled,
			discord_webhook, webhook_active
		)
		VALUES ($1, $2, $3, 300, 'active', TRUE, $4, TRUE)
		RETURNING id`, userIDs[2], targetID, scheduleID, fmt.Sprintf("https://discord.test/api/webhooks/%d/new", suffix)).Scan(&newWatchID); err != nil {
		t.Fatal(err)
	}
	watchIDs = append(watchIDs, newWatchID)

	dropTarget := claim("first-drop")
	eventID, alertCount := apply(dropTarget, 8_000)
	if eventID == 0 || alertCount != 2 {
		t.Fatalf("first drop event=%d alerts=%d, want event and 2 alerts", eventID, alertCount)
	}
	var notificationCount int
	if err := store.db.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM alert_notifications
		WHERE price_watch_id IN ($1, $2) AND kind = 'price_drop'`, watchIDs[0], watchIDs[1]).Scan(&notificationCount); err != nil {
		t.Fatal(err)
	}
	if notificationCount != 2 {
		t.Fatalf("price drop notifications = %d, want 2", notificationCount)
	}
	// ClaimAlertDeliveries deliberately prioritizes item matches over every
	// other notification kind. Give this isolated routing assertion the same
	// priority and an old due timestamp so unrelated local-test fixtures cannot
	// starve it. The persisted kind was asserted as price_drop immediately above.
	if _, err := store.db.ExecContext(ctx, `
		UPDATE alert_notifications
		SET kind = 'item_match'
		WHERE price_watch_id IN ($1, $2)`, watchIDs[0], watchIDs[1]); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.ExecContext(ctx, `
		UPDATE alert_deliveries delivery
		SET next_attempt_at = TIMESTAMP '2000-01-01', created_at = TIMESTAMP '2000-01-01'
		FROM alert_notifications notification
		WHERE notification.id = delivery.notification_id
		  AND notification.price_watch_id IN ($1, $2)`, watchIDs[0], watchIDs[1]); err != nil {
		t.Fatal(err)
	}

	deliveries, err := store.ClaimAlertDeliveries(ctx, "price-watch-deliveries", 10)
	if err != nil {
		t.Fatal(err)
	}
	priceWatchDeliveries := 0
	for _, delivery := range deliveries {
		if delivery.PriceWatchID == watchIDs[0] || delivery.PriceWatchID == watchIDs[1] {
			priceWatchDeliveries++
			if delivery.Destination == "" || !delivery.NotificationsEnabled || !delivery.ChannelEnabled || delivery.Payload.PriceDrop == nil {
				t.Fatalf("invalid price watch delivery: %#v", delivery)
			}
		}
	}
	if priceWatchDeliveries != 2 {
		rows, diagnosticErr := store.db.QueryContext(ctx, `
			SELECT notification.price_watch_id, delivery.status,
				delivery.next_attempt_at <= NOW(), notification.expires_at > NOW(),
				delivery.channel, delivery.destination_fingerprint
			FROM alert_deliveries delivery
			JOIN alert_notifications notification ON notification.id = delivery.notification_id
			WHERE notification.price_watch_id IN ($1, $2)
			ORDER BY delivery.id`, watchIDs[0], watchIDs[1])
		if diagnosticErr == nil {
			defer rows.Close()
			for rows.Next() {
				var watchID int64
				var status, channel, fingerprint string
				var due, unexpired bool
				if scanErr := rows.Scan(&watchID, &status, &due, &unexpired, &channel, &fingerprint); scanErr == nil {
					t.Logf("watch=%d status=%s due=%v unexpired=%v channel=%s fingerprint=%s", watchID, status, due, unexpired, channel, fingerprint)
				}
			}
		}
		t.Fatalf("claimed price watch deliveries = %d, want 2", priceWatchDeliveries)
	}

	if nextEvent, alerts := apply(claim("same-price"), 8_000); nextEvent != 0 || alerts != 0 {
		t.Fatalf("same price generated event=%d alerts=%d", nextEvent, alerts)
	}
	if nextEvent, alerts := apply(claim("increase"), 10_000); nextEvent != 0 || alerts != 0 {
		t.Fatalf("increase generated event=%d alerts=%d", nextEvent, alerts)
	}
	if nextEvent, alerts := apply(claim("second-drop"), 8_000); nextEvent == 0 || alerts != 3 {
		t.Fatalf("second drop generated event=%d alerts=%d, want event and 3 alerts", nextEvent, alerts)
	}

	for attempt := 1; attempt <= 3; attempt++ {
		target := claim(fmt.Sprintf("unavailable-%d", attempt))
		stopped, err := store.RecordPriceWatchUnavailable(
			ctx,
			target.ID,
			target.ClaimToken,
			time.Now().UTC(),
			time.Now().UTC().Add(5*time.Minute),
			"unavailable fixture",
		)
		if err != nil {
			t.Fatal(err)
		}
		if stopped != (attempt == 3) {
			t.Fatalf("attempt %d stopped=%v", attempt, stopped)
		}
	}
	var stoppedCount int
	if err := store.db.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM price_watches
		WHERE target_id = $1 AND status = 'stopped' AND stopped_reason = 'item_unavailable'`, targetID).Scan(&stoppedCount); err != nil {
		t.Fatal(err)
	}
	if stoppedCount != 3 {
		t.Fatalf("stopped watches = %d, want 3", stoppedCount)
	}
}
