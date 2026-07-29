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
	if _, err := db.ExecContext(ctx, `
		INSERT INTO free_proxy_health (proxy_id, region, status, next_check_at, updated_at)
		SELECT id, 'sqlother', 'pending', NOW(), NOW()
		FROM free_proxies
		WHERE proxy_url = $1
		ON CONFLICT (proxy_id, region) DO UPDATE
		SET status = 'pending', next_check_at = NOW(), updated_at = NOW()`, proxyURL); err != nil {
		t.Fatalf("seed other health row: %v", err)
	}

	candidates, err := store.ClaimFreeProxiesDueForCheck(ctx, []string{region}, 3, true)
	if err != nil {
		t.Fatalf("claim due proxies: %v", err)
	}
	if len(candidates) != 1 || candidates[0].Protocol != "http" {
		t.Fatalf("claimed candidates = %#v, want one HTTP proxy", candidates)
	}
	duplicateCandidates, err := store.ClaimFreeProxiesDueForCheck(
		ctx,
		[]string{"sqlother"},
		3,
		true,
	)
	if err != nil {
		t.Fatalf("claim same proxy in another region: %v", err)
	}
	if len(duplicateCandidates) != 0 {
		t.Fatalf(
			"cross-region duplicate candidates = %#v, want active global lease",
			duplicateCandidates,
		)
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
	if _, err := db.ExecContext(ctx, `
		INSERT INTO free_proxy_health (proxy_id, region, status, next_check_at, updated_at)
		SELECT id, 'sqlother', 'pending', NOW(), NOW()
		FROM free_proxies
		WHERE proxy_url = $1
		ON CONFLICT (proxy_id, region) DO UPDATE
		SET next_check_at = NOW(), updated_at = NOW()`, proxyURL); err != nil {
		t.Fatalf("seed other region health row: %v", err)
	}
	if err := store.RecordFreeProxyFailureClassContext(
		ctx,
		proxyURL,
		region,
		0,
		"read timeout after prior success",
		"timeout",
		3,
		30,
	); err != nil {
		t.Fatalf("record proven proxy timeout: %v", err)
	}

	active, err := store.GetActiveFreeProxiesContext(ctx, region, 10)
	if err != nil {
		t.Fatalf("get active proxies after isolated timeout: %v", err)
	}
	if len(active) != 1 || active[0] != proxyURL {
		t.Fatalf("active proxies after isolated timeout = %#v, want proven proxy", active)
	}
	if err := store.RecordFreeProxyFailureClassContext(
		ctx,
		proxyURL,
		region,
		0,
		"second read timeout after prior success",
		"timeout",
		3,
		30,
	); err != nil {
		t.Fatalf("record second proven proxy timeout: %v", err)
	}
	active, err = store.GetActiveFreeProxiesContext(ctx, region, 10)
	if err != nil {
		t.Fatalf("get reserve proxies after second timeout: %v", err)
	}
	if len(active) != 1 || active[0] != proxyURL {
		t.Fatalf("reserve proxies after second timeout = %#v, want proven proxy", active)
	}

	var quarantinedUntil sql.NullTime
	if err := db.QueryRowContext(ctx, `
		SELECT quarantined_until
		FROM free_proxies
		WHERE proxy_url = $1`, proxyURL).Scan(&quarantinedUntil); err != nil {
		t.Fatalf("read proven proxy quarantine: %v", err)
	}
	if quarantinedUntil.Valid {
		t.Fatalf("proven proxy received global quarantine until %v", quarantinedUntil.Time)
	}

	var otherNextCheck time.Time
	if err := db.QueryRowContext(ctx, `
		SELECT fph.next_check_at
		FROM free_proxy_health fph
		JOIN free_proxies fp ON fp.id = fph.proxy_id
		WHERE fp.proxy_url = $1
		  AND fph.region = 'sqlother'`, proxyURL).Scan(&otherNextCheck); err != nil {
		t.Fatalf("read other region next check: %v", err)
	}
	if otherNextCheck.After(time.Now().Add(time.Minute)) {
		t.Fatalf("proven proxy timeout delayed another region until %v", otherNextCheck)
	}

	maintenanceCandidates, err := store.ClaimFreeProxiesDueForCheck(
		ctx,
		[]string{"sqlother"},
		3,
		false,
	)
	if err != nil {
		t.Fatalf("claim maintenance proxies: %v", err)
	}
	if len(maintenanceCandidates) != 0 {
		t.Fatalf(
			"maintenance candidates = %#v, want no pending discovery candidates",
			maintenanceCandidates,
		)
	}
}
