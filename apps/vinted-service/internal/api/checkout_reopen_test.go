package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"vintrack-vinted/internal/session"
	"vintrack-vinted/internal/vinted"
)

const syntheticPayPalApproval = "https://www.paypal.com/checkoutnow?token=synthetic-approval"

func payPalAutoPreferences() vinted.CheckoutPreferences {
	return vinted.CheckoutPreferences{Shipping: "home", Payment: "paypal", AutoCheckout: &vinted.AutoCheckoutPreference{WarningVersion: 1, Currency: "EUR", MaxTotalMinor: 3000}}
}

// storeCheckoutCheckpoint leaves a finished request's checkpoint behind, the
// way a reopened buy link finds it.
func storeCheckoutCheckpoint(t *testing.T, manager *session.Manager, sess *session.VintedSession, link session.CheckoutLink) {
	t.Helper()
	token, acquired, err := manager.AcquireCheckoutPreparation(sess, link.ItemID)
	if err != nil || !acquired {
		t.Fatal("could not create test checkpoint")
	}
	if err := manager.SaveCheckoutPreparation(sess, token, link); err != nil {
		t.Fatal(err)
	}
	if err := manager.ReleaseCheckoutPreparation(sess, link.ItemID, token); err != nil {
		t.Fatal(err)
	}
}

func reopenCheckout(t *testing.T, server *Server, fields map[string]interface{}) (int, session.CheckoutLink, string) {
	t.Helper()
	request := map[string]interface{}{"seller_id": 456, "account_id": 42, "domain": "www.vinted.de", "preferences": payPalAutoPreferences()}
	for key, value := range fields {
		request[key] = value
	}
	body, _ := json.Marshal(request)
	req := httptest.NewRequest(http.MethodPost, "/api/items/checkout/prepare", strings.NewReader(string(body)))
	req.Header.Set("X-User-ID", "synthetic-user")
	recorder := httptest.NewRecorder()
	server.handlePrepareCheckout(recorder, req)
	var link session.CheckoutLink
	_ = json.Unmarshal(recorder.Body.Bytes(), &link)
	return recorder.Code, link, recorder.Body.String()
}

// reopenTestServer fails the test if a reopened result ever builds a Vinted client.
func reopenTestServer(t *testing.T) (*Server, *session.Manager, *session.VintedSession) {
	t.Helper()
	manager := checkoutTestManager(t)
	sess, err := manager.Get("synthetic-user")
	if err != nil || sess == nil {
		t.Fatal("synthetic session missing")
	}
	server := &Server{sessions: manager, newCheckoutClient: func(*session.VintedSession, string) (*vinted.Client, error) {
		t.Error("a stored checkout result contacted Vinted")
		return nil, errors.New("synthetic: no client for a stored result")
	}}
	return server, manager, sess
}

func payPalCheckpoint(itemID int64) session.CheckoutLink {
	return session.CheckoutLink{
		ItemID: itemID, SellerID: 456, TransactionID: 77, Status: "paypal_redirect_ready",
		CheckoutURL: "https://www.vinted.de/checkout?purchase_id=synthetic",
		// A checkpoint never holds a provider link; if one did, it must not be used.
		PaymentURL:     "https://www.paypal.com/checkoutnow?token=synthetic-stale-checkpoint",
		PreferencesKey: payPalAutoPreferences().Key(), AutoCheckoutReason: "Continue in PayPal to complete the payment.",
	}
}

