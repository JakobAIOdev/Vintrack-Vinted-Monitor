package vinted

import (
	"encoding/json"
	"errors"
	"io"
	"net/url"
	"strings"
	"testing"

	"vintrack-vinted/internal/session"
)

func cardAutoPreferences() CheckoutPreferences {
	p := autoPreferences()
	p.Payment = "card"
	p.AutoCheckout.WarningVersion = 2
	return p
}

func cardAutoQuote(t *testing.T) map[string]interface{} {
	quote := autoQuote(t)
	payment := checkoutMap(quote, "checkout", "components", "payment_method")
	method := map[string]interface{}{"payment_method": "credit_card", "enabled": true}
	payment["pay_in_methods"] = []interface{}{method}
	payment["cards"] = []interface{}{map[string]interface{}{"id": "synthetic-card", "expired": false}}
	payment["selected_payment_method"] = map[string]interface{}{"pay_in_method": method, "credit_card": map[string]interface{}{"external_code": "synthetic-card", "expired": false}}
	return quote
}

func cardAutoResults(t *testing.T, quote map[string]interface{}) []fakeHTTPResult {
	results := autoResults(t, quote)
	build := cardAutoQuote(t)
	checkoutMap(build, "checkout", "components", "payment_method")["selected_payment_method"] = nil
	build["purchase"] = map[string]interface{}{"id": "synthetic-purchase"}
	body, _ := json.Marshal(build)
	results[1].body = string(body)
	return results
}

func TestCardAutoCheckoutStartsOnceAndResumesNativePayment(t *testing.T) {
	for _, tc := range []struct{ body, status string }{
		{`{"payment":{"status":"success"}}`, "card_payment_confirmed"},
		{`{"payment":{"status":"pending"}}`, "card_payment_pending"},
		{`{"payment":{"status":"failure"}}`, "card_payment_failed"},
		{`{"payment":{"status":"success"},"action":{"type":"native_adyen_payment_3ds","parameters":{"token":"synthetic-secret"}}}`, "card_authentication_required"},
		{`{"action":{"type":"payrails_cvv_resubmission"}}`, "card_authentication_required"},
		{`{"action":{"type":"redirect","parameters":{"url":"https://evil.test/secret"}}}`, "card_authentication_required"},
		{`{"payment":{"status":"unrecognized"}}`, "payment_outcome_unknown"},
		{`{"payment":{"status":"success"},"errors":[]}`, "payment_outcome_unknown"},
		{`{"payment":{"status":"success"},"action":{}}`, "payment_outcome_unknown"},
	} {
		t.Run(tc.status+tc.body, func(t *testing.T) {
			client, transport := testClient(append(cardAutoResults(t, cardAutoQuote(t)), fakeHTTPResult{status: 200, body: tc.body})...)
			client.session.Domain = "www.vinted.fr"
			var checkpoints []session.CheckoutLink
			link, err := client.PrepareCheckout(123, 456, func(link session.CheckoutLink) error { checkpoints = append(checkpoints, link); return nil }, cardAutoPreferences())
			if err != nil || link.Status != tc.status || len(transport.requests) != 4 || link.PaymentURL != "" {
				t.Fatalf("unexpected card outcome: %#v %v", link, err)
			}
			resume, _ := url.Parse(link.CheckoutURL)
			if resume.Host != "www.vinted.fr" || resume.Path != "/checkout" || resume.Query().Get("after_payment_redirect") != "true" {
				t.Fatal("native payment resume missing")
			}
			encoded, _ := json.Marshal(checkpoints)
			if strings.Contains(string(encoded), "synthetic-secret") || strings.Contains(string(encoded), "evil.test") {
				t.Fatal("bank action data persisted")
			}
			body, _ := io.ReadAll(transport.requests[2].Body)
			var payload map[string]interface{}
			_ = json.Unmarshal(body, &payload)
			if firstStringPath(payload, []string{"components", "payment_method", "card_id"}) != "synthetic-card" {
				t.Fatal("native saved-card reference not selected")
			}
		})
	}
}

