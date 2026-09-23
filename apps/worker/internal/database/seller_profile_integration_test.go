package database

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"testing"
	"time"

	"vintrack-worker/internal/cache"

	_ "github.com/lib/pq"
)

func TestSellerProfileCacheAgainstPostgres(t *testing.T) {
	databaseURL := os.Getenv("SELLER_PROFILE_INTEGRATION_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("SELLER_PROFILE_INTEGRATION_DATABASE_URL is not set")
	}
	db, err := sql.Open("postgres", databaseURL)
	if err != nil {
		t.Fatalf("open postgres: %v", err)
	}
	defer db.Close()
	store := &Store{db: db}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	suffix := time.Now().UnixNano()
	domain := fmt.Sprintf("seller-cache-%d.invalid", suffix)
	sellerID := suffix
	defer db.ExecContext(context.Background(),
		`DELETE FROM seller_profiles WHERE domain = $1 AND seller_id = $2`,
		domain,
		sellerID,
	)

	fetchedAt := time.Now().UTC().Add(-time.Minute).Truncate(time.Microsecond)
	want := cache.SellerInfo{
		Region: "🇩🇪 DE", Rating: "⭐ 4.8 (42)", RatingStars: 4.8,
		RatingCount: 42, RatingAvailable: true, FetchedAt: fetchedAt,
	}
	if err := store.SetSellerInfoCache(ctx, domain, sellerID, want, 24*time.Hour); err != nil {
		t.Fatalf("upsert seller profile: %v", err)
	}
	got, ok := store.GetSellerProfile(ctx, domain, sellerID)
	if !ok {
		t.Fatal("seller profile was not readable")
	}
	if got.Region != want.Region || got.Rating != want.Rating ||
		got.RatingStars != want.RatingStars || got.RatingCount != want.RatingCount ||
		!got.RatingAvailable || !got.FetchedAt.Equal(want.FetchedAt) {
		t.Fatalf("seller profile = %#v, want %#v", got, want)
	}

	older := want
	older.Region = "🇫🇷 FR"
	older.FetchedAt = fetchedAt.Add(-time.Hour)
	if err := store.SetSellerInfoCache(ctx, domain, sellerID, older, 24*time.Hour); err != nil {
		t.Fatalf("write older seller profile: %v", err)
	}
	got, ok = store.GetSellerProfile(ctx, domain, sellerID)
	if !ok || got.Region != want.Region || !got.FetchedAt.Equal(want.FetchedAt) {
		t.Fatalf("older refresh overwrote current profile: %#v", got)
	}
}
