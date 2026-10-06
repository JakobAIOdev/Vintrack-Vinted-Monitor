package scraper

import (
	"testing"
	"vintrack-worker/internal/model"
)

func TestCheckoutAlertLinkRequiresCurrentEligibilityAndDoesNotTrustSnapshot(t *testing.T) {
	t.Setenv("DASHBOARD_URL", "https://dashboard.example.test")
	item := &model.Item{ID: 123, MonitorID: 17, CheckoutStartURL: "https://untrusted.test/checkout"}
	delivery := model.AlertDelivery{MonitorID: 17, Payload: model.AlertNotificationPayload{Item: item}}
	if got := checkoutAlertItem(delivery).CheckoutStartURL; got != "" {
		t.Fatalf("unlinked member got checkout URL: %q", got)
	}
	delivery.CheckoutEnabled = true
	if got := checkoutAlertItem(delivery).CheckoutStartURL; got != "https://dashboard.example.test/checkout/17/123" {
		t.Fatalf("unexpected handoff URL: %q", got)
	}
	if item.CheckoutStartURL != "https://untrusted.test/checkout" {
		t.Fatal("outbox snapshot was mutated")
	}
}
