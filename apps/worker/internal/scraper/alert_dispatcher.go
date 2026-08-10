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
	for {
		select {
		case <-e.jobsCtx.Done():
			return
		case delivery := <-e.claimedAlertDeliveries:
			if err := e.processAlertDelivery(e.jobsCtx, delivery); err != nil {
				log.Printf("alert dispatcher delivery %d: %v", delivery.ID, err)
			}
			select {
			case e.alertDeliveryWake <- struct{}{}:
			default:
			}
		}
	}
}

func (e *Engine) alertDeliveryCoordinator() {
	defer e.jobsWG.Done()
	fallback := time.NewTicker(2 * time.Second)
	defer fallback.Stop()
	wake := true
	for {
		if wake {
			wake = false
			for available := cap(e.claimedAlertDeliveries) - len(e.claimedAlertDeliveries); available > 0; available = cap(e.claimedAlertDeliveries) - len(e.claimedAlertDeliveries) {
				batchSize := min(available, 32)
				claimToken, err := newAlertClaimToken()
				if err != nil {
					log.Printf("alert claim token: %v", err)
					break
				}
				claimCtx, cancel := context.WithTimeout(e.jobsCtx, 2*time.Second)
				deliveries, err := e.db.ClaimAlertDeliveries(claimCtx, claimToken, batchSize)
				cancel()
				if err != nil {
					log.Printf("alert batch claim: %v", err)
					break
				}
				for _, delivery := range deliveries {
					select {
					case e.claimedAlertDeliveries <- delivery:
					case <-e.jobsCtx.Done():
						return
					}
				}
				if len(deliveries) < batchSize {
					break
				}
			}
		}
		select {
		case <-e.jobsCtx.Done():
			return
		case <-e.alertDeliveryWake:
			wake = true
		case <-fallback.C:
			wake = true
		}
	}
}

func (e *Engine) alertDeliveryLeaseRecovery() {
	defer e.jobsWG.Done()
	e.runAlertMaintenance(10*time.Second, "recover alert delivery leases", func(ctx context.Context) error {
		_, err := e.db.RecoverExpiredAlertDeliveryLeases(ctx)
		return err
	})
}

func (e *Engine) alertDeliveryExpiry() {
	defer e.jobsWG.Done()
	e.runAlertMaintenance(15*time.Second, "expire alert deliveries", e.db.ExpireAlertDeliveries)
}

func (e *Engine) alertDeliveryHeartbeat() {
	defer e.jobsWG.Done()
	e.runAlertMaintenance(10*time.Second, "alert dispatcher heartbeat", func(ctx context.Context) error {
		return e.db.SetSettingValueContext(ctx, "alert_dispatcher_heartbeat", time.Now().UTC().Format(time.RFC3339Nano))
	})
}

func (e *Engine) runAlertMaintenance(interval time.Duration, label string, run func(context.Context) error) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		ctx, cancel := context.WithTimeout(e.jobsCtx, 3*time.Second)
		err := run(ctx)
		cancel()
		if err != nil {
			log.Printf("%s: %v", label, err)
		}
		select {
		case <-e.jobsCtx.Done():
			return
		case <-ticker.C:
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
	return true, e.processAlertDelivery(ctx, *delivery)
}

func (e *Engine) processAlertDelivery(ctx context.Context, delivery model.AlertDelivery) error {
	if !delivery.NotificationsEnabled || !delivery.ChannelEnabled {
		_, err := e.db.CancelAlertDelivery(ctx, delivery, "notifications_disabled", "notification target is disabled")
		return err
	}
	if delivery.Destination == "" {
		_, err := e.db.CancelAlertDelivery(ctx, delivery, "invalid_destination", "notification target is missing")
		return err
	}
	if delivery.CurrentFingerprint != delivery.DestinationFingerprint {
		_, err := e.db.CancelAlertDelivery(ctx, delivery, "destination_changed", "notification target changed after enqueue")
		return err
	}
	if time.Now().After(delivery.ExpiresAt) {
		_, err := e.db.FailAlertDelivery(ctx, delivery, "expired", "delivery expired before provider accepted it")
		return err
	}

	attemptTimeout := 10 * time.Second
	if delivery.Channel == "telegram" {
		attemptTimeout = 25 * time.Second
	}
	attemptCtx, cancelAttempt := context.WithTimeout(ctx, attemptTimeout)
	result := sendAlertDeliveryAttempt(attemptCtx, delivery)
	cancelAttempt()
	if result.Success {
		completed, err := e.db.CompleteAlertDelivery(ctx, delivery)
		if err == nil && completed && result.RetryAfter > 0 {
			until := time.Now().Add(result.RetryAfter + alertRetryJitter(delivery))
			_ = e.db.DeferAlertDestination(ctx, delivery.Channel, delivery.DestinationFingerprint, until, false)
		}
		return err
	}

	if result.Retryable && delivery.AttemptCount < maximumAlertDeliveryAttempts {
		delay := result.RetryAfter
		if delay <= 0 {
			delay = alertExponentialBackoff(delivery.AttemptCount)
		}
		nextAttempt := time.Now().Add(delay + alertRetryJitter(delivery))
		if nextAttempt.Before(delivery.ExpiresAt) {
			if result.GlobalRateLimit {
				_ = e.db.DeferAlertDestination(ctx, delivery.Channel, delivery.DestinationFingerprint, nextAttempt, true)
			}
			_, err := e.db.RetryAlertDelivery(ctx, delivery, result.ReasonCode, result.Detail, nextAttempt)
			return err
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
	_, err := e.db.FailAlertDelivery(ctx, delivery, reason, detail)
	return err
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
