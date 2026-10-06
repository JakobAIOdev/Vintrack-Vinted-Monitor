package vinted

import (
	"encoding/json"
	"errors"
	"io"
	"strings"
	"testing"

	"vintrack-vinted/internal/session"
)

func checkoutResults() []fakeHTTPResult {
	return []fakeHTTPResult{
		{status: 200, body: `{"conversation":{"transaction":{"id":77}}}`},
		{status: 200, body: `{"purchase":{"id":"synthetic-purchase"},"checksum":"synthetic-checksum"}`},
		{status: 200, body: `{}`},
	}
}

const nativeHomeCheckout = `{"checkout":{"components":{"payment_method":{"pay_in_methods":[{"code":"MANGOPAY_PAYPAL"}],"selected_payment_method":null},"shipping_address":{"address":{"id":55}},"shipping_pickup_options":{"selected_pickup_option":1},"shipping_pickup_details":{"pickup_details":{"selected_rate_uuid":"synthetic-rate"}},"pay_button_v2":{"payments_available":true}}}}`

func TestPrepareCheckoutReusesMatchingFreshBuildForReview(t *testing.T) {
	for _, payment := range []string{"paypal", "card", "google_pay"} {
		t.Run(payment, func(t *testing.T) {
			build := autoQuote(t)
			if payment == "card" {
				build = cardAutoQuote(t)
			} else if payment == "google_pay" {
				method := map[string]interface{}{"payment_method": payment, "enabled": true}
				pm := checkoutMap(build, "checkout", "components", "payment_method")
				pm["pay_in_methods"] = []interface{}{method}
				pm["selected_payment_method"] = map[string]interface{}{"pay_in_method": method}
			}
			build["purchase"] = map[string]interface{}{"id": "synthetic-purchase"}
			body, _ := json.Marshal(build)
			results := checkoutResults()[:2]
			results[1].body = string(body)
			client, transport := testClient(results...)
			var statuses []string
			link, err := client.PrepareCheckout(123, 456, func(link session.CheckoutLink) error { statuses = append(statuses, link.Status); return nil }, CheckoutPreferences{Shipping: "home", Payment: payment})
			if err != nil || link.Status != "checkout_prepared" || len(transport.requests) != 2 || link.CheckoutURL == "" || link.PaymentURL != "" {
				t.Fatalf("fresh build was not reused: %#v err=%v requests=%d", link, err, len(transport.requests))
			}
			if strings.Join(statuses, ",") != "transaction_creating,checkout_building,checkout_prepared" {
				t.Fatalf("missing durable final checkpoint: %v", statuses)
			}
		})
	}
}

func TestPrepareCheckoutKeepsUpdateForUnverifiedBuildSelections(t *testing.T) {
	cases := map[string]func(map[string]interface{}){
		"missing checksum": func(raw map[string]interface{}) { delete(raw, "checksum") },
		"missing address ID": func(raw map[string]interface{}) {
			delete(checkoutMap(raw, "checkout", "components", "shipping_address", "address"), "id")
		},
		"fractional address": func(raw map[string]interface{}) {
			checkoutMap(raw, "checkout", "components", "shipping_address", "address")["id"] = 55.5
		},
		"pickup selected": func(raw map[string]interface{}) {
			checkoutMap(raw, "checkout", "components", "shipping_pickup_options")["selected_pickup_option"] = 2
		},
		"fractional pickup": func(raw map[string]interface{}) {
			checkoutMap(raw, "checkout", "components", "shipping_pickup_options")["selected_pickup_option"] = 1.5
		},
		"missing rate": func(raw map[string]interface{}) {
			delete(checkoutMap(raw, "checkout", "components", "shipping_pickup_details", "pickup_details"), "selected_rate_uuid")
		},
		"payment unavailable": func(raw map[string]interface{}) {
			checkoutMap(raw, "checkout", "components", "pay_button_v2")["payments_available"] = false
		},
		"missing payment": func(raw map[string]interface{}) {
			checkoutMap(raw, "checkout", "components", "payment_method")["selected_payment_method"] = nil
		},
		"wrong provider": func(raw map[string]interface{}) {
			checkoutMap(raw, "checkout", "components", "payment_method", "selected_payment_method", "pay_in_method")["payment_method"] = "google_pay"
		},
		"disabled provider": func(raw map[string]interface{}) {
			checkoutMap(raw, "checkout", "components", "payment_method")["pay_in_methods"] = []interface{}{map[string]interface{}{"payment_method": "paypal", "enabled": false}}
		},
	}
	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			build := autoQuote(t)
			change(build)
			build["purchase"] = map[string]interface{}{"id": "synthetic-purchase"}
			body, _ := json.Marshal(build)
			results := autoResults(t, autoQuote(t))
			results[1].body = string(body)
			client, transport := testClient(results...)
			link, err := client.PrepareCheckout(123, 456, func(session.CheckoutLink) error { return nil }, CheckoutPreferences{Shipping: "home", Payment: "paypal"})
			if err != nil || link.Status != "checkout_prepared" || len(transport.requests) != 3 || transport.requests[2].Method != "PUT" {
				t.Fatalf("unverified build skipped update: %#v err=%v requests=%d", link, err, len(transport.requests))
			}
		})
	}
}

