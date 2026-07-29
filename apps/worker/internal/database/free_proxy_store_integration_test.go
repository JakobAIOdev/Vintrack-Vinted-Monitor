package database

import (
	"context"
	"database/sql"
	"os"
	"testing"
	"time"

	"github.com/lib/pq"
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
	fanoutCandidates, err := store.ClaimFreeProxiesDueForCheck(
		ctx,
		[]string{"sqlother"},
		3,
		true,
	)
	if err != nil {
		t.Fatalf("claim globally successful proxy for another region: %v", err)
	}
	if len(fanoutCandidates) != 1 || fanoutCandidates[0].ProxyURL != proxyURL {
		t.Fatalf(
			"fanout candidates = %#v, want globally successful proxy",
			fanoutCandidates,
		)
	}
	if err := store.RecordFreeProxySuccessContext(ctx, proxyURL, "sqlother", 275); err != nil {
		t.Fatalf("record fanout success: %v", err)
	}
	if _, err := db.ExecContext(ctx, `
		UPDATE free_proxy_health fph
		SET next_check_at = NOW()
		FROM free_proxies fp
		WHERE fp.id = fph.proxy_id
		  AND fp.proxy_url = $1
		  AND fph.region = 'sqlother'`, proxyURL); err != nil {
		t.Fatalf("make fanout region immediately due: %v", err)
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
	if len(maintenanceCandidates) != 1 ||
		maintenanceCandidates[0].ProxyURL != proxyURL {
		t.Fatalf(
			"maintenance candidates = %#v, want the active fanout proxy",
			maintenanceCandidates,
		)
	}

	if err := store.RecordFreeProxySuccessContext(ctx, proxyURL, region, 225); err != nil {
		t.Fatalf("reset proxy with success: %v", err)
	}
	if _, err := db.ExecContext(ctx, `
		UPDATE free_proxy_health fph
		SET next_check_at = NOW()
		FROM free_proxies fp
		WHERE fp.id = fph.proxy_id
		  AND fp.proxy_url = $1
		  AND fph.region = 'sqlother'`, proxyURL); err != nil {
		t.Fatalf("make other region due: %v", err)
	}
	if err := store.RecordFreeProxyFailureStageContext(
		ctx,
		proxyURL,
		region,
		0,
		"warmup timed out",
		"timeout",
		"warmup",
		3,
		30,
	); err != nil {
		t.Fatalf("record staged warmup failure: %v", err)
	}

	var stagedQuarantine time.Time
	var storedStage sql.NullString
	if err := db.QueryRowContext(ctx, `
		SELECT quarantined_until, last_error_stage
		FROM free_proxies
		WHERE proxy_url = $1`, proxyURL).Scan(&stagedQuarantine, &storedStage); err != nil {
		t.Fatalf("read staged global failure: %v", err)
	}
	if stagedQuarantine.Before(time.Now().Add(4 * time.Minute)) {
		t.Fatalf("warmup failure quarantine = %v, want at least about 5 minutes", stagedQuarantine)
	}
	if !storedStage.Valid || storedStage.String != "warmup" {
		t.Fatalf("global error stage = %#v, want warmup", storedStage)
	}

	if err := db.QueryRowContext(ctx, `
		SELECT fph.next_check_at
		FROM free_proxy_health fph
		JOIN free_proxies fp ON fp.id = fph.proxy_id
		WHERE fp.proxy_url = $1
		  AND fph.region = 'sqlother'`, proxyURL).Scan(&otherNextCheck); err != nil {
		t.Fatalf("read globally delayed region: %v", err)
	}
	if otherNextCheck.Before(stagedQuarantine.Add(-time.Second)) {
		t.Fatalf(
			"other region next check = %v, want global quarantine %v",
			otherNextCheck,
			stagedQuarantine,
		)
	}
}

func TestFreeProxyClaimUsesRegionalSourceProtocolYield(t *testing.T) {
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
	const (
		region     = "sqlyield"
		highSource = "sql-yield-high"
		lowSource  = "sql-yield-low"
		highURL    = "http://vintrack-free-proxy-yield-high.invalid:1"
		lowURL     = "http://vintrack-free-proxy-yield-low.invalid:1"
	)
	defer db.ExecContext(
		context.Background(),
		`DELETE FROM free_proxies WHERE source = ANY($1)`,
		pq.Array([]string{highSource, lowSource}),
	)

	for _, record := range []FreeProxyRecord{
		{
			ProxyURL: highURL,
			Protocol: "http",
			Host:     "vintrack-free-proxy-yield-high.invalid",
			Port:     1,
			Source:   highSource,
			Sources:  []string{highSource},
		},
		{
			ProxyURL: lowURL,
			Protocol: "http",
			Host:     "vintrack-free-proxy-yield-low.invalid",
			Port:     1,
			Source:   lowSource,
			Sources:  []string{lowSource},
		},
	} {
		if _, err := store.UpsertFreeProxiesContext(
			ctx,
			[]FreeProxyRecord{record},
		); err != nil {
			t.Fatalf("upsert candidate %s: %v", record.ProxyURL, err)
		}
	}

	if _, err := db.ExecContext(ctx, `
		INSERT INTO free_proxy_health (
			proxy_id,
			region,
			status,
			next_check_at,
			updated_at
		)
		SELECT id, $2, 'pending', NOW(), NOW()
		FROM free_proxies
		WHERE proxy_url = ANY($1)
		ON CONFLICT (proxy_id, region) DO UPDATE
		SET status = 'pending',
			success_count = 0,
			last_checked_at = NULL,
			last_success_at = NULL,
			last_error = NULL,
			last_status_code = NULL,
			next_check_at = NOW(),
			updated_at = NOW()`,
		pq.Array([]string{highURL, lowURL}),
		region,
	); err != nil {
		t.Fatalf("seed yield candidates: %v", err)
	}

	if _, err := db.ExecContext(ctx, `
		INSERT INTO free_proxies (
			proxy_url,
			protocol,
			host,
			port,
			source,
			status,
			last_seen_at,
			updated_at
		)
		SELECT
			'http://vintrack-free-proxy-yield-history-' || source_name || '-' || n || '.invalid:1',
			'http',
			'vintrack-free-proxy-yield-history-' || source_name || '-' || n || '.invalid',
			1,
			source_name,
			'disabled',
			NOW(),
			NOW()
		FROM unnest(ARRAY[$1::text, $2::text]) AS source_name
		CROSS JOIN generate_series(1, 20) AS n
		ON CONFLICT (proxy_url) DO UPDATE
		SET source = EXCLUDED.source,
			status = 'disabled',
			updated_at = NOW()`,
		highSource,
		lowSource,
	); err != nil {
		t.Fatalf("seed yield history proxies: %v", err)
	}
	if _, err := db.ExecContext(ctx, `
		INSERT INTO free_proxy_health (
			proxy_id,
			region,
			status,
			last_status_code,
			last_error,
			last_checked_at,
			last_success_at,
			next_check_at,
			updated_at
		)
		SELECT
			fp.id,
			$3,
			'cooldown',
			CASE WHEN fp.source = $1 AND numbered.n <= 10 THEN 200 ELSE 0 END,
			CASE WHEN fp.source = $1 AND numbered.n <= 10 THEN NULL ELSE 'timeout' END,
			NOW() - INTERVAL '5 minutes',
			CASE
				WHEN fp.source = $1 AND numbered.n <= 10
				THEN NOW() - INTERVAL '5 minutes'
				ELSE NULL
			END,
			NOW() + INTERVAL '1 hour',
			NOW()
		FROM free_proxies fp
		CROSS JOIN LATERAL (
			SELECT (
				regexp_match(fp.proxy_url, '-([0-9]+)\.invalid')
			)[1]::int AS n
		) AS numbered
		WHERE fp.source = ANY(ARRAY[$1::text, $2::text])
		  AND fp.status = 'disabled'
		ON CONFLICT (proxy_id, region) DO UPDATE
		SET status = EXCLUDED.status,
			last_status_code = EXCLUDED.last_status_code,
			last_error = EXCLUDED.last_error,
			last_checked_at = EXCLUDED.last_checked_at,
			last_success_at = EXCLUDED.last_success_at,
			next_check_at = EXCLUDED.next_check_at,
			updated_at = NOW()`,
		highSource,
		lowSource,
		region,
	); err != nil {
		t.Fatalf("seed regional yield history: %v", err)
	}

	candidates, err := store.ClaimFreeProxiesDueForCheck(
		ctx,
		[]string{region},
		1,
		true,
	)
	if err != nil {
		t.Fatalf("claim regional-yield candidate: %v", err)
	}
	if len(candidates) != 1 || candidates[0].ProxyURL != highURL {
		t.Fatalf(
			"regional-yield candidates = %#v, want %s",
			candidates,
			highURL,
		)
	}
}

func TestFreeProxyClaimFillsMultiRegionWaveAfterProxyDeduplication(t *testing.T) {
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
	const source = "sql-wave-fill"
	regions := []string{"sqlwa", "sqlwb", "sqlwc"}
	defer db.ExecContext(
		context.Background(),
		`DELETE FROM free_proxies WHERE source = $1`,
		source,
	)

	if _, err := db.ExecContext(ctx, `
		INSERT INTO free_proxies (
			proxy_url,
			protocol,
			host,
			port,
			source,
			status,
			last_seen_at,
			updated_at
		)
		SELECT
			'http://vintrack-free-proxy-wave-' || n || '.invalid:1',
			'http',
			'vintrack-free-proxy-wave-' || n || '.invalid',
			1,
			$1,
			'active',
			NOW(),
			NOW()
		FROM generate_series(1, 24) AS n
		ON CONFLICT (proxy_url) DO UPDATE
		SET source = EXCLUDED.source,
			status = 'active',
			quarantined_until = NULL,
			check_claimed_until = NULL,
			updated_at = NOW()`,
		source,
	); err != nil {
		t.Fatalf("seed multi-region wave proxies: %v", err)
	}
	if _, err := db.ExecContext(ctx, `
		INSERT INTO free_proxy_health (
			proxy_id,
			region,
			status,
			success_streak,
			success_count,
			failure_streak,
			last_checked_at,
			last_success_at,
			last_error,
			last_error_code,
			last_error_stage,
			next_check_at,
			updated_at
		)
		SELECT
			fp.id,
			region,
			'pending',
			0,
			0,
			0,
			NULL,
			NULL,
			NULL,
			NULL,
			NULL,
			NOW(),
			NOW()
		FROM free_proxies fp
		CROSS JOIN unnest($2::text[]) AS region
		WHERE fp.source = $1
		ON CONFLICT (proxy_id, region) DO UPDATE
		SET status = 'pending',
			success_streak = 0,
			success_count = 0,
			failure_streak = 0,
			last_checked_at = NULL,
			last_success_at = NULL,
			last_error = NULL,
			last_error_code = NULL,
			last_error_stage = NULL,
			next_check_at = NOW(),
			updated_at = NOW()`,
		source,
		pq.Array(regions),
	); err != nil {
		t.Fatalf("seed multi-region health rows: %v", err)
	}

	candidates, err := store.ClaimFreeProxiesDueForCheck(
		ctx,
		regions,
		12,
		true,
	)
	if err != nil {
		t.Fatalf("claim multi-region wave: %v", err)
	}
	if len(candidates) != 12 {
		t.Fatalf(
			"multi-region wave size = %d, want 12: %#v",
			len(candidates),
			candidates,
		)
	}
	claimedRegions := make(map[string]int)
	for _, candidate := range candidates {
		claimedRegions[candidate.Region]++
	}
	for _, region := range regions {
		if claimedRegions[region] == 0 {
			t.Fatalf(
				"multi-region wave distribution = %#v, want every region represented",
				claimedRegions,
			)
		}
	}
}
