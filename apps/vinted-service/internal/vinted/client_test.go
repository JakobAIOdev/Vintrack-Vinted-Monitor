package vinted

import (
	"encoding/json"
	"errors"
	"io"
	"net/url"
	"strings"
	"testing"
	"time"

	"vintrack-vinted/internal/session"

	http "github.com/bogdanfinn/fhttp"
)

type fakeHTTPResult struct {
	status  int
	body    string
	headers http.Header
	err     error
}

type fakeVintedHTTPClient struct {
	results        []fakeHTTPResult
	requests       []*http.Request
	cookies        []*http.Cookie
	followRedirect bool
}

func (f *fakeVintedHTTPClient) Do(req *http.Request) (*http.Response, error) {
	f.requests = append(f.requests, req)
	if len(f.results) == 0 {
		return nil, errors.New("unexpected HTTP request")
	}
	result := f.results[0]
	f.results = f.results[1:]
	if result.err != nil {
		return nil, result.err
	}
	return &http.Response{
		StatusCode: result.status,
		Header:     result.headers,
		Body:       io.NopCloser(strings.NewReader(result.body)),
		Request:    req,
	}, nil
}

func (f *fakeVintedHTTPClient) GetCookies(_ *url.URL) []*http.Cookie {
	return f.cookies
}

func (f *fakeVintedHTTPClient) SetCookies(_ *url.URL, cookies []*http.Cookie) {
	f.cookies = append(f.cookies, cookies...)
}

func (f *fakeVintedHTTPClient) GetFollowRedirect() bool {
	return f.followRedirect
}

func (f *fakeVintedHTTPClient) SetFollowRedirect(follow bool) {
	f.followRedirect = follow
}

func testClient(results ...fakeHTTPResult) (*Client, *fakeVintedHTTPClient) {
	httpClient := &fakeVintedHTTPClient{results: results, followRedirect: true}
	return &Client{
		httpClient: httpClient,
		session:    &session.VintedSession{Domain: "www.vinted.cz"},
	}, httpClient
}

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

func TestNormalizeFilterOptionsPayload_GatewayBrandSearch(t *testing.T) {
	var payload filterOptionsPayload
	err := json.Unmarshal([]byte(`{
		"options": [
			{"id": "671", "title": "Dior", "type": "default"},
			{"id": "15430438", "title": "Christian Dior", "type": "default"}
		],
		"selected_filters": {"code": "brand", "ids": []}
	}`), &payload)
	if err != nil {
		t.Fatalf("unmarshal gateway fixture: %v", err)
	}

	options := normalizeFilterOptionsPayload(payload)
	if len(options) != 2 {
		t.Fatalf("got %d options, want 2: %#v", len(options), options)
	}
	if options[1].ID != "15430438" || options[1].Label != "Christian Dior" {
		t.Errorf("Christian Dior option = %#v", options[1])
	}
}

func TestBuildGatewayFilterSearchURL(t *testing.T) {
	rawURL := buildGatewayFilterSearchURL(
		"www.vinted.de",
		[]string{"1904", "5"},
		"Christian Dior",
		"brand",
	)
	parsed, err := url.Parse(rawURL)
	if err != nil {
		t.Fatalf("parse gateway filter URL: %v", err)
	}

	if parsed.Host != "www.vinted.de" {
		t.Errorf("host = %q, want www.vinted.de", parsed.Host)
	}
	if parsed.Path != "/web/gateway/svc-filters/filters/search" {
		t.Errorf("path = %q", parsed.Path)
	}
	if got := parsed.Query().Get("filter_search_code"); got != "brand" {
		t.Errorf("filter_search_code = %q, want brand", got)
	}
	if got := parsed.Query().Get("filter_search_text"); got != "Christian Dior" {
		t.Errorf("filter_search_text = %q, want Christian Dior", got)
	}
	if got := parsed.Query().Get("attribute_ids[catalog]"); got != "1904,5" {
		t.Errorf("attribute_ids[catalog] = %q, want 1904,5", got)
	}

	unscopedURL := buildGatewayFilterSearchURL(
		"www.vinted.de",
		nil,
		"Celine",
		"brand",
	)
	unscoped, err := url.Parse(unscopedURL)
	if err != nil {
		t.Fatalf("parse unscoped gateway filter URL: %v", err)
	}
	if unscoped.Query().Has("attribute_ids[catalog]") {
		t.Error("unscoped search unexpectedly contains a catalog attribute")
	}
}