func TestAutoCheckoutStillUpdatesMatchingBuildBeforePayment(t *testing.T) {
	for _, payment := range []string{"paypal", "card"} {
		t.Run(payment, func(t *testing.T) {
			build := autoQuote(t)
			preferences := autoPreferences()
			if payment == "card" {
				build = cardAutoQuote(t)
				preferences = cardAutoPreferences()
			}
			updated := autoQuote(t)
			if payment == "card" {
				updated = cardAutoQuote(t)
			}
			updated["checksum"] = "synthetic-updated-quote"
			results := autoResults(t, updated)
			build["purchase"] = map[string]interface{}{"id": "synthetic-purchase"}
			body, _ := json.Marshal(build)
			results[1].body = string(body)
			results = append(results, fakeHTTPResult{status: 200, body: `{"payment":{"status":"pending"}}`})
			client, transport := testClient(results...)
			client.session.Domain = "www.vinted.de"
			_, err := client.PrepareCheckout(123, 456, func(session.CheckoutLink) error { return nil }, preferences)
			if err != nil || len(transport.requests) != 4 || transport.requests[2].Method != "PUT" {
				t.Fatalf("automatic payment skipped final quote: err=%v requests=%d", err, len(transport.requests))
			}
			payload, _ := io.ReadAll(transport.requests[3].Body)
			if !strings.Contains(string(payload), `"checksum":"synthetic-updated-quote"`) {
				t.Fatal("automatic payment used an earlier quote")
			}
		})
	}
}

func TestPrepareCheckoutCombinesPayPalAndDeliveryWhenBuildOffersIt(t *testing.T) {
	results := checkoutResults()
	results[1].body = strings.TrimSuffix(nativeHomeCheckout, "}") + `,"purchase":{"id":"synthetic-purchase"}}`
	results[2].body = strings.Replace(nativeHomeCheckout, `"selected_payment_method":null`, `"selected_payment_method":{"pay_in_method":{"payment_method":"paypal"}}`, 1)
	client, transport := testClient(results...)
	link, err := client.PrepareCheckout(123, 456, func(session.CheckoutLink) error { return nil }, CheckoutPreferences{Shipping: "home", Payment: "paypal"})
	if err != nil || link.Status != "checkout_prepared" || len(transport.requests) != 3 {
		t.Fatalf("combined update failed: link=%#v err=%v requests=%d", link, err, len(transport.requests))
	}
	body, _ := io.ReadAll(transport.requests[2].Body)
	var raw map[string]interface{}
	_ = json.Unmarshal(body, &raw)
	if firstStringPath(raw, []string{"components", "payment_method", "payment_method"}) != "paypal" || firstInt64Path(raw, []string{"components", "shipping_pickup_options", "pickup_type"}) != 1 {
		t.Fatalf("delivery and payment not combined: %s", body)
	}
}

func TestPrepareCheckoutDoesNotReselectSavedPayPal(t *testing.T) {
	results := checkoutResults()
	results[2].body = strings.Replace(nativeHomeCheckout, `"selected_payment_method":null`, `"selected_payment_method":{"pay_in_method":{"payment_method":"paypal"}}`, 1)
	client, transport := testClient(results...)
	link, err := client.PrepareCheckout(123, 456, func(session.CheckoutLink) error { return nil }, CheckoutPreferences{Shipping: "home", Payment: "paypal"})
	if err != nil || link.Status != "checkout_prepared" || len(transport.requests) != 3 {
		t.Fatalf("saved payment caused extra request: link=%#v err=%v", link, err)
	}
}

