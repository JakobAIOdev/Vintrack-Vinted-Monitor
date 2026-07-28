package vinted

import (
	"testing"
	"time"

	"vintrack-vinted/internal/session"

	http "github.com/bogdanfinn/fhttp"
)

func TestParseUserIDFromJWT_Valid(t *testing.T) {
	// JWT with payload: {"sub": "12345"}
	// base64url("{"sub":"12345"}") = eyJzdWIiOiIxMjM0NSJ9
	token := "header.eyJzdWIiOiIxMjM0NSJ9.signature"

	userID, userIDStr := parseUserIDFromJWT(token)
	if userID != 12345 {
		t.Errorf("userID = %d, want 12345", userID)
	}
	if userIDStr != "12345" {
		t.Errorf("userIDStr = %q, want %q", userIDStr, "12345")
	}
}

func TestParseUserIDFromJWT_PrefersSubjectOverAccountID(t *testing.T) {
	token := "header.eyJhY2NvdW50X2lkIjo2Nzg5MCwic3ViIjoiMTIzNDUifQ.signature"

	userID, userIDStr := parseUserIDFromJWT(token)
	if userID != 12345 {
		t.Errorf("userID = %d, want 12345", userID)
	}
	if userIDStr != "12345" {
		t.Errorf("userIDStr = %q, want %q", userIDStr, "12345")
	}
}

func TestParseUserIDFromJWT_PrefersActorSubject(t *testing.T) {
	token := "header.eyJhY2NvdW50X2lkIjo2Nzg5MCwiYWN0Ijp7InN1YiI6IjU0MzIxIn0sInN1YiI6IjEyMzQ1In0.signature"

	userID, _ := parseUserIDFromJWT(token)
	if userID != 54321 {
		t.Errorf("userID = %d, want 54321", userID)
	}
}

func TestParseUserIDFromJWT_FallsBackToAccountID(t *testing.T) {
	token := "header.eyJhY2NvdW50X2lkIjoiNjc4OTAifQ.signature"

	userID, _ := parseUserIDFromJWT(token)
	if userID != 67890 {
		t.Errorf("userID = %d, want 67890", userID)
	}
}

func TestParseUserIDFromJWT_InvalidToken(t *testing.T) {
	tests := []struct {
		name  string
		token string
	}{
		{"empty", ""},
		{"no dots", "nodots"},
		{"one dot", "one.dot"},
		{"invalid base64", "a.!!!invalid!!!.c"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			userID, _ := parseUserIDFromJWT(tt.token)
			if userID != 0 {
				t.Errorf("parseUserIDFromJWT(%q) = %d, want 0", tt.token, userID)
			}
		})
	}
}

func TestParseUserIDFromJWT_NoSubClaim(t *testing.T) {
	// JWT with payload: {"name": "test"} (no sub)
	// base64url({"name":"test"}) = eyJuYW1lIjoidGVzdCJ9
	token := "header.eyJuYW1lIjoidGVzdCJ9.signature"

	userID, _ := parseUserIDFromJWT(token)
	if userID != 0 {
		t.Errorf("userID = %d, want 0 for missing sub claim", userID)
	}
}

func TestLocale(t *testing.T) {
	tests := []struct {
		domain   string
		expected string
	}{
		{"www.vinted.de", "de-DE"},
		{"www.vinted.fr", "fr-FR"},
		{"www.vinted.es", "es-ES"},
		{"www.vinted.it", "it-IT"},
		{"www.vinted.nl", "nl-NL"},
		{"www.vinted.pl", "pl-PL"},
		{"www.vinted.co.uk", "en-GB"},
		{"www.vinted.ie", "en-IE"},
		{"www.vinted.cz", "cs-CZ"},
		{"www.vinted.com", "en-US"},
		{"www.vinted.xyz", "de-DE"}, // fallback
	}

	for _, tt := range tests {
		t.Run(tt.domain, func(t *testing.T) {
			c := &Client{session: &session.VintedSession{Domain: tt.domain}}
			got := c.locale()
			if got != tt.expected {
				t.Errorf("locale() for %q = %q, want %q", tt.domain, got, tt.expected)
			}
		})
	}
}

func TestPortal(t *testing.T) {
	tests := []struct {
		domain   string
		expected string
	}{
		{"www.vinted.de", "de"},
		{"www.vinted.co.uk", "uk"},
		{"www.vinted.ie", "ie"},
		{"www.vinted.cz", "cz"},
	}

	for _, tt := range tests {
		t.Run(tt.domain, func(t *testing.T) {
			c := &Client{session: &session.VintedSession{Domain: tt.domain}}
			if got := c.portal(); got != tt.expected {
				t.Errorf("portal() for %q = %q, want %q", tt.domain, got, tt.expected)
			}
		})
	}
}

func TestNormalizeFilterOptionsPayload(t *testing.T) {
	payload := filterOptionsPayload{
		Options: []filterOptionEntry{
			{ID: float64(10), Title: "PlayStation 5"},
			{Value: "20", Label: "PlayStation 2"},
			{ID: float64(10), Name: "Duplicate"},
			{ID: float64(30)},
		},
	}

	options := normalizeFilterOptionsPayload(payload)
	if len(options) != 2 {
		t.Fatalf("got %d options, want 2: %#v", len(options), options)
	}
	if options[0].ID != "10" || options[0].Label != "PlayStation 5" {
		t.Errorf("first option = %#v", options[0])
	}
	if options[1].ID != "20" || options[1].Label != "PlayStation 2" {
		t.Errorf("second option = %#v", options[1])
	}
}

