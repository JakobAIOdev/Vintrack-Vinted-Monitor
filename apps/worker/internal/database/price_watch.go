package database

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"vintrack-worker/internal/model"
)

type PriceWatchObservation struct {
	ScheduleID   int64
	TargetID     int64
	ClaimToken   string
	CanonicalURL string
	Title        string
	ImageURL     string
	PriceMinor   int64
	CurrencyCode string
	ObservedAt   time.Time
	NextCheckAt  time.Time
}

type PriceWatchCheckSample struct {
	ScheduleID int64
	CheckedAt  time.Time
	Success    bool
	StatusCode int
	DurationMS int
	ErrorCode  string
	TxBytes    int64
	RxBytes    int64
}

type priceWatchSubscriber struct {
	id                   int64
	userID               string
	armed                bool
	notificationsEnabled bool
	discordWebhook       string
	webhookActive        bool
	telegramChatID       string
	telegramActive       bool
	telegramStyle        model.NotificationMessageStyle
	discordStyle         model.NotificationMessageStyle
}

func (s *Store) ClaimPriceWatchTargets(ctx context.Context, claimToken string, limit int, lease time.Duration) ([]model.PriceWatchTarget, error) {
	if strings.TrimSpace(claimToken) == "" {
		return nil, errors.New("empty price watch claim token")
	}
	if limit < 1 {
		limit = 1
	}
	if limit > 100 {
		limit = 100
	}
	if lease <= 0 {
		lease = 30 * time.Second
	}

	rows, err := s.db.QueryContext(ctx, `
		WITH candidates AS (
			SELECT schedule.id
			FROM price_watch_schedules schedule
			WHERE schedule.availability IN ('pending', 'active')
			  AND schedule.next_check_at <= NOW()
			  AND (schedule.lease_until IS NULL OR schedule.lease_until <= NOW())
			  AND EXISTS (
				SELECT 1 FROM price_watches watch
				WHERE watch.schedule_id = schedule.id AND watch.status = 'active'
			  )
			ORDER BY schedule.next_check_at, schedule.id
			LIMIT $1
			FOR UPDATE OF schedule SKIP LOCKED
		), claimed AS (
			UPDATE price_watch_schedules schedule
			SET claim_token = $2,
				lease_until = NOW() + $3::interval,
				updated_at = NOW()
			FROM candidates
			WHERE schedule.id = candidates.id
			RETURNING schedule.*
		)
		SELECT claimed.id, target.id, target.region, target.item_id,
			target.canonical_url, claimed.current_price_minor,
			claimed.currency_code, claimed.availability,
			claimed.consecutive_unavailable, claimed.consecutive_errors,
			claimed.claim_token, claimed.transport_kind,
			claimed.proxy_group_id, COALESCE(proxy_group.name, ''),
			COALESCE(proxy_group.proxies, ''),
			COALESCE(proxy_group.proxy_check_working, 0),
			proxy_group.bandwidth_limit_bytes,
			COALESCE(proxy_group.bandwidth_rx_bytes, 0),
			COALESCE(proxy_group.bandwidth_tx_bytes, 0),
			intervals.poll_interval_seconds
		FROM claimed
		JOIN price_watch_targets target ON target.id = claimed.target_id
		LEFT JOIN proxy_groups proxy_group ON proxy_group.id = claimed.proxy_group_id
		JOIN LATERAL (
			SELECT MIN(watch.poll_interval_seconds)::int AS poll_interval_seconds
			FROM price_watches watch
			WHERE watch.schedule_id = claimed.id AND watch.status = 'active'
		) intervals ON intervals.poll_interval_seconds IS NOT NULL
		ORDER BY claimed.next_check_at, claimed.id`,
		limit, claimToken, fmt.Sprintf("%d milliseconds", lease.Milliseconds()),
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	targets := make([]model.PriceWatchTarget, 0, limit)
	for rows.Next() {
		var target model.PriceWatchTarget
		var proxyGroupID sql.NullInt64
		if err := rows.Scan(
			&target.ID,
			&target.TargetID,
			&target.Region,
			&target.ItemID,
			&target.CanonicalURL,
			&target.CurrentPriceMinor,
			&target.CurrencyCode,
			&target.Availability,
			&target.ConsecutiveUnavailable,
			&target.ConsecutiveErrors,
			&target.ClaimToken,
			&target.TransportKind,
			&proxyGroupID,
			&target.ProxyGroupName,
			&target.Proxies,
			&target.WorkingProxyCount,
			&target.ProxyGroupLimitBytes,
			&target.ProxyGroupRxBytes,
			&target.ProxyGroupTxBytes,
			&target.PollIntervalSeconds,
		); err != nil {
			return nil, err
		}
		if proxyGroupID.Valid {
			id := int(proxyGroupID.Int64)
			target.ProxyGroupID = &id
		}
		targets = append(targets, target)
	}
	return targets, rows.Err()
}

func (s *Store) ApplyPriceWatchObservation(ctx context.Context, observation PriceWatchObservation) (int64, int, error) {
	if observation.ScheduleID <= 0 || observation.TargetID <= 0 || observation.ClaimToken == "" || observation.PriceMinor < 0 {
		return 0, 0, errors.New("invalid price watch observation")
	}
	observation.CurrencyCode = strings.ToUpper(strings.TrimSpace(observation.CurrencyCode))
	if len(observation.CurrencyCode) != 3 {
		return 0, 0, errors.New("invalid price watch currency")
	}
	if observation.ObservedAt.IsZero() {
		observation.ObservedAt = time.Now().UTC()
	}
	if !observation.NextCheckAt.After(observation.ObservedAt) {
		observation.NextCheckAt = observation.ObservedAt.Add(2 * time.Minute)
	}

	tx, err := s.alertPool().BeginTx(ctx, nil)
	if err != nil {
		return 0, 0, err
	}
	defer tx.Rollback()

	var previousPrice sql.NullInt64
	var previousCurrency sql.NullString
	var storedURL string
	var storedTitle sql.NullString
	var storedImageURL sql.NullString
	var itemID int64
	var region string
	err = tx.QueryRowContext(ctx, `
		SELECT schedule.current_price_minor, schedule.currency_code,
			target.canonical_url, target.title, target.image_url,
			target.item_id, target.region
		FROM price_watch_schedules schedule
		JOIN price_watch_targets target ON target.id = schedule.target_id
		WHERE schedule.id = $1 AND schedule.target_id = $2 AND schedule.claim_token = $3
		FOR UPDATE OF schedule, target`, observation.ScheduleID, observation.TargetID, observation.ClaimToken,
	).Scan(&previousPrice, &previousCurrency, &storedURL, &storedTitle, &storedImageURL, &itemID, &region)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, 0, nil
	}
	if err != nil {
		return 0, 0, err
	}

	subscribers, err := loadPriceWatchSubscribersTx(ctx, tx, observation.ScheduleID)
	if err != nil {
		return 0, 0, err
	}
	canonicalURL := strings.TrimSpace(observation.CanonicalURL)
	if canonicalURL == "" {
		canonicalURL = storedURL
	}
	title := strings.TrimSpace(observation.Title)
	if title == "" {
		title = storedTitle.String
	}
	imageURL := strings.TrimSpace(observation.ImageURL)
	if imageURL == "" {
		imageURL = storedImageURL.String
	}

	if _, err := tx.ExecContext(ctx, `
		UPDATE price_watch_targets
		SET canonical_url = $2,
			title = COALESCE(NULLIF($3, ''), title),
			image_url = COALESCE(NULLIF($4, ''), image_url),
			current_price_minor = $5,
			currency_code = $6,
			updated_at = NOW()
		WHERE id = $1`, observation.TargetID, canonicalURL, title, imageURL, observation.PriceMinor, observation.CurrencyCode); err != nil {
		return 0, 0, err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE price_watch_schedules
		SET current_price_minor = $4,
			currency_code = $5,
			availability = 'active',
			consecutive_unavailable = 0,
			consecutive_errors = 0,
			last_error_code = NULL,
			last_error_detail = NULL,
			last_checked_at = $6,
			last_success_at = $6,
			next_check_at = $7,
			lease_until = NULL,
			claim_token = NULL,
			updated_at = NOW()
		WHERE id = $1 AND target_id = $2 AND claim_token = $3`,
		observation.ScheduleID, observation.TargetID, observation.ClaimToken,
		observation.PriceMinor, observation.CurrencyCode,
		observation.ObservedAt.UTC(), observation.NextCheckAt.UTC()); err != nil {
		return 0, 0, err
	}

	if _, err := tx.ExecContext(ctx, `
		UPDATE price_watches
		SET initial_price_minor = COALESCE(initial_price_minor, $2),
			armed_at = COALESCE(armed_at, $3),
			updated_at = NOW()
		WHERE schedule_id = $1 AND status = 'active' AND armed_at IS NULL`,
		observation.ScheduleID, observation.PriceMinor, observation.ObservedAt.UTC()); err != nil {
		return 0, 0, err
	}

	priceDropped := previousPrice.Valid && previousCurrency.Valid &&
		strings.EqualFold(previousCurrency.String, observation.CurrencyCode) &&
		observation.PriceMinor < previousPrice.Int64
	if !priceDropped {
		if err := tx.Commit(); err != nil {
			return 0, 0, err
		}
		return 0, 0, nil
	}

	var eventID int64
	if err := tx.QueryRowContext(ctx, `
		INSERT INTO price_watch_events (
			target_id, schedule_id, previous_price_minor, new_price_minor,
			currency_code, observed_at
		) VALUES ($1, $2, $3, $4, $5, $6)
		RETURNING id`, observation.TargetID, observation.ScheduleID,
		previousPrice.Int64, observation.PriceMinor, observation.CurrencyCode,
		observation.ObservedAt.UTC()).Scan(&eventID); err != nil {
		return 0, 0, err
	}

	createdAlerts := 0
	for _, subscriber := range subscribers {
		if !subscriber.armed || !subscriber.notificationsEnabled {
			continue
		}
		request := model.AlertNotificationRequest{
			UserID: subscriber.userID, PriceWatchID: subscriber.id, ItemID: itemID,
			Kind: "price_drop", IdempotencyKey: fmt.Sprintf("price_drop:%d:%d", subscriber.id, eventID),
			ExpiresAt: observation.ObservedAt.Add(30 * time.Minute),
			Payload: model.AlertNotificationPayload{
				Version: 1, Kind: "price_drop", TelegramStyle: subscriber.telegramStyle,
				DiscordStyle: subscriber.discordStyle,
				PriceDrop: &model.PriceDropAlert{
					WatchID: subscriber.id, ItemID: itemID, Region: region, Title: title,
					URL: canonicalURL, ImageURL: imageURL,
					PreviousPriceMinor: previousPrice.Int64, NewPriceMinor: observation.PriceMinor,
					CurrencyCode: observation.CurrencyCode, ObservedAt: observation.ObservedAt.UTC(),
				},
			},
		}
		if subscriber.webhookActive {
			request.DiscordTarget = subscriber.discordWebhook
		}
		if subscriber.telegramActive {
			request.TelegramTarget = subscriber.telegramChatID
		}
		created, err := enqueueAlertNotificationTx(ctx, tx, request)
		if err != nil {
			return 0, 0, err
		}
		if created {
			createdAlerts++
		}
	}
	if err := tx.Commit(); err != nil {
		return 0, 0, err
	}
	return eventID, createdAlerts, nil
}

func loadPriceWatchSubscribersTx(ctx context.Context, tx *sql.Tx, scheduleID int64) ([]priceWatchSubscriber, error) {
	rows, err := tx.QueryContext(ctx, `
		SELECT watch.id, watch.user_id, watch.armed_at IS NOT NULL,
			watch.notifications_enabled, COALESCE(watch.discord_webhook, ''),
			watch.webhook_active, COALESCE(connection.chat_id, ''), watch.telegram_active,
			COALESCE(member.telegram_message_style, 'rich'),
			COALESCE(member.discord_message_style, 'rich')
		FROM price_watches watch
		JOIN "User" member ON member.id = watch.user_id
		LEFT JOIN telegram_connections connection ON connection."userId" = watch.user_id
		WHERE watch.schedule_id = $1 AND watch.status = 'active'
		ORDER BY watch.id
		FOR UPDATE OF watch`, scheduleID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var subscribers []priceWatchSubscriber
	for rows.Next() {
		var subscriber priceWatchSubscriber
		if err := rows.Scan(&subscriber.id, &subscriber.userID, &subscriber.armed,
			&subscriber.notificationsEnabled, &subscriber.discordWebhook,
			&subscriber.webhookActive, &subscriber.telegramChatID,
			&subscriber.telegramActive, &subscriber.telegramStyle,
			&subscriber.discordStyle); err != nil {
			return nil, err
		}
		subscriber.telegramStyle = model.NormalizeNotificationMessageStyle(subscriber.telegramStyle)
		subscriber.discordStyle = model.NormalizeNotificationMessageStyle(subscriber.discordStyle)
		subscribers = append(subscribers, subscriber)
	}
	return subscribers, rows.Err()
}

func (s *Store) RecordPriceWatchUnavailable(ctx context.Context, scheduleID int64, claimToken string, checkedAt time.Time, nextCheckAt time.Time, reason string) (bool, error) {
	if checkedAt.IsZero() {
		checkedAt = time.Now().UTC()
	}
	if !nextCheckAt.After(checkedAt) {
		nextCheckAt = checkedAt.Add(2 * time.Minute)
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	var count int
	err = tx.QueryRowContext(ctx, `
		UPDATE price_watch_schedules
		SET consecutive_unavailable = consecutive_unavailable + 1,
			consecutive_errors = 0, last_error_code = 'item_unavailable',
			last_error_detail = NULLIF($3, ''), last_checked_at = $4,
			next_check_at = $5, lease_until = NULL, claim_token = NULL,
			updated_at = NOW()
		WHERE id = $1 AND claim_token = $2
		RETURNING consecutive_unavailable`, scheduleID, claimToken,
		boundedAlertDetail(reason), checkedAt.UTC(), nextCheckAt.UTC()).Scan(&count)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	stopped := count >= 3
	if stopped {
		if _, err := tx.ExecContext(ctx, `
			UPDATE price_watch_schedules SET availability = 'unavailable', updated_at = NOW()
			WHERE id = $1`, scheduleID); err != nil {
			return false, err
		}
		if _, err := tx.ExecContext(ctx, `
			UPDATE price_watches SET status = 'stopped', stopped_reason = 'item_unavailable',
				armed_at = NULL, updated_at = NOW()
			WHERE schedule_id = $1 AND status = 'active'`, scheduleID); err != nil {
			return false, err
		}
	}
	if err := tx.Commit(); err != nil {
		return false, err
	}
	return stopped, nil
}

func (s *Store) RecordPriceWatchError(ctx context.Context, scheduleID int64, claimToken string, checkedAt time.Time, nextCheckAt time.Time, code string, detail string) error {
	if checkedAt.IsZero() {
		checkedAt = time.Now().UTC()
	}
	if !nextCheckAt.After(checkedAt) {
		nextCheckAt = checkedAt.Add(time.Minute)
	}
	_, err := s.db.ExecContext(ctx, `
		UPDATE price_watch_schedules
		SET consecutive_errors = consecutive_errors + 1,
			consecutive_unavailable = 0, last_error_code = NULLIF($3, ''),
			last_error_detail = NULLIF($4, ''), last_checked_at = $5,
			next_check_at = $6, lease_until = NULL, claim_token = NULL,
			updated_at = NOW()
		WHERE id = $1 AND claim_token = $2`, scheduleID, claimToken,
		strings.TrimSpace(code), boundedAlertDetail(detail), checkedAt.UTC(), nextCheckAt.UTC())
	return err
}

func (s *Store) RecordPriceWatchCheck(ctx context.Context, sample PriceWatchCheckSample) error {
	if sample.ScheduleID <= 0 {
		return nil
	}
	if sample.CheckedAt.IsZero() {
		sample.CheckedAt = time.Now().UTC()
	}
	bucket := sample.CheckedAt.UTC().Truncate(time.Hour)
	success := int64(0)
	failure := int64(1)
	if sample.Success {
		success, failure = 1, 0
	}
	accessDenied, rateLimited, serverError := int64(0), int64(0), int64(0)
	if sample.StatusCode == 401 || sample.StatusCode == 403 {
		accessDenied = 1
	}
	if sample.StatusCode == 429 {
		rateLimited = 1
	}
	if sample.StatusCode >= 500 {
		serverError = 1
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO price_watch_check_hourly_stats (
			schedule_id, bucket_hour, check_count, successful_check_count,
			failed_check_count, access_denied_count, rate_limited_count,
			server_error_count, duration_total_ms, duration_sample_count,
			tx_bytes, rx_bytes, latest_status_code, latest_error_code, last_checked_at
		) VALUES ($1,$2,1,$3,$4,$5,$6,$7,$8,1,$9,$10,NULLIF($11,0),NULLIF($12,''),$13)
		ON CONFLICT (schedule_id, bucket_hour) DO UPDATE SET
			check_count = price_watch_check_hourly_stats.check_count + 1,
			successful_check_count = price_watch_check_hourly_stats.successful_check_count + EXCLUDED.successful_check_count,
			failed_check_count = price_watch_check_hourly_stats.failed_check_count + EXCLUDED.failed_check_count,
			access_denied_count = price_watch_check_hourly_stats.access_denied_count + EXCLUDED.access_denied_count,
			rate_limited_count = price_watch_check_hourly_stats.rate_limited_count + EXCLUDED.rate_limited_count,
			server_error_count = price_watch_check_hourly_stats.server_error_count + EXCLUDED.server_error_count,
			duration_total_ms = price_watch_check_hourly_stats.duration_total_ms + EXCLUDED.duration_total_ms,
			duration_sample_count = price_watch_check_hourly_stats.duration_sample_count + 1,
			tx_bytes = price_watch_check_hourly_stats.tx_bytes + EXCLUDED.tx_bytes,
			rx_bytes = price_watch_check_hourly_stats.rx_bytes + EXCLUDED.rx_bytes,
			latest_status_code = EXCLUDED.latest_status_code,
			latest_error_code = EXCLUDED.latest_error_code,
			last_checked_at = EXCLUDED.last_checked_at`,
		sample.ScheduleID, bucket, success, failure, accessDenied, rateLimited,
		serverError, sample.DurationMS, sample.TxBytes, sample.RxBytes,
		sample.StatusCode, strings.TrimSpace(sample.ErrorCode), sample.CheckedAt.UTC())
	return err
}

func (s *Store) PrunePriceWatchTelemetry(ctx context.Context, retentionDays int) error {
	if retentionDays < 30 {
		retentionDays = 30
	}
	_, err := s.db.ExecContext(ctx, `
		DELETE FROM price_watch_check_hourly_stats
		WHERE bucket_hour < NOW() - ($1::text || ' days')::interval`, retentionDays)
	return err
}