func TestStartedPayPalPaymentIsHandedBackWithoutContactingVinted(t *testing.T) {
	server, manager, sess := reopenTestServer(t)
	const itemID = 300
	storeCheckoutCheckpoint(t, manager, sess, payPalCheckpoint(itemID))

	// No handoff: the link is gone, and the payment is not started again.
	for range 2 {
		status, link, body := reopenCheckout(t, server, map[string]interface{}{"item_id": itemID})
		if status != 200 || link.Status != "checkout_review_required" || link.PaymentURL != "" || !strings.Contains(link.AutoCheckoutReason, "no longer available") {
			t.Fatalf("missing handoff: status=%d link=%+v", status, link)
		}
		if strings.Contains(body, "paypal.com") {
			t.Fatal("a provider link came from the checkpoint")
		}
	}

	if err := manager.SaveCheckoutPaymentHandoff(sess, itemID, syntheticPayPalApproval); err != nil {
		t.Fatal(err)
	}
	for _, preferences := range []vinted.CheckoutPreferences{payPalAutoPreferences(), payPalAutoPreferences(), {Shipping: "home", Payment: "wallet"}, {Shipping: "pickup", Payment: "card", AutoCheckout: &vinted.AutoCheckoutPreference{WarningVersion: 2, Currency: "EUR", MaxTotalMinor: 100}}} {
		status, link, body := reopenCheckout(t, server, map[string]interface{}{"item_id": itemID, "preferences": preferences})
		if status != 200 || link.Status != "paypal_redirect_ready" || link.PaymentURL != syntheticPayPalApproval {
			t.Fatalf("started PayPal payment was not handed back: status=%d link=%+v", status, link)
		}
		if !strings.Contains(link.AutoCheckoutReason, "already started") || !strings.Contains(link.AutoCheckoutReason, "no second payment") {
			t.Fatalf("reopen reason does not say that nothing was sent: %q", link.AutoCheckoutReason)
		}
		if link.CheckoutURL == "" || link.TransactionID != 77 || strings.Contains(body, "synthetic-stale-checkpoint") {
			t.Fatalf("stored checkout was not returned intact: %s", body)
		}
	}

	// Validation and browser authorization never receive the provider link and
	// never authorize a payment for an item whose payment already started.
	status, link, body := reopenCheckout(t, server, map[string]interface{}{"item_id": itemID, "stop_before_payment": true})
	if status != 200 || link.PaymentURL != "" || link.Status != "checkout_review_required" || strings.Contains(body, "paypal.com") {
		t.Fatalf("validation received a provider link: status=%d %s", status, body)
	}
	status, link, body = reopenCheckout(t, server, map[string]interface{}{"item_id": itemID, "browser_prepare_only": true})
	if status != 200 || link.PaymentURL != "" || link.Status != "checkout_review_required" || strings.Contains(body, "paypal.com") || strings.Contains(body, "browser_payment_authorized") {
		t.Fatalf("browser authorization reused a started payment: status=%d %s", status, body)
	}

	// The handoff belongs to this item and this seller only.
	status, _, body = reopenCheckout(t, server, map[string]interface{}{"item_id": itemID, "seller_id": 457})
	if status != http.StatusConflict || strings.Contains(body, "paypal.com") {
		t.Fatalf("changed checkout target received the provider link: status=%d %s", status, body)
	}
	storeCheckoutCheckpoint(t, manager, sess, payPalCheckpoint(itemID+1))
	status, link, _ = reopenCheckout(t, server, map[string]interface{}{"item_id": itemID + 1})
	if status != 200 || link.Status != "checkout_review_required" || link.PaymentURL != "" {
		t.Fatalf("handoff crossed the item boundary: status=%d link=%+v", status, link)
	}

	// The link is still available to the request that owns it afterwards.
	status, link, _ = reopenCheckout(t, server, map[string]interface{}{"item_id": itemID})
	if status != 200 || link.Status != "paypal_redirect_ready" || link.PaymentURL != syntheticPayPalApproval {
		t.Fatalf("handoff was consumed by a refused request: status=%d link=%+v", status, link)
	}
}

func TestPayPalHandoffNeverReturnsANonPayPalLink(t *testing.T) {
	server, manager, sess := reopenTestServer(t)
	for index, stored := range []string{
		"https://www.paypal.com.evil.test/checkoutnow?token=synthetic",
		"https://evil.test/checkoutnow?token=synthetic",
		"http://www.paypal.com/checkoutnow?token=synthetic",
		"https://www.paypal.com/checkoutnow?token=synthetic#fragment",
		"https://synthetic@www.paypal.com/checkoutnow?token=synthetic",
		"https://www.paypal.com/signin?returnUri=synthetic",
		"https://www.paypal.com:8443/checkoutnow?token=synthetic",
		"https://www.vinted.de/checkout?purchase_id=synthetic",
		"javascript:alert('synthetic')",
		"//www.paypal.com/checkoutnow?token=synthetic",
	} {
		itemID := int64(320 + index)
		storeCheckoutCheckpoint(t, manager, sess, payPalCheckpoint(itemID))
		if err := manager.SaveCheckoutPaymentHandoff(sess, itemID, stored); err != nil {
			t.Fatal(err)
		}
		status, link, body := reopenCheckout(t, server, map[string]interface{}{"item_id": itemID})
		if status != 200 || link.Status != "checkout_review_required" || link.PaymentURL != "" {
			t.Fatalf("%q was handed out: status=%d link=%+v", stored, status, link)
		}
		if strings.Contains(body, "synthetic@") || strings.Contains(body, "evil.test") || strings.Contains(body, "token=synthetic") || strings.Contains(body, "javascript:") {
			t.Fatalf("%q leaked into the response: %s", stored, body)
		}
	}
}

