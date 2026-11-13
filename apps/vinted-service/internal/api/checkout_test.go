package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"strconv"
	"strings"
	"testing"
	"time"
	"vintrack-vinted/internal/vinted"

	"vintrack-vinted/internal/session"
)

func TestPrepareCheckoutRejectsUnauthenticatedAndInvalidRequestsBeforeSessionLookup(t *testing.T) {
	for _, tc := range []struct {
		userID, body string
		status       int
	}{
		{"", `{}`, http.StatusUnauthorized},
		{"synthetic-user", `{}`, http.StatusBadRequest},
		{"synthetic-user", `{"item_id":-1,"seller_id":2,"account_id":3,"domain":"www.vinted.de"}`, http.StatusBadRequest},
		{"synthetic-user", `{"item_id":1,"seller_id":2,"account_id":3,"domain":"www.vinted.de","payment_method":{}}`, http.StatusBadRequest},
		{"synthetic-user", `{"item_id":"1","seller_id":2}`, http.StatusBadRequest},
		{"synthetic-user", `{"item_id":1,"seller_id":2,"account_id":3,"domain":"www.vinted.de","preferences":{},"browser_prepare_only":true,"stop_before_payment":true}`, http.StatusBadRequest},
		{"synthetic-user", `{"item_id":1,"seller_id":2,"account_id":3,"domain":"www.vinted.de","browser_prepare_only":true}`, http.StatusBadRequest},
	} {
		req := httptest.NewRequest(http.MethodPost, "/api/items/checkout/prepare", strings.NewReader(tc.body))
		req.Header.Set("X-User-ID", tc.userID)
		recorder := httptest.NewRecorder()
		(&Server{}).handlePrepareCheckout(recorder, req)
		if recorder.Code != tc.status {
			t.Fatalf("status = %d, want %d", recorder.Code, tc.status)
		}
	}
}

func TestBrowserPaymentAuthorizationFailsClosedWithoutDurableStorage(t *testing.T) {
	manager := checkoutTestManager(t)
	server := &Server{sessions: manager}
	body := `{"item_id":123,"seller_id":456,"account_id":42,"domain":"www.vinted.de","browser_prepare_only":true,"preferences":{"shipping":"home","payment":"paypal","autoCheckout":{"warningVersion":1,"currency":"EUR","maxTotalMinor":3000}}}`
	req := httptest.NewRequest(http.MethodPost, "/api/items/checkout/prepare", strings.NewReader(body))
	req.Header.Set("X-User-ID", "synthetic-user")
	recorder := httptest.NewRecorder()
	server.handlePrepareCheckout(recorder, req)
	if recorder.Code != http.StatusServiceUnavailable || strings.Contains(recorder.Body.String(), `"browser_payment_authorized":true`) {
		t.Fatal("authorized automatic payment without durable storage")
	}
}