func TestPlatformOptionMatches(t *testing.T) {
	tests := []struct {
		label string
		query string
		want  bool
	}{
		{label: "PlayStation 2", query: "PS2", want: true},
		{label: "PlayStation 5 Pro", query: "ps5", want: true},
		{label: "Nintendo 64", query: "N64", want: true},
		{label: "Nintendo Entertainment System", query: "NES", want: true},
		{label: "Nintendo Game Boy Advance", query: "GBA", want: true},
		{label: "Xbox Series S & X", query: "series", want: true},
		{label: "Steam Deck", query: "switch", want: false},
	}

	for _, tt := range tests {
		t.Run(tt.label+"/"+tt.query, func(t *testing.T) {
			if got := platformOptionMatches(tt.label, tt.query); got != tt.want {
				t.Errorf("platformOptionMatches(%q, %q) = %v, want %v", tt.label, tt.query, got, tt.want)
			}
		})
	}
}

func TestDomainForPortal(t *testing.T) {
	if got := domainForPortal("ie"); got != "www.vinted.ie" {
		t.Errorf("domainForPortal(\"ie\") = %q, want %q", got, "www.vinted.ie")
	}
}

func TestDomainForRegion(t *testing.T) {
	if got, ok := DomainForRegion(" CZ "); !ok || got != "www.vinted.cz" {
		t.Errorf("DomainForRegion(\" CZ \") = %q, %v; want %q, true", got, ok, "www.vinted.cz")
	}
	if got, ok := DomainForRegion("unknown"); ok || got != "" {
		t.Errorf("DomainForRegion(\"unknown\") = %q, %v; want empty, false", got, ok)
	}
}

func TestTruncate(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		maxLen   int
		expected string
	}{
		{"short string", "hello", 10, "hello"},
		{"exact length", "hello", 5, "hello"},
		{"truncated", "hello world", 5, "hello..."},
		{"empty", "", 5, ""},
		{"one char max", "hello", 1, "h..."},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := truncate(tt.input, tt.maxLen)
			if got != tt.expected {
				t.Errorf("truncate(%q, %d) = %q, want %q", tt.input, tt.maxLen, got, tt.expected)
			}
		})
	}
}

func TestMinInt(t *testing.T) {
	tests := []struct {
		a, b, expected int
	}{
		{1, 2, 1},
		{5, 3, 3},
		{0, 0, 0},
		{-1, 1, -1},
	}

	for _, tt := range tests {
		got := minInt(tt.a, tt.b)
		if got != tt.expected {
			t.Errorf("minInt(%d, %d) = %d, want %d", tt.a, tt.b, got, tt.expected)
		}
	}
}

func TestGetAccessToken(t *testing.T) {
	sess := &session.VintedSession{AccessToken: "test-token-123"}
	c := &Client{session: sess}

	if got := c.GetAccessToken(); got != "test-token-123" {
		t.Errorf("GetAccessToken() = %q, want %q", got, "test-token-123")
	}
}

func TestGetDomain(t *testing.T) {
	sess := &session.VintedSession{Domain: "www.vinted.de"}
	c := &Client{session: sess}

	if got := c.GetDomain(); got != "www.vinted.de" {
		t.Errorf("GetDomain() = %q, want %q", got, "www.vinted.de")
	}
}

func TestGetSession(t *testing.T) {
	sess := &session.VintedSession{
		UserID:      "user-1",
		AccessToken: "token",
		Domain:      "www.vinted.fr",
	}
	c := &Client{session: sess}

	got := c.GetSession()
	if got.UserID != "user-1" {
		t.Errorf("GetSession().UserID = %q, want %q", got.UserID, "user-1")
	}
	if got.Domain != "www.vinted.fr" {
		t.Errorf("GetSession().Domain = %q, want %q", got.Domain, "www.vinted.fr")
	}
}

func TestSerializeCookies(t *testing.T) {
	cookies := []*http.Cookie{
		{Name: "access_token_web", Value: "access"},
		{Name: "anon_id", Value: "anon-1"},
		{Name: "foo", Value: "bar"},
		{Name: "anon_id", Value: "anon-2"},
		{Name: "refresh_token_web", Value: "refresh"},
	}

	got := serializeCookies(cookies)
	want := "anon_id=anon-2; foo=bar"
	if got != want {
		t.Fatalf("serializeCookies() = %q, want %q", got, want)
	}
}

func TestCanReuseWarmup(t *testing.T) {
	c := &Client{
		session: &session.VintedSession{
			CsrfToken: "csrf",
			WarmedAt:  time.Now().UTC().Format(time.RFC3339),
		},
		csrfToken: "csrf",
	}

	if !c.canReuseWarmup() {
		t.Fatal("canReuseWarmup() = false, want true for fresh cached warmup")
	}

	c.session.WarmedAt = time.Now().UTC().Add(-warmupReuseWindow - time.Minute).Format(time.RFC3339)
	if c.canReuseWarmup() {
		t.Fatal("canReuseWarmup() = true, want false for stale cached warmup")
	}
}
