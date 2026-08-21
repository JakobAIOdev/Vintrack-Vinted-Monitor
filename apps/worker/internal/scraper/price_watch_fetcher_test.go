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
	if page.Available {
		t.Fatalf("expected unavailable page: %+v", page)
	}
}

func TestParsePriceWatchHTMLTreatsInternal404AsUnavailable(t *testing.T) {
	page, err := parsePriceWatchHTML(strings.NewReader(`<html><head><title>404: This page could not be found.</title></head></html>`), 77, 512*1024)
	if err != nil {
		t.Fatalf("parse internal 404: %v", err)
	}
	if page.Available {
		t.Fatalf("expected unavailable page: %+v", page)
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
