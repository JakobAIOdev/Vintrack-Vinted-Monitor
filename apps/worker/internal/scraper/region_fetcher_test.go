package scraper

import (
	"context"
	"errors"
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

func TestClassifySellerFetchError(t *testing.T) {
	if kind := classifySellerFetchError(nil); kind != failureNone {
		t.Fatalf("nil error classified as %v, want failureNone", kind)
	}
	if kind := classifySellerFetchError(context.DeadlineExceeded); kind != failureTimeout {
		t.Fatalf("context.DeadlineExceeded classified as %v, want failureTimeout", kind)
	}
	if kind := classifySellerFetchError(context.Canceled); kind != failureCanceled {
		t.Fatalf("context.Canceled classified as %v, want failureCanceled", kind)
	}
	wrapped := &sellerFetchError{kind: failureRateLimited, status: 429, err: errors.New("seller api status 429")}
	if kind := classifySellerFetchError(wrapped); kind != failureRateLimited {
		t.Fatalf("wrapped 429 classified as %v, want failureRateLimited", kind)
	}
	if kind := classifySellerFetchError(errors.New("boom")); kind != failureUnknown {
		t.Fatalf("plain error classified as %v, want failureUnknown", kind)
	}
}

func TestClassifyHTTPStatus(t *testing.T) {
	cases := map[int]sellerFetchFailureKind{
		0:   failureNetwork,
		401: failureAuth,
		403: failureAuth,
		429: failureRateLimited,
		500: failureServerError,
		503: failureServerError,
		404: failureUnknown,
	}
	for status, want := range cases {
		if got := classifyHTTPStatus(status); got != want {
			t.Errorf("classifyHTTPStatus(%d) = %v, want %v", status, got, want)
		}
	}
}

// TestNegativeCacheCoalescesRepeatedFailure pins the burst scenario the
// negative cache exists for: several items from the same known-bad seller
// arriving a little apart (after the failing fetch's own single-flight has
// already closed) must not each pay for a fresh remote round trip.
func TestNegativeCacheCoalescesRepeatedFailure(t *testing.T) {
	var fetches atomic.Int32
	sellerID := time.Now().UnixNano()
	enricher := &SellerEnricher{
		domain: "www.vinted.de", cacheTTL: time.Minute, negativeTTL: time.Hour,
		remoteFetch: func(ctx context.Context, sellerID int64) (SellerInfo, error) {
			fetches.Add(1)
			return SellerInfo{}, &sellerFetchError{kind: failureAuth, status: 401, err: errors.New("seller api status 401")}
		},
	}

	if _, err := enricher.FetchSellerInfo(context.Background(), sellerID); err == nil {
		t.Fatal("expected first fetch to fail")
	}
	if got := fetches.Load(); got != 1 {
		t.Fatalf("fetches after first attempt = %d, want 1", got)
	}

	// A second item for the same seller arrives after the first flight has
	// already closed; it must be served from the negative cache, not the
	// network.
	if _, err := enricher.FetchSellerInfo(context.Background(), sellerID); err == nil {
		t.Fatal("expected negative-cache hit to still report failure")
	}
	if got := fetches.Load(); got != 1 {
		t.Fatalf("fetches after negative-cache hit = %d, want still 1", got)
	}
}

// TestNegativeCacheExpiresAndRetries confirms the short-circuit is bounded:
// once the negative TTL elapses, a fresh attempt is made rather than serving
// a stale failure forever.
func TestNegativeCacheExpiresAndRetries(t *testing.T) {
	var fetches atomic.Int32
	sellerID := time.Now().UnixNano()
	enricher := &SellerEnricher{
		domain: "www.vinted.de", cacheTTL: time.Minute, negativeTTL: 15 * time.Millisecond,
		remoteFetch: func(ctx context.Context, sellerID int64) (SellerInfo, error) {
			fetches.Add(1)
			return SellerInfo{}, &sellerFetchError{kind: failureServerError, status: 503, err: errors.New("seller api status 503")}
		},
	}

	if _, err := enricher.FetchSellerInfo(context.Background(), sellerID); err == nil {
		t.Fatal("expected first fetch to fail")
	}
	time.Sleep(30 * time.Millisecond)
	if _, err := enricher.FetchSellerInfo(context.Background(), sellerID); err == nil {
		t.Fatal("expected second fetch to fail")
	}
	if got := fetches.Load(); got != 2 {
		t.Fatalf("fetches after negative-cache expiry = %d, want 2", got)
	}
}

// TestNegativeCacheExcludesTimeoutAndCanceled pins the safety rule that a
// caller-deadline-shaped failure (timeout or cancellation) is never cached:
// caching it would risk a strict retry with a fresh, longer budget being
// served a stale "it failed" answer that was really about someone else's
// short remaining time, not the seller.
func TestNegativeCacheExcludesTimeoutAndCanceled(t *testing.T) {
	var fetches atomic.Int32
	sellerID := time.Now().UnixNano()
	enricher := &SellerEnricher{
		domain: "www.vinted.de", cacheTTL: time.Minute, negativeTTL: time.Hour,
		remoteFetch: func(ctx context.Context, sellerID int64) (SellerInfo, error) {
			fetches.Add(1)
			return SellerInfo{}, context.DeadlineExceeded
		},
	}

	if _, err := enricher.FetchSellerInfo(context.Background(), sellerID); err == nil {
		t.Fatal("expected first fetch to fail")
	}
	if _, err := enricher.FetchSellerInfo(context.Background(), sellerID); err == nil {
		t.Fatal("expected second fetch to fail")
	}
	if got := fetches.Load(); got != 2 {
		t.Fatalf("fetches after timeout = %d, want 2 (timeout must not be negative-cached)", got)
	}
}

// TestNegativeCacheNeverMasksAsRealResult confirms a negative-cache hit
// always returns the same sentinel-failure shape a fresh miss would, never a
// fabricated SellerInfo that could be mistaken for a genuine "no rating"
// result by isSellerInfoComplete or downstream strict-filter checks.
func TestNegativeCacheNeverMasksAsRealResult(t *testing.T) {
	sellerID := time.Now().UnixNano()
	enricher := &SellerEnricher{
		domain: "www.vinted.de", cacheTTL: time.Minute, negativeTTL: time.Hour,
		remoteFetch: func(ctx context.Context, sellerID int64) (SellerInfo, error) {
			return SellerInfo{}, &sellerFetchError{kind: failureDecodeError, err: errors.New("decode error")}
		},
	}
	if _, err := enricher.FetchSellerInfo(context.Background(), sellerID); err == nil {
		t.Fatal("expected first fetch to fail")
	}
	info, err := enricher.FetchSellerInfo(context.Background(), sellerID)
	if err == nil {
		t.Fatal("expected negative-cache hit to report failure")
	}
	if isSellerInfoComplete(info) {
		t.Fatalf("negative-cache hit produced a complete SellerInfo: %#v", info)
	}
	if info.RatingAvailable {
		t.Fatalf("negative-cache hit fabricated RatingAvailable=true: %#v", info)
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
