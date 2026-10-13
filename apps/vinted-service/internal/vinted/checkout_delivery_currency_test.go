package vinted

import (
	"encoding/json"
	"io"
	"strings"
	"testing"

	"vintrack-vinted/internal/session"
)

func savedPickupQuote(t *testing.T) map[string]interface{} {
	q := autoQuote(t)
	c := checkoutMap(q, "checkout", "components")
	c["shipping_pickup_options"] = map[string]interface{}{"selected_pickup_option": 2}
	c["shipping_pickup_details"] = map[string]interface{}{"pickup_details": map[string]interface{}{
		"selected_rate_uuid": "synthetic-rate",
		"shipping_option":    map[string]interface{}{"rate_uuid": "synthetic-rate"},
		"shipping_point":     map[string]interface{}{"uuid": "synthetic-point", "code": "synthetic-code", "rate_uuid": "synthetic-rate"},
	}}
	return q
}

func checkoutJSON(q map[string]interface{}) string {
	body, _ := json.Marshal(q)
	return string(body)
}

func TestGBPAutoCheckoutUsesExplicitLimitCurrency(t *testing.T) {
	for name, change := range map[string]func(map[string]interface{}, *CheckoutPreferences){
		"within GBP limit": func(map[string]interface{}, *CheckoutPreferences) {},
		"over GBP limit":   func(q map[string]interface{}, p *CheckoutPreferences) { p.AutoCheckout.MaxTotalMinor = 1828 },
		"old EUR opt-in":   func(q map[string]interface{}, p *CheckoutPreferences) { p.AutoCheckout.Currency = "EUR" },
		"GBP opt-in EUR quote": func(q map[string]interface{}, p *CheckoutPreferences) {
			checkoutMap(q, "checkout", "components", "pay_button_v2", "total", "price")["currency_code"] = "EUR"
		},
		"mixed wallet currency": func(q map[string]interface{}, p *CheckoutPreferences) {
			checkoutMap(q, "checkout", "components", "order_summary_v2")["deductions"] = []interface{}{map[string]interface{}{"type": "order-summary-wallet-deduction", "price": map[string]interface{}{"amount": "0.00", "currency_code": "EUR"}}}
		},
		"GBP wallet funds": func(q map[string]interface{}, p *CheckoutPreferences) {
			checkoutMap(q, "checkout", "components", "order_summary_v2")["deductions"] = []interface{}{map[string]interface{}{"type": "order-summary-wallet-deduction", "price": map[string]interface{}{"amount": "0.01", "currency_code": "GBP"}}}
		},
		"conversion": func(q map[string]interface{}, p *CheckoutPreferences) {
			checkoutMap(q, "checkout", "components", "order_summary_v2")["currency_conversion"] = map[string]interface{}{}
		},
		"fractional precision": func(q map[string]interface{}, p *CheckoutPreferences) {
			checkoutMap(q, "checkout", "components", "pay_button_v2", "total", "price")["amount"] = "18.291"
		},
	} {
		t.Run(name, func(t *testing.T) {
			q := cardAutoQuote(t)
			checkoutMap(q, "checkout", "components", "pay_button_v2", "total", "price")["currency_code"] = "GBP"
			p := cardAutoPreferences()
			p.AutoCheckout.Currency = "GBP"
			change(q, &p)
			results := append(cardAutoResults(t, q), fakeHTTPResult{status: 200, body: `{"payment":{"status":"success"}}`})
			client, transport := testClient(results...)
			client.session.Domain = "www.vinted.co.uk"
			link, err := client.PrepareCheckout(123, 456, func(session.CheckoutLink) error { return nil }, p)
			want, requests := "checkout_review_required", 3
			if name == "within GBP limit" {
				want, requests = "card_payment_confirmed", 4
			}
			if err != nil || link.Status != want || len(transport.requests) != requests {
				t.Fatalf("unexpected GBP outcome: %#v %v, requests %d", link, err, len(transport.requests))
			}
			if name == "old EUR opt-in" && !strings.Contains(link.AutoCheckoutReason, "EUR spending limit") {
				t.Fatal("missing currency explanation")
			}
		})
	}
}