func TestPrepareCheckoutSelectsHomeAndAvailablePayPalWithoutPayment(t *testing.T) {
	results := checkoutResults()
	results[2].body = nativeHomeCheckout
	selected := strings.Replace(nativeHomeCheckout, `"selected_payment_method":null`, `"selected_payment_method":{"pay_in_method":{"payment_method":"paypal"}}`, 1)
	results = append(results, fakeHTTPResult{status: 200, body: selected})
	client, transport := testClient(results...)
	var checkpointStatuses []string
	link, err := client.PrepareCheckout(123, 456, func(link session.CheckoutLink) error {
		checkpointStatuses = append(checkpointStatuses, link.Status)
		return nil
	}, CheckoutPreferences{Shipping: "home", Payment: "paypal"})
	if err != nil || link.Status != "checkout_prepared" || len(transport.requests) != 4 {
		t.Fatalf("preferences not applied: link=%#v err=%v requests=%d", link, err, len(transport.requests))
	}
	for i, req := range transport.requests {
		if strings.Contains(req.URL.Path, "/payment") {
			t.Fatal("payment must never be called")
		}
		if i < 2 {
			continue
		}
		body, _ := io.ReadAll(req.Body)
		var raw map[string]interface{}
		_ = json.Unmarshal(body, &raw)
		if firstInt64Path(raw, []string{"components", "shipping_pickup_options", "pickup_type"}) != 1 {
			t.Fatalf("home not selected: %s", body)
		}
		if i == 3 && firstStringPath(raw, []string{"components", "payment_method", "payment_method"}) != "paypal" {
			t.Fatalf("PayPal not selected: %s", body)
		}
	}
	if checkpointStatuses[3] != "checkout_selecting_preferences" {
		t.Fatal("missing preference mutation checkpoint")
	}
}

func TestPrepareCheckoutWalletOrUnavailablePayPalRequiresReviewWithoutSubstitution(t *testing.T) {
	for _, payment := range []string{"wallet", "paypal"} {
		results := checkoutResults()
		results[2].body = strings.Replace(nativeHomeCheckout, `[{"code":"MANGOPAY_PAYPAL"}]`, `[]`, 1)
		client, transport := testClient(results...)
		link, err := client.PrepareCheckout(123, 456, func(session.CheckoutLink) error { return nil }, CheckoutPreferences{Shipping: "home", Payment: payment})
		if err != nil || link.Status != "checkout_review_required" || len(transport.requests) != 3 {
			t.Fatalf("unexpected fallback: %#v %v", link, err)
		}
	}
}

func TestPrepareCheckoutPreferenceCheckpointFailurePreventsNextMutation(t *testing.T) {
	results := checkoutResults()
	results[2].body = nativeHomeCheckout
	client, transport := testClient(results...)
	_, err := client.PrepareCheckout(123, 456, func(link session.CheckoutLink) error {
		if link.Status == "checkout_selecting_preferences" {
			return errors.New("storage unavailable")
		}
		return nil
	}, CheckoutPreferences{Shipping: "home", Payment: "paypal"})
	if err == nil || len(transport.requests) != 3 {
		t.Fatal("preference update ran without a saved checkpoint")
	}
}

