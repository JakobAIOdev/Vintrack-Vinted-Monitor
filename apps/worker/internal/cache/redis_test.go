package cache

import (
	"fmt"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestSeenBucketKeysCoverEightUTCDateBuckets(t *testing.T) {
	now := time.Date(2026, time.September, 13, 0, 30, 0, 0, time.FixedZone("CEST", 2*60*60))
	keys := seenBucketKeys(42, now)
	if len(keys) != seenBucketDays {
		t.Fatalf("bucket count = %d, want %d", len(keys), seenBucketDays)
	}
	if keys[0] != "item:seen:v2:42:2026-09-12" {
		t.Fatalf("current UTC bucket = %q", keys[0])
	}
	if keys[7] != "item:seen:v2:42:2026-09-05" {
		t.Fatalf("oldest UTC bucket = %q", keys[7])
	}
}

func TestSeenBucketExpiryIsFixedAtEightUTCMidnights(t *testing.T) {
	now := time.Date(2026, time.September, 13, 23, 59, 0, 0, time.UTC)
	want := time.Date(2026, time.September, 21, 0, 0, 0, 0, time.UTC)
	if got := seenBucketExpiresAt(now); !got.Equal(want) {
		t.Fatalf("expiry = %s, want %s", got, want)
	}
}

func TestRedisSeenV2ClaimsAreAtomicAndDualReadLegacy(t *testing.T) {
	addr := os.Getenv("REDIS_INTEGRATION_ADDR")
	if addr == "" {
		t.Skip("REDIS_INTEGRATION_ADDR is not set")
	}
	cache, err := NewRedisCache(addr, os.Getenv("REDIS_INTEGRATION_PASSWORD"), 15)
	if err != nil {
		t.Fatalf("connect redis: %v", err)
	}
	defer cache.client.Close()

	now := time.Now()
	monitorID := int(now.UnixNano()%90_000_000) + 10_000_000
	itemID := now.UnixNano()
	otherItemID := itemID + 1
	legacyKey := fmt.Sprintf("item:seen:%d:%d", monitorID, itemID)
	keys := append([]string{legacyKey}, seenBucketKeys(monitorID, now)...)
	defer cache.client.Del(cache.ctx, keys...)

	if err := cache.client.Set(cache.ctx, legacyKey, "discovery", time.Hour).Err(); err != nil {
		t.Fatalf("seed legacy key: %v", err)
	}
	isNew, err := cache.BatchIsNew(monitorID, []int64{itemID, otherItemID})
	if err != nil {
		t.Fatalf("batch dual-read: %v", err)
	}
	if isNew[itemID] || !isNew[otherItemID] {
		t.Fatalf("dual-read result = %#v, want legacy item seen and unknown item new", isNew)
	}
	if claimed, err := cache.ClaimMonitorItem(monitorID, itemID, "canonical"); err != nil || claimed {
		t.Fatalf("legacy claim = %v, %v; want already claimed", claimed, err)
	}
	if err := cache.client.Del(cache.ctx, legacyKey).Err(); err != nil {
		t.Fatalf("delete legacy key: %v", err)
	}

	var claims atomic.Int32
	var wg sync.WaitGroup
	errs := make(chan error, 32)
	for index := 0; index < 32; index++ {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			source := "canonical"
			if index%2 == 0 {
				source = "discovery"
			}
			claimed, claimErr := cache.ClaimMonitorItem(monitorID, itemID, source)
			if claimErr != nil {
				errs <- claimErr
				return
			}
			if claimed {
				claims.Add(1)
			}
		}(index)
	}
	wg.Wait()
	close(errs)
	for claimErr := range errs {
		t.Errorf("concurrent claim: %v", claimErr)
	}
	if got := claims.Load(); got != 1 {
		t.Fatalf("successful claims = %d, want exactly 1", got)
	}

	currentBucket := seenBucketKey(monitorID, now)
	if seen, err := cache.client.SIsMember(cache.ctx, currentBucket, itemID).Result(); err != nil || !seen {
		t.Fatalf("v2 membership = %v, %v; want true", seen, err)
	}
	ttl, err := cache.client.TTL(cache.ctx, currentBucket).Result()
	if err != nil {
		t.Fatalf("v2 ttl: %v", err)
	}
	wantTTL := time.Until(seenBucketExpiresAt(now))
	if ttl < wantTTL-5*time.Second || ttl > wantTTL+5*time.Second {
		t.Fatalf("v2 ttl = %s, want approximately %s", ttl, wantTTL)
	}

	previousBucket := seenBucketKey(monitorID, now.AddDate(0, 0, -1))
	if err := cache.client.SAdd(cache.ctx, previousBucket, otherItemID).Err(); err != nil {
		t.Fatalf("seed previous v2 bucket: %v", err)
	}
	if claimed, err := cache.ClaimMonitorItem(monitorID, otherItemID, "canonical"); err != nil || claimed {
		t.Fatalf("previous-bucket claim = %v, %v; want already claimed", claimed, err)
	}
}
