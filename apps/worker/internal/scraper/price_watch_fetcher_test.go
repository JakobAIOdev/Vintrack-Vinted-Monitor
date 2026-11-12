package scraper

import (
	"context"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"vintrack-worker/internal/model"
)

func TestFetchPriceWatchLive(t *testing.T) {
	liveURL := os.Getenv("PRICE_WATCH_LIVE_URL")
	itemIDText := os.Getenv("PRICE_WATCH_LIVE_ITEM_ID")
	if liveURL == "" || itemIDText == "" {
		t.Skip("PRICE_WATCH_LIVE_URL and PRICE_WATCH_LIVE_ITEM_ID are not set")
	}
	itemID, err := strconv.ParseInt(itemIDText, 10, 64)
	if err != nil {
		t.Fatalf("invalid live item ID: %v", err)
	}
	client, err := NewClientWithTimeout("", nil, 10*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()

	page, err := fetchPriceWatchPage(ctx, client, model.PriceWatchTarget{
		Region:       "de",
		ItemID:       itemID,
		CanonicalURL: liveURL,
	})
	if err != nil {
		t.Fatalf("fetch live Vinted item page: %v", err)
	}
	if !page.Available || page.PriceMinor < 1 || page.CurrencyCode != "EUR" || page.Title == "" {
		t.Fatalf("incomplete live item: %+v", page)
	}
}

func TestParsePriceWatchHTMLFixture(t *testing.T) {
	fixturePath := os.Getenv("PRICE_WATCH_HTML_FIXTURE")
	itemIDText := os.Getenv("PRICE_WATCH_HTML_FIXTURE_ITEM_ID")
	if fixturePath == "" || itemIDText == "" {
		t.Skip("PRICE_WATCH_HTML_FIXTURE and PRICE_WATCH_HTML_FIXTURE_ITEM_ID are not set")
	}
	itemID, err := strconv.ParseInt(itemIDText, 10, 64)
	if err != nil {
		t.Fatalf("invalid fixture item ID: %v", err)
	}
	fixture, err := os.Open(fixturePath)
	if err != nil {
		t.Fatal(err)
	}
	defer fixture.Close()

	page, err := parsePriceWatchHTML(fixture, itemID, 3*1024*1024)
	if err != nil {
		t.Fatalf("parse captured Vinted item page: %v", err)
	}
	if page.PriceMinor < 1 || len(page.CurrencyCode) != 3 || page.Title == "" {
		t.Fatalf("incomplete captured item: %+v", page)
	}
	if expected := os.Getenv("PRICE_WATCH_HTML_FIXTURE_STATE"); expected != "" && page.State != expected {
		t.Fatalf("captured item state = %q, want %q", page.State, expected)
	}
}

// currentFlightItem mirrors the item object Vinted currently embeds in its
// item pages: sorted keys, the listing ID as a string, and the state flags
// ahead of it. All values are synthetic.
func currentFlightItem(id int64, canBuy bool, reserved bool, hidden bool) string {
	return `[\"$\",\"$L14b\",null,{\"item\":{\"brand_dto\":{\"id\":\"73952\",\"is_favourite\":false,` +
		`\"path\":\"/brand/73952-synthetic\",\"slug\":\"synthetic\",\"title\":\"Brand name\"},` +
		`\"business\":false,\"can_buy\":` + strconv.FormatBool(canBuy) + `,\"catalog_id\":\"1811\",` +
		`\"conversion\":null,\"currency\":\"EUR\",\"hates_you\":false,\"id\":\"` + strconv.FormatInt(id, 10) + `\",` +
		`\"instant_buy\":false,\"is_hated\":false,\"is_hidden\":` + strconv.FormatBool(hidden) + `,` +
		`\"is_reserved\":` + strconv.FormatBool(reserved) + `,\"photos\":\"$146:props:value:photos\",` +
		`\"plugins\":\"$90:props:plugins\",\"price\":{\"amount\":\"50\",\"currency_code\":\"EUR\"},` +
		`\"reservation\":null,\"seller_id\":\"1\",\"title\":\"Synthetic pullover\",\"type\":\"sidebar\"}}]`
}

// A later listing on the same page (similar items) with its own photo.
const otherFlightListing = `{\"id\":\"990\",\"can_buy\":true,\"price\":{\"amount\":\"9\",\"currency_code\":\"EUR\"},` +
	`\"title\":\"Other listing\",\"photos\":[{\"url\":\"https:\\/\\/images.example\\/other.webp\"}]}`

func TestParsePriceWatchHTMLReadsCurrentFlightSchema(t *testing.T) {
	tests := []struct {
		name      string
		html      string
		state     string
		available bool
	}{
		{"available", currentFlightItem(7001, true, false, false), PriceWatchItemAvailable, true},
		{"sold", currentFlightItem(7001, false, false, false), PriceWatchItemSold, false},
		{"reserved", currentFlightItem(7001, false, true, false), PriceWatchItemReserved, false},
		{"hidden", currentFlightItem(7001, false, false, true), PriceWatchItemHidden, false},
		{
			// The sold page carries the closed flag about half a megabyte
			// ahead of the price data, outside the captured window.
			"closed marker far ahead",
			`{\"accessibility_label\":\"x\",\"is_closed\":true,\"item_id\":\"7001\",\"photos\":[]}` +
				strings.Repeat("x", 400*1024) + currentFlightItem(7001, true, false, false),
			PriceWatchItemSold, false,
		},
		{
			"closed marker of another listing",
			`{\"is_closed\":true,\"item_id\":\"70011\"}` + currentFlightItem(7001, true, false, false),
			PriceWatchItemAvailable, true,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			page, err := parsePriceWatchHTML(strings.NewReader(test.html+otherFlightListing), 7001, 1024*1024)
			if err != nil {
				t.Fatalf("parse current flight item: %v", err)
			}
			if page.State != test.state || page.Available != test.available || page.Gone() != (test.state == PriceWatchItemSold) {
				t.Fatalf("state = %q available=%v gone=%v, want %q", page.State, page.Available, page.Gone(), test.state)
			}
			if page.PriceMinor != 5000 || page.CurrencyCode != "EUR" || page.Title != "Synthetic pullover" {
				t.Fatalf("unexpected listing data: %+v", page)
			}
			if page.ImageURL != "" {
				t.Fatalf("image of another listing was attributed to the item: %q", page.ImageURL)
			}
		})
	}
}

