package api

import (
	"net/http/httptest"
	"strings"
	"testing"
)

func TestNormalizeVintedDomain(t *testing.T) {
	tests := []struct {
		input string
		want  string
	}{
		{input: "vinted.de", want: "www.vinted.de"},
		{input: ".vinted.fr", want: "www.vinted.fr"},
		{input: "www.vinted.es", want: "www.vinted.es"},
		{input: "https://vinted.it/catalog", want: "www.vinted.it"},
		{input: "https://www.vinted.co.uk/member/1", want: "www.vinted.co.uk"},
		{input: "https://www.vinted.ie/member/1", want: "www.vinted.ie"},
	}

	for _, tt := range tests {
		if got := normalizeVintedDomain(tt.input); got != tt.want {
			t.Fatalf("normalizeVintedDomain(%q) = %q, want %q", tt.input, got, tt.want)
		}
	}
}

func TestPlatformSearchRequiresVintrackUser(t *testing.T) {
	server := NewServer(nil, "")
	request := httptest.NewRequest("GET", "/api/catalog/platforms?query=ps5&catalog_ids=3002&region=de", nil)
	response := httptest.NewRecorder()

	server.handlePlatformSearch(response, request)

	if response.Code != 401 {
		t.Fatalf("status = %d, want 401", response.Code)
	}
}

func TestPlatformSearchRejectsUnknownRegionBeforeUpstreamRequest(t *testing.T) {
	server := NewServer(nil, "")
	request := httptest.NewRequest("GET", "/api/catalog/platforms?query=ps5&catalog_ids=3002&region=unknown", nil)
	request.Header.Set("X-User-ID", "test-user")
	response := httptest.NewRecorder()

	server.handlePlatformSearch(response, request)

	if response.Code != 400 {
		t.Fatalf("status = %d, want 400", response.Code)
	}
}

func TestBrandSearchRequiresVintrackUser(t *testing.T) {
	server := NewServer(nil, "")
	request := httptest.NewRequest(
		"GET",
		"/api/catalog/brands?query=christian+dior&region=de",
		nil,
	)
	response := httptest.NewRecorder()

	server.handleBrandSearch(response, request)

	if response.Code != 401 {
		t.Fatalf("status = %d, want 401", response.Code)
	}
}

func TestBrandSearchRejectsUnknownRegionBeforeUpstreamRequest(t *testing.T) {
	server := NewServer(nil, "")
	request := httptest.NewRequest(
		"GET",
		"/api/catalog/brands?query=celine&region=unknown",
		nil,
	)
	request.Header.Set("X-User-ID", "test-user")
	response := httptest.NewRecorder()

	server.handleBrandSearch(response, request)

	if response.Code != 400 {
		t.Fatalf("status = %d, want 400", response.Code)
	}
}

func TestBrandResolveRequiresVintrackUser(t *testing.T) {
	server := NewServer(nil, "")
	request := httptest.NewRequest(
		"POST",
		"/api/catalog/brands/resolve",
		strings.NewReader(`{"brand_url":"https://www.vinted.cz/brand/194976-adidas-originals","region":"cz"}`),
	)
	response := httptest.NewRecorder()

	server.handleBrandResolve(response, request)

	if response.Code != 401 {
		t.Fatalf("status = %d, want 401", response.Code)
	}
}

func TestBrandResolveRejectsInvalidBrandURLBeforeUpstreamRequest(t *testing.T) {
	server := NewServer(nil, "")
	request := httptest.NewRequest(
		"POST",
		"/api/catalog/brands/resolve",
		strings.NewReader(`{"brand_url":"https://example.com/brand/194976-adidas-originals","region":"cz"}`),
	)
	request.Header.Set("X-User-ID", "test-user")
	response := httptest.NewRecorder()

	server.handleBrandResolve(response, request)

	if response.Code != 400 {
		t.Fatalf("status = %d, want 400", response.Code)
	}
}

func TestNormalizeBrowserSessionInput_FromCookieHeader(t *testing.T) {
	accessToken, refreshToken, cookieHeader, userAgent, err := normalizeBrowserSessionInput(
		"",
		"",
		"foo=bar; access_token_web=access-123; anon_id=anon-1; refresh_token_web=refresh-456",
		"",
	)
	if err != nil {
		t.Fatalf("normalizeBrowserSessionInput() error = %v", err)
	}
	if accessToken != "access-123" {
		t.Fatalf("accessToken = %q, want %q", accessToken, "access-123")
	}
	if refreshToken != "refresh-456" {
		t.Fatalf("refreshToken = %q, want %q", refreshToken, "refresh-456")
	}
	if cookieHeader != "foo=bar; access_token_web=access-123; anon_id=anon-1; refresh_token_web=refresh-456" {
		t.Fatalf("cookieHeader = %q", cookieHeader)
	}
	if userAgent != "" {
		t.Fatalf("userAgent = %q, want empty", userAgent)
	}
}

func TestNormalizeBrowserSessionInput_FromRawRequestHeaders(t *testing.T) {
	rawHeaders := "accept: application/json\nuser-agent: Mozilla/5.0 Test Agent\ncookie: anon_id=anon-1; access_token_web=access-123; refresh_token_web=refresh-456\nx-extra: 1"

	accessToken, refreshToken, cookieHeader, userAgent, err := normalizeBrowserSessionInput("", "", rawHeaders, "")
	if err != nil {
		t.Fatalf("normalizeBrowserSessionInput() error = %v", err)
	}
	if accessToken != "access-123" {
		t.Fatalf("accessToken = %q, want %q", accessToken, "access-123")
	}
	if refreshToken != "refresh-456" {
		t.Fatalf("refreshToken = %q, want %q", refreshToken, "refresh-456")
	}
	if cookieHeader != "anon_id=anon-1; access_token_web=access-123; refresh_token_web=refresh-456" {
		t.Fatalf("cookieHeader = %q", cookieHeader)
	}
	if userAgent != "Mozilla/5.0 Test Agent" {
		t.Fatalf("userAgent = %q, want %q", userAgent, "Mozilla/5.0 Test Agent")
	}
}

func TestNormalizeBrowserSessionInput_RequiresAccessToken(t *testing.T) {
	_, _, _, _, err := normalizeBrowserSessionInput("", "", "foo=bar; anon_id=anon-1", "")
	if err == nil {
		t.Fatal("normalizeBrowserSessionInput() error = nil, want non-nil")
	}
}

func TestNormalizeBrowserSessionInput_AllowsRefreshOnly(t *testing.T) {
	accessToken, refreshToken, _, _, err := normalizeBrowserSessionInput("", "refresh-456", "", "")
	if err != nil {
		t.Fatalf("normalizeBrowserSessionInput() error = %v", err)
	}
	if accessToken != "" {
		t.Fatalf("accessToken = %q, want empty", accessToken)
	}
	if refreshToken != "refresh-456" {
		t.Fatalf("refreshToken = %q, want %q", refreshToken, "refresh-456")
	}
}
