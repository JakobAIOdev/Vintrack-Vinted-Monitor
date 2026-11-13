package api

import (
	"testing"
	"time"

	"vintrack-vinted/internal/session"
)

func TestExtensionSyncIsRedundantOnlyForUnchangedRecentlyValidatedSession(t *testing.T) {
	now := time.Date(2026, time.November, 11, 12, 0, 0, 0, time.UTC)
	existing := keepAliveSession("member")
	existing.UserAgent = "synthetic-agent"
	existing.LastValidAt = now.Add(-5 * time.Minute).Format(time.RFC3339)
	same := extensionSyncCompleteRequest{
		AccessToken: existing.AccessToken, UserAgent: existing.UserAgent, BrowserVintedID: existing.VintedUserID,
	}
	if !extensionSyncIsRedundant(&existing, same, existing.Domain, now) {
		t.Fatal("identical recent sync was not recognised as redundant")
	}

	tests := map[string]func(existing *session.VintedSession, req *extensionSyncCompleteRequest, domain *string){
		"new token": func(_ *session.VintedSession, r *extensionSyncCompleteRequest, _ *string) {
			r.AccessToken = "synthetic-new"
		},
		"other domain": func(_ *session.VintedSession, _ *extensionSyncCompleteRequest, d *string) { *d = "www.vinted.fr" },
		"other browser": func(_ *session.VintedSession, r *extensionSyncCompleteRequest, _ *string) {
			r.UserAgent = "other-agent"
		},
		"other account": func(_ *session.VintedSession, r *extensionSyncCompleteRequest, _ *string) { r.BrowserVintedID = 7 },
		"account switch": func(_ *session.VintedSession, r *extensionSyncCompleteRequest, _ *string) {
			r.AllowAccountSwitch = true
		},
		"checkout context": func(_ *session.VintedSession, r *extensionSyncCompleteRequest, _ *string) {
			r.CheckoutContext = &browserCheckoutContext{}
		},
		"refresh token": func(_ *session.VintedSession, r *extensionSyncCompleteRequest, _ *string) {
			r.RefreshToken = "synthetic-refresh"
		},
		"stale validation": func(e *session.VintedSession, _ *extensionSyncCompleteRequest, _ *string) {
			e.LastValidAt = now.Add(-21 * time.Minute).Format(time.RFC3339)
		},
		"never validated":    func(e *session.VintedSession, _ *extensionSyncCompleteRequest, _ *string) { e.LastValidAt = "" },
		"not active":         func(e *session.VintedSession, _ *extensionSyncCompleteRequest, _ *string) { e.Status = "degraded" },
		"not browser linked": func(e *session.VintedSession, _ *extensionSyncCompleteRequest, _ *string) { e.BrowserLinked = false },
		"expired token": func(e *session.VintedSession, r *extensionSyncCompleteRequest, _ *string) {
			e.AccessToken = "eyJhbGciOiJub25lIn0.eyJleHAiOjF9.synthetic"
			r.AccessToken = e.AccessToken
		},
	}
	for name, mutate := range tests {
		candidate, req, domain := existing, same, existing.Domain
		mutate(&candidate, &req, &domain)
		if extensionSyncIsRedundant(&candidate, req, domain, now) {
			t.Fatalf("%s: sync was treated as redundant", name)
		}
	}
	if extensionSyncIsRedundant(nil, same, existing.Domain, now) {
		t.Fatal("missing session was treated as redundant")
	}
}