func TestBuildCatalogFilterSearchURL(t *testing.T) {
	rawURL := buildCatalogFilterSearchURL(
		"www.vinted.cz",
		[]string{"97", "97", " 5 "},
		"adidas Originals",
		"brand",
	)
	parsed, err := url.Parse(rawURL)
	if err != nil {
		t.Fatalf("parse catalog filter URL: %v", err)
	}
	if parsed.Path != "/api/v2/catalog/filters/search" {
		t.Errorf("path = %q", parsed.Path)
	}
	if got := parsed.Query().Get("filter_search_code"); got != "brand" {
		t.Errorf("filter_search_code = %q", got)
	}
	if got := parsed.Query().Get("filter_search_text"); got != "adidas Originals" {
		t.Errorf("filter_search_text = %q", got)
	}
	if got := parsed.Query().Get("catalog_ids"); got != "97,5" {
		t.Errorf("catalog_ids = %q", got)
	}
	for _, key := range []string{"size_ids", "brand_ids", "status_ids", "color_ids", "material_ids"} {
		if !parsed.Query().Has(key) || parsed.Query().Get(key) != "" {
			t.Errorf("%s should be present and empty", key)
		}
	}
}

func TestParseVintedBrandURL(t *testing.T) {
	tests := []struct {
		name     string
		rawURL   string
		wantID   int64
		wantSlug string
		wantErr  bool
	}{
		{name: "brand page", rawURL: "https://www.vinted.cz/brand/194976-adidas-originals", wantID: 194976, wantSlug: "adidas-originals"},
		{name: "catalog brand page", rawURL: "https://www.vinted.cz/catalog/97-watches/brand/23065-lip?order=newest_first", wantID: 23065, wantSlug: "lip"},
		{name: "foreign host", rawURL: "https://example.com/brand/194976-adidas-originals", wantErr: true},
		{name: "http", rawURL: "http://www.vinted.cz/brand/194976-adidas-originals", wantErr: true},
		{name: "userinfo", rawURL: "https://user@www.vinted.cz/brand/194976-adidas-originals", wantErr: true},
		{name: "missing slug", rawURL: "https://www.vinted.cz/brand/194976", wantErr: true},
		{name: "item page", rawURL: "https://www.vinted.cz/items/194976-adidas-originals", wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			id, slug, err := ParseVintedBrandURL(tt.rawURL)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("expected error, got id=%d slug=%q", id, slug)
				}
				return
			}
			if err != nil {
				t.Fatalf("ParseVintedBrandURL() error = %v", err)
			}
			if id != tt.wantID || slug != tt.wantSlug {
				t.Fatalf("got id=%d slug=%q, want id=%d slug=%q", id, slug, tt.wantID, tt.wantSlug)
			}
		})
	}
}

func TestValidateBrandPageHTML(t *testing.T) {
	body := []byte(`<!doctype html><html><head><title>adidas Originals | Vinted</title><link href="https://www.vinted.cz/brand/194976-adidas-originals" rel="canonical"></head><body><h1>adidas Originals</h1></body></html>`)
	brand, err := validateBrandPageHTML(body, "www.vinted.cz", 194976)
	if err != nil {
		t.Fatalf("validateBrandPageHTML() error = %v", err)
	}
	if brand.ID != "194976" || brand.Label != "adidas Originals" {
		t.Fatalf("brand = %#v", brand)
	}
}