func TestPayPalHandoffIsOnlyUsedForAStartedPayPalPayment(t *testing.T) {
	server, manager, sess := reopenTestServer(t)
	for index, status := range []string{"card_payment_confirmed", "card_payment_pending", "card_payment_failed", "card_authentication_required", "payment_outcome_unknown", "payment_starting", "payment_ready", "checkout_prepared", "checkout_review_required"} {
		itemID := int64(340 + index)
		checkpoint := payPalCheckpoint(itemID)
		checkpoint.Status = status
		storeCheckoutCheckpoint(t, manager, sess, checkpoint)
		if err := manager.SaveCheckoutPaymentHandoff(sess, itemID, syntheticPayPalApproval); err != nil {
			t.Fatal(err)
		}
		for _, validate := range []bool{false, true} {
			code, link, body := reopenCheckout(t, server, map[string]interface{}{"item_id": itemID, "stop_before_payment": validate})
			if code != 200 || link.PaymentURL != "" || strings.Contains(body, "paypal.com") || link.Status == "paypal_redirect_ready" {
				t.Fatalf("%s (validate=%v) returned a provider link: status=%d %s", status, validate, code, body)
			}
		}
	}
	// A checkpoint without a checkout URL is uncertain whatever its status.
	checkpoint := payPalCheckpoint(360)
	checkpoint.CheckoutURL = ""
	storeCheckoutCheckpoint(t, manager, sess, checkpoint)
	if err := manager.SaveCheckoutPaymentHandoff(sess, 360, syntheticPayPalApproval); err != nil {
		t.Fatal(err)
	}
	code, _, body := reopenCheckout(t, server, map[string]interface{}{"item_id": 360})
	if code != http.StatusConflict || !strings.Contains(body, "checkout_uncertain") || strings.Contains(body, "paypal.com") {
		t.Fatalf("uncertain checkpoint: status=%d %s", code, body)
	}
}

func TestCheckoutAttemptReleasable(t *testing.T) {
	first := &session.CheckoutLink{ItemID: 1, Status: "transaction_creating"}
	refused := func(status int) error {
		return &vinted.UpstreamHTTPError{Operation: "buy conversation", StatusCode: status}
	}
	for _, tc := range []struct {
		name string
		link *session.CheckoutLink
		err  error
		want bool
	}{
		{"no error", first, nil, false},
		{"no error and no link", nil, nil, false},
		{"nothing sent", nil, errors.New("synthetic checkpoint failure"), true},
		{"first step 400", first, refused(400), true},
		{"first step 403 edge", first, refused(403), true},
		{"first step 403 API", first, &vinted.UpstreamHTTPError{Operation: "buy conversation", StatusCode: 403, APIError: true}, true},
		{"first step 404", first, refused(404), true},
		{"first step 429", first, refused(429), true},
		{"first step 499", first, refused(499), true},
		{"first step 401", first, &vinted.AuthError{Step: "buy conversation", StatusCode: 401}, true},
		{"first step challenge", first, &vinted.DataDomeChallengeError{Step: "buy conversation", StatusCode: 403}, true},
		{"first step wrapped 429", first, fmt.Errorf("synthetic: %w", refused(429)), true},
		{"first step 500", first, refused(500), false},
		{"first step 502", first, refused(502), false},
		{"first step 503", first, refused(503), false},
		{"first step 301", first, refused(301), false},
		{"first step 307", first, refused(307), false},
		{"first step 399", first, refused(399), false},
		{"first step lost connection", first, &vinted.TransportError{Step: "buy conversation"}, false},
		{"first step proxy unreachable", first, &vinted.TransportError{Step: "buy conversation", BeforeSend: true}, true},
		{"first step wrapped proxy unreachable", first, fmt.Errorf("synthetic: %w", &vinted.TransportError{Step: "buy conversation", BeforeSend: true}), true},
		{"transaction known proxy unreachable", &session.CheckoutLink{Status: "transaction_creating", TransactionID: 77}, &vinted.TransportError{Step: "buy conversation", BeforeSend: true}, false},
		{"build proxy unreachable", &session.CheckoutLink{Status: "checkout_building", TransactionID: 77}, &vinted.TransportError{Step: "checkout build", BeforeSend: true}, false},
		{"update proxy unreachable", &session.CheckoutLink{Status: "checkout_updating", TransactionID: 77}, &vinted.TransportError{Step: "checkout update", BeforeSend: true}, false},
		{"payment proxy unreachable", &session.CheckoutLink{Status: "payment_starting", TransactionID: 77}, &vinted.TransportError{Step: "checkout payment", BeforeSend: true}, false},
		{"payment unknown proxy unreachable", &session.CheckoutLink{Status: "payment_outcome_unknown", TransactionID: 77}, &vinted.TransportError{Step: "checkout payment", BeforeSend: true}, false},
		{"first step untyped", first, errors.New("invalid buy conversation response"), false},
		{"transaction known", &session.CheckoutLink{Status: "transaction_creating", TransactionID: 77}, refused(429), false},
		{"build 429", &session.CheckoutLink{Status: "checkout_building", TransactionID: 77}, &vinted.UpstreamHTTPError{Operation: "checkout build", StatusCode: 429}, false},
		{"build without transaction", &session.CheckoutLink{Status: "checkout_building"}, refused(429), false},
		{"update 403", &session.CheckoutLink{Status: "checkout_updating", TransactionID: 77}, refused(403), false},
		{"selecting 403", &session.CheckoutLink{Status: "checkout_selecting_preferences", TransactionID: 77}, refused(403), false},
		{"prepared", &session.CheckoutLink{Status: "checkout_prepared"}, refused(403), false},
		{"review", &session.CheckoutLink{Status: "checkout_review_required"}, refused(403), false},
		{"payment ready", &session.CheckoutLink{Status: "payment_ready"}, refused(403), false},
		{"payment starting", &session.CheckoutLink{Status: "payment_starting"}, refused(403), false},
		{"payment starting checkpoint failure", &session.CheckoutLink{Status: "payment_starting"}, errors.New("synthetic checkpoint failure"), false},
		{"payment unknown", &session.CheckoutLink{Status: "payment_outcome_unknown"}, refused(403), false},
		{"card confirmed", &session.CheckoutLink{Status: "card_payment_confirmed"}, refused(403), false},
		{"PayPal started", &session.CheckoutLink{Status: "paypal_redirect_ready"}, refused(403), false},
		{"empty status", &session.CheckoutLink{}, refused(403), false},
	} {
		if got := checkoutAttemptReleasable(tc.link, tc.err); got != tc.want {
			t.Errorf("%s: releasable = %v, want %v", tc.name, got, tc.want)
		}
	}
}

