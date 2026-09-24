package scraper

import (
	"context"
	"errors"
	"net/url"
	"testing"
	"time"

	"vintrack-worker/internal/model"

	http "github.com/bogdanfinn/fhttp"
)

func TestWarmupFallbackPolicy(t *testing.T) {
	for _, test := range []struct {
		name string
		err  error
		want bool
	}{
		{name: "not found", err: &httpStatusError{statusCode: 404}, want: true},
		{name: "gone", err: &httpStatusError{statusCode: 410}, want: true},
		{name: "forbidden", err: &httpStatusError{statusCode: 403}, want: false},
		{name: "timeout", err: context.DeadlineExceeded, want: false},
	} {
		t.Run(test.name, func(t *testing.T) {
			got := shouldFallbackCatalogWarmup(test.err)
			if got != test.want {
				t.Fatalf("fallback = %v, want %v", got, test.want)
			}
		})
	}
}

func TestFetchCatalogWithSessionRetryRewarmsAndRetriesOnce(t *testing.T) {
	attempts := 0
	rewarmed := 0
	items, status, err := fetchCatalogWithSessionRetry(
		func() error {
			rewarmed++
			return nil
		},
		func() ([]model.VintedItem, int, error) {
			attempts++
			if attempts == 1 {
				return nil, 401, nil
			}
			return []model.VintedItem{{ID: 42}}, 200, nil
		},
	)

	if err != nil {
		t.Fatalf("fetchCatalogWithSessionRetry() error = %v", err)
	}
	if status != 200 || len(items) != 1 || items[0].ID != 42 {
		t.Fatalf("result = status %d items %#v, want 200 with item 42", status, items)
	}
	if attempts != 2 || rewarmed != 1 {
		t.Fatalf("attempts=%d rewarms=%d, want 2 and 1", attempts, rewarmed)
	}
}

func TestFetchCatalogWithSessionRetryDoesNotRetryOtherFailures(t *testing.T) {
	attempts := 0
	rewarmed := 0
	wantErr := errors.New("network failed")
	_, _, err := fetchCatalogWithSessionRetry(
		func() error {
			rewarmed++
			return nil
		},
		func() ([]model.VintedItem, int, error) {
			attempts++
			return nil, 0, wantErr
		},
	)

	if !errors.Is(err, wantErr) {
		t.Fatalf("error = %v, want %v", err, wantErr)
	}
	if attempts != 1 || rewarmed != 0 {
		t.Fatalf("attempts=%d rewarms=%d, want 1 and 0", attempts, rewarmed)
	}
}

func TestFetchCatalogWithSessionRetryRewarmsOnForbidden(t *testing.T) {
	attempts := 0
	rewarmed := 0
	_, status, err := fetchCatalogWithSessionRetry(
		func() error {
			rewarmed++
			return nil
		},
		func() ([]model.VintedItem, int, error) {
			attempts++
			if attempts == 1 {
				return nil, 403, nil
			}
			return []model.VintedItem{{ID: 7}}, 200, nil
		},
	)
	if err != nil || status != 200 || attempts != 2 || rewarmed != 1 {
		t.Fatalf("status=%d err=%v attempts=%d rewarms=%d", status, err, attempts, rewarmed)
	}
}

func TestNormalizeCatalogItemsUsesItemBoxFallbacks(t *testing.T) {
	items := []model.VintedItem{{
		ID: 42,
		ItemBox: model.VintedItemBox{
			FirstLine:  "Levi's",
			SecondLine: "W32 · Very good",
		},
	}}
	normalizeCatalogItems(items)
	if items[0].BrandTitle != "Levi's" || items[0].SizeTitle != "W32" || items[0].Condition != "Very good" {
		t.Fatalf("normalized item = %#v", items[0])
	}
}

func TestValidateCatalogCurrencyRejectsWrongMarketplaceSession(t *testing.T) {
	items := []model.VintedItem{{Price: model.VintedPrice{Amount: "10", Currency: "GBP"}}}
	if err := validateCatalogCurrency("www.vinted.de", items); err == nil {
		t.Fatal("expected DE catalog with GBP prices to be rejected")
	}
	items[0].Price.Currency = "EUR"
	items[0].TotalItemPrice = &model.VintedPrice{Amount: "11", Currency: "EUR"}
	if err := validateCatalogCurrency("www.vinted.de", items); err != nil {
		t.Fatalf("valid DE catalog rejected: %v", err)
	}
}

func TestCatalogAPIHeadersMatchMarketplaceWeb(t *testing.T) {
	headers := newCatalogAPIHeaders("www.vinted.co.uk", "anon-synthetic")
	for key, want := range map[string]string{
		"Origin":          "https://www.vinted.co.uk",
		"Referer":         "https://www.vinted.co.uk/",
		"Accept-Language": "en-GB,en-US;q=0.9,en;q=0.8",
		"Priority":        "u=1, i",
		"Sec-Fetch-Site":  "same-site",
		"Locale":          "en-GB",
		"Platform":        "web",
		"X-Next-App":      "marketplace-web",
		"X-Anon-Id":       "anon-synthetic",
	} {
		if got := headers.Get(key); got != want {
			t.Errorf("%s = %q, want %q", key, got, want)
		}
	}
	if got := headers.Get("X-Csrf-Token"); got != "" {
		t.Errorf("X-Csrf-Token = %q, want omitted", got)
	}
	if got := newCatalogAPIHeaders("www.vinted.de", "").Get("X-Anon-Id"); got != "" {
		t.Errorf("X-Anon-Id = %q, want omitted without a session id", got)
	}
}

func TestSynchronizeCatalogCookiesCopiesMarketplaceSessionToAPIHost(t *testing.T) {
	client, err := NewClientWithTimeout("", nil, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()

	marketplaceURL, _ := url.Parse("https://www.vinted.co.uk/")
	catalogURL, _ := url.Parse("https://api.vinted.co.uk/")
	client.HttpClient.SetCookies(marketplaceURL, []*http.Cookie{
		{Name: "access_token_web", Value: "anonymous-session", Path: "/"},
		{Name: "anon_id", Value: "anonymous-id", Path: "/"},
	})
	if got := client.HttpClient.GetCookies(catalogURL); len(got) != 0 {
		t.Fatalf("catalog cookies before synchronization = %v, want none", cookieNames(got))
	}

	client.synchronizeCatalogCookies("www.vinted.co.uk")
	got := cookieNames(client.HttpClient.GetCookies(catalogURL))
	if len(got) != 2 || got[0] != "access_token_web" || got[1] != "anon_id" {
		t.Fatalf("catalog cookies after synchronization = %v", got)
	}
}

func cookieNames(cookies []*http.Cookie) []string {
	names := make([]string, len(cookies))
	for index, cookie := range cookies {
		names[index] = cookie.Name
	}
	return names
}
