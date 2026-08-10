package scraper

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestSellerInfoCache_SetAndGet(t *testing.T) {
	cache := &sellerInfoCache{
		cache: make(map[string]sellerCacheEntry, 16),
	}

	info := SellerInfo{Region: "🇩🇪 DE", Rating: "⭐ 4.5 (10)", RatingStars: 4.5, RatingCount: 10, RatingAvailable: true}
	cache.Set("www.vinted.de", 123, info, time.Now())

	got, ok := cache.Get("www.vinted.de", 123, time.Minute)
	if !ok {
		t.Fatal("Expected cache hit for user 123")
	}
	if got.Region != info.Region {
		t.Errorf("Region = %q, want %q", got.Region, info.Region)
	}
	if got.Rating != info.Rating {
		t.Errorf("Rating = %q, want %q", got.Rating, info.Rating)
	}
}

func TestSellerInfoCache_IsolatedByDomainAndExpires(t *testing.T) {
	cache := &sellerInfoCache{cache: make(map[string]sellerCacheEntry, 4)}
	cache.Set("www.vinted.de", 7, SellerInfo{Region: "🇩🇪 DE"}, time.Now())
	cache.Set("www.vinted.fr", 7, SellerInfo{Region: "🇫🇷 FR"}, time.Now())
	if got, _ := cache.Get("www.vinted.de", 7, time.Minute); got.Region != "🇩🇪 DE" {
		t.Fatalf("DE cache leaked across domains: %#v", got)
	}
	cache.Set("www.vinted.de", 8, SellerInfo{Region: "old"}, time.Now().Add(-time.Hour))
	if _, ok := cache.Get("www.vinted.de", 8, time.Minute); ok {
		t.Fatal("expired seller cache entry was returned")
	}
}

func TestConcurrentItemsForSellerUseOneRemoteFetch(t *testing.T) {
	var fetches atomic.Int32
	sellerID := time.Now().UnixNano()
	enricher := &SellerEnricher{
		domain: "www.vinted.de", cacheTTL: time.Minute,
		remoteFetch: func(ctx context.Context, sellerID int64) (SellerInfo, error) {
			fetches.Add(1)
			select {
			case <-time.After(25 * time.Millisecond):
				return SellerInfo{Region: "🇩🇪 DE", RatingAvailable: true}, nil
			case <-ctx.Done():
				return SellerInfo{}, ctx.Err()
			}
		},
	}
	engine := &Engine{sellerFlights: make(map[string]*sellerFetchFlight)}
	var wg sync.WaitGroup
	for i := 0; i < 32; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := engine.fetchSellerInfo(context.Background(), enricher, sellerID); err != nil {
				t.Errorf("fetch seller: %v", err)
			}
		}()
	}
	wg.Wait()
	if got := fetches.Load(); got != 1 {
		t.Fatalf("remote fetches = %d, want 1", got)
	}
}

func TestSellerInfoCache_Miss(t *testing.T) {
	cache := &sellerInfoCache{
		cache: make(map[string]sellerCacheEntry, 16),
	}

	_, ok := cache.Get("www.vinted.de", 999, time.Minute)
	if ok {
		t.Error("Expected cache miss for non-existent user")
	}
}

func TestSellerInfoCache_Overwrite(t *testing.T) {
	cache := &sellerInfoCache{
		cache: make(map[string]sellerCacheEntry, 16),
	}

	cache.Set("www.vinted.de", 1, SellerInfo{Region: "🇩🇪 DE"}, time.Now())
	cache.Set("www.vinted.de", 1, SellerInfo{Region: "🇫🇷 FR"}, time.Now())

	got, _ := cache.Get("www.vinted.de", 1, time.Minute)
	if got.Region != "🇫🇷 FR" {
		t.Errorf("Overwritten region = %q, want '🇫🇷 FR'", got.Region)
	}
}

func TestISOCountryMap_Coverage(t *testing.T) {
	expectedCodes := []string{"DE", "FR", "IT", "ES", "NL", "PL", "AT", "BE", "GB", "UK", "LU", "PT"}
	for _, code := range expectedCodes {
		if _, ok := isoCountryMap[code]; !ok {
			t.Errorf("isoCountryMap missing code %q", code)
		}
	}
}

func TestIsSellerInfoComplete(t *testing.T) {
	if isSellerInfoComplete(SellerInfo{Region: "🇩🇪 DE"}) {
		t.Fatal("expected incomplete info when rating is missing")
	}
	if !isSellerInfoComplete(SellerInfo{Region: "🇩🇪 DE", Rating: "⭐ 5.0 (1)", RatingAvailable: true}) {
		t.Fatal("expected complete info when region and rating are present")
	}
}

func TestNormalizeSellerRating(t *testing.T) {
	display, stars, count, available := normalizeSellerRating(58, 0.981)
	if !available || display != "⭐ 4.9 (58)" || stars != 4.9 || count != 58 {
		t.Fatalf("normalized rating = %q %.1f %d %v", display, stars, count, available)
	}

	display, stars, count, available = normalizeSellerRating(0, 0)
	if !available || display != "No rating" || stars != 0 || count != 0 {
		t.Fatalf("unrated seller = %q %.1f %d %v", display, stars, count, available)
	}

	if _, _, _, available = normalizeSellerRating(10, 1.2); available {
		t.Fatal("malformed reputation unexpectedly became available")
	}
}
