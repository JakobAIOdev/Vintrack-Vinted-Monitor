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