func TestAllCurrentCurrenciesUseExactLimitsBeforePayment(t *testing.T) {
	for currency, digits := range checkoutCurrencyMinorUnits {
		t.Run(currency, func(t *testing.T) {
			scale, _, _ := checkoutCurrencyScale(currency)
			amount := "18"
			if digits > 0 {
				amount += "." + strings.Repeat("1", digits)
			}
			price := map[string]interface{}{"currency_code": currency, "amount": amount}
			minor, ok := checkoutMoneyMinor(price, currency)
			if !ok || minor <= 0 {
				t.Fatal("valid currency amount rejected")
			}
			for _, overLimit := range []bool{false, true} {
				q := cardAutoQuote(t)
				checkoutMap(q, "checkout", "components", "pay_button_v2", "total")["price"] = price
				checkoutMap(q, "checkout", "components", "order_summary_v2")["deductions"] = []interface{}{map[string]interface{}{"type": "order-summary-wallet-deduction", "price": map[string]interface{}{"currency_code": currency, "amount": "0.00"}}}
				p := cardAutoPreferences()
				p.AutoCheckout.Currency, p.AutoCheckout.MaxTotalMinor = currency, minor
				if overLimit {
					p.AutoCheckout.MaxTotalMinor--
				}
				client, transport := testClient(append(cardAutoResults(t, q), fakeHTTPResult{status: 200, body: `{"payment":{"status":"success"}}`})...)
				client.session.Domain = "www.vinted.de"
				link, err := client.PrepareCheckout(123, 456, func(session.CheckoutLink) error { return nil }, p)
				status, count := "card_payment_confirmed", 4
				if overLimit {
					status, count = "checkout_review_required", 3
				}
				if err != nil || link.Status != status || len(transport.requests) != count {
					t.Fatalf("currency/limit mismatch: %#v %v", link, err)
				}
			}
			if !validCheckoutLimit(currency, 10_000*scale) || validCheckoutLimit(currency, 10_000*scale+1) {
				t.Fatal("limit cap does not follow currency units")
			}
		})
	}
	for _, currency := range []string{"ZZZ", "XXX", "BTC", "eur"} {
		p := cardAutoPreferences()
		p.AutoCheckout.Currency = currency
		if p.Valid() {
			t.Fatal("unknown currency accepted")
		}
	}
}

func TestCurrencyFractionsAreExactAndDoNotRound(t *testing.T) {
	for _, tc := range []struct {
		currency, amount string
		minor            int64
		valid            bool
	}{
		{"JPY", "18.0000", 18, true}, {"JPY", "18.01", 0, false},
		{"PLN", "18.2900", 1829, true}, {"PLN", "18.291", 0, false},
		{"KWD", "18.291", 18291, true}, {"KWD", "18.2911", 0, false},
		{"CLF", "18.2914", 182914, true},
	} {
		minor, valid := checkoutMoneyMinor(map[string]interface{}{"amount": tc.amount, "currency_code": tc.currency}, tc.currency)
		if valid != tc.valid || minor != tc.minor {
			t.Fatalf("%s %s parsed as %d/%v", tc.currency, tc.amount, minor, valid)
		}
	}
}

func TestSavedPickupPointSelectedAndConfirmedBeforePayment(t *testing.T) {
	for _, revealAfterSwitch := range []bool{false, true} {
		t.Run(map[bool]string{false: "point in build", true: "point after pickup switch"}[revealAfterSwitch], func(t *testing.T) {
			q := savedPickupQuote(t)
			results := autoResults(t, q)
			if revealAfterSwitch {
				results = append(results, fakeHTTPResult{status: 200, body: checkoutJSON(q)})
			} else {
				build := savedPickupQuote(t)
				build["purchase"] = map[string]interface{}{"id": "synthetic-purchase"}
				results[1].body = checkoutJSON(build)
			}
			results = append(results, fakeHTTPResult{status: 200, body: `{"action":{"type":"redirect","parameters":{"url":"https://www.paypal.com/checkoutnow?token=synthetic"}}}`})
			client, transport := testClient(results...)
			client.session.Domain = "www.vinted.de"
			p := autoPreferences()
			p.Shipping = "pickup"
			link, err := client.PrepareCheckout(123, 456, func(session.CheckoutLink) error { return nil }, p)
			if err != nil || link.Status != "paypal_redirect_ready" {
				t.Fatalf("pickup not ready: %#v %v", link, err)
			}
			index := 2
			if revealAfterSwitch {
				index = 3
			}
			body, _ := io.ReadAll(transport.requests[index].Body)
			var payload map[string]interface{}
			_ = json.Unmarshal(body, &payload)
			if firstInt64Path(payload, []string{"components", "shipping_pickup_options", "pickup_type"}) != 2 ||
				firstStringPath(payload, []string{"components", "shipping_pickup_details", "point_uuid"}) != "synthetic-point" ||
				firstStringPath(payload, []string{"components", "shipping_pickup_details", "point_code"}) != "synthetic-code" ||
				firstStringPath(payload, []string{"components", "shipping_pickup_details", "rate_uuid"}) != "synthetic-rate" {
				t.Fatal("saved point and carrier not explicitly selected")
			}
			if len(transport.requests) != index+2 {
				t.Fatal("unexpected requests or retry")
			}
		})
	}
}