func TestPrepareCheckoutStopsBeforePaymentAndUsesSavedPreferences(t *testing.T) {
	client, transport := testClient(checkoutResults()...)
	client.session.VintedUserID = 42
	var checkpoints []session.CheckoutLink
	link, err := client.PrepareCheckout(123, 456, func(link session.CheckoutLink) error {
		checkpoints = append(checkpoints, link)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if link.Status != "checkout_review_required" || link.TransactionID != 77 || link.PurchaseID != "synthetic-purchase" || link.PaymentURL != "" {
		t.Fatalf("unexpected link: %#v", link)
	}
	if len(transport.requests) != 3 {
		t.Fatalf("requests = %d, want 3", len(transport.requests))
	}
	for index, req := range transport.requests {
		if strings.Contains(req.URL.Path, "/payment") {
			t.Fatal("payment request must never be sent")
		}
		want := []string{"POST", "POST", "PUT"}[index]
		if req.Method != want {
			t.Fatalf("method = %s, want %s", req.Method, want)
		}
	}
	body, _ := io.ReadAll(transport.requests[2].Body)
	var update struct {
		Components map[string]map[string]interface{} `json:"components"`
	}
	if err := json.Unmarshal(body, &update); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"payment_method", "shipping_address", "shipping_pickup_options", "shipping_pickup_details"} {
		component, ok := update.Components[key]
		if !ok || len(component) != 0 {
			t.Fatalf("%s must use Vinted's saved defaults: %s", key, body)
		}
	}
	if len(checkpoints) != 4 || checkpoints[0].Status != "transaction_creating" || checkpoints[1].TransactionID != 77 || checkpoints[2].CheckoutURL == "" {
		t.Fatalf("missing mutation checkpoints: %#v", checkpoints)
	}
	encoded, _ := json.Marshal(link)
	if strings.Contains(string(encoded), "checksum") {
		t.Fatal("checksum leaked into public checkout response")
	}
}

func TestPrepareCheckoutNeverReplaysAuthenticationOrTransportFailures(t *testing.T) {
	for _, result := range []fakeHTTPResult{
		{status: 401, body: `{"code":100,"message_code":"invalid_authentication_token"}`},
		{err: errors.New("connection lost after POST")},
	} {
		client, transport := testClient(result)
		client.session.RefreshToken = "synthetic-refresh"
		_, err := client.PrepareCheckout(123, 456, func(session.CheckoutLink) error { return nil })
		if err == nil || len(transport.requests) != 1 {
			t.Fatalf("must not retry a mutating request: err=%v requests=%d", err, len(transport.requests))
		}
	}
}

func TestPrepareCheckoutStopsWhenCheckpointCannotBeSaved(t *testing.T) {
	for _, stop := range []int{1, 2, 3} {
		client, transport := testClient(checkoutResults()...)
		calls := 0
		_, err := client.PrepareCheckout(123, 456, func(session.CheckoutLink) error {
			calls++
			if calls == stop {
				return errors.New("storage unavailable")
			}
			return nil
		})
		if err == nil || len(transport.requests) != stop-1 {
			t.Fatalf("checkpoint failure allowed a following mutation: stop=%d requests=%d err=%v", stop, len(transport.requests), err)
		}
	}
}

func TestPrepareCheckoutUpdateFailureKeepsBuiltCheckoutForManualReview(t *testing.T) {
	results := checkoutResults()
	results[2] = fakeHTTPResult{status: 403, body: `{"message":"shipping option not available"}`}
	client, transport := testClient(results...)
	link, err := client.PrepareCheckout(123, 456, func(session.CheckoutLink) error { return nil })
	if err != nil || link.Status != "checkout_review_required" || link.CheckoutURL == "" || len(transport.requests) != 3 {
		t.Fatalf("lost prepared checkout: %#v, %v", link, err)
	}
}

func TestPrepareCheckoutRejectsUnsafeRedirectAndOwnItems(t *testing.T) {
	for _, raw := range []string{"https://www.vinted.cz.evil.test/checkout", "https://attacker@www.vinted.cz/checkout", "https://www.vinted.cz/checkout/payment", "http://www.vinted.cz/checkout", "https://www.vinted.cz/checkout#token"} {
		results := checkoutResults()
		body, _ := json.Marshal(map[string]interface{}{"purchase": map[string]string{"id": "synthetic"}, "checkout_url": raw})
		results[1].body = string(body)
		client, transport := testClient(results...)
		_, err := client.PrepareCheckout(123, 456, func(session.CheckoutLink) error { return nil })
		if err == nil || len(transport.requests) != 2 {
			t.Fatalf("unsafe checkout URL accepted: %q", raw)
		}
	}
	client, transport := testClient()
	client.session.VintedUserID = 456
	_, err := client.PrepareCheckout(123, 456, func(session.CheckoutLink) error { return nil })
	if err == nil || len(transport.requests) != 0 {
		t.Fatal("own item was not rejected before mutation")
	}
}
