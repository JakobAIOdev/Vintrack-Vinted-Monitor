package database

import (
	"context"
	"database/sql"
	"fmt"
	"maps"
	"os"
	"slices"
	"testing"
	"time"

	"github.com/lib/pq"
)

func TestFreeProxyMaintainerLeaseIsClusterWide(t *testing.T) {
	databaseURL := os.Getenv("FREE_PROXY_STORE_INTEGRATION_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("FREE_PROXY_STORE_INTEGRATION_DATABASE_URL is not set")
	}

	db, err := sql.Open("postgres", databaseURL)
	if err != nil {
		t.Fatalf("open postgres: %v", err)
	}
	defer db.Close()
	store := &Store{db: db}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	releaseFirst, acquired, err := store.TryAcquireFreeProxyMaintainerLeaseContext(ctx)
	if err != nil {
		t.Fatalf("acquire first maintainer lease: %v", err)
	}
	if !acquired {
		t.Fatal("first maintainer lease was not acquired")
	}
	defer releaseFirst()

	_, acquired, err = store.TryAcquireFreeProxyMaintainerLeaseContext(ctx)
	if err != nil {
		t.Fatalf("acquire competing maintainer lease: %v", err)
	}
	if acquired {
		t.Fatal("competing maintainer unexpectedly acquired cluster-wide lease")
	}

	releaseFirst()
	releaseSecond, acquired, err := store.TryAcquireFreeProxyMaintainerLeaseContext(ctx)
	if err != nil {
		t.Fatalf("reacquire released maintainer lease: %v", err)
	}
	if !acquired {
		t.Fatal("released maintainer lease could not be reacquired")
	}
	releaseSecond()
}

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
	if _, err := store.UpsertFreeProxiesContext(ctx, []FreeProxyRecord{{
		ProxyURL: proxyURL,
		Protocol: "http",
		Host:     "vintrack-free-proxy-sqlcheck.invalid",
		Port:     1,
		Source:   "tertiary",
		Sources:  []string{"tertiary", "secondary"},
	}}); err != nil {
		t.Fatalf("merge free proxy sources: %v", err)
	}
	var storedSources pq.StringArray
	if err := db.QueryRowContext(ctx, `
		SELECT sources FROM free_proxies WHERE proxy_url = $1`, proxyURL).Scan(&storedSources); err != nil {
		t.Fatalf("read merged free proxy sources: %v", err)
	}
	for _, source := range []string{"sqlcheck", "secondary", "tertiary"} {
		if !slices.Contains(storedSources, source) {
			t.Fatalf("merged sources = %#v, missing %q", storedSources, source)
		}
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
	if err := store.RecordFreeProxyInfrastructureFailureContext(
		ctx,
		proxyURL,
		region,
		0,
		"maintainer host could not reach proxy warmup",
		"timeout",
		"warmup",
	); err != nil {
		t.Fatalf("record infrastructure failure: %v", err)
	}
	var infrastructureStatus string
	var infrastructureFailureStreak int
	var infrastructureGlobalFailures int
	var infrastructureQuarantine sql.NullTime
	var validatorSuccessCount int
	if err := db.QueryRowContext(ctx, `
		SELECT
			fph.status,
			fph.failure_streak,
			fph.success_count,
			fp.failure_count,
			fp.quarantined_until
		FROM free_proxy_health fph
		JOIN free_proxies fp ON fp.id = fph.proxy_id
		WHERE fp.proxy_url = $1
		  AND fph.region = $2`, proxyURL, region).Scan(
		&infrastructureStatus,
		&infrastructureFailureStreak,
		&validatorSuccessCount,
		&infrastructureGlobalFailures,
		&infrastructureQuarantine,
	); err != nil {
		t.Fatalf("read infrastructure failure state: %v", err)
	}
	if infrastructureStatus != "active" ||
		infrastructureFailureStreak != 0 ||
		validatorSuccessCount != 1 ||
		infrastructureGlobalFailures != 0 ||
		infrastructureQuarantine.Valid {
		t.Fatalf(
			"infrastructure failure degraded proven proxy: status=%s regional=%d successes=%d global=%d quarantine=%v",
			infrastructureStatus,
			infrastructureFailureStreak,
			validatorSuccessCount,
			infrastructureGlobalFailures,
			infrastructureQuarantine,
		)
	}
	if err := store.TouchFreeProxyRuntimeSuccessContext(
		ctx,
		proxyURL,
		region,
		175,
	); err != nil {
		t.Fatalf("touch sampled runtime success: %v", err)
	}
	var sampledSuccessCount int
	var sampledLatency int
	if err := db.QueryRowContext(ctx, `
		SELECT fph.success_count, fph.latency_ms
		FROM free_proxy_health fph
		JOIN free_proxies fp ON fp.id = fph.proxy_id
		WHERE fp.proxy_url = $1
		  AND fph.region = $2`, proxyURL, region).Scan(
		&sampledSuccessCount,
		&sampledLatency,
	); err != nil {
		t.Fatalf("read sampled runtime success: %v", err)
	}
	if sampledSuccessCount != validatorSuccessCount || sampledLatency != 175 {
		t.Fatalf(
			"sampled runtime success changed validator count/latency = %d/%d, want %d/175",
			sampledSuccessCount,
			sampledLatency,
			validatorSuccessCount,
		)
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
	if !fanoutCandidates[0].Proven {
		t.Fatal("globally successful candidate was not marked proven")
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
	for attempt := 1; attempt <= 3; attempt++ {
		if err := store.RecordFreeProxyFailureStageContext(
			ctx,
			proxyURL,
			region,
			403,
			"regional warmup forbidden",
			"vinted_403",
			"warmup",
			3,
			30,
		); err != nil {
			t.Fatalf("record regional access failure %d: %v", attempt, err)
		}

		var regionalStatus string
		var regionalFailureStreak int
		if err := db.QueryRowContext(ctx, `
			SELECT fph.status, fph.failure_streak
			FROM free_proxy_health fph
			JOIN free_proxies fp ON fp.id = fph.proxy_id
			WHERE fp.proxy_url = $1
			  AND fph.region = $2`,
			proxyURL,
			region,
		).Scan(&regionalStatus, &regionalFailureStreak); err != nil {
			t.Fatalf("read regional failure %d state: %v", attempt, err)
		}
		wantStatus := "active"
		if attempt == 3 {
			wantStatus = "cooldown"
		}
		if regionalStatus != wantStatus || regionalFailureStreak != attempt {
			t.Fatalf(
				"regional failure %d state = %s/%d, want %s/%d",
				attempt,
				regionalStatus,
				regionalFailureStreak,
				wantStatus,
				attempt,
			)
		}

		active, err = store.GetActiveFreeProxiesContext(ctx, region, 10)
		if err != nil {
			t.Fatalf("get proxies after regional failure %d: %v", attempt, err)
		}
		wantActive := 1
		if attempt == 3 {
			wantActive = 0
		}
		if len(active) != wantActive {
			t.Fatalf(
				"active proxies after regional failure %d = %#v, want %d",
				attempt,
				active,
				wantActive,
			)
		}
	}
	if err := store.RecordFreeProxySuccessContext(ctx, proxyURL, region, 225); err != nil {
		t.Fatalf("reset proxy after regional hysteresis: %v", err)
	}
	if _, err := db.ExecContext(ctx, `
		UPDATE free_proxy_health fph
		SET status = 'cooldown',
			failure_streak = 1,
			next_check_at = NOW() + INTERVAL '5 minutes',
			updated_at = NOW()
		FROM free_proxies fp
		WHERE fp.id = fph.proxy_id
		  AND fp.proxy_url = $1
		  AND fph.region = $2`,
		proxyURL,
		region,
	); err != nil {
		t.Fatalf("seed legacy cooldown reserve: %v", err)
	}
	active, err = store.GetActiveFreeProxiesContext(ctx, region, 10)
	if err != nil {
		t.Fatalf("get legacy cooldown reserve: %v", err)
	}
	if len(active) != 1 || active[0] != proxyURL {
		t.Fatalf(
			"legacy cooldown reserve = %#v, want proven proxy",
			active,
		)
	}
	if err := store.RecordFreeProxySuccessContext(ctx, proxyURL, region, 225); err != nil {
		t.Fatalf("reset legacy cooldown reserve: %v", err)
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
	for failure := 1; failure <= 3; failure++ {
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
			t.Fatalf("record staged warmup failure %d: %v", failure, err)
		}

		var interimQuarantine sql.NullTime
		if err := db.QueryRowContext(ctx, `
			SELECT quarantined_until
			FROM free_proxies
			WHERE proxy_url = $1`, proxyURL).Scan(&interimQuarantine); err != nil {
			t.Fatalf("read staged quarantine after failure %d: %v", failure, err)
		}
		if failure < 3 && interimQuarantine.Valid {
			t.Fatalf(
				"proven proxy quarantined after transport failure %d: %v",
				failure,
				interimQuarantine.Time,
			)
		}
	}

	var stagedQuarantine sql.NullTime
	var storedStage sql.NullString
	if err := db.QueryRowContext(ctx, `
		SELECT quarantined_until, last_error_stage
		FROM free_proxies
		WHERE proxy_url = $1`, proxyURL).Scan(&stagedQuarantine, &storedStage); err != nil {
		t.Fatalf("read staged global failure: %v", err)
	}
	if !stagedQuarantine.Valid || stagedQuarantine.Time.Before(time.Now().Add(14*time.Minute)) {
		t.Fatalf("warmup failure quarantine = %v, want about 15 minutes", stagedQuarantine)
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
	if otherNextCheck.Before(stagedQuarantine.Time.Add(-time.Second)) {
		t.Fatalf(
			"other region next check = %v, want global quarantine %v",
			otherNextCheck,
			stagedQuarantine.Time,
		)
	}
}

func TestFreeProxyCandidateWindowUsesPerRegionLimit(t *testing.T) {
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
	const region = "sqlwindow"

	records := make([]FreeProxyRecord, 0, 7)
	proxyURLs := make([]string, 0, 7)
	for index := 0; index < 7; index++ {
		proxyURL := fmt.Sprintf("http://vintrack-window-%d.invalid:1", index)
		proxyURLs = append(proxyURLs, proxyURL)
		records = append(records, FreeProxyRecord{
			ProxyURL: proxyURL,
			Protocol: "http",
			Host:     fmt.Sprintf("vintrack-window-%d.invalid", index),
			Port:     1,
			Source:   "sqlwindow",
		})
	}
	defer db.ExecContext(context.Background(), `DELETE FROM free_proxies WHERE proxy_url = ANY($1)`, pq.Array(proxyURLs))
	if _, err := store.UpsertFreeProxiesContext(ctx, records); err != nil {
		t.Fatalf("upsert candidate inventory: %v", err)
	}
	existingLimits := make(map[string]int)
	rows, err := db.QueryContext(ctx, `
		SELECT region, COUNT(*) FROM free_proxy_health GROUP BY region`)
	if err != nil {
		t.Fatalf("load existing candidate windows: %v", err)
	}
	for rows.Next() {
		var existingRegion string
		var count int
		if err := rows.Scan(&existingRegion, &count); err != nil {
			rows.Close()
			t.Fatalf("scan existing candidate window: %v", err)
		}
		existingLimits[existingRegion] = count
	}
	if err := rows.Close(); err != nil {
		t.Fatalf("close candidate window rows: %v", err)
	}

	for _, limit := range []int{3, 5, 2} {
		limits := maps.Clone(existingLimits)
		limits[region] = limit
		if err := store.EnsureFreeProxyHealthRowsWithLimitsContext(
			ctx,
			limits,
		); err != nil {
			t.Fatalf("ensure candidate window %d: %v", limit, err)
		}
		var count int
		if err := db.QueryRowContext(ctx, `
			SELECT COUNT(*)
			FROM free_proxy_health
			WHERE region = $1
			  AND candidate_window_token =
				FLOOR(EXTRACT(EPOCH FROM NOW()) / 3600)::bigint`, region).Scan(&count); err != nil {
			t.Fatalf("count candidate window %d: %v", limit, err)
		}
		if count != limit {
			t.Fatalf("candidate window count = %d, want %d", count, limit)
		}
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
	defer db.ExecContext(
		context.Background(),
		`DELETE FROM free_proxy_source_health_stats WHERE region = $1`,
		region,
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
	if _, err := db.ExecContext(ctx, `
		INSERT INTO free_proxy_source_health_stats (
			region,
			source,
			protocol,
			checked_count,
			success_count,
			failure_count,
			last_checked_at,
			last_success_at,
			updated_at
		) VALUES
			($1, $2, 'http', 100, 50, 50, NOW(), NOW(), NOW()),
			($1, $3, 'http', 100, 1, 99, NOW(), NOW(), NOW())
		ON CONFLICT (region, source, protocol) DO UPDATE
		SET checked_count = EXCLUDED.checked_count,
			success_count = EXCLUDED.success_count,
			failure_count = EXCLUDED.failure_count,
			last_checked_at = EXCLUDED.last_checked_at,
			last_success_at = EXCLUDED.last_success_at,
			updated_at = NOW()`,
		region,
		highSource,
		lowSource,
	); err != nil {
		t.Fatalf("seed cached regional source yield: %v", err)
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
