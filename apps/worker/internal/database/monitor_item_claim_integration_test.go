package database

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"vintrack-worker/internal/cache"
)

func TestMonitorItemClaimChecksDurableHistory(t *testing.T) {
	databaseURL := os.Getenv("MONITOR_ITEM_INTEGRATION_DATABASE_URL")
	redisAddr := os.Getenv("REDIS_INTEGRATION_ADDR")
	if databaseURL == "" || redisAddr == "" {
		t.Skip("MONITOR_ITEM_INTEGRATION_DATABASE_URL and REDIS_INTEGRATION_ADDR are required")
	}
	db, err := sql.Open("postgres", databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	redisCache, err := cache.NewRedisCache(redisAddr, os.Getenv("REDIS_INTEGRATION_PASSWORD"), 15)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { redisCache.Close() })
	store := &Store{db: db, cache: redisCache}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	suffix := time.Now().UnixNano()
	userID := fmt.Sprintf("monitor-claim-test-%d", suffix)
	if _, err := db.ExecContext(ctx, `INSERT INTO "User" (id, email, role) VALUES ($1, $2, 'free')`, userID, userID+"@example.test"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = db.Exec(`DELETE FROM "User" WHERE id = $1`, userID) })
	var monitorID, otherMonitorID int
	for _, target := range []*int{&monitorID, &otherMonitorID} {
		if err := db.QueryRowContext(ctx, `INSERT INTO monitors ("userId", name, query, status, region)
			VALUES ($1, 'Claim test', 'camera', 'paused', 'pl') RETURNING id`, userID).Scan(target); err != nil {
			t.Fatal(err)
		}
	}

	// Seed only the durable item, without Redis keys, detection telemetry or
	// outbox rows. This is the production state after those records expire.
	oldItemID := suffix
	if _, err := db.ExecContext(ctx, `INSERT INTO items (id, monitor_id, title, price, url, image_url, found_at)
		VALUES ($1, $2, 'Old camera', '10 PLN', '/items/old-camera', '', NOW() - INTERVAL '24 days')`, oldItemID, monitorID); err != nil {
		t.Fatal(err)
	}
	for _, source := range []string{"canonical", "discovery"} {
		if store.ClaimMonitorItem(ctx, monitorID, oldItemID, source) {
			t.Fatalf("%s reclaimed an item saved 24 days ago with an empty Redis history", source)
		}
	}
	if !store.ClaimMonitorItem(ctx, otherMonitorID, oldItemID, "canonical") {
		t.Fatal("history in one monitor must not suppress a different monitor")
	}

	t.Run("new item has one owner across sources", func(t *testing.T) {
		assertSingleMonitorItemClaim(t, store, monitorID, suffix+1)
	})
	t.Run("Postgres fallback is atomic without Redis", func(t *testing.T) {
		assertSingleMonitorItemClaim(t, &Store{db: db}, monitorID, suffix+2)
	})
	t.Run("failed history check does not poison Redis", func(t *testing.T) {
		cancelled, cancel := context.WithCancel(ctx)
		cancel()
		if store.ClaimMonitorItem(cancelled, monitorID, suffix+3, "canonical") {
			t.Fatal("cancelled history check must not allow an alert")
		}
		if !store.ClaimMonitorItem(ctx, monitorID, suffix+3, "canonical") {
			t.Fatal("failed history check consumed the item's Redis claim")
		}
	})
}

func assertSingleMonitorItemClaim(t *testing.T, store *Store, monitorID int, itemID int64) {
	t.Helper()
	var claimed atomic.Int32
	var wg sync.WaitGroup
	for index := range 16 {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			source := "canonical"
			if index%2 != 0 {
				source = "discovery"
			}
			if store.ClaimMonitorItem(context.Background(), monitorID, itemID, source) {
				claimed.Add(1)
			}
		}(index)
	}
	wg.Wait()
	if got := claimed.Load(); got != 1 {
		t.Fatalf("claims=%d, want exactly one owner", got)
	}
}