func TestValidateBrandPageHTMLRejectsInvalidEvidence(t *testing.T) {
	valid := `<!doctype html><html><head><title>LIP | Vinted</title><link rel="canonical" href="https://www.vinted.cz/brand/23065-lip"></head><body><h1>LIP</h1></body></html>`
	tests := []struct {
		name string
		body string
	}{
		{name: "canonical ID mismatch", body: strings.Replace(valid, "23065-lip", "999-lip", 1)},
		{name: "cross domain canonical", body: strings.Replace(valid, "www.vinted.cz", "example.com", 1)},
		{name: "missing title", body: strings.Replace(valid, "<title>LIP | Vinted</title>", "", 1)},
		{name: "label mismatch", body: strings.Replace(valid, "<h1>LIP</h1>", "<h1>Other</h1>", 1)},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := validateBrandPageHTML([]byte(tt.body), "www.vinted.cz", 23065); err == nil {
				t.Fatal("expected validation error")
			}
		})
	}
}

func TestSearchBrandsUsesCatalogWarmupAndPrimaryEndpoint(t *testing.T) {
	client, transport := testClient(
		fakeHTTPResult{status: 200, body: `<meta name="csrf-token" content="csrf">`},
		fakeHTTPResult{status: 200, body: `{"options":[{"id":194976,"title":"adidas Originals"}]}`},
	)

	brands, err := client.SearchBrands([]string{"97"}, "adidas")
	if err != nil {
		t.Fatalf("SearchBrands() error = %v", err)
	}
	if len(brands) != 1 || brands[0].ID != "194976" || brands[0].Label != "adidas Originals" {
		t.Fatalf("SearchBrands() = %#v", brands)
	}
	if len(transport.requests) != 2 {
		t.Fatalf("request count = %d, want 2", len(transport.requests))
	}
	if transport.requests[0].URL.Path != "/catalog" {
		t.Errorf("warmup path = %q, want /catalog", transport.requests[0].URL.Path)
	}
	if transport.requests[1].URL.Path != "/api/v2/catalog/filters/search" {
		t.Errorf("search path = %q", transport.requests[1].URL.Path)
	}
	if got := transport.requests[1].Header.Get("X-Csrf-Token"); got != "csrf" {
		t.Errorf("X-Csrf-Token = %q, want csrf", got)
	}
}

func TestSearchBrandsRetriesOnceAfterUnauthorized(t *testing.T) {
	client, transport := testClient(
		fakeHTTPResult{status: 200, body: "warmup"},
		fakeHTTPResult{status: 401, body: `{}`},
		fakeHTTPResult{status: 200, body: "retry warmup"},
		fakeHTTPResult{status: 200, body: `{"options":[{"id":"23065","label":"LIP"}]}`},
	)

	brands, err := client.SearchBrands(nil, "lip")
	if err != nil {
		t.Fatalf("SearchBrands() error = %v", err)
	}
	if len(brands) != 1 || brands[0].ID != "23065" {
		t.Fatalf("SearchBrands() = %#v", brands)
	}
	if len(transport.requests) != 4 {
		t.Fatalf("request count = %d, want 4", len(transport.requests))
	}
	if transport.requests[2].URL.Path != "/catalog" || transport.requests[3].URL.Path != "/api/v2/catalog/filters/search" {
		t.Fatalf("retry paths = %q, %q", transport.requests[2].URL.Path, transport.requests[3].URL.Path)
	}
}

func TestSearchBrandsFallsBackOnTransportAndSchemaErrors(t *testing.T) {
	tests := []struct {
		name    string
		primary fakeHTTPResult
	}{
		{name: "transport", primary: fakeHTTPResult{err: errors.New("connection reset")}},
		{name: "schema", primary: fakeHTTPResult{status: 200, body: `{"unexpected":true}`}},
		{name: "server status", primary: fakeHTTPResult{status: 503, body: `{"error":"unavailable"}`}},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			client, transport := testClient(
				fakeHTTPResult{status: 200, body: "warmup"},
				test.primary,
				fakeHTTPResult{status: 200, body: `{"options":[{"id":"77","title":"Fallback Brand"}]}`},
			)

			brands, err := client.SearchBrands(nil, "fallback")
			if err != nil {
				t.Fatalf("SearchBrands() error = %v", err)
			}
			if len(brands) != 1 || brands[0].Label != "Fallback Brand" {
				t.Fatalf("SearchBrands() = %#v", brands)
			}
			if got := transport.requests[len(transport.requests)-1].URL.Path; got != "/web/gateway/svc-filters/filters/search" {
				t.Errorf("fallback path = %q", got)
			}
		})
	}
}

