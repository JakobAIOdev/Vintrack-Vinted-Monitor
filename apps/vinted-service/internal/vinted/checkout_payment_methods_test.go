package vinted

import (
	"encoding/json"
	"io"
	"testing"

	"vintrack-vinted/internal/session"
)

func paymentCheckout(t *testing.T, methods []map[string]interface{}, selected map[string]interface{}, cards []map[string]interface{}) string {
	t.Helper()
	var raw map[string]interface{}
	if err := json.Unmarshal([]byte(nativeHomeCheckout), &raw); err != nil {
		t.Fatal(err)
	}
	payment := checkoutMap(raw, "checkout", "components", "payment_method")
	payment["pay_in_methods"] = methods
	payment["selected_payment_method"] = selected
	payment["cards"] = cards
	raw["purchase"] = map[string]string{"id": "synthetic-purchase"}
	body, _ := json.Marshal(raw)
	return string(body)
}

func TestPrepareCheckoutUsesOfferedProviderValuesAndStopsBeforePayment(t *testing.T) {
	for _, provider := range []string{"google_pay", "klarna", "tink", "bancontact", "ideal", "blik", "przelewy24", "card"} {
		t.Run(provider, func(t *testing.T) {
			native := provider
			code := provider
			var cards []map[string]interface{}
			if provider == "card" {
				native = "credit_card"
				cards = []map[string]interface{}{{"id": 55}}
			}
			if provider == "bancontact" {
				native = "provider_bancontact"
			}
			method := map[string]interface{}{"code": code, "payment_method": native}
			selected := map[string]interface{}{"pay_in_method": method}
			if provider == "card" {
				selected["card_id"] = 55
			}
			results := checkoutResults()
			results[1].body = paymentCheckout(t, []map[string]interface{}{method}, nil, cards)
			results[2].body = paymentCheckout(t, []map[string]interface{}{method}, selected, cards)
			client, transport := testClient(results...)
			link, err := client.PrepareCheckout(123, 456, func(session.CheckoutLink) error { return nil }, CheckoutPreferences{Shipping: "home", Payment: provider})
			if err != nil || link.Status != "checkout_prepared" || len(transport.requests) != 3 {
				t.Fatalf("provider not selected: %#v %v", link, err)
			}
			for _, req := range transport.requests {
				if req.URL.Path == "/api/v2/purchases/synthetic-purchase/checkout/payment" {
					t.Fatal("payment initiated")
				}
			}
			body, _ := io.ReadAll(transport.requests[2].Body)
			var payload map[string]interface{}
			_ = json.Unmarshal(body, &payload)
			if firstStringPath(payload, []string{"components", "payment_method", "payment_method"}) != native {
				t.Fatal("did not use offered native value")
			}
			if provider == "card" && firstInt64Path(payload, []string{"components", "payment_method", "card_id"}) != 55 {
				t.Fatal("saved card missing")
			}
		})
	}
}

func TestPrepareCheckoutDoesNotSubstituteUnavailableOrAmbiguousPayment(t *testing.T) {
	for _, scenario := range []struct {
		name, preference string
		methods, cards   []map[string]interface{}
	}{
		{name: "unavailable", preference: "google_pay", methods: []map[string]interface{}{{"code": "MANGOPAY_PAYPAL"}}},
		{name: "read-only", preference: "google_pay", methods: []map[string]interface{}{{"payment_method": "google_pay", "read_only": true}}},
		{name: "missing card", preference: "card", methods: []map[string]interface{}{{"payment_method": "card"}}},
		{name: "ambiguous cards", preference: "card", methods: []map[string]interface{}{{"payment_method": "card"}}, cards: []map[string]interface{}{{"id": 55}, {"id": 56}}},
		{name: "ambiguous provider", preference: "klarna", methods: []map[string]interface{}{{"code": "KLARNA", "payment_method": "klarna_now"}, {"code": "KLARNA", "payment_method": "klarna_later"}}},
		{name: "unsafe method", preference: "ideal", methods: []map[string]interface{}{{"code": "IDEAL", "payment_method": "https://evil.test"}}},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			results := checkoutResults()
			results[1].body = paymentCheckout(t, scenario.methods, nil, scenario.cards)
			results[2].body = results[1].body
			client, transport := testClient(results...)
			link, err := client.PrepareCheckout(123, 456, func(session.CheckoutLink) error { return nil }, CheckoutPreferences{Shipping: "home", Payment: scenario.preference})
			if err != nil || link.Status != "checkout_review_required" || len(transport.requests) != 3 {
				t.Fatalf("unexpected provider fallback: %#v %v", link, err)
			}
			body, _ := io.ReadAll(transport.requests[2].Body)
			var payload map[string]interface{}
			_ = json.Unmarshal(body, &payload)
			if len(checkoutMap(payload, "components", "payment_method")) != 0 {
				t.Fatal("unavailable method selected")
			}
		})
	}
}
