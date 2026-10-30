package database

import (
	"context"
	"database/sql"
	"fmt"
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
			protocol TEXT NOT NULL DEFAULT 'http',
			host TEXT NOT NULL DEFAULT 'proxy.invalid',
			port INTEGER NOT NULL DEFAULT 80,
			source TEXT NOT NULL DEFAULT 'iplocate',
			sources TEXT[] NOT NULL DEFAULT '{}',
			status TEXT NOT NULL DEFAULT 'pending',
			success_count INTEGER NOT NULL DEFAULT 0,
			failure_count INTEGER NOT NULL DEFAULT 0,
			last_success_at TIMESTAMP,
			last_checked_at TIMESTAMP,
			last_error TEXT,
			last_error_code TEXT,
			last_seen_at TIMESTAMP DEFAULT NOW() - INTERVAL '2 days',
			quarantined_until TIMESTAMP,
			check_claimed_until TIMESTAMP,
			updated_at TIMESTAMP NOT NULL DEFAULT NOW()
		);
		CREATE TEMP TABLE free_proxy_health (
			id BIGSERIAL PRIMARY KEY,
			proxy_id INTEGER NOT NULL REFERENCES free_proxies(id) ON DELETE CASCADE,
			region TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'pending',
			success_streak INTEGER NOT NULL DEFAULT 0,
			success_count INTEGER NOT NULL DEFAULT 0,
			last_success_at TIMESTAMP,
			failure_count INTEGER NOT NULL DEFAULT 0,
			failure_streak INTEGER NOT NULL DEFAULT 0,
			last_error TEXT,
			last_checked_at TIMESTAMP,
			next_check_at TIMESTAMP,
			candidate_window_token BIGINT DEFAULT FLOOR(EXTRACT(EPOCH FROM NOW()) / 3600)::bigint,
			score INTEGER NOT NULL DEFAULT 0,
			updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
			UNIQUE (proxy_id, region)
		);
		CREATE TEMP TABLE free_proxy_source_health_stats (
			region TEXT NOT NULL,
			source TEXT NOT NULL,
			protocol TEXT NOT NULL,
			success_count INTEGER NOT NULL DEFAULT 0,
			failure_count INTEGER NOT NULL DEFAULT 0,
			success_ewma DOUBLE PRECISION NOT NULL DEFAULT 0.5,
			PRIMARY KEY (region, source, protocol)
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

func TestPruneFreeProxyImportExpiresHistoricalSuccessOnlyAfterRetention(t *testing.T) {
	store := freeProxyImportTestStore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_, err := store.db.ExecContext(ctx, `
		INSERT INTO free_proxies (proxy_url, success_count, last_seen_at, last_success_at)
		SELECT 'http://' || name || '.invalid:80', 5,
			NOW() - INTERVAL '8 days', NOW() - INTERVAL '8 days'
		FROM unnest(ARRAY['expired-global', 'expired-regional', 'recent-global',
			'recent-regional', 'recent-feed', 'current-feed', 'claimed', 'disabled',
			'manual', 'unknown-source', 'retained-seven-days']) name;
		UPDATE free_proxies SET last_success_at = NOW() - INTERVAL '2 days'
			WHERE proxy_url = 'http://recent-global.invalid:80';
		UPDATE free_proxies SET last_seen_at = NOW() - INTERVAL '2 days'
			WHERE proxy_url = 'http://recent-feed.invalid:80';
		UPDATE free_proxies SET last_seen_at = NOW() - INTERVAL '6 days'
			WHERE proxy_url = 'http://retained-seven-days.invalid:80';
		UPDATE free_proxies SET check_claimed_until = NOW() + INTERVAL '1 minute'
			WHERE proxy_url = 'http://claimed.invalid:80';
		UPDATE free_proxies SET status = 'disabled'
			WHERE proxy_url = 'http://disabled.invalid:80';
		UPDATE free_proxies SET source = 'manual'
			WHERE proxy_url = 'http://manual.invalid:80';
		UPDATE free_proxies SET source = 'custom-feed'
			WHERE proxy_url = 'http://unknown-source.invalid:80';
		INSERT INTO free_proxy_health (proxy_id, region, success_count, last_success_at)
		SELECT id, 'de', 2, CASE
			WHEN proxy_url = 'http://recent-regional.invalid:80' THEN NOW() - INTERVAL '2 days'
			ELSE NOW() - INTERVAL '8 days' END
		FROM free_proxies
		WHERE proxy_url IN ('http://recent-regional.invalid:80', 'http://expired-regional.invalid:80');`)
	if err != nil {
		t.Fatal(err)
	}
	pruned, err := store.PruneUnselectedFreeProxiesContext(ctx, []string{"http://current-feed.invalid:80"})
	if err != nil || pruned != 2 {
		t.Fatalf("historical cleanup = %d, %v; want two expired entries", pruned, err)
	}
	var remaining, regionalRows int
	if err := store.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM free_proxies`).Scan(&remaining); err != nil {
		t.Fatal(err)
	}
	if err := store.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM free_proxy_health`).Scan(&regionalRows); err != nil {
		t.Fatal(err)
	}
	if remaining != 9 || regionalRows != 1 {
		t.Fatalf("cleanup removed protected inventory or retained expired history: proxies=%d regional=%d", remaining, regionalRows)
	}
	var expired int
	if err := store.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM free_proxies WHERE proxy_url LIKE 'http://expired-%'`).Scan(&expired); err != nil {
		t.Fatal(err)
	}
	if expired != 0 {
		t.Fatal("expired historical successes still occupy inventory capacity")
	}
}

func TestPruneFreeProxyImportRenewsFullInventoryWithHistoricalSuccesses(t *testing.T) {
	store := freeProxyImportTestStore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	_, err := store.db.ExecContext(ctx, `
		INSERT INTO free_proxies (proxy_url, success_count, last_seen_at, last_success_at)
		SELECT 'http://existing-' || n || '.invalid:80', 5,
			NOW() - CASE WHEN n <= 1000 THEN INTERVAL '8 days' ELSE INTERVAL '1 hour' END,
			NOW() - CASE WHEN n <= 1000 THEN INTERVAL '8 days' ELSE INTERVAL '1 hour' END
		FROM generate_series(1, 30000) n;
		INSERT INTO free_proxy_health (proxy_id, region, success_count, last_success_at)
		SELECT id, 'de', 5, last_success_at FROM free_proxies;`)
	if err != nil {
		t.Fatal(err)
	}
	pruned, err := store.PruneUnselectedFreeProxiesContext(ctx, []string{"http://new-0.invalid:80"})
	if err != nil || pruned != 1000 {
		t.Fatalf("full inventory cleanup = %d, %v; want 1000 expired historical entries", pruned, err)
	}
	replacements := make([]FreeProxyRecord, 1000)
	for i := range replacements {
		host := fmt.Sprintf("new-%d.invalid", i)
		replacements[i] = FreeProxyRecord{ProxyURL: "http://" + host + ":80", Protocol: "http", Host: host, Port: 80, Source: "iplocate"}
	}
	if processed, err := store.UpsertFreeProxiesContext(ctx, replacements); err != nil || processed != 1000 {
		t.Fatalf("replacement import = %d, %v", processed, err)
	}
	var total, healthyRetained, newCount int
	if err := store.db.QueryRowContext(ctx, `
		SELECT COUNT(*), COUNT(*) FILTER (WHERE last_success_at > NOW() - INTERVAL '1 day'),
			COUNT(*) FILTER (WHERE proxy_url LIKE 'http://new-%') FROM free_proxies`).Scan(&total, &healthyRetained, &newCount); err != nil {
		t.Fatal(err)
	}
	if total != 30000 || healthyRetained != 29000 || newCount != 1000 {
		t.Fatalf("inventory failed to renew within cap: total=%d healthy=%d new=%d", total, healthyRetained, newCount)
	}
}
