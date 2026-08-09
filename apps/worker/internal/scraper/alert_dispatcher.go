package scraper

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"log"
	"time"

	"vintrack-worker/internal/discord"
	"vintrack-worker/internal/model"
	"vintrack-worker/internal/telegram"
)

const maximumAlertDeliveryAttempts = 8

func (e *Engine) alertDeliveryListener() {
	defer e.jobsWG.Done()
	e.db.ListenForAlertDeliveries(e.jobsCtx, e.alertDeliveryWake)
}

func (e *Engine) alertDeliveryWorker() {
	defer e.jobsWG.Done()
	fallback := time.NewTicker(2 * time.Second)
	defer fallback.Stop()
	for {
		delivered, err := e.processNextAlertDelivery(e.jobsCtx)
		if err != nil {
			log.Printf("alert dispatcher: %v", err)
		}
		if delivered {
			continue
		}
		select {
		case <-e.jobsCtx.Done():
			return
		case <-e.alertDeliveryWake:
		case <-fallback.C:
		}
	}
}

func (e *Engine) alertDeliveryMaintenance() {
	defer e.jobsWG.Done()
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	run := func() {
		ctx, cancel := context.WithTimeout(e.jobsCtx, 5*time.Second)
		defer cancel()
		if err := e.db.ExpireAlertDeliveries(ctx); err != nil {
			log.Printf("expire alert deliveries: %v", err)
		}
		_ = e.db.SetSettingValueContext(ctx, "alert_dispatcher_heartbeat", time.Now().UTC().Format(time.RFC3339Nano))
	}
	run()
	for {
		select {
		case <-e.jobsCtx.Done():
			return
		case <-ticker.C:
			run()
		}
	}
}

func (e *Engine) processNextAlertDelivery(ctx context.Context) (bool, error) {
	claimToken, err := newAlertClaimToken()
	if err != nil {
		return false, err
	}
	claimCtx, cancelClaim := context.WithTimeout(ctx, 5*time.Second)
	delivery, err := e.db.ClaimAlertDelivery(claimCtx, claimToken)
	cancelClaim()
	if err != nil || delivery == nil {
		return false, err
	}

	if !delivery.NotificationsEnabled || !delivery.ChannelEnabled {
		_, err := e.db.CancelAlertDelivery(ctx, *delivery, "notifications_disabled", "notification target is disabled")
		return true, err
	}
	if delivery.Destination == "" {
		_, err := e.db.CancelAlertDelivery(ctx, *delivery, "invalid_destination", "notification target is missing")
		return true, err
	}
	if delivery.CurrentFingerprint != delivery.DestinationFingerprint {
		_, err := e.db.CancelAlertDelivery(ctx, *delivery, "destination_changed", "notification target changed after enqueue")
		return true, err
	}
	if time.Now().After(delivery.ExpiresAt) {
		_, err := e.db.FailAlertDelivery(ctx, *delivery, "expired", "delivery expired before provider accepted it")
		return true, err
	}

	attemptTimeout := 10 * time.Second
	if delivery.Channel == "telegram" {
		attemptTimeout = 25 * time.Second
	}
	attemptCtx, cancelAttempt := context.WithTimeout(ctx, attemptTimeout)
	result := sendAlertDeliveryAttempt(attemptCtx, *delivery)
	cancelAttempt()
	if result.Success {
		completed, err := e.db.CompleteAlertDelivery(ctx, *delivery)
		if err == nil && completed && result.RetryAfter > 0 {
			until := time.Now().Add(result.RetryAfter + alertRetryJitter(*delivery))
			_ = e.db.DeferAlertDestination(ctx, delivery.Channel, delivery.DestinationFingerprint, until, false)
		}
		return true, err
	}

	if result.Retryable && delivery.AttemptCount < maximumAlertDeliveryAttempts {
		delay := result.RetryAfter
		if delay <= 0 {
			delay = alertExponentialBackoff(delivery.AttemptCount)
		}
		nextAttempt := time.Now().Add(delay + alertRetryJitter(*delivery))
		if nextAttempt.Before(delivery.ExpiresAt) {
			if result.GlobalRateLimit {
				_ = e.db.DeferAlertDestination(ctx, delivery.Channel, delivery.DestinationFingerprint, nextAttempt, true)
			}
			_, err := e.db.RetryAlertDelivery(ctx, *delivery, result.ReasonCode, result.Detail, nextAttempt)
			return true, err
		}
	}

	reason := result.ReasonCode
	if reason == "" {
		reason = "provider_rejected"
	}
	detail := result.Detail
	if result.Retryable && delivery.AttemptCount >= maximumAlertDeliveryAttempts {
		detail = "maximum delivery attempts reached: " + detail
	}
	_, err = e.db.FailAlertDelivery(ctx, *delivery, reason, detail)
	return true, err
}

func sendAlertDeliveryAttempt(ctx context.Context, delivery model.AlertDelivery) model.AlertDeliveryResult {
	payload := delivery.Payload
	if payload.Item != nil {
		if delivery.Channel == "discord" {
			return discord.SendWebhookAttempt(ctx, delivery.Destination, *payload.Item, payload.MonitorName, payload.ProxySource, payload.DiscordStyle)
		}
		return telegram.SendItemAttempt(ctx, delivery.Destination, *payload.Item, payload.MonitorName, payload.ProxySource, payload.TelegramStyle)
	}
	if delivery.Channel == "discord" {
		return discord.SendStatusAttempt(ctx, delivery.Destination, payload.Title, payload.Message)
	}
	return telegram.SendStatusAttempt(ctx, delivery.Destination, payload.Title, payload.Message)
}

func alertExponentialBackoff(attempt int) time.Duration {
	if attempt < 1 {
		attempt = 1
	}
	if attempt > 6 {
		attempt = 6
	}
	return time.Duration(1<<(attempt-1)) * time.Second
}

func alertRetryJitter(delivery model.AlertDelivery) time.Duration {
	value := (delivery.ID + int64(delivery.AttemptCount*53)) % 401
	return time.Duration(100+value) * time.Millisecond
}

func newAlertClaimToken() (string, error) {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return hex.EncodeToString(value), nil
}
