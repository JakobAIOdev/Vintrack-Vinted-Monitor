package database

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"strings"
	"time"

	"vintrack-worker/internal/model"

	"github.com/lib/pq"
)

const (
	alertDeliveryLeaseDuration = 60 * time.Second
	alertPruneBatchSize        = 10_000
	alertPruneMaximumBatches   = 20
)

func AlertDestinationFingerprint(channel string, destination string) string {
	sum := sha256.Sum256([]byte(strings.ToLower(strings.TrimSpace(channel)) + "\x00" + strings.TrimSpace(destination)))
	return hex.EncodeToString(sum[:])
}

func (s *Store) EnqueueAlertNotification(ctx context.Context, request model.AlertNotificationRequest) (bool, error) {
	if request.Kind == "" || request.IdempotencyKey == "" || request.ExpiresAt.IsZero() {
		return false, errors.New("invalid alert notification request")
	}
	payload, err := json.Marshal(request.Payload)
	if err != nil {
		return false, fmt.Errorf("marshal alert payload: %w", err)
	}

	tx, err := s.alertPool().BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()

	if request.DedupeUserItem && request.UserID != "" && request.ItemID > 0 {
		// The claim starts provisional and is promoted to its full lifetime only
		// once a delivery actually succeeds (see promoteAlertDedupeClaimTx).
		//
		// It used to be written with a 30-day expiry before the first attempt.
		// Because it is scoped to the user rather than the monitor, any alert
		// that then expired or was cancelled left a claim behind that suppressed
		// that item across every one of that member's monitors for a month.
		//
		// Expiring claims are reclaimed in the same statement, which also closes
		// the race the previous separate DELETE left open.
		var claimed bool
		err := tx.QueryRowContext(ctx, `
			INSERT INTO alert_dedupe_claims (user_id, item_id, expires_at)
			VALUES ($1, $2, NOW() + INTERVAL '15 minutes')
			ON CONFLICT (user_id, item_id) DO UPDATE
			SET expires_at = EXCLUDED.expires_at, claimed_at = NOW()
			WHERE alert_dedupe_claims.expires_at <= NOW()
			RETURNING TRUE`, request.UserID, request.ItemID).Scan(&claimed)
		if err == sql.ErrNoRows {
			if err := insertAlertEventTx(ctx, tx, model.AlertEvent{
				UserID: request.UserID, MonitorID: request.MonitorID, ItemID: request.ItemID,
				Channel: "all", Status: "deduplicated", NotificationKind: request.Kind,
				ReasonCode: "duplicate_user_item_alert", FailureReason: "duplicate_user_item_alert",
			}); err != nil {
				return false, err
			}
			if err := tx.Commit(); err != nil {
				return false, err
			}
			return false, nil
		}
		if err != nil {
			return false, err
		}
	}

	var notificationID int64
	err = tx.QueryRowContext(ctx, `
		INSERT INTO alert_notifications (
			user_id, monitor_id, item_id, kind, payload_version, payload,
			idempotency_key, expires_at
		)
		VALUES (NULLIF($1, ''), NULLIF($2, 0), NULLIF($3, 0::bigint), $4, $5, $6::jsonb, $7, $8)
		ON CONFLICT (idempotency_key) DO NOTHING
		RETURNING id`,
		request.UserID, request.MonitorID, request.ItemID, request.Kind,
		request.Payload.Version, string(payload), request.IdempotencyKey, request.ExpiresAt.UTC(),
	).Scan(&notificationID)
	if err == sql.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, err
	}

	type target struct{ channel, value string }
	targets := []target{{"discord", request.DiscordTarget}, {"telegram", request.TelegramTarget}}
	deliveryCount := 0
	for _, destination := range targets {
		if strings.TrimSpace(destination.value) == "" {
			continue
		}
		fingerprint := AlertDestinationFingerprint(destination.channel, destination.value)
		var deliveryID int64
		if err := tx.QueryRowContext(ctx, `
			INSERT INTO alert_deliveries (
				notification_id, channel, destination_fingerprint
			)
			VALUES ($1, $2, $3)
			ON CONFLICT (notification_id, channel) DO NOTHING
			RETURNING id`, notificationID, destination.channel, fingerprint).Scan(&deliveryID); err != nil {
			if err == sql.ErrNoRows {
				continue
			}
			return false, err
		}
		if err := insertAlertEventTx(ctx, tx, model.AlertEvent{
			UserID: request.UserID, MonitorID: request.MonitorID, ItemID: request.ItemID,
			NotificationID: notificationID, DeliveryID: deliveryID,
			Channel: destination.channel, Status: "queued", NotificationKind: request.Kind,
		}); err != nil {
			return false, err
		}
		deliveryCount++
	}

	if deliveryCount == 0 {
		if _, err := tx.ExecContext(ctx, `DELETE FROM alert_notifications WHERE id = $1`, notificationID); err != nil {
			return false, err
		}
	}
	if err := tx.Commit(); err != nil {
		return false, err
	}
	return deliveryCount > 0, nil
}

