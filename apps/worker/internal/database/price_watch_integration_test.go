package database

import (
	"context"
	"database/sql"
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

	scheduleState := func() (string, int, string) {
		t.Helper()
		var availability, lastErrorCode string
		var consecutiveUnavailable int
		if err := store.db.QueryRowContext(ctx, `
			SELECT availability, consecutive_unavailable, COALESCE(last_error_code, '')
			FROM price_watch_schedules WHERE id = $1`, scheduleID).Scan(&availability, &consecutiveUnavailable, &lastErrorCode); err != nil {
			t.Fatal(err)
		}
		return availability, consecutiveUnavailable, lastErrorCode
	}
	// checkedAt advances by a minute per call, as confirming checks do.
	checkedAt := time.Now().UTC()
	recordGone := func(token string, reason string) bool {
		t.Helper()
		target := claim(token)
		checkedAt = checkedAt.Add(time.Minute)
		stopped, err := store.RecordPriceWatchUnavailable(
			ctx, target.ID, target.ClaimToken, checkedAt,
			checkedAt.Add(time.Minute), reason, "gone fixture",
		)
		if err != nil {
			t.Fatal(err)
		}
		return stopped
	}

	// A reserved listing still exists: it keeps its own availability, stays
	// claimable and its price is still tracked.
	reservedTarget := claim("reserved")
	now := time.Now().UTC()
	if _, _, err := store.ApplyPriceWatchObservation(ctx, PriceWatchObservation{
		ScheduleID: reservedTarget.ID, TargetID: reservedTarget.TargetID, ClaimToken: reservedTarget.ClaimToken,
		CanonicalURL: reservedTarget.CanonicalURL, PriceMinor: 8_000, CurrencyCode: "EUR",
		Availability: PriceWatchAvailabilityReserved, ObservedAt: now, NextCheckAt: now.Add(5 * time.Minute),
	}); err != nil {
		t.Fatal(err)
	}
	if availability, _, _ := scheduleState(); availability != PriceWatchAvailabilityReserved {
		t.Fatalf("reserved listing availability = %q", availability)
	}
	if nextEvent, alerts := apply(claim("back-on-sale"), 8_000); nextEvent != 0 || alerts != 0 {
		t.Fatalf("back on sale generated event=%d alerts=%d", nextEvent, alerts)
	}
	if availability, _, _ := scheduleState(); availability != PriceWatchAvailabilityActive {
		t.Fatalf("availability after returning to sale = %q", availability)
	}

	// A single "sold" result is not enough to stop a watch...
	if recordGone("sold-1", PriceWatchStopSold) {
		t.Fatal("watch stopped after one unconfirmed check")
	}
	if availability, streak, code := scheduleState(); availability != PriceWatchAvailabilityActive || streak != 1 || code != PriceWatchStopSold {
		t.Fatalf("after first sold check: availability=%q streak=%d code=%q", availability, streak, code)
	}
	// ...and seeing the listing for sale again clears the suspicion.
	if nextEvent, alerts := apply(claim("for-sale-again"), 8_000); nextEvent != 0 || alerts != 0 {
		t.Fatalf("for sale again generated event=%d alerts=%d", nextEvent, alerts)
	}
	if _, streak, code := scheduleState(); streak != 0 || code != "" {
		t.Fatalf("available check kept streak=%d code=%q", streak, code)
	}

	// A failed request between two "sold" results says nothing about the
	// listing and must not restart the count.
	if recordGone("sold-2", PriceWatchStopSold) {
		t.Fatal("watch stopped after one unconfirmed check")
	}
	failed := claim("request-failed")
	if err := store.RecordPriceWatchError(ctx, failed.ID, failed.ClaimToken, time.Now().UTC(),
		time.Now().UTC().Add(time.Minute), "network_error", "fixture"); err != nil {
		t.Fatal(err)
	}
	if _, streak, code := scheduleState(); streak != 1 || code != "network_error" {
		t.Fatalf("failed request changed the streak: streak=%d code=%q", streak, code)
	}
	if !recordGone("sold-3", PriceWatchStopSold) {
		t.Fatalf("watch did not stop after %d consecutive sold checks", PriceWatchGoneConfirmations)
	}

	var stoppedCount int
	if err := store.db.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM price_watches
		WHERE target_id = $1 AND status = 'stopped' AND stopped_reason = 'item_sold'
		  AND armed_at IS NULL`, targetID).Scan(&stoppedCount); err != nil {
		t.Fatal(err)
	}
	if stoppedCount != 3 {
		t.Fatalf("stopped watches = %d, want 3", stoppedCount)
	}
	if availability, _, code := scheduleState(); availability != PriceWatchAvailabilityUnavailable || code != PriceWatchStopSold {
		t.Fatalf("stopped schedule: availability=%q code=%q", availability, code)
	}

	// Every member with notifications on is told once why the watch ended.
	stoppedNotice := func(watchID int64) (int, string, string, string) {
		t.Helper()
		var count int
		var title, message, channels sql.NullString
		if err := store.db.QueryRowContext(ctx, `
			SELECT COUNT(DISTINCT notification.id), MAX(notification.payload->>'title'),
				MAX(notification.payload->>'message'),
				STRING_AGG(DISTINCT delivery.channel, ',')
			FROM alert_notifications notification
			LEFT JOIN alert_deliveries delivery ON delivery.notification_id = notification.id
			WHERE notification.price_watch_id = $1 AND notification.kind = 'price_watch_stopped'`, watchID).Scan(&count, &title, &message, &channels); err != nil {
			t.Fatal(err)
		}
		return count, title.String, message.String, channels.String
	}
	for _, watchID := range watchIDs {
		count, title, message, channels := stoppedNotice(watchID)
		if count != 1 || title != "Price Watch ended: listing sold" || channels != "discord" {
			t.Fatalf("watch %d stop notice: count=%d title=%q channels=%q", watchID, count, title, channels)
		}
		wantMessage := fmt.Sprintf("“Integration item” was sold or is no longer for sale, so Vintrack stopped watching it.\nLast price: 80.00 EUR\nhttps://www.vinted.de/items/%d-test", itemID)
		if message != wantMessage {
			t.Fatalf("watch %d stop message = %q, want %q", watchID, message, wantMessage)
		}
	}

	// A retired schedule is never claimed again, even when it is due.
	if _, err := store.db.ExecContext(ctx, `
		UPDATE price_watch_schedules SET next_check_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, scheduleID); err != nil {
		t.Fatal(err)
	}
	targets, err := store.ClaimPriceWatchTargets(ctx, "after-stop", 10, 30*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	for _, target := range targets {
		if target.ID == scheduleID {
			t.Fatal("stopped schedule was claimed again")
		}
	}

	// Resuming (as the dashboard does) starts a fresh validation; a deleted
	// listing then stops the watch with its own reason.
	if _, err := store.db.ExecContext(ctx, `
		UPDATE price_watch_schedules SET availability = 'pending', consecutive_unavailable = 0 WHERE id = $1`, scheduleID); err != nil {
		t.Fatal(err)
	}
	// The second watch is resumed with notifications switched off.
	if _, err := store.db.ExecContext(ctx, `
		UPDATE price_watches SET status = 'active', stopped_reason = NULL,
			notifications_enabled = (id = $1)
		WHERE id IN ($1, $2)`, watchIDs[0], watchIDs[1]); err != nil {
		t.Fatal(err)
	}
	if recordGone("deleted-1", PriceWatchStopDeleted) {
		t.Fatal("watch stopped after one unconfirmed check")
	}
	if !recordGone("deleted-2", "unknown reason") {
		t.Fatal("watch did not stop after the confirming check")
	}
	var reason string
	if err := store.db.QueryRowContext(ctx, `
		SELECT stopped_reason FROM price_watches WHERE id = $1 AND status = 'stopped'`, watchIDs[0]).Scan(&reason); err != nil {
		t.Fatal(err)
	}
	// An unrecognized reason falls back to the generic one.
	if reason != PriceWatchStopUnavailable {
		t.Fatalf("stopped reason = %q, want %q", reason, PriceWatchStopUnavailable)
	}
	// Ending again after a resume is announced again, but only to members who
	// still want notifications; the watch that stayed stopped is not repeated.
	if count, _, _, _ := stoppedNotice(watchIDs[0]); count != 2 {
		t.Fatalf("resumed watch stop notices = %d, want 2", count)
	}
	if count, _, _, _ := stoppedNotice(watchIDs[1]); count != 1 {
		t.Fatalf("muted watch stop notices = %d, want 1", count)
	}
	if count, _, _, _ := stoppedNotice(watchIDs[2]); count != 1 {
		t.Fatalf("still-stopped watch stop notices = %d, want 1", count)
	}
}
