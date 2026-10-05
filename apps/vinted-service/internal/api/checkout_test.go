package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
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