func TestParsePriceWatchHTMLDoesNotMatchLongerListingIDs(t *testing.T) {
	for _, html := range []string{
		currentFlightItem(70011, true, false, false),
		`{\"id\":70011,\"price\":{\"amount\":\"8.25\",\"currency_code\":\"EUR\"},\"title\":\"Longer ID\"}`,
	} {
		_, err := parsePriceWatchHTML(strings.NewReader(html), 7001, 512*1024)
		if fetchErr, ok := err.(*PriceWatchFetchError); !ok || fetchErr.Code != "item_schema_missing" {
			t.Fatalf("expected a schema error for a different listing, got %v", err)
		}
	}
}

func TestParsePriceWatchHTMLReportsJSONLDAvailability(t *testing.T) {
	product := func(availability string) string {
		return `<script type="application/ld+json">{"@type":"Product","name":"Console",` +
			`"offers":{"url":"https://www.vinted.de/items/123-console","priceCurrency":"EUR","price":20` +
			availability + `}}</script>`
	}
	for availability, state := range map[string]string{
		"": PriceWatchItemAvailable,
		`,"availability":"https://schema.org/InStock"`:    PriceWatchItemAvailable,
		`,"availability":"https://schema.org/SoldOut"`:    PriceWatchItemSold,
		`,"availability":"https://schema.org/OutOfStock"`: PriceWatchItemSold,
	} {
		page, err := parsePriceWatchHTML(strings.NewReader(product(availability)), 123, 512*1024)
		if err != nil || page.State != state || page.Available != (state == PriceWatchItemAvailable) {
			t.Fatalf("availability %q: page=%+v err=%v, want state %q", availability, page, err, state)
		}
	}
}