func TestPickupAmbiguityNeverStartsPayment(t *testing.T) {
	for name, change := range map[string]func(map[string]interface{}){
		"no saved point": func(q map[string]interface{}) {
			delete(checkoutMap(q, "checkout", "components", "shipping_pickup_details", "pickup_details"), "shipping_point")
		},
		"missing point code": func(q map[string]interface{}) {
			delete(checkoutMap(q, "checkout", "components", "shipping_pickup_details", "pickup_details", "shipping_point"), "code")
		},
		"point changed": func(q map[string]interface{}) {
			checkoutMap(q, "checkout", "components", "shipping_pickup_details", "pickup_details", "shipping_point")["uuid"] = "different-point"
		},
		"code changed": func(q map[string]interface{}) {
			checkoutMap(q, "checkout", "components", "shipping_pickup_details", "pickup_details", "shipping_point")["code"] = "different-code"
		},
		"carrier mismatch": func(q map[string]interface{}) {
			checkoutMap(q, "checkout", "components", "shipping_pickup_details", "pickup_details", "shipping_option")["rate_uuid"] = "different-rate"
		},
		"selected rate mismatch": func(q map[string]interface{}) {
			checkoutMap(q, "checkout", "components", "shipping_pickup_details", "pickup_details")["selected_rate_uuid"] = "different-rate"
		},
		"home substituted": func(q map[string]interface{}) {
			checkoutMap(q, "checkout", "components", "shipping_pickup_options")["selected_pickup_option"] = 1
		},
		"phone missing": func(q map[string]interface{}) {
			checkoutMap(q, "checkout", "components")["shipping_contact"] = map[string]interface{}{"is_receiver_phone_number_required": true, "phone_number": " "}
		},
		"incomplete address": func(q map[string]interface{}) {
			checkoutMap(q, "checkout", "components", "shipping_address", "address")["is_complete"] = false
		},
	} {
		t.Run(name, func(t *testing.T) {
			q := savedPickupQuote(t)
			change(q)
			results := autoResults(t, q)
			build := savedPickupQuote(t)
			build["purchase"] = map[string]interface{}{"id": "synthetic-purchase"}
			results[1].body = checkoutJSON(build)
			client, transport := testClient(results...)
			client.session.Domain = "www.vinted.de"
			p := autoPreferences()
			p.Shipping = "pickup"
			link, err := client.PrepareCheckout(123, 456, func(session.CheckoutLink) error { return nil }, p)
			if err != nil || link.Status != "checkout_review_required" || len(transport.requests) != 3 {
				t.Fatalf("unsafe pickup payment: %#v %v", link, err)
			}
		})
	}
}

func TestPickupWithoutSavedPointAndManualPickupStopBeforePayment(t *testing.T) {
	for _, auto := range []bool{false, true} {
		q := savedPickupQuote(t)
		if auto {
			delete(checkoutMap(q, "checkout", "components", "shipping_pickup_details", "pickup_details"), "shipping_point")
		}
		results := autoResults(t, q)
		if !auto {
			results = append(results, fakeHTTPResult{status: 200, body: checkoutJSON(q)})
		}
		client, transport := testClient(results...)
		client.session.Domain = "www.vinted.de"
		p := autoPreferences()
		p.Shipping = "pickup"
		if !auto {
			p.AutoCheckout = nil
		}
		link, err := client.PrepareCheckout(123, 456, func(session.CheckoutLink) error { return nil }, p)
		want, requests := "checkout_review_required", 3
		if !auto {
			want, requests = "checkout_prepared", 4
		}
		if err != nil || link.Status != want || len(transport.requests) != requests {
			t.Fatalf("unexpected pickup: %#v %v", link, err)
		}
		for _, request := range transport.requests {
			if strings.HasSuffix(request.URL.Path, "/payment") {
				t.Fatal("unexpected payment")
			}
		}
	}
}
