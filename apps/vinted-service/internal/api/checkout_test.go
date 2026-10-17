package api

import (
	"context"
	"encoding/json"
	"errors"
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

func TestBrowserPaymentAuthorizationDoesNotRequireVintedTransportOrValidToken(t *testing.T) {
	binary, err := exec.LookPath("redis-server")
	if err != nil {
		t.Skip("redis-server required for isolated authorization test")
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
	manager, err := session.NewManager(addr, "", "", "")
	if err != nil {
		t.Fatal(err)
	}
	// A browser claim never needs a server access token or healthy server TLS
	// session. The page bridge verifies the actual account before its first POST.
	if err := manager.Store(session.VintedSession{UserID: "synthetic-user", VintedUserID: 42, Domain: "www.vinted.de", LinkedAt: "synthetic", Status: "needs_browser_reauth", BrowserLinked: true}); err != nil {
		t.Fatal(err)
	}
	server := &Server{sessions: manager}
	body := `{"item_id":123,"seller_id":456,"account_id":42,"domain":"www.vinted.de","browser_prepare_only":true,"preferences":{"shipping":"home","payment":"paypal","autoCheckout":{"warningVersion":1,"currency":"EUR","maxTotalMinor":3000}}}`
	for index, want := range []int{http.StatusOK, http.StatusConflict} {
		req := httptest.NewRequest(http.MethodPost, "/api/items/checkout/prepare", strings.NewReader(body))
		req.Header.Set("X-User-ID", "synthetic-user")
		recorder := httptest.NewRecorder()
		server.handlePrepareCheckout(recorder, req)
		if recorder.Code != want {
			t.Fatalf("attempt %d status %d, want %d", index, recorder.Code, want)
		}
		if index == 0 && !strings.Contains(recorder.Body.String(), `"browser_payment_authorized":true`) {
			t.Fatal("missing authorization")
		}
	}
	// Changing payment methods cannot bypass an existing item payment claim.
	cardBody := strings.Replace(strings.Replace(body, `"payment":"paypal"`, `"payment":"card"`, 1), `"warningVersion":1`, `"warningVersion":2`, 1)
	for _, tc := range []struct {
		body   string
		status int
	}{
		{cardBody, http.StatusConflict},
		{strings.Replace(cardBody, `"item_id":123`, `"item_id":124`, 1), http.StatusOK},
	} {
		req := httptest.NewRequest(http.MethodPost, "/api/items/checkout/prepare", strings.NewReader(tc.body))
		req.Header.Set("X-User-ID", "synthetic-user")
		recorder := httptest.NewRecorder()
		server.handlePrepareCheckout(recorder, req)
		if recorder.Code != tc.status {
			t.Fatalf("card authorization status %d, want %d", recorder.Code, tc.status)
		}
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
	} {
		payload, status := checkoutFailureResponse(tc.err)
		if payload["code"] != tc.code || payload["failed_step"] != tc.step || status != tc.status {
			t.Fatalf("wrong failure classification: %v", payload)
		}
		if tc.upstream != 0 && payload["upstream_status"] != tc.upstream {
			t.Fatal("upstream status missing")
		}
		encoded, _ := json.Marshal(payload)
		if strings.Contains(string(encoded), "synthetic-secret") {
			t.Fatal("private upstream data leaked")
		}
	}
}