func TestNextPriceWatchURLFollowsOnlyTheSameListing(t *testing.T) {
	current := "https://www.vinted.de/items/123-console"
	next, err := nextPriceWatchURL(current, "/items/123-console-renamed?referrer=catalog", "www.vinted.de", 123, 301)
	if err != nil || next != "https://www.vinted.de/items/123-console-renamed?referrer=catalog" {
		t.Fatalf("renamed listing redirect = %q, %v", next, err)
	}

	for location, wantCode := range map[string]string{
		"": "invalid_redirect",
		"/session-refresh?ref_url=%2Fitems%2F123&token=secret": "unexpected_redirect",
		"https://www.vinted.de/":                               "unexpected_redirect",
		"https://www.vinted.de/items/124-other":                "unexpected_redirect",
		"https://www.vinted.fr/items/123-console":              "unexpected_redirect",
	} {
		_, err := nextPriceWatchURL(current, location, "www.vinted.de", 123, 302)
		if err == nil || err.Code != wantCode || err.StatusCode != 302 {
			t.Fatalf("redirect to %q = %+v, want %s", location, err, wantCode)
		}
		if strings.Contains(err.Detail, "secret") || strings.Contains(err.Detail, "?") {
			t.Fatalf("redirect detail leaks the query string: %q", err.Detail)
		}
	}
	_, err = nextPriceWatchURL(current, "/session-refresh?ref_url=%2Fitems%2F123", "www.vinted.de", 123, 307)
	if err == nil || err.Detail != "item page redirected to www.vinted.de/session-refresh" {
		t.Fatalf("redirect detail = %+v", err)
	}
	// A redirect is a property of the attempt, so another client may succeed.
	if !shouldFallbackPriceWatchFetch(err) {
		t.Fatal("an unexpected redirect must allow a fallback attempt")
	}
}

func TestParsePriceWatchHTMLUsesProductJSONLD(t *testing.T) {
	html := `<html><head><script type="application/ld+json">` +
		`{"@type":"Product","name":"Console","image":"https://images.example/item.webp",` +
		`"offers":{"@type":"Offer","url":"https://www.vinted.de/items/123-console",` +
		`"priceCurrency":"EUR","price":199.5,"availability":"https://schema.org/InStock"}}` +
		`</script></head><body>` +
		`{"shipping":{"price":4.99,"currencyCode":"EUR"}}` +
		`</body></html>`

	page, err := parsePriceWatchHTML(strings.NewReader(html), 123, 1024*1024)
	if err != nil {
		t.Fatalf("parse JSON-LD: %v", err)
	}
	if page.PriceMinor != 19950 || page.CurrencyCode != "EUR" || !page.Available {
		t.Fatalf("unexpected page: %+v", page)
	}
	if page.Title != "Console" || page.ImageURL != "https://images.example/item.webp" {
		t.Fatalf("unexpected metadata: %+v", page)
	}
}

func TestParsePriceWatchHTMLUsesSnakeCaseNextFlightItem(t *testing.T) {
	prefix := strings.Repeat("x", 160*1024) +
		`{\"shipping\":{\"amount\":\"4.99\",\"currencyCode\":\"EUR\"}}` +
		`{\"item_id\":7090190431,\"can_buy\":true,\"is_closed\":false}`
	item := `{\"value\":{\"id\":7090190431,\"seller_id\":42,` +
		`\"price\":{\"amount\":\"16.0\",\"currency_code\":\"EUR\"},` +
		`\"title\":\"Ralph \\u0026 Lauren\",` +
		`\"photos\":[{\"id\":1,\"url\":\"https:\\/\\/images.example\\/item.webp\"}]}}`

	page, err := parsePriceWatchHTML(strings.NewReader(prefix+item), 7090190431, 512*1024)
	if err != nil {
		t.Fatalf("parse Next flight item: %v", err)
	}
	if page.PriceMinor != 1600 || page.CurrencyCode != "EUR" || !page.Available {
		t.Fatalf("unexpected page: %+v", page)
	}
	if page.Title != "Ralph & Lauren" || page.ImageURL != "https://images.example/item.webp" {
		t.Fatalf("unexpected metadata: %+v", page)
	}
}

func TestParsePriceWatchHTMLIgnoresLaterDuplicateItemIDWithoutPrice(t *testing.T) {
	item := `{\"id\":55,\"price\":{\"amount\":\"19.99\",\"currency_code\":\"EUR\"},` +
		`\"title\":\"Correct item\",\"photos\":[{\"url\":\"https:\\/\\/images.example\\/55.webp\"}]}`
	laterReference := `{\"tracking\":{\"id\":55,\"type\":\"impression\"}}`

	page, err := parsePriceWatchHTML(strings.NewReader(item+laterReference), 55, 512*1024)
	if err != nil {
		t.Fatalf("parse item with later ID reference: %v", err)
	}
	if page.PriceMinor != 1999 || page.Title != "Correct item" {
		t.Fatalf("unexpected page: %+v", page)
	}
}

