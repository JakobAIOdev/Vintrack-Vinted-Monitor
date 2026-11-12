package scraper

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"vintrack-worker/internal/model"
)

// A watch that ended is announced as a title-and-text notification. The
// dispatcher must hand it to the provider instead of treating it as an item
// match or a price drop.
func TestPriceWatchStoppedNoticeIsDeliveredToDiscord(t *testing.T) {
	var received struct {
		Embeds []struct {
			Title       string `json:"title"`
			Description string `json:"description"`
		} `json:"embeds"`
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(io.LimitReader(r.Body, 64*1024))
		if err := json.Unmarshal(body, &received); err != nil {
			t.Errorf("decode webhook body: %v", err)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	message := "“Wool coat” was sold or is no longer for sale, so Vintrack stopped watching it.\n" +
		"Last price: 15.00 EUR\nhttps://www.vinted.de/items/300-wool-coat"
	result := sendAlertDeliveryAttempt(context.Background(), model.AlertDelivery{
		Kind:        "price_watch_stopped",
		Channel:     "discord",
		Destination: server.URL,
		Payload: model.AlertNotificationPayload{
			Version: 1, Kind: "price_watch_stopped",
			Title: "Price Watch ended: listing sold", Message: message, Region: "de",
		},
	})
	if !result.Success {
		t.Fatalf("delivery failed: %+v", result)
	}
	if len(received.Embeds) != 1 || received.Embeds[0].Title != "Price Watch ended: listing sold" || received.Embeds[0].Description != message {
		t.Fatalf("unexpected webhook payload: %+v", received)
	}
}