func TestSearchBrandsDoesNotFallbackForSuccessfulEmptyResponse(t *testing.T) {
	client, transport := testClient(
		fakeHTTPResult{status: 200, body: "warmup"},
		fakeHTTPResult{status: 200, body: `{"options":[]}`},
	)

	brands, err := client.SearchBrands(nil, "no-match")
	if err != nil {
		t.Fatalf("SearchBrands() error = %v", err)
	}
	if len(brands) != 0 {
		t.Fatalf("SearchBrands() = %#v, want empty", brands)
	}
	if len(transport.requests) != 2 {
		t.Fatalf("request count = %d, want 2", len(transport.requests))
	}
}

func TestCatalogFilterSearchRejectsOversizedResponse(t *testing.T) {
	client, _ := testClient(fakeHTTPResult{
		status: 200,
		body:   strings.Repeat("x", maxFilterSearchResponseBytes+1),
	})
	client.warmedUp = true
	client.catalogWarmedUp = true

	_, err := client.searchCatalogFilterOptions(nil, "large", "brand")
	if err == nil || !strings.Contains(err.Error(), "exceeds") {
		t.Fatalf("error = %v, want response size error", err)
	}
}

func TestResolveBrandPageRejectsInvalidUpstreamEvidence(t *testing.T) {
	validHTML := `<html><head><title>LIP | Vinted</title><link rel="canonical" href="https://www.vinted.cz/brand/23065-lip"></head><body><h1>LIP</h1></body></html>`
	tests := []struct {
		name       string
		pageResult fakeHTTPResult
		wantError  string
	}{
		{
			name:       "not found",
			pageResult: fakeHTTPResult{status: 404, body: "not found"},
			wantError:  "HTTP 404",
		},
		{
			name: "cross domain redirect",
			pageResult: fakeHTTPResult{
				status:  302,
				headers: http.Header{"Location": {"https://www.vinted.fr/brand/23065-lip"}},
			},
			wantError: "outside the selected region",
		},
		{
			name:       "evidence beyond inspection limit",
			pageResult: fakeHTTPResult{status: 200, body: strings.Repeat("x", maxBrandPageInspectionBytes) + validHTML},
			wantError:  "official title",
		},
		{
			name:       "canonical mismatch",
			pageResult: fakeHTTPResult{status: 200, body: strings.Replace(validHTML, "23065-lip", "99-wrong", 1)},
			wantError:  "canonical ID",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			client, _ := testClient(
				fakeHTTPResult{status: 200, body: "warmup"},
				test.pageResult,
			)
			_, err := client.ResolveBrandPage("https://www.vinted.cz/brand/23065-lip")
			if err == nil || !strings.Contains(err.Error(), test.wantError) {
				t.Fatalf("error = %v, want %q", err, test.wantError)
			}
		})
	}
}

func TestResolveBrandPageAcceptsLargePageWhenEvidenceIsInBoundedPrefix(t *testing.T) {
	validHTML := `<html><head><title>Under Armour | Vinted</title><link rel="canonical" href="https://www.vinted.cz/brand/52035-under-armour"></head><body><h1>Under Armour</h1>`
	client, _ := testClient(
		fakeHTTPResult{status: 200, body: "warmup"},
		fakeHTTPResult{
			status: 200,
			body:   validHTML + strings.Repeat("x", maxBrandPageInspectionBytes),
		},
	)

	brand, err := client.ResolveBrandPage("https://www.vinted.cz/brand/52035-under-armour")
	if err != nil {
		t.Fatalf("ResolveBrandPage() error = %v", err)
	}
	if brand.ID != "52035" || brand.Label != "Under Armour" {
		t.Fatalf("ResolveBrandPage() = %#v", brand)
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
