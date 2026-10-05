package api

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"strconv"
	"strings"
	"testing"
	"time"

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
}
