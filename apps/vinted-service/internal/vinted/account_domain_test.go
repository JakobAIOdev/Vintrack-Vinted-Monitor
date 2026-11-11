package vinted

import (
	"testing"

	"vintrack-vinted/internal/session"
)

func TestNewClientRejectsNonVintedDomains(t *testing.T) {
	for _, domain := range []string{
		"", "evil.example", "10.0.0.5:8443", "localhost", "www.vinted.de.evil.example",
		"vinted.de@evil.example", "www.vinted.de/../x", "notvinted.de",
	} {
		if IsSupportedAccountDomain(domain) {
			t.Fatalf("IsSupportedAccountDomain(%q) = true", domain)
		}
		if _, err := NewClient(&session.VintedSession{Domain: domain, AccessToken: "synthetic"}); err == nil {
			t.Fatalf("NewClient accepted domain %q", domain)
		}
	}
	for _, domain := range []string{"www.vinted.de", "vinted.fr", "www.vinted.co.uk", "WWW.VINTED.COM", "www.vinted.gr"} {
		if !IsSupportedAccountDomain(domain) {
			t.Fatalf("IsSupportedAccountDomain(%q) = false", domain)
		}
	}
	if _, err := NewClient(&session.VintedSession{Domain: "www.vinted.de"}); err != nil {
		t.Fatalf("NewClient rejected a Vinted domain: %v", err)
	}
}
