package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRequestCheckoutRequiresFullCheckoutBeforeWarmupOrMutation(t *testing.T) {
	manager := checkoutTestManager(t)
	server := &Server{sessions: manager}
	for _, validate := range []string{"false", "true"} {
		request := httptest.NewRequest(http.MethodPost, "/api/items/checkout/prepare", strings.NewReader(`{"item_id":123,"seller_id":456,"account_id":42,"domain":"www.vinted.de","stop_before_payment":`+validate+`,"preferences":{"shipping":"home","payment":"card"}}`))
		request.Header.Set("X-User-ID", "synthetic-user")
		response := httptest.NewRecorder()
		server.handlePrepareCheckout(response, request)
		if response.Code != http.StatusConflict || !strings.Contains(response.Body.String(), "FULL_CHECKOUT_REQUIRED") {
			t.Fatal("preparation-only request was not rejected locally")
		}
		sess, _ := manager.Get("synthetic-user")
		if cached, err := manager.GetCheckoutPreparation(sess, 123); err != nil || cached != nil {
			t.Fatal("preparation-only request created a checkpoint")
		}
	}
}

func TestLegacyRequestEndpointsCannotBypassFullCheckout(t *testing.T) {
	server := &Server{}
	for _, handler := range []http.HandlerFunc{server.handleOneClickBuy, server.handleBuyWarm} {
		for _, user := range []string{"", "synthetic-user"} {
			request := httptest.NewRequest(http.MethodPost, "/api/items/buy", strings.NewReader(`{}`))
			request.Header.Set("X-User-ID", user)
			response := httptest.NewRecorder()
			handler(response, request)
			expected := http.StatusGone
			if user == "" {
				expected = http.StatusUnauthorized
			}
			if response.Code != expected {
				t.Fatal("legacy request endpoint did not stop before session or network access")
			}
		}
	}
}