func TestCheckoutFailureDiagnosticsAreBoundedAndSanitized(t *testing.T) {
	for _, tc := range []struct {
		err              error
		code, step       string
		status, upstream int
	}{
		{&vinted.UpstreamHTTPError{Operation: "buy conversation", StatusCode: 403, Message: "synthetic-secret"}, "vinted_checkout_rejected", "transaction", 409, 403},
		{&vinted.UpstreamHTTPError{Operation: "checkout build", StatusCode: 429}, "vinted_rate_limited", "build", 429, 429},
		{&vinted.UpstreamHTTPError{Operation: "checkout update", StatusCode: 503}, "vinted_unavailable", "update", 502, 503},
		{&vinted.AuthError{Step: "buy conversation", StatusCode: 401, Message: "synthetic-secret"}, "invalid_authentication_token", "transaction", 401, 401},
		{&vinted.DataDomeChallengeError{Step: "checkout build", StatusCode: 403, CaptchaURL: "https://example.test/synthetic-secret"}, "vinted_security_check", "build", 409, 403},
		{errors.New("synthetic-secret"), "checkout_failed", "unknown", 502, 0},
		{&vinted.TransportError{Step: "buy conversation"}, "checkout_network_failed", "transaction", 502, 0},
		{&vinted.TransportError{Step: "checkout build"}, "checkout_network_failed", "build", 502, 0},
		{fmt.Errorf("synthetic-secret: %w", &vinted.TransportError{Step: "checkout update"}), "checkout_network_failed", "update", 502, 0},
		{&vinted.TransportError{Step: "buy conversation", Kind: "timeout"}, "checkout_network_failed", "transaction", 502, 0},
		{&vinted.TransportError{Step: "buy conversation", Kind: "proxy_unreachable", BeforeSend: true}, "checkout_proxy_unreachable", "transaction", 502, 0},
		{&vinted.TransportError{Step: "buy conversation", Kind: "proxy_refused_407", BeforeSend: true}, "checkout_proxy_auth_failed", "transaction", 502, 0},
		{&vinted.TransportError{Step: "buy conversation", Kind: "proxy_refused_502", BeforeSend: true}, "checkout_proxy_refused", "transaction", 502, 0},
		{&vinted.TransportError{Step: "checkout build", Kind: "proxy_refused", BeforeSend: true}, "checkout_proxy_refused", "build", 502, 0},
		{&vinted.TransportError{Step: "buy conversation", Kind: "proxy_address_not_public", BeforeSend: true}, "checkout_proxy_invalid", "transaction", 502, 0},
		{&vinted.TransportError{Step: "buy conversation", Kind: "synthetic-secret"}, "checkout_network_failed", "transaction", 502, 0},
		{&vinted.UpstreamHTTPError{Operation: "buy conversation", StatusCode: 307, Message: "synthetic-secret"}, "vinted_redirected", "transaction", 502, 0},
		{&vinted.UpstreamHTTPError{Operation: "checkout build", StatusCode: 302}, "vinted_redirected", "build", 502, 0},
		{&vinted.UpstreamHTTPError{Operation: "buy conversation", StatusCode: 403, APIError: true}, "vinted_checkout_rejected", "transaction", 409, 403},
		{&vinted.UpstreamHTTPError{Operation: "buy conversation", StatusCode: 404}, "checkout_failed", "transaction", 502, 404},
		{&vinted.DataDomeChallengeError{Step: "buy conversation", StatusCode: 429, CaptchaURL: "https://example.test/synthetic-secret"}, "vinted_security_check", "transaction", 409, 429},
	} {
		payload, status := checkoutFailureResponse(tc.err)
		if payload["code"] != tc.code || payload["failed_step"] != tc.step || status != tc.status {
			t.Fatalf("wrong failure classification: %v", payload)
		}
		if tc.upstream != 0 && payload["upstream_status"] != tc.upstream {
			t.Fatal("upstream status missing")
		}
		if _, present := payload["upstream_status"]; tc.upstream == 0 && present {
			t.Fatalf("unexpected upstream status: %v", payload)
		}
		if _, present := payload["retryable"]; present {
			t.Fatal("a failure is only retryable after its claim was released")
		}
		encoded, _ := json.Marshal(payload)
		if strings.Contains(string(encoded), "synthetic-secret") {
			t.Fatal("private upstream data leaked")
		}
	}
}

func checkoutTestManager(t *testing.T) *session.Manager {
	return checkoutTestManagerWithDatabase(t, "")
}

