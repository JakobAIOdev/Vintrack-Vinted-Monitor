package vinted

import (
	"encoding/json"
	"errors"
	"io"
	"strings"
	"testing"

	"vintrack-vinted/internal/session"
)

func autoPreferences() CheckoutPreferences {
	return CheckoutPreferences{Shipping: "home", Payment: "paypal", AutoCheckout: &AutoCheckoutPreference{WarningVersion: 1, MaxTotalMinor: 3000, Currency: "EUR"}}
}

func autoQuote(t *testing.T) map[string]interface{} {
	t.Helper()
	var raw map[string]interface{}
	_ = json.Unmarshal([]byte(nativeHomeCheckout), &raw)
	raw["checksum"] = "synthetic-current-checksum"
	c := checkoutMap(raw, "checkout", "components")
	checkoutMap(c, "payment_method")["selected_payment_method"] = map[string]interface{}{"pay_in_method": map[string]interface{}{"payment_method": "paypal"}}
	checkoutMap(c, "pay_button_v2")["total"] = map[string]interface{}{"price": map[string]interface{}{"amount": "18.29", "currency_code": "EUR"}}
	c["order_summary_v2"] = map[string]interface{}{"deductions": []interface{}{}}
	return raw
}

func autoResults(t *testing.T, quote map[string]interface{}) []fakeHTTPResult {
	t.Helper()
	results := checkoutResults()
	results[1].body = strings.TrimSuffix(nativeHomeCheckout, "}") + `,"purchase":{"id":"synthetic-purchase"}}`
	body, _ := json.Marshal(quote)
	results[2].body = string(body)
	return results
}

func TestAutoCheckoutStartsPayPalOnceAndDoesNotPersistRedirect(t *testing.T) {
	results := append(autoResults(t, autoQuote(t)), fakeHTTPResult{status: 200, body: `{"payment":{"status":"pending"},"action":{"type":"redirect","parameters":{"url":"https://www.paypal.com/checkoutnow?token=synthetic"}}}`})
	client, transport := testClient(results...)
	client.session.Domain = "www.vinted.de"
	var checkpoints []session.CheckoutLink
	link, err := client.PrepareCheckout(123, 456, func(link session.CheckoutLink) error { checkpoints = append(checkpoints, link); return nil }, autoPreferences())
	if err != nil || link.Status != "paypal_redirect_ready" || !validPayPalPaymentURL(link.PaymentURL) || len(transport.requests) != 4 {
		t.Fatalf("PayPal not started: %#v %v", link, err)
	}
	if checkpoints[len(checkpoints)-2].Status != "payment_starting" {
		t.Fatal("payment intent missing")
	}
	for _, checkpoint := range checkpoints {
		if checkpoint.PaymentURL != "" {
			t.Fatal("payment token persisted")
		}
	}
	body, _ := io.ReadAll(transport.requests[3].Body)
	var payload map[string]interface{}
	_ = json.Unmarshal(body, &payload)
	if payload["checksum"] != "synthetic-current-checksum" {
		t.Fatal("stale checksum used")
	}
}

func TestAutoCheckoutUnsafeQuotesNeverStartPayment(t *testing.T) {
	cases := map[string]func(map[string]interface{}){
		"wallet": func(raw map[string]interface{}) {
			checkoutMap(raw, "checkout", "components", "order_summary_v2")["deductions"] = []interface{}{map[string]interface{}{"type": "order-summary-wallet-deduction", "price": map[string]interface{}{"amount": "1.00", "currency_code": "EUR"}}}
		},
		"unknown deductions": func(raw map[string]interface{}) {
			delete(checkoutMap(raw, "checkout", "components", "order_summary_v2"), "deductions")
		},
		"unknown prices": func(raw map[string]interface{}) {
			delete(checkoutMap(raw, "checkout", "components", "pay_button_v2"), "total")
		},
		"zero": func(raw map[string]interface{}) {
			checkoutMap(raw, "checkout", "components", "pay_button_v2", "total", "price")["amount"] = "0"
		},
		"over limit": func(raw map[string]interface{}) {
			checkoutMap(raw, "checkout", "components", "pay_button_v2", "total", "price")["amount"] = "30.01"
		},
		"fractional precision": func(raw map[string]interface{}) {
			checkoutMap(raw, "checkout", "components", "pay_button_v2", "total", "price")["amount"] = "18.291"
		},
		"currency": func(raw map[string]interface{}) {
			checkoutMap(raw, "checkout", "components", "pay_button_v2", "total", "price")["currency_code"] = "USD"
		},
		"currency conversion": func(raw map[string]interface{}) {
			checkoutMap(raw, "checkout", "components", "order_summary_v2")["currency_conversion"] = map[string]interface{}{}
		},
		"checksum": func(raw map[string]interface{}) { delete(raw, "checksum") },
		"wrong payment": func(raw map[string]interface{}) {
			checkoutMap(raw, "checkout", "components", "payment_method", "selected_payment_method", "pay_in_method")["payment_method"] = "card"
		},
		"disabled": func(raw map[string]interface{}) {
			checkoutMap(raw, "checkout", "components", "payment_method")["pay_in_methods"] = []interface{}{map[string]interface{}{"payment_method": "paypal", "enabled": false}}
		},
	}
	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			quote := autoQuote(t)
			change(quote)
			client, transport := testClient(autoResults(t, quote)...)
			client.session.Domain = "www.vinted.de"
			link, err := client.PrepareCheckout(123, 456, func(session.CheckoutLink) error { return nil }, autoPreferences())
			if err != nil || link.Status != "checkout_review_required" || len(transport.requests) != 3 {
				t.Fatalf("unsafe payment: %#v %v", link, err)
			}
		})
	}
}

func TestAutoCheckoutUnknownPaymentOutcomesAreNotRetried(t *testing.T) {
	for _, result := range []fakeHTTPResult{
		{status: 401, body: `{"error":"synthetic"}`},
		{err: errors.New("connection lost")},
		{status: 200, body: `{"payment":{"status":"success"}}`},
		{status: 200, body: `{"action":{"type":"redirect","parameters":{"url":"https://www.paypal.com.evil.test/checkoutnow"}}}`},
	} {
		client, transport := testClient(append(autoResults(t, autoQuote(t)), result)...)
		client.session.Domain = "www.vinted.de"
		link, err := client.PrepareCheckout(123, 456, func(session.CheckoutLink) error { return nil }, autoPreferences())
		if err != nil || link.Status != "payment_outcome_unknown" || link.PaymentURL != "" || len(transport.requests) != 4 {
			t.Fatalf("unsafe retry/outcome: %#v %v", link, err)
		}
	}
}

func TestAutoCheckoutCheckpointFailureAndUnsupportedRegionPreventPayment(t *testing.T) {
	client, transport := testClient(autoResults(t, autoQuote(t))...)
	client.session.Domain = "www.vinted.de"
	_, err := client.PrepareCheckout(123, 456, func(link session.CheckoutLink) error {
		if link.Status == "payment_starting" {
			return errors.New("storage lost")
		}
		return nil
	}, autoPreferences())
	if err == nil || len(transport.requests) != 3 {
		t.Fatal("payment sent without checkpoint")
	}
	client, transport = testClient()
	_, err = client.PrepareCheckout(123, 456, func(session.CheckoutLink) error { return nil }, autoPreferences())
	if err == nil || len(transport.requests) != 0 {
		t.Fatal("unsupported region accepted")
	}
}
