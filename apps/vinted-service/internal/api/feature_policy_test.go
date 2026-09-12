package api

import "testing"

func TestFeatureForPath(t *testing.T) {
	tests := map[string]string{
		"/api/account/status":       "vinted_account",
		"/api/account/unlink":       "",
		"/api/items/liked":          "liked_items",
		"/api/items/wardrobe":       "your_listings",
		"/api/messages/inbox":       "chats",
		"/api/offers/send":          "offers",
		"/api/items/buy":            "checkout_links",
		"/api/items/checkout-links": "checkout_links",
		"/api/catalog/brands":       "",
	}
	for path, expected := range tests {
		if actual := featureForPath(path); actual != expected {
			t.Errorf("featureForPath(%q) = %q, want %q", path, actual, expected)
		}
	}
}