func TestParsePriceWatchHTMLMarksClosedFlightItemUnavailable(t *testing.T) {
	html := `{\"item_id\":44,\"can_buy\":false,\"is_closed\":true}` +
		`{\"id\":44,\"price\":{\"amount\":\"8.25\",\"currency_code\":\"EUR\"},` +
		`\"title\":\"Sold item\",\"photos\":[{\"url\":\"https:\\/\\/images.example\\/sold.webp\"}]}`

	page, err := parsePriceWatchHTML(strings.NewReader(html), 44, 512*1024)
	if err != nil {
		t.Fatalf("parse closed item: %v", err)
	}
	if page.Available || page.State != PriceWatchItemSold || !page.Gone() {
		t.Fatalf("expected a sold page: %+v", page)
	}
}

func TestParsePriceWatchHTMLTreatsInternal404AsUnavailable(t *testing.T) {
	page, err := parsePriceWatchHTML(strings.NewReader(`<html><head><title>404: This page could not be found.</title></head></html>`), 77, 512*1024)
	if err != nil {
		t.Fatalf("parse internal 404: %v", err)
	}
	if page.Available || page.State != PriceWatchItemDeleted || !page.Gone() {
		t.Fatalf("expected a deleted page: %+v", page)
	}
}

func TestParsePriceWatchHTMLDoesNotTreatGenericNoindexAsUnavailable(t *testing.T) {
	_, err := parsePriceWatchHTML(
		strings.NewReader(`<html><head><meta name="robots" content="noindex"></head><body>Access check</body></html>`),
		77,
		512*1024,
	)
	if fetchErr, ok := err.(*PriceWatchFetchError); !ok || fetchErr.Code != "item_schema_missing" {
		t.Fatalf("expected a retryable schema error, got %v", err)
	}
}

func TestParsePriceWatchHTMLRejectsMissingAndOversizedData(t *testing.T) {
	_, err := parsePriceWatchHTML(strings.NewReader(`<html><title>Item</title></html>`), 1, 512*1024)
	if fetchErr, ok := err.(*PriceWatchFetchError); !ok || fetchErr.Code != "item_schema_missing" {
		t.Fatalf("expected missing schema error, got %v", err)
	}

	_, err = parsePriceWatchHTML(strings.NewReader(strings.Repeat("x", 300*1024)), 1, 256*1024)
	if fetchErr, ok := err.(*PriceWatchFetchError); !ok || fetchErr.Code != "response_too_large" {
		t.Fatalf("expected response limit error, got %v", err)
	}
}

func TestDecimalStringToMinor(t *testing.T) {
	tests := map[string]int64{
		"0":       0,
		"3":       300,
		"16.0":    1600,
		"12.34":   1234,
		"12.3400": 1234,
	}
	for input, expected := range tests {
		actual, ok := decimalStringToMinor(input)
		if !ok || actual != expected {
			t.Fatalf("%q: got %d, %v; want %d", input, actual, ok, expected)
		}
	}
	for _, input := range []string{"", "-1", "1.234", "abc"} {
		if _, ok := decimalStringToMinor(input); ok {
			t.Fatalf("expected %q to be rejected", input)
		}
	}
}

func TestValidatePriceWatchURL(t *testing.T) {
	if err := validatePriceWatchURL("https://www.vinted.de/items/123-console", "www.vinted.de", 123); err != nil {
		t.Fatalf("valid URL rejected: %v", err)
	}
	for _, rawURL := range []string{
		"http://www.vinted.de/items/123-console",
		"https://evil.example/items/123-console",
		"https://www.vinted.de/catalog?item=123",
		"https://www.vinted.de/items/124-console",
	} {
		if err := validatePriceWatchURL(rawURL, "www.vinted.de", 123); err == nil {
			t.Fatalf("invalid URL accepted: %s", rawURL)
		}
	}
}
