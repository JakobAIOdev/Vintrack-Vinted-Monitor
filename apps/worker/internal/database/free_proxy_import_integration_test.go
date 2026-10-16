package database

import (
	"context"
	"database/sql"
	"os"
	"testing"
	"time"
)

// Temporary tables shadow any existing application tables. One connection
// keeps every store query in this isolated session; no shared rows are touched.
func freeProxyImportTestStore(t *testing.T) *Store {
	t.Helper()
	databaseURL := os.Getenv("FREE_PROXY_STORE_INTEGRATION_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("FREE_PROXY_STORE_INTEGRATION_DATABASE_URL is not set")
	}
	db, err := sql.Open("postgres", databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	db.SetMaxOpenConns(1)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_, err = db.ExecContext(ctx, `
		CREATE TEMP TABLE free_proxies (
			id SERIAL PRIMARY KEY,
			proxy_url TEXT NOT NULL UNIQUE,
			source TEXT NOT NULL DEFAULT 'iplocate',
			status TEXT NOT NULL DEFAULT 'pending',
			success_count INTEGER NOT NULL DEFAULT 0,
			last_success_at TIMESTAMP,
			last_checked_at TIMESTAMP,
			last_seen_at TIMESTAMP DEFAULT NOW() - INTERVAL '2 days',
			check_claimed_until TIMESTAMP
		);
		CREATE TEMP TABLE free_proxy_health (
			proxy_id INTEGER NOT NULL REFERENCES free_proxies(id) ON DELETE CASCADE,
			region TEXT NOT NULL,
			last_success_at TIMESTAMP,
			PRIMARY KEY (proxy_id, region)
		);`)
	if err != nil {
		t.Fatal(err)
	}
	return &Store{db: db}
}

func TestPruneFreeProxyImportReclaimsStaleUntestedWithoutRemovingProtectedProxies(t *testing.T) {
	store := freeProxyImportTestStore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_, err := store.db.ExecContext(ctx, `
		INSERT INTO free_proxies (proxy_url) VALUES
			('http://stale-untested.invalid:80'),
			('http://stale-failed.invalid:80'),
			('http://expired-claim.invalid:80'),
			('http://current-feed.invalid:80'),
			('http://recent.invalid:80'),
			('http://unknown-freshness.invalid:80'),
			('http://global-success.invalid:80'),
			('http://global-success-time.invalid:80'),
			('http://regional-success.invalid:80'),
			('http://claimed.invalid:80'),
			('http://disabled.invalid:80'),
			('http://manual.invalid:80');
		UPDATE free_proxies SET last_checked_at = NOW() - INTERVAL '2 days'
			WHERE proxy_url = 'http://stale-failed.invalid:80';
		UPDATE free_proxies SET check_claimed_until = NOW() - INTERVAL '1 minute'
			WHERE proxy_url = 'http://expired-claim.invalid:80';
		UPDATE free_proxies SET last_seen_at = NOW()
			WHERE proxy_url = 'http://recent.invalid:80';
		UPDATE free_proxies SET last_seen_at = NULL
			WHERE proxy_url = 'http://unknown-freshness.invalid:80';
		UPDATE free_proxies SET success_count = 1
			WHERE proxy_url = 'http://global-success.invalid:80';
		UPDATE free_proxies SET last_success_at = NOW()
			WHERE proxy_url = 'http://global-success-time.invalid:80';
		INSERT INTO free_proxy_health (proxy_id, region, last_success_at)
			SELECT id, 'de', NOW() FROM free_proxies
			WHERE proxy_url = 'http://regional-success.invalid:80';
		INSERT INTO free_proxy_health (proxy_id, region)
			SELECT id, 'de' FROM free_proxies
			WHERE proxy_url = 'http://stale-untested.invalid:80';
		UPDATE free_proxies SET check_claimed_until = NOW() + INTERVAL '5 minutes'
			WHERE proxy_url = 'http://claimed.invalid:80';
		UPDATE free_proxies SET status = 'disabled'
			WHERE proxy_url = 'http://disabled.invalid:80';
		UPDATE free_proxies SET source = 'manual'
			WHERE proxy_url = 'http://manual.invalid:80';`)
	if err != nil {
		t.Fatal(err)
	}
	pruned, err := store.PruneUnselectedFreeProxiesContext(ctx, []string{"http://current-feed.invalid:80"})
	if err != nil {
		t.Fatal(err)
	}
	if pruned != 3 {
		t.Fatalf("pruned %d proxies, want the stale untested/failed/expired-claim entries only", pruned)
	}
	for _, host := range []string{"current-feed", "recent", "unknown-freshness", "global-success", "global-success-time", "regional-success", "claimed", "disabled", "manual"} {
		var exists bool
		if err := store.db.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM free_proxies WHERE proxy_url = $1)`, "http://"+host+".invalid:80").Scan(&exists); err != nil {
			t.Fatal(err)
		}
		if !exists {
			t.Errorf("protected proxy %s was removed", host)
		}
	}
	var orphanChecks int
	if err := store.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM free_proxy_health WHERE last_success_at IS NULL`).Scan(&orphanChecks); err != nil {
		t.Fatal(err)
	}
	if orphanChecks != 0 {
		t.Fatal("pruned proxy retained its regional health row")
	}
}

func TestPruneFreeProxyImportBoundsCleanupAndPreservesEmptyFeedInventory(t *testing.T) {
	store := freeProxyImportTestStore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := store.db.ExecContext(ctx, `INSERT INTO free_proxies (proxy_url)
		SELECT 'http://stale-' || n || '.invalid:80' FROM generate_series(1, 1001) n`); err != nil {
		t.Fatal(err)
	}
	pruned, err := store.PruneUnselectedFreeProxiesContext(ctx, nil)
	if err != nil || pruned != 0 {
		t.Fatalf("empty feeds pruned %d proxies: %v", pruned, err)
	}
	for _, want := range []int64{1000, 1, 0} {
		pruned, err = store.PruneUnselectedFreeProxiesContext(ctx, []string{"http://new.invalid:80"})
		if err != nil || pruned != want {
			t.Fatalf("cleanup batch = %d, %v; want %d", pruned, err, want)
		}
	}
}
