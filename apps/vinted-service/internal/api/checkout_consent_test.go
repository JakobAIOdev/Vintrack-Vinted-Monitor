package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"vintrack-vinted/internal/session"
)

func TestCheckoutConsentStorageFailureFailsClosed(t *testing.T) {
	server := &Server{sessions: &session.Manager{}}
	response := httptest.NewRecorder()
	if server.requireCheckoutConsent(response, "synthetic-member") {
		t.Fatal("checkout permitted without persistent consent storage")
	}
	if response.Code != http.StatusServiceUnavailable || !strings.Contains(response.Body.String(), "checkout consent unavailable") {
		t.Fatalf("unexpected response: %d %s", response.Code, response.Body.String())
	}
}