func (s *Store) ClaimAlertDelivery(ctx context.Context, claimToken string) (*model.AlertDelivery, error) {
	deliveries, err := s.ClaimAlertDeliveries(ctx, claimToken, 1)
	if err != nil || len(deliveries) == 0 {
		return nil, err
	}
	return &deliveries[0], nil
}

func (s *Store) ClaimAlertDeliveries(ctx context.Context, claimToken string, limit int) ([]model.AlertDelivery, error) {
	if claimToken == "" {
		return nil, errors.New("empty alert delivery claim token")
	}
	if limit < 1 {
		limit = 1
	}
	if limit > 100 {
		limit = 100
	}

	rows, err := s.alertPool().QueryContext(ctx, `
		WITH candidate AS (
			SELECT d.id
			FROM alert_deliveries d
			JOIN alert_notifications n ON n.id = d.notification_id
			WHERE d.status IN ('pending', 'retrying')
			  AND d.next_attempt_at <= NOW()
			  AND n.expires_at > NOW()
			  AND NOT EXISTS (
				SELECT 1
				FROM alert_deliveries active
				WHERE active.destination_fingerprint = d.destination_fingerprint
				  AND active.id <> d.id
				  AND active.status = 'processing'
				  AND active.lease_until > NOW()
			  )
			  AND NOT EXISTS (
				SELECT 1
				FROM alert_deliveries older
				JOIN alert_notifications older_n ON older_n.id = older.notification_id
				WHERE older.destination_fingerprint = d.destination_fingerprint
				  AND older_n.expires_at > NOW()
				  AND (
					CASE WHEN older_n.kind = 'item_match' THEN 0 ELSE 1 END,
					older.created_at,
					older.id
				  ) < (
					CASE WHEN n.kind = 'item_match' THEN 0 ELSE 1 END,
					d.created_at,
					d.id
				  )
				  AND older.status IN ('pending', 'processing', 'retrying')
			  )
			ORDER BY
				CASE WHEN n.kind = 'item_match' THEN 0 ELSE 1 END,
				d.next_attempt_at,
				d.created_at,
				d.id
			LIMIT $3
			FOR UPDATE OF d SKIP LOCKED
		), claimed AS (
			UPDATE alert_deliveries d
			SET status = 'processing',
				attempt_count = attempt_count + 1,
				claim_token = $1,
				lease_until = NOW() + $2::interval,
				updated_at = NOW()
			FROM candidate
			WHERE d.id = candidate.id
			RETURNING d.*
		)
		SELECT
			claimed.id, claimed.notification_id, COALESCE(n.user_id, ''),
			COALESCE(n.monitor_id, 0), COALESCE(n.item_id, 0), n.kind,
			n.payload, n.expires_at, claimed.channel,
			CASE claimed.channel
				WHEN 'discord' THEN COALESCE(m.discord_webhook, '')
				WHEN 'telegram' THEN COALESCE(tc.chat_id, '')
				ELSE ''
			END AS destination,
			claimed.destination_fingerprint, claimed.attempt_count, claimed.claim_token,
			COALESCE(m.notifications_enabled, FALSE),
			CASE claimed.channel
				WHEN 'discord' THEN COALESCE(m.webhook_active, FALSE)
				WHEN 'telegram' THEN COALESCE(m.telegram_active, FALSE)
				ELSE FALSE
			END AS channel_enabled
		FROM claimed
		JOIN alert_notifications n ON n.id = claimed.notification_id
		LEFT JOIN monitors m ON m.id = n.monitor_id
		LEFT JOIN telegram_connections tc ON tc."userId" = n.user_id`,
		claimToken, fmt.Sprintf("%d seconds", int(alertDeliveryLeaseDuration.Seconds())), limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	deliveries := make([]model.AlertDelivery, 0, limit)
	for rows.Next() {
		var delivery model.AlertDelivery
		var payload []byte
		if err := rows.Scan(
			&delivery.ID, &delivery.NotificationID, &delivery.UserID,
			&delivery.MonitorID, &delivery.ItemID, &delivery.Kind,
			&payload, &delivery.ExpiresAt, &delivery.Channel, &delivery.Destination,
			&delivery.DestinationFingerprint, &delivery.AttemptCount, &delivery.ClaimToken,
			&delivery.NotificationsEnabled, &delivery.ChannelEnabled,
		); err != nil {
			return nil, err
		}
		if err := json.Unmarshal(payload, &delivery.Payload); err != nil {
			return nil, fmt.Errorf("decode alert notification %d: %w", delivery.NotificationID, err)
		}
		delivery.CurrentFingerprint = AlertDestinationFingerprint(delivery.Channel, delivery.Destination)
		deliveries = append(deliveries, delivery)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return deliveries, nil
}

func (s *Store) RecoverExpiredAlertDeliveryLeases(ctx context.Context) (int64, error) {
	result, err := s.alertPool().ExecContext(ctx, `
		WITH expired AS (
			SELECT id
			FROM alert_deliveries
			WHERE status = 'processing' AND lease_until <= NOW()
			ORDER BY lease_until, id
			LIMIT 1000
			FOR UPDATE SKIP LOCKED
		)
		UPDATE alert_deliveries d
		SET status = 'retrying', claim_token = NULL, lease_until = NULL,
			next_attempt_at = LEAST(next_attempt_at, NOW()), updated_at = NOW()
		FROM expired
		WHERE d.id = expired.id`)
	if err != nil {
		return 0, err
	}
	return result.RowsAffected()
}

func (s *Store) CompleteAlertDelivery(ctx context.Context, delivery model.AlertDelivery) (bool, error) {
	return s.finishAlertDelivery(ctx, delivery, "sent", "", "")
}

func (s *Store) FailAlertDelivery(ctx context.Context, delivery model.AlertDelivery, reasonCode string, detail string) (bool, error) {
	return s.finishAlertDelivery(ctx, delivery, "failed", reasonCode, detail)
}

func (s *Store) CancelAlertDelivery(ctx context.Context, delivery model.AlertDelivery, reasonCode string, detail string) (bool, error) {
	return s.finishAlertDelivery(ctx, delivery, "cancelled", reasonCode, detail)
}

func (s *Store) finishAlertDelivery(
	ctx context.Context,
	delivery model.AlertDelivery,
	status string,
	reasonCode string,
	detail string,
) (bool, error) {
	detail = boundedAlertDetail(detail)
	tx, err := s.alertPool().BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()

	result, err := tx.ExecContext(ctx, `
		UPDATE alert_deliveries
		SET status = $3, last_reason_code = NULLIF($4, ''),
			last_error_detail = NULLIF($5, ''), completed_at = NOW(),
			lease_until = NULL, claim_token = NULL, updated_at = NOW()
		WHERE id = $1 AND claim_token = $2 AND status = 'processing'`,
		delivery.ID, delivery.ClaimToken, status, reasonCode, detail,
	)
	if err != nil {
		return false, err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return false, err
	}
	if affected == 0 {
		// The 60 second lease expired while the provider call was in flight and
		// the recovery sweep released the row, so this outcome cannot be
		// recorded and the message will be sent again. Silently returning here
		// made duplicate notifications untraceable.
		log.Printf(
			"alert delivery %d (%s) lost its lease before completion with outcome %q; it may be delivered twice",
			delivery.ID, delivery.Channel, status,
		)
		if err := insertAlertEventTx(ctx, tx, model.AlertEvent{
			UserID: delivery.UserID, MonitorID: delivery.MonitorID, ItemID: delivery.ItemID,
			NotificationID: delivery.NotificationID, DeliveryID: delivery.ID,
			Channel: delivery.Channel, Status: "failed", NotificationKind: delivery.Kind,
			ReasonCode: "lease_lost", AttemptNumber: delivery.AttemptCount,
			FailureReason: "lease expired after the provider call; message may be duplicated",
		}); err != nil {
			return false, err
		}
		if err := tx.Commit(); err != nil {
			return false, err
		}
		return false, nil
	}

	if err := insertAlertEventTx(ctx, tx, model.AlertEvent{
		UserID: delivery.UserID, MonitorID: delivery.MonitorID, ItemID: delivery.ItemID,
		NotificationID: delivery.NotificationID, DeliveryID: delivery.ID,
		Channel: delivery.Channel, Status: status, NotificationKind: delivery.Kind,
		ReasonCode: reasonCode, AttemptNumber: delivery.AttemptCount, FailureReason: detail,
	}); err != nil {
		return false, err
	}
	if status == "sent" {
		if delivery.MonitorID > 0 && delivery.ItemID > 0 {
			if _, err := tx.ExecContext(ctx, `
				UPDATE monitor_item_detections
				SET alert_sent_at = COALESCE(alert_sent_at, NOW()), updated_at = NOW()
				WHERE monitor_id = $1 AND item_id = $2`, delivery.MonitorID, delivery.ItemID); err != nil {
				return false, err
			}
		}
		// The message reached the member, so the provisional dedupe claim earns
		// its full lifetime. Both sides of this are primary-key lookups.
		if _, err := tx.ExecContext(ctx, `
			UPDATE alert_dedupe_claims c
			SET expires_at = GREATEST(c.expires_at, NOW() + INTERVAL '30 days')
			FROM alert_notifications n
			WHERE n.id = $1 AND c.user_id = n.user_id AND c.item_id = n.item_id`,
			delivery.NotificationID); err != nil {
			return false, err
		}
	}
	if err := tx.Commit(); err != nil {
		return false, err
	}
	return true, nil
}

func (s *Store) RetryAlertDelivery(
	ctx context.Context,
	delivery model.AlertDelivery,
	reasonCode string,
	detail string,
	nextAttempt time.Time,
) (bool, error) {
	detail = boundedAlertDetail(detail)
	tx, err := s.alertPool().BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	result, err := tx.ExecContext(ctx, `
		UPDATE alert_deliveries
		SET status = 'retrying', next_attempt_at = $3,
			last_reason_code = NULLIF($4, ''), last_error_detail = NULLIF($5, ''),
			lease_until = NULL, claim_token = NULL, updated_at = NOW()
		WHERE id = $1 AND claim_token = $2 AND status = 'processing'`,
		delivery.ID, delivery.ClaimToken, nextAttempt.UTC(), reasonCode, detail,
	)
	if err != nil {
		return false, err
	}
	affected, err := result.RowsAffected()
	if err != nil || affected == 0 {
		return false, err
	}
	if err := insertAlertEventTx(ctx, tx, model.AlertEvent{
		UserID: delivery.UserID, MonitorID: delivery.MonitorID, ItemID: delivery.ItemID,
		NotificationID: delivery.NotificationID, DeliveryID: delivery.ID,
		Channel: delivery.Channel, Status: "retry_scheduled", NotificationKind: delivery.Kind,
		ReasonCode: reasonCode, AttemptNumber: delivery.AttemptCount, FailureReason: detail,
	}); err != nil {
		return false, err
	}
	if err := tx.Commit(); err != nil {
		return false, err
	}
	return true, nil
}

func insertAlertEventTx(ctx context.Context, tx *sql.Tx, event model.AlertEvent) error {
	metadata := event.Metadata
	if strings.TrimSpace(metadata) == "" {
		metadata = "{}"
	}
	_, err := tx.ExecContext(ctx, `
		INSERT INTO alert_events (
			"userId", monitor_id, item_id, notification_id, delivery_id,
			channel, status, notification_kind, reason_code, attempt_number,
			failure_reason, metadata
		)
		VALUES (
			NULLIF($1, ''), NULLIF($2, 0), NULLIF($3, 0::bigint),
			NULLIF($4, 0::bigint), NULLIF($5, 0::bigint), $6, $7, $8,
			NULLIF($9, ''), NULLIF($10, 0), NULLIF($11, ''), $12::jsonb
		)`,
		event.UserID, event.MonitorID, event.ItemID, event.NotificationID, event.DeliveryID,
		event.Channel, event.Status, defaultAlertKind(event.NotificationKind),
		event.ReasonCode, event.AttemptNumber, event.FailureReason, metadata,
	)
	return err
}

func defaultAlertKind(kind string) string {
	if strings.TrimSpace(kind) == "" {
		return "item_match"
	}
	return kind
}

func boundedAlertDetail(detail string) string {
	detail = strings.TrimSpace(detail)
	if len(detail) > 1000 {
		return detail[:1000]
	}
	return detail
}

// alertExpiryBatchSize bounds one expiry sweep.
//
// The previous implementation claimed up to 1000 rows and then issued one
// alert_events insert per row inside the same transaction. Under a few seconds
// of maintenance budget that reliably timed out and rolled back, so the same
// rows were retried every cycle and never actually expired.
const alertExpiryBatchSize = 200

// ExpireAlertDeliveries fails deliveries whose notification deadline has passed.
// It is a single statement, so it runs in an implicit transaction and one round
// trip regardless of batch size.
func (s *Store) ExpireAlertDeliveries(ctx context.Context) error {
	_, err := s.alertPool().ExecContext(ctx, `
		WITH expired AS (
			SELECT d.id
			FROM alert_deliveries d
			JOIN alert_notifications n ON n.id = d.notification_id
			WHERE d.status IN ('pending', 'processing', 'retrying')
			  AND n.expires_at <= NOW()
			ORDER BY n.expires_at, d.id
			LIMIT $1
			FOR UPDATE OF d SKIP LOCKED
		), failed AS (
			UPDATE alert_deliveries d
			SET status = 'failed', last_reason_code = 'expired',
				last_error_detail = 'delivery expired before provider accepted it',
				completed_at = NOW(), lease_until = NULL, claim_token = NULL, updated_at = NOW()
			FROM expired
			WHERE d.id = expired.id
			RETURNING d.id, d.notification_id, d.channel, d.attempt_count
		)
		INSERT INTO alert_events (
			"userId", monitor_id, item_id, notification_id, delivery_id,
			channel, status, notification_kind, reason_code, attempt_number, failure_reason
		)
		SELECT n.user_id, n.monitor_id, n.item_id, n.id, failed.id, failed.channel,
			'failed', n.kind, 'expired', NULLIF(failed.attempt_count, 0),
			'delivery expired before provider accepted it'
		FROM failed
		JOIN alert_notifications n ON n.id = failed.notification_id`,
		alertExpiryBatchSize)
	return err
}

func (s *Store) PruneAlertTelemetry(successDays int, failureDays int, statsDays int) {
	if successDays < 1 {
		successDays = 7
	}
	if failureDays < successDays {
		failureDays = 30
	}
	if statsDays < 1 {
		statsDays = 90
	}

	for batch := 0; batch < alertPruneMaximumBatches; batch++ {
		result, err := s.db.Exec(`
			WITH expired AS (
				SELECT id FROM alert_events
				WHERE (status IN ('sent', 'deduplicated', 'queued') AND created_at < NOW() - ($1::text || ' days')::interval)
				   OR (status IN ('failed', 'retry_scheduled', 'cancelled', 'stale') AND created_at < NOW() - ($2::text || ' days')::interval)
				ORDER BY created_at, id LIMIT $3
			)
			DELETE FROM alert_events e USING expired WHERE e.id = expired.id`,
			successDays, failureDays, alertPruneBatchSize)
		if err != nil {
			return
		}
		deleted, _ := result.RowsAffected()
		if deleted < alertPruneBatchSize {
			break
		}
	}
	for batch := 0; batch < alertPruneMaximumBatches; batch++ {
		result, err := s.db.Exec(`
			WITH expired AS (
				SELECT bucket_hour, channel, notification_kind, outcome, reason_code
				FROM alert_event_hourly_stats
				WHERE bucket_hour < NOW() - ($1::text || ' days')::interval
				ORDER BY bucket_hour LIMIT $2
			)
			DELETE FROM alert_event_hourly_stats s USING expired e
			WHERE s.bucket_hour = e.bucket_hour AND s.channel = e.channel
			  AND s.notification_kind = e.notification_kind AND s.outcome = e.outcome
			  AND s.reason_code = e.reason_code`, statsDays, alertPruneBatchSize)
		if err != nil {
			break
		}
		deleted, _ := result.RowsAffected()
		if deleted < alertPruneBatchSize {
			break
		}
	}
	for batch := 0; batch < alertPruneMaximumBatches; batch++ {
		result, err := s.db.Exec(`
			WITH expired AS (
				SELECT user_id, item_id FROM alert_dedupe_claims
				WHERE expires_at <= NOW() ORDER BY expires_at LIMIT $1
			)
			DELETE FROM alert_dedupe_claims c USING expired e
			WHERE c.user_id = e.user_id AND c.item_id = e.item_id`, alertPruneBatchSize)
		if err != nil {
			break
		}
		deleted, _ := result.RowsAffected()
		if deleted < alertPruneBatchSize {
			break
		}
	}
	for batch := 0; batch < alertPruneMaximumBatches; batch++ {
		result, err := s.db.Exec(`
			WITH expired AS (
				SELECT n.id FROM alert_notifications n
				WHERE NOT EXISTS (
					SELECT 1 FROM alert_deliveries d
					WHERE d.notification_id = n.id
					  AND d.status IN ('pending', 'processing', 'retrying')
				)
				AND (
					(n.created_at < NOW() - ($1::text || ' days')::interval AND NOT EXISTS (
						SELECT 1 FROM alert_deliveries d
						WHERE d.notification_id = n.id AND d.status = 'failed'
					))
					OR n.created_at < NOW() - ($2::text || ' days')::interval
				)
				ORDER BY n.created_at, n.id LIMIT $3
			)
			DELETE FROM alert_notifications n USING expired e WHERE n.id = e.id`,
			successDays, failureDays, alertPruneBatchSize)
		if err != nil {
			break
		}
		deleted, _ := result.RowsAffected()
		if deleted < alertPruneBatchSize {
			break
		}
	}
}

func (s *Store) OpenOrUpdateProxyIncident(
	ctx context.Context,
	monitorID int,
	domain string,
	proxySource string,
	retryAt time.Time,
) error {
	if monitorID <= 0 || strings.TrimSpace(domain) == "" {
		return nil
	}
	var retry interface{}
	if !retryAt.IsZero() {
		retry = retryAt.UTC()
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO monitor_proxy_incidents (
			monitor_id, domain, proxy_source, retry_at
		)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (monitor_id) WHERE recovered_at IS NULL
		DO UPDATE SET
			last_wait_at = NOW(),
			retry_at = EXCLUDED.retry_at,
			wait_count = monitor_proxy_incidents.wait_count + 1`,
		monitorID, domain, proxySource, retry,
	)
	return err
}

func (s *Store) CloseProxyIncident(ctx context.Context, monitorID int, reason string) error {
	if monitorID <= 0 {
		return nil
	}
	if strings.TrimSpace(reason) == "" {
		reason = "recovered"
	}
	_, err := s.db.ExecContext(ctx, `
		UPDATE monitor_proxy_incidents
		SET recovered_at = NOW(), end_reason = $2, last_wait_at = GREATEST(last_wait_at, started_at)
		WHERE monitor_id = $1 AND recovered_at IS NULL`, monitorID, reason)
	return err
}

func (s *Store) PruneOperationalEvents(retentionDays int) {
	if retentionDays < 1 {
		retentionDays = 30
	}
	for batch := 0; batch < alertPruneMaximumBatches; batch++ {
		result, err := s.db.Exec(`
			WITH expired AS (
				SELECT id FROM monitor_events
				WHERE created_at < NOW() - ($1::text || ' days')::interval
				ORDER BY created_at, id LIMIT $2
			)
			DELETE FROM monitor_events e USING expired WHERE e.id = expired.id`,
			retentionDays, alertPruneBatchSize)
		if err != nil {
			break
		}
		deleted, _ := result.RowsAffected()
		if deleted < alertPruneBatchSize {
			break
		}
	}
	for batch := 0; batch < alertPruneMaximumBatches; batch++ {
		result, err := s.db.Exec(`
			WITH expired AS (
				SELECT id FROM monitor_proxy_incidents
				WHERE recovered_at IS NOT NULL
				  AND recovered_at < NOW() - ($1::text || ' days')::interval
				ORDER BY recovered_at, id LIMIT $2
			)
			DELETE FROM monitor_proxy_incidents i USING expired e WHERE i.id = e.id`,
			retentionDays, alertPruneBatchSize)
		if err != nil {
			break
		}
		deleted, _ := result.RowsAffected()
		if deleted < alertPruneBatchSize {
			break
		}
	}
}

func (s *Store) DeferAlertDestination(ctx context.Context, channel string, fingerprint string, until time.Time, global bool) error {
	if until.IsZero() {
		return nil
	}
	if global {
		_, err := s.alertPool().ExecContext(ctx, `
			UPDATE alert_deliveries
			SET next_attempt_at = GREATEST(next_attempt_at, $2), updated_at = NOW()
			WHERE channel = $1 AND status IN ('pending', 'retrying')`, channel, until.UTC())
		return err
	}
	_, err := s.alertPool().ExecContext(ctx, `
		UPDATE alert_deliveries
		SET next_attempt_at = GREATEST(next_attempt_at, $2), updated_at = NOW()
		WHERE destination_fingerprint = $1 AND status IN ('pending', 'retrying')`, fingerprint, until.UTC())
	return err
}

func (s *Store) ListenForAlertDeliveries(ctx context.Context, wake chan<- struct{}) {
	if strings.TrimSpace(s.connString) == "" {
		return
	}
	listener := pq.NewListener(s.connString, time.Second, time.Minute, nil)
	defer listener.Close()
	if err := listener.Listen("alert_delivery_ready"); err != nil {
		return
	}
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-listener.Notify:
			select {
			case wake <- struct{}{}:
			default:
			}
		case <-ticker.C:
			_ = listener.Ping()
		}
	}
}