func TestCardAutoCheckoutRequiresNewConsentAndSafeFinalSelection(t *testing.T) {
	for _, version := range []int{0, 1, 3} {
		p := cardAutoPreferences()
		p.AutoCheckout.WarningVersion = version
		client, transport := testClient()
		client.session.Domain = "www.vinted.de"
		if _, err := client.PrepareCheckout(123, 456, func(session.CheckoutLink) error { return nil }, p); err == nil || len(transport.requests) != 0 {
			t.Fatal("card accepted PayPal or missing warning")
		}
	}
	for name, change := range map[string]func(map[string]interface{}){
		"wallet": func(q map[string]interface{}) {
			checkoutMap(q, "checkout", "components", "order_summary_v2")["deductions"] = []interface{}{map[string]interface{}{"type": "order-summary-wallet-deduction", "price": map[string]interface{}{"amount": "1.00", "currency_code": "EUR"}}}
		},
		"limit": func(q map[string]interface{}) {
			checkoutMap(q, "checkout", "components", "pay_button_v2", "total", "price")["amount"] = "30.01"
		},
		"currency": func(q map[string]interface{}) {
			checkoutMap(q, "checkout", "components", "pay_button_v2", "total", "price")["currency_code"] = "PLN"
		},
		"expired list entry": func(q map[string]interface{}) {
			checkoutMap(q, "checkout", "components", "payment_method")["cards"] = []interface{}{map[string]interface{}{"id": "synthetic-card", "expired": true}}
		},
		"fractional card id": func(q map[string]interface{}) {
			checkoutMap(q, "checkout", "components", "payment_method", "selected_payment_method", "credit_card")["external_code"] = 55.5
		},
		"missing card": func(q map[string]interface{}) {
			delete(checkoutMap(q, "checkout", "components", "payment_method", "selected_payment_method"), "credit_card")
		},
		"expired": func(q map[string]interface{}) {
			checkoutMap(q, "checkout", "components", "payment_method", "selected_payment_method", "credit_card")["expired"] = true
		},
		"card changed": func(q map[string]interface{}) {
			checkoutMap(q, "checkout", "components", "payment_method", "selected_payment_method", "credit_card")["external_code"] = "different-card"
		},
		"disabled": func(q map[string]interface{}) {
			checkoutMap(q, "checkout", "components", "payment_method")["pay_in_methods"] = []interface{}{map[string]interface{}{"payment_method": "credit_card", "enabled": false}}
		},
		"signals required": func(q map[string]interface{}) { checkoutMap(q, "checkout")["adyen_protect_signals_enabled"] = true },
	} {
		t.Run(name, func(t *testing.T) {
			quote := cardAutoQuote(t)
			change(quote)
			client, transport := testClient(cardAutoResults(t, quote)...)
			client.session.Domain = "www.vinted.de"
			link, err := client.PrepareCheckout(123, 456, func(session.CheckoutLink) error { return nil }, cardAutoPreferences())
			if err != nil || link.Status != "checkout_review_required" || len(transport.requests) != 3 {
				t.Fatalf("unsafe card payment: %#v %v", link, err)
			}
		})
	}
}

func TestCardPaymentNetworkFailureNeverRetriesOrReportsSuccess(t *testing.T) {
	client, transport := testClient(append(cardAutoResults(t, cardAutoQuote(t)), fakeHTTPResult{err: errors.New("response lost")})...)
	client.session.Domain = "www.vinted.de"
	link, err := client.PrepareCheckout(123, 456, func(session.CheckoutLink) error { return nil }, cardAutoPreferences())
	if err != nil || link.Status != "payment_outcome_unknown" || len(transport.requests) != 4 {
		t.Fatalf("unsafe card retry: %#v %v", link, err)
	}
}
