package telegram

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"sync/atomic"
	"testing"
	"time"

	"vintrack-worker/internal/model"
)

func TestAcceptedTelegramRequestIsNotRetriedOrReplacedWhenResponseIsLost(t *testing.T) {
	item := model.Item{
		ID: 123, MonitorID: 17, Title: "Camera", Price: "12 EUR",
		URL: "https://example.test/items/123", ImageURL: "https://example.test/image.jpg",
	}
	for _, test := range []struct {
		name string
		send func(context.Context) model.AlertDeliveryResult
	}{
		{name: "item photo", send: func(ctx context.Context) model.AlertDeliveryResult {
			return SendItemAttempt(ctx, "1", item, "monitor", "free", model.NotificationMessageStyleRich)
		}},
		{name: "compact item", send: func(ctx context.Context) model.AlertDeliveryResult {
			return SendItemAttempt(ctx, "1", item, "monitor", "free", model.NotificationMessageStyleCompact)
		}},
		{name: "price drop photo", send: func(ctx context.Context) model.AlertDeliveryResult {
			return SendPriceDropAttempt(ctx, "1", model.PriceDropAlert{
				ItemID: 123, Title: "Camera", URL: item.URL, ImageURL: item.ImageURL,
			}, model.NotificationMessageStyleRich)
		}},
		{name: "status", send: func(ctx context.Context) model.AlertDeliveryResult {
			return SendStatusAttempt(ctx, "1", "Status", "Monitor status")
		}},
	} {
		for _, failure := range []string{"timeout", "connection closed"} {
			t.Run(test.name+"/"+failure, func(t *testing.T) {
				var accepted atomic.Int32
				release := make(chan struct{})
				defer close(release)
				withTelegramServer(t, func(w http.ResponseWriter, r *http.Request) {
					_, _ = io.Copy(io.Discard, r.Body)
					accepted.Add(1)
					if failure == "timeout" {
						<-release
						return
					}
					conn, _, err := w.(http.Hijacker).Hijack()
					if err != nil {
						t.Error(err)
						return
					}
					_ = conn.Close()
				})
				httpClient.Timeout = 100 * time.Millisecond
				result := test.send(context.Background())
				if result.Success || result.Retryable || result.ReasonCode != "delivery_unknown" {
					t.Fatalf("accepted request must finish as unconfirmed without retry: %#v", result)
				}
				if got := accepted.Load(); got != 1 {
					t.Fatalf("accepted %d messages, want exactly one without photo fallback", got)
				}
			})
		}
	}
}

func TestTelegramConnectionFailureBeforeSendingRemainsRetryable(t *testing.T) {
	for _, test := range []struct {
		name   string
		cause  error
		reason string
	}{
		{name: "dial error", cause: errors.New("connection refused"), reason: "network_error"},
		{name: "dial timeout", cause: context.DeadlineExceeded, reason: "network_timeout"},
	} {
		t.Run(test.name, func(t *testing.T) {
			withTelegramServer(t, func(http.ResponseWriter, *http.Request) {
				t.Error("request must not reach the server")
			})
			httpClient.Transport = &http.Transport{
				DialContext: func(context.Context, string, string) (net.Conn, error) {
					return nil, &net.OpError{Op: "dial", Net: "tcp", Err: test.cause}
				},
			}
			result := sendAttempt(context.Background(), "sendMessage", map[string]interface{}{
				"chat_id": "1", "text": "test",
			})
			if result.Success || !result.Retryable || result.ReasonCode != test.reason {
				t.Fatalf("unsent request must remain retryable: %#v", result)
			}
		})
	}
}
