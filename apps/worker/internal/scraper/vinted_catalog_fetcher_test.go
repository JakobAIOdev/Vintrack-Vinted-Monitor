package scraper

import (
	"errors"
	"testing"

	"vintrack-worker/internal/model"
)

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

func TestExtractCSRFTokenFromNextBootstrap(t *testing.T) {
	body := []byte(`self.__next_f.push([1,"{\"CSRF_TOKEN\":\"123e4567-e89b-12d3-a456-426614174000\"}"])`)
	if got := extractCSRFToken(body); got != "123e4567-e89b-12d3-a456-426614174000" {
		t.Fatalf("extractCSRFToken() = %q", got)
	}
	if got := extractCSRFToken([]byte("missing")); got != "" {
		t.Fatalf("missing token = %q, want empty", got)
	}
}

func TestCatalogAPIHeadersMatchMarketplaceWeb(t *testing.T) {
	headers := newCatalogAPIHeaders("www.vinted.co.uk", catalogBootstrap{
		csrfToken: "csrf-fixture",
		anonID:    "anon-fixture",
	})
	for key, want := range map[string]string{
		"Origin":         "https://www.vinted.co.uk",
		"Referer":        "https://www.vinted.co.uk/",
		"Locale":         "en-GB",
		"Platform":       "web",
		"X-Anon-Id":      "anon-fixture",
		"X-Csrf-Token":   "csrf-fixture",
		"X-Next-App":     "marketplace-web",
		"Sec-Fetch-Site": "same-site",
	} {
		if got := headers.Get(key); got != want {
			t.Errorf("%s = %q, want %q", key, got, want)
		}
	}
}