func TestCheckoutStepForStatus(t *testing.T) {
	for status, want := range map[string]string{
		"transaction_creating":           "transaction",
		"checkout_building":              "build",
		"checkout_updating":              "update",
		"checkout_selecting_preferences": "update",
		// A failure at this checkpoint means the payment was never sent; it
		// is reported as checkout_stopped_before_payment, not as a step.
		"payment_starting":               "unknown",
		"checkout_prepared":              "unknown",
		"checkout_review_required":       "unknown",
		"payment_ready":                  "unknown",
		"payment_outcome_unknown":        "unknown",
		"card_payment_confirmed":         "unknown",
		"paypal_redirect_ready":          "unknown",
		"payment_authorization_reserved": "unknown",
		"":                               "unknown",
		"synthetic-secret":               "unknown",
	} {
		if got := checkoutStepForStatus(status); got != want {
			t.Errorf("checkoutStepForStatus(%q) = %q, want %q", status, got, want)
		}
	}
}

func TestKnownVintedAccountRefusalsGetAnActionableMessage(t *testing.T) {
	payload, status := checkoutFailureResponse(&vinted.UpstreamHTTPError{Operation: "buy conversation", StatusCode: 403, APIError: true, Code: "170", MessageCode: "outdated_terms_and_conditions", Message: "synthetic-secret"})
	if status != 409 || payload["code"] != "vinted_terms_outdated" || payload["failed_step"] != "transaction" {
		t.Fatalf("unexpected classification: %v", payload)
	}
	encoded, _ := json.Marshal(payload)
	if !strings.Contains(string(encoded), "terms and conditions") || strings.Contains(string(encoded), "synthetic-secret") {
		t.Fatal("message is not actionable or leaks upstream text")
	}
	// The enum only counts inside Vinted's API envelope.
	payload, _ = checkoutFailureResponse(&vinted.UpstreamHTTPError{Operation: "buy conversation", StatusCode: 403, MessageCode: "outdated_terms_and_conditions"})
	if payload["code"] != "vinted_checkout_rejected" {
		t.Fatalf("enum trusted outside the API envelope: %v", payload)
	}
}
