package scraper

import (
	"errors"
	"testing"

	"vintrack-worker/internal/model"
)

func TestFetchCatalogWith401RetryRewarmsAndRetriesOnce(t *testing.T) {
	attempts := 0
	rewarmed := 0
	items, status, err := fetchCatalogWith401Retry(
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
		t.Fatalf("fetchCatalogWith401Retry() error = %v", err)
	}
	if status != 200 || len(items) != 1 || items[0].ID != 42 {
		t.Fatalf("result = status %d items %#v, want 200 with item 42", status, items)
	}
	if attempts != 2 || rewarmed != 1 {
		t.Fatalf("attempts=%d rewarms=%d, want 2 and 1", attempts, rewarmed)
	}
}

func TestFetchCatalogWith401RetryDoesNotRetryOtherFailures(t *testing.T) {
	attempts := 0
	rewarmed := 0
	wantErr := errors.New("network failed")
	_, _, err := fetchCatalogWith401Retry(
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