func checkoutTestManagerWithDatabase(t *testing.T, databaseURL string) *session.Manager {
	t.Helper()
	binary, err := exec.LookPath("redis-server")
	if err != nil {
		t.Skip("redis-server required for isolated checkout test")
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	_ = listener.Close()
	ctx, cancel := context.WithCancel(context.Background())
	command := exec.CommandContext(ctx, binary, "--bind", "127.0.0.1", "--port", strconv.Itoa(port), "--save", "", "--appendonly", "no", "--dir", t.TempDir())
	if err := command.Start(); err != nil {
		cancel()
		t.Fatal(err)
	}
	t.Cleanup(func() { cancel(); _ = command.Wait() })
	addr := net.JoinHostPort("127.0.0.1", strconv.Itoa(port))
	deadline := time.Now().Add(2 * time.Second)
	for {
		conn, err := net.DialTimeout("tcp", addr, 50*time.Millisecond)
		if err == nil {
			_ = conn.Close()
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("isolated Redis did not start")
		}
		time.Sleep(10 * time.Millisecond)
	}
	manager, err := session.NewManager(addr, "", databaseURL, "synthetic-test-encryption-key")
	if err != nil {
		t.Fatal(err)
	}
	// A browser claim never needs a server access token or healthy server TLS
	// session. The page bridge verifies the actual account before its first POST.
	if err := manager.Store(session.VintedSession{UserID: "synthetic-user", AccessToken: "synthetic-never-live", VintedUserID: 42, Domain: "www.vinted.de", LinkedAt: "synthetic", Status: "needs_browser_reauth", BrowserLinked: true}); err != nil {
		t.Fatal(err)
	}
	return manager
}

func TestCachedCheckoutOutcomesDoNotWarmUpOrRepeatPayment(t *testing.T) {
	manager := checkoutTestManager(t)
	sess, err := manager.Get("synthetic-user")
	if err != nil {
		t.Fatal(err)
	}
	server := &Server{sessions: manager}
	for index, tc := range []struct {
		status   string
		validate bool
		want     string
	}{
		{"card_payment_confirmed", false, "card_payment_confirmed"},
		{"card_payment_pending", false, "card_payment_pending"},
		{"card_payment_failed", false, "card_payment_failed"},
		{"card_authentication_required", false, "card_authentication_required"},
		{"payment_outcome_unknown", false, "payment_outcome_unknown"},
		{"payment_starting", false, "payment_outcome_unknown"},
		{"payment_ready", true, "payment_ready"},
		{"payment_ready", false, "checkout_review_required"},
	} {
		t.Run(tc.status+strconv.FormatBool(tc.validate), func(t *testing.T) {
			itemID := int64(200 + index)
			token, acquired, err := manager.AcquireCheckoutPreparation(sess, itemID)
			if err != nil || !acquired {
				t.Fatal("could not create test checkpoint")
			}
			preferences := vinted.CheckoutPreferences{Shipping: "home", Payment: "card", AutoCheckout: &vinted.AutoCheckoutPreference{WarningVersion: 2, Currency: "EUR", MaxTotalMinor: 3000}}
			link := session.CheckoutLink{ItemID: itemID, SellerID: 456, Status: tc.status, CheckoutURL: "https://www.vinted.de/checkout?purchase_id=synthetic", PaymentURL: "https://www.paypal.com/checkoutnow?token=synthetic", PreferencesKey: preferences.Key(), AutoCheckoutReason: "Synthetic original outcome"}
			if err := manager.SaveCheckoutPreparation(sess, token, link); err != nil {
				t.Fatal(err)
			}
			if err := manager.ReleaseCheckoutPreparation(sess, itemID, token); err != nil {
				t.Fatal(err)
			}
			for _, changedPreferences := range []bool{false, true} {
				if changedPreferences && tc.status == "payment_ready" {
					continue
				}
				current := preferences
				if changedPreferences {
					current = vinted.CheckoutPreferences{Shipping: "home", Payment: "wallet"}
				}
				body, _ := json.Marshal(map[string]interface{}{"item_id": itemID, "seller_id": 456, "account_id": 42, "domain": "www.vinted.de", "preferences": current, "stop_before_payment": tc.validate})
				req := httptest.NewRequest(http.MethodPost, "/api/items/checkout/prepare", strings.NewReader(string(body)))
				req.Header.Set("X-User-ID", "synthetic-user")
				recorder := httptest.NewRecorder()
				server.handlePrepareCheckout(recorder, req)
				var result session.CheckoutLink
				_ = json.Unmarshal(recorder.Body.Bytes(), &result)
				if recorder.Code != 200 || result.Status != tc.want || result.PaymentURL != "" {
					t.Fatalf("unsafe cache result: status=%d link=%+v", recorder.Code, result)
				}
				if paymentOutcomeStatus(tc.status) && result.AutoCheckoutReason != link.AutoCheckoutReason {
					t.Fatal("cached payment evidence was overwritten")
				}
			}
		})
	}
}
