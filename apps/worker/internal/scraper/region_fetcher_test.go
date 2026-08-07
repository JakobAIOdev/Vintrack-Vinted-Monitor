package scraper

import "testing"

func TestSellerInfoCache_SetAndGet(t *testing.T) {
	cache := &sellerInfoCache{
		cache: make(map[int64]sellerCacheEntry, 16),
	}

	info := SellerInfo{Region: "🇩🇪 DE", Rating: "⭐ 4.5 (10)", RatingStars: 4.5, RatingCount: 10, RatingAvailable: true}
	cache.Set(123, info)

	got, ok := cache.Get(123)
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

func TestSellerInfoCache_Miss(t *testing.T) {
	cache := &sellerInfoCache{
		cache: make(map[int64]sellerCacheEntry, 16),
	}

	_, ok := cache.Get(999)
	if ok {
		t.Error("Expected cache miss for non-existent user")
	}
}

func TestSellerInfoCache_Overwrite(t *testing.T) {
	cache := &sellerInfoCache{
		cache: make(map[int64]sellerCacheEntry, 16),
	}

	cache.Set(1, SellerInfo{Region: "🇩🇪 DE"})
	cache.Set(1, SellerInfo{Region: "🇫🇷 FR"})

	got, _ := cache.Get(1)
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
