package session

import (
	"strings"
	"testing"
)

func TestBrowserLinkTokenHashIsStableAndOpaque(t *testing.T) {
	token := "browser-link-token-with-secret-material"
	hash := browserLinkTokenHash(token)

	if len(hash) != 64 {
		t.Fatalf("hash length = %d, want 64", len(hash))
	}
	if hash != browserLinkTokenHash(token) {
		t.Fatal("browserLinkTokenHash() is not deterministic")
	}
	if hash == browserLinkTokenHash(token+"-other") {
		t.Fatal("different tokens produced the same hash")
	}
	if strings.Contains(hash, token) {
		t.Fatal("browser link hash contains raw token material")
	}
}
