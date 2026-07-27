package database

import (
	"context"
	"database/sql"
	"os"
	"testing"
	"time"

	_ "github.com/lib/pq"
)

func TestFreeProxyStoreQueriesAgainstPostgres(t *testing.T) {
	databaseURL := os.Getenv("FREE_PROXY_STORE_INTEGRATION_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("FREE_PROXY_STORE_INTEGRATION_DATABASE_URL is not set")
	}

	db, err := sql.Open("postgres", databaseURL)
	if err != nil {
		t.Fatalf("open postgres: %v", err)
	}
	defer db.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	store := &Store{db: db}
	const proxyURL = "http://vintrack-free-proxy-sqlcheck.invalid:1"
	const region = "sqlcheck"
	defer db.ExecContext(context.Background(), `DELETE FROM free_proxies WHERE proxy_url = $1`, proxyURL)

	if _, err := store.UpsertFreeProxiesContext(ctx, []FreeProxyRecord{{
		ProxyURL: proxyURL,
		Protocol: "http",
		Host:     "vintrack-free-proxy-sqlcheck.invalid",
		Port:     1,
		Source:   "sqlcheck",
		Sources:  []string{"sqlcheck", "secondary"},
	}}); err != nil {
		t.Fatalf("upsert free proxy: %v", err)
	}
	if _, err := db.ExecContext(ctx, `
		INSERT INTO free_proxy_health (proxy_id, region, status, next_check_at, updated_at)
		SELECT id, $2, 'pending', NOW(), NOW()
		FROM free_proxies
		WHERE proxy_url = $1
		ON CONFLICT (proxy_id, region) DO UPDATE
		SET status = 'pending', next_check_at = NOW(), updated_at = NOW()`,
		proxyURL,
		region,
	); err != nil {
		t.Fatalf("seed health row: %v", err)
	}

	candidates, err := store.ClaimFreeProxiesDueForCheck(ctx, []string{region}, 3, true)
	if err != nil {
		t.Fatalf("claim due proxies: %v", err)
	}
	if len(candidates) != 1 || candidates[0].Protocol != "http" {
		t.Fatalf("claimed candidates = %#v, want one HTTP proxy", candidates)
	}
	if err := store.RecordFreeProxyFailureClassContext(
		ctx,
		proxyURL,
		region,
		0,
		"dial tcp: connection refused",
		"connect",
		3,
		30,
	); err != nil {
		t.Fatalf("record transport failure: %v", err)
	}
	if err := store.RecordFreeProxyFailureClassContext(
		ctx,
		proxyURL,
		region,
		503,
		"catalog returned 503",
		"upstream_5xx",
		3,
		30,
	); err != nil {
		t.Fatalf("record upstream failure: %v", err)
	}
	if err := store.RecordFreeProxySuccessContext(ctx, proxyURL, region, 250); err != nil {
		t.Fatalf("record success: %v", err)
	}
}
