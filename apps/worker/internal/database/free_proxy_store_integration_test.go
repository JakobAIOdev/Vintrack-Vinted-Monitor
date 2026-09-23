package database

import (
	"context"
	"database/sql"
	"fmt"
	"maps"
	"os"
	"slices"
	"strings"
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

	releaseCanary, canaryAcquired, err := store.TryAcquireFreeProxyUKCanaryLeaseContext(ctx)
	if err != nil {
		t.Fatalf("acquire UK canary lease alongside maintainer: %v", err)
	}
	if !canaryAcquired {
		t.Fatal("UK canary lease was blocked by the independent maintainer lease")
	}
	defer releaseCanary()
	_, canaryAcquired, err = store.TryAcquireFreeProxyUKCanaryLeaseContext(ctx)
	if err != nil {
		t.Fatalf("acquire competing UK canary lease: %v", err)
	}
	if canaryAcquired {
		t.Fatal("competing UK canary unexpectedly acquired cluster-wide lease")
	}

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

func TestDiverseActiveFreeProxiesPreferIndependentNetworks(t *testing.T) {
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
	const region = "sqldiverse"
	records := []FreeProxyRecord{
		{ProxyURL: "http://198.51.100.10:8101", Protocol: "http", Host: "198.51.100.10", Port: 8101, Source: "source-a"},
		{ProxyURL: "http://198.51.100.11:8102", Protocol: "http", Host: "198.51.100.11", Port: 8102, Source: "source-a"},
		{ProxyURL: "http://198.51.100.12:8103", Protocol: "http", Host: "198.51.100.12", Port: 8103, Source: "source-a"},
		{ProxyURL: "http://203.0.113.10:8201", Protocol: "http", Host: "203.0.113.10", Port: 8201, Source: "source-b"},
		{ProxyURL: "http://192.0.2.10:8301", Protocol: "http", Host: "192.0.2.10", Port: 8301, Source: "source-c"},
		{ProxyURL: "http://192.88.99.10:8401", Protocol: "http", Host: "192.88.99.10", Port: 8401, Source: "source-low"},
	}
	proxyURLs := make([]string, 0, len(records))
	for _, record := range records {
		proxyURLs = append(proxyURLs, record.ProxyURL)
	}
	defer db.ExecContext(
		context.Background(),
		`DELETE FROM free_proxies WHERE proxy_url = ANY($1)`,
		pq.Array(proxyURLs),
	)

	if _, err := store.UpsertFreeProxiesContext(ctx, records); err != nil {
		t.Fatalf("upsert diverse proxies: %v", err)
	}
	if _, err := db.ExecContext(ctx, `
		INSERT INTO free_proxy_health (
			proxy_id, region, status, score, latency_ms, success_streak,
			success_count, failure_streak, last_checked_at, last_success_at,
			next_check_at, updated_at
		)
		SELECT
			fp.id, $1, 'active', CASE WHEN fp.source = 'source-low' THEN 69 ELSE 90 END, fp.port, 2,
			2, 0, NOW(), NOW(), NOW() + INTERVAL '5 minutes', NOW()
		FROM free_proxies fp
		WHERE fp.proxy_url = ANY($2)
		ON CONFLICT (proxy_id, region) DO UPDATE
		SET status = 'active',
			score = EXCLUDED.score,
			latency_ms = EXCLUDED.latency_ms,
			success_streak = 2,
			success_count = 2,
			failure_streak = 0,
			last_checked_at = NOW(),
			last_success_at = NOW(),
			next_check_at = NOW() + INTERVAL '5 minutes',
			updated_at = NOW()`, region, pq.Array(proxyURLs)); err != nil {
		t.Fatalf("seed mature diverse proxies: %v", err)
	}

	proxies, err := store.GetDiverseActiveFreeProxiesContext(ctx, region, 10)
	if err != nil {
		t.Fatalf("get diverse active proxies: %v", err)
	}
	if len(proxies) != 3 {
		t.Fatalf("diverse proxies = %#v, want exactly 3 independent networks", proxies)
	}
	sameNetwork := 0
	for _, proxyURL := range proxies {
		if strings.HasPrefix(proxyURL, "http://198.51.100.") {
			sameNetwork++
		}
	}
	if sameNetwork != 1 {
		t.Fatalf("diverse proxies = %#v, want exactly one 198.51.100/24 member", proxies)
	}
}

func TestMatureFreeProxyRecoveryIncludesStaleButNeverServesIt(t *testing.T) {
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
		region   = "sqlstaleuk"
		proxyURL = "http://198.19.42.10:8842"
	)
	defer db.ExecContext(
		context.Background(),
		`DELETE FROM free_proxies WHERE proxy_url = $1`,
		proxyURL,
	)

	if _, err := store.UpsertFreeProxiesContext(ctx, []FreeProxyRecord{{
		ProxyURL: proxyURL,
		Protocol: "http",
		Host:     "198.19.42.10",
		Port:     8842,
		Source:   "source-stale-recovery",
	}}); err != nil {
		t.Fatalf("upsert stale recovery proxy: %v", err)
	}
	if _, err := db.ExecContext(ctx, `
		INSERT INTO free_proxy_health (
			proxy_id, region, status, score, latency_ms, success_streak,
			success_count, failure_streak, last_checked_at, last_success_at,
			next_check_at, updated_at
		)
		SELECT id, $1, 'active', 90, 250, 3, 3, 0,
			NOW() - INTERVAL '25 minutes', NOW() - INTERVAL '25 minutes',
			NOW(), NOW()
		FROM free_proxies
		WHERE proxy_url = $2
		ON CONFLICT (proxy_id, region) DO UPDATE
		SET status = 'active', score = 90, success_streak = 3,
			success_count = 3, failure_streak = 0,
			last_checked_at = NOW() - INTERVAL '25 minutes',
			last_success_at = NOW() - INTERVAL '25 minutes',
			next_check_at = NOW(), updated_at = NOW()`, region, proxyURL); err != nil {
		t.Fatalf("seed stale recovery health: %v", err)
	}

	fresh, err := store.GetDiverseActiveFreeProxiesContext(ctx, region, 10)
	if err != nil {
		t.Fatalf("get fresh serving cohort: %v", err)
	}
	if len(fresh) != 0 {
		t.Fatalf("stale proxy leaked into serving cohort: %#v", fresh)
	}
	recovery, err := store.GetDiverseMatureFreeProxiesForRevalidationContext(ctx, region, 10)
	if err != nil {
		t.Fatalf("get stale recovery cohort: %v", err)
	}
	if len(recovery) != 1 || recovery[0] != proxyURL {
		t.Fatalf("recovery cohort = %#v, want %s", recovery, proxyURL)
	}

	if _, claimed, err := store.TryClaimActiveFreeProxyForCanaryContext(
		ctx,
		proxyURL,
		region,
		time.Minute,
	); err != nil || claimed {
		t.Fatalf("fresh-only claim = claimed %v err %v, want false", claimed, err)
	}
	claimedUntil, claimed, err := store.TryClaimMatureFreeProxyForRevalidationContext(
		ctx,
		proxyURL,
		region,
		time.Minute,
	)
	if err != nil || !claimed {
		t.Fatalf("stale recovery claim = claimed %v err %v, want true", claimed, err)
	}
	whileClaimed, err := store.GetDiverseMatureFreeProxiesForRevalidationContext(ctx, region, 10)
	if err != nil {
		t.Fatalf("get recovery cohort while validation is claimed: %v", err)
	}
	if len(whileClaimed) != 1 || whileClaimed[0] != proxyURL {
		t.Fatalf("validation claim hid mature capacity: %#v", whileClaimed)
	}
	if err := store.ReleaseFreeProxyCanaryClaimContext(ctx, proxyURL, claimedUntil); err != nil {
		t.Fatalf("release stale recovery claim: %v", err)
	}
}

func TestDiverseActiveFreeProxiesCapsEachSourceAtHalf(t *testing.T) {
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
	const region = "sqlsrccap"
	records := make([]FreeProxyRecord, 0, 12)
	sourceByURL := make(map[string]string, 12)
	for index := range 6 {
		for sourceIndex, source := range []string{"source-a", "source-b"} {
			host := fmt.Sprintf("198.18.%d.%d", index*2+sourceIndex, 10+index)
			port := 9000 + index*2 + sourceIndex
			proxyURL := fmt.Sprintf("http://%s:%d", host, port)
			records = append(records, FreeProxyRecord{
				ProxyURL: proxyURL,
				Protocol: "http",
				Host:     host,
				Port:     port,
				Source:   source,
			})
			sourceByURL[proxyURL] = source
		}
	}
	proxyURLs := make([]string, 0, len(records))
	for _, record := range records {
		proxyURLs = append(proxyURLs, record.ProxyURL)
	}
	defer db.ExecContext(
		context.Background(),
		`DELETE FROM free_proxies WHERE proxy_url = ANY($1)`,
		pq.Array(proxyURLs),
	)

	if _, err := store.UpsertFreeProxiesContext(ctx, records); err != nil {
		t.Fatalf("upsert source-balanced proxies: %v", err)
	}
	if _, err := db.ExecContext(ctx, `
		INSERT INTO free_proxy_health (
			proxy_id, region, status, score, latency_ms, success_streak,
			success_count, failure_streak, last_checked_at, last_success_at,
			next_check_at, updated_at
		)
		SELECT
			fp.id, $1, 'active', CASE WHEN fp.source = 'source-a' THEN 100 ELSE 80 END,
			100, 2, 2, 0, NOW(), NOW(), NOW() + INTERVAL '5 minutes', NOW()
		FROM free_proxies fp
		WHERE fp.proxy_url = ANY($2)
		ON CONFLICT (proxy_id, region) DO UPDATE
		SET status = 'active',
			score = EXCLUDED.score,
			latency_ms = EXCLUDED.latency_ms,
			success_streak = 2,
			success_count = 2,
			failure_streak = 0,
			last_checked_at = NOW(),
			last_success_at = NOW(),
			next_check_at = NOW() + INTERVAL '5 minutes',
			updated_at = NOW()`, region, pq.Array(proxyURLs)); err != nil {
		t.Fatalf("seed source-balanced proxies: %v", err)
	}

	proxies, err := store.GetDiverseActiveFreeProxiesContext(ctx, region, 10)
	if err != nil {
		t.Fatalf("get source-balanced proxies: %v", err)
	}
	if len(proxies) != 10 {
		t.Fatalf("source-balanced proxies = %#v, want 10", proxies)
	}
	counts := make(map[string]int)
	for _, proxyURL := range proxies {
		counts[sourceByURL[proxyURL]]++
	}
	if counts["source-a"] != 5 || counts["source-b"] != 5 {
		t.Fatalf("source-balanced counts = %#v, want 5 per source", counts)
	}
}

func TestDiverseActiveFreeProxiesUseSourcesArrayForFairness(t *testing.T) {
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

	records := make([]FreeProxyRecord, 0, 10)
	for index := range 6 {
		host := fmt.Sprintf("198.20.%d.10", index)
		sources := []string{"z-primary"}
		if index == 0 {
			sources = append(sources, "a-secondary")
		}
		records = append(records, FreeProxyRecord{
			ProxyURL: fmt.Sprintf("http://%s:%d", host, 9100+index),
			Protocol: "http",
			Host:     host,
			Port:     9100 + index,
			Source:   "z-primary",
			Sources:  sources,
		})
	}
	for index, source := range []string{"source-b", "source-c", "source-d", "source-e"} {
		host := fmt.Sprintf("198.21.%d.10", index)
		records = append(records, FreeProxyRecord{
			ProxyURL: fmt.Sprintf("http://%s:%d", host, 9200+index),
			Protocol: "http",
			Host:     host,
			Port:     9200 + index,
			Source:   source,
			Sources:  []string{source},
		})
	}
	proxyURLs := make([]string, 0, len(records))
	for _, record := range records {
		proxyURLs = append(proxyURLs, record.ProxyURL)
	}
	defer db.ExecContext(
		context.Background(),
		`DELETE FROM free_proxies WHERE proxy_url = ANY($1)`,
		pq.Array(proxyURLs),
	)

	if _, err := store.UpsertFreeProxiesContext(ctx, records); err != nil {
		t.Fatalf("upsert multi-source proxies: %v", err)
	}
	if _, err := db.ExecContext(ctx, `
		INSERT INTO free_proxy_health (
			proxy_id, region, status, score, latency_ms, success_streak,
			success_count, failure_streak, last_checked_at, last_success_at,
			next_check_at, updated_at
		)
		SELECT id, 'sqlsrcarr', 'active', 90, 200, 3, 3, 0,
			NOW(), NOW(), NOW() + INTERVAL '5 minutes', NOW()
		FROM free_proxies
		WHERE proxy_url = ANY($1)
		ON CONFLICT (proxy_id, region) DO UPDATE
		SET status = 'active', score = 90, success_streak = 3,
			success_count = 3, failure_streak = 0,
			last_checked_at = NOW(), last_success_at = NOW(), updated_at = NOW()`,
		pq.Array(proxyURLs),
	); err != nil {
		t.Fatalf("seed multi-source health: %v", err)
	}

	proxies, err := store.GetDiverseActiveFreeProxiesContext(ctx, "sqlsrcarr", 10)
	if err != nil {
		t.Fatalf("get multi-source diverse proxies: %v", err)
	}
	if len(proxies) != 10 {
		t.Fatalf("multi-source diverse proxies = %#v, want all 10", proxies)
	}
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

	const autoProxyURL = "http://vintrack-free-proxy-source-refresh.invalid:1"
	defer db.ExecContext(context.Background(), `DELETE FROM free_proxies WHERE proxy_url = $1`, autoProxyURL)
	if _, err := store.UpsertFreeProxiesContext(ctx, []FreeProxyRecord{{
		ProxyURL: autoProxyURL,
		Protocol: "http",
		Host:     "vintrack-free-proxy-source-refresh.invalid",
		Port:     1,
		Source:   "iplocate:uk",
		Sources:  []string{"iplocate:uk", "proxifly"},
	}}); err != nil {
		t.Fatalf("insert auto proxy source membership: %v", err)
	}
	if _, err := store.UpsertFreeProxiesContext(ctx, []FreeProxyRecord{{
		ProxyURL: autoProxyURL,
		Protocol: "http",
		Host:     "vintrack-free-proxy-source-refresh.invalid",
		Port:     1,
		Source:   "proxifly:uk",
		Sources:  []string{"proxifly:uk"},
	}}); err != nil {
		t.Fatalf("refresh auto proxy source membership: %v", err)
	}
	storedSources = nil
	if err := db.QueryRowContext(ctx, `
		SELECT sources FROM free_proxies WHERE proxy_url = $1`, autoProxyURL).Scan(&storedSources); err != nil {
		t.Fatalf("read refreshed auto proxy sources: %v", err)
	}
	if !slices.Equal([]string(storedSources), []string{"proxifly:uk"}) {
		t.Fatalf("refreshed auto sources = %#v, want only current source", storedSources)
	}

	if err := store.RefreshFreeProxySourcesContext(ctx, []string{"proxifly:uk"}, nil); err != nil {
		t.Fatalf("remove stale auto source membership: %v", err)
	}
	var storedPrimarySource string
	storedSources = nil
	if err := db.QueryRowContext(ctx, `
		SELECT source, sources FROM free_proxies WHERE proxy_url = $1`, autoProxyURL).
		Scan(&storedPrimarySource, &storedSources); err != nil {
		t.Fatalf("read removed auto proxy sources: %v", err)
	}
	if storedPrimarySource != "proxifly" || len(storedSources) != 0 {
		t.Fatalf("removed auto source = %q %#v, want proxifly and no regional memberships", storedPrimarySource, storedSources)
	}
	if err := store.RefreshFreeProxySourcesContext(
		ctx,
		[]string{"proxifly:uk"},
		[]FreeProxyRecord{{
			ProxyURL: autoProxyURL,
			Source:   "proxifly:uk",
			Sources:  []string{"proxifly:uk"},
		}},
	); err != nil {
		t.Fatalf("restore current auto source membership: %v", err)
	}
	storedSources = nil
	if err := db.QueryRowContext(ctx, `
		SELECT source, sources FROM free_proxies WHERE proxy_url = $1`, autoProxyURL).
		Scan(&storedPrimarySource, &storedSources); err != nil {
		t.Fatalf("read restored auto proxy sources: %v", err)
	}
	if storedPrimarySource != "proxifly:uk" ||
		!slices.Equal([]string(storedSources), []string{"proxifly:uk"}) {
		t.Fatalf("restored auto source = %q %#v, want proxifly:uk", storedPrimarySource, storedSources)
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
		t.Fatalf("record first success: %v", err)
	}
	var firstStatus string
	var firstSuccessStreak int
	if err := db.QueryRowContext(ctx, `
		SELECT fph.status, fph.success_streak
		FROM free_proxy_health fph
		JOIN free_proxies fp ON fp.id = fph.proxy_id
		WHERE fp.proxy_url = $1 AND fph.region = $2`, proxyURL, region).Scan(
		&firstStatus,
		&firstSuccessStreak,
	); err != nil {
		t.Fatalf("read first promotion state: %v", err)
	}
	if firstStatus != "pending" || firstSuccessStreak != 1 {
		t.Fatalf("first success state = %s/%d, want pending/1", firstStatus, firstSuccessStreak)
	}
	if _, err := db.ExecContext(ctx, `
		UPDATE free_proxy_health fph
		SET last_success_at = NOW() - INTERVAL '61 seconds',
			next_check_at = NOW()
		FROM free_proxies fp
		WHERE fp.id = fph.proxy_id
		  AND fp.proxy_url = $1
		  AND fph.region = $2`, proxyURL, region); err != nil {
		t.Fatalf("age first success: %v", err)
	}
	if err := store.RecordFreeProxySuccessContext(ctx, proxyURL, region, 250); err != nil {
		t.Fatalf("record second success: %v", err)
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
		validatorSuccessCount != 2 ||
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
	claimedUntil, claimed, err := store.TryClaimActiveFreeProxyForCanaryContext(
		ctx,
		proxyURL,
		region,
		time.Minute,
	)
	if err != nil || !claimed {
		t.Fatalf("claim active proxy for canary = %v, %v", claimed, err)
	}
	if _, duplicateClaim, err := store.TryClaimActiveFreeProxyForCanaryContext(
		ctx,
		proxyURL,
		region,
		time.Minute,
	); err != nil || duplicateClaim {
		t.Fatalf("duplicate canary claim = %v, %v", duplicateClaim, err)
	}
	if err := store.ReleaseFreeProxyCanaryClaimContext(ctx, proxyURL, claimedUntil); err != nil {
		t.Fatalf("release canary claim: %v", err)
	}
	if reclaimedUntil, reclaimed, err := store.TryClaimActiveFreeProxyForCanaryContext(
		ctx,
		proxyURL,
		region,
		time.Minute,
	); err != nil || !reclaimed {
		t.Fatalf("reclaim released canary proxy = %v, %v", reclaimed, err)
	} else if err := store.ReleaseFreeProxyCanaryClaimContext(ctx, proxyURL, reclaimedUntil); err != nil {
		t.Fatalf("release reclaimed canary proxy: %v", err)
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
	if len(active) != 0 {
		t.Fatalf("active proxies after isolated timeout = %#v, want fail-closed pool", active)
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
	if len(active) != 0 {
		t.Fatalf("active proxies after second timeout = %#v, want fail-closed pool", active)
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
		wantStatus := "cooldown"
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
		wantActive := 0
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
	if len(active) != 0 {
		t.Fatalf(
			"legacy cooldown reserve = %#v, want fail-closed pool",
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

	var sameRegionQuarantine sql.NullTime
	if err := db.QueryRowContext(ctx, `
		SELECT quarantined_until
		FROM free_proxies
		WHERE proxy_url = $1`, proxyURL).Scan(&sameRegionQuarantine); err != nil {
		t.Fatalf("read same-region quarantine: %v", err)
	}
	if sameRegionQuarantine.Valid {
		t.Fatalf("same-region transport failures caused global quarantine: %v", sameRegionQuarantine.Time)
	}
	if err := store.RecordFreeProxyFailureStageContext(
		ctx,
		proxyURL,
		"sqlother",
		0,
		"second regional edge timed out",
		"timeout",
		"warmup",
		3,
		30,
	); err != nil {
		t.Fatalf("record corroborating regional timeout: %v", err)
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

	var newlyProvenURL string
	if err := db.QueryRowContext(ctx, `
		SELECT fp.proxy_url
		FROM free_proxies fp
		LEFT JOIN free_proxy_health fph
		  ON fph.proxy_id = fp.id AND fph.region = $1
		WHERE fp.proxy_url = ANY($2)
		  AND fph.candidate_window_token IS DISTINCT FROM
			FLOOR(EXTRACT(EPOCH FROM NOW()) / 3600)::bigint
		LIMIT 1`, region, pq.Array(proxyURLs)).Scan(&newlyProvenURL); err != nil {
		t.Fatalf("select proxy outside frozen regional window: %v", err)
	}
	if _, err := db.ExecContext(ctx, `
		UPDATE free_proxies
		SET success_count = 1, last_success_at = NOW(), updated_at = NOW()
		WHERE proxy_url = $1`, newlyProvenURL); err != nil {
		t.Fatalf("mark globally proven proxy: %v", err)
	}
	limits := maps.Clone(existingLimits)
	limits[region] = 2
	if err := store.EnsureFreeProxyHealthRowsWithLimitsContext(ctx, limits); err != nil {
		t.Fatalf("refresh frozen window with immediate fanout: %v", err)
	}
	var fanoutWindowCurrent bool
	if err := db.QueryRowContext(ctx, `
		SELECT fph.candidate_window_token =
			FLOOR(EXTRACT(EPOCH FROM NOW()) / 3600)::bigint
		FROM free_proxy_health fph
		JOIN free_proxies fp ON fp.id = fph.proxy_id
		WHERE fph.region = $1 AND fp.proxy_url = $2`, region, newlyProvenURL).Scan(&fanoutWindowCurrent); err != nil {
		t.Fatalf("read immediate fanout window: %v", err)
	}
	if !fanoutWindowCurrent {
		t.Fatal("globally proven proxy did not enter the frozen regional fanout window immediately")
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

func TestFreeProxyClaimPrioritizesRegionalSourceFromSourcesArray(t *testing.T) {
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
		region       = "uktest"
		affineURL    = "http://vintrack-uk-affine.invalid:1"
		genericURL   = "http://vintrack-uk-generic.invalid:1"
		genericA     = "sql-uk-generic-a"
		genericB     = "sql-uk-generic-b"
		regionalHint = "iplocate:uktest"
	)
	defer db.ExecContext(
		context.Background(),
		`DELETE FROM free_proxies WHERE proxy_url = ANY($1)`,
		pq.Array([]string{affineURL, genericURL}),
	)
	if _, err := store.UpsertFreeProxiesContext(ctx, []FreeProxyRecord{
		{
			ProxyURL: affineURL, Protocol: "http", Host: "vintrack-uk-affine.invalid", Port: 1,
			Source: genericA, Sources: []string{genericA, regionalHint},
		},
		{
			ProxyURL: genericURL, Protocol: "http", Host: "vintrack-uk-generic.invalid", Port: 1,
			Source: genericB, Sources: []string{genericB},
		},
	}); err != nil {
		t.Fatalf("upsert affinity candidates: %v", err)
	}
	if _, err := db.ExecContext(ctx, `
		INSERT INTO free_proxy_health (
			proxy_id, region, status, candidate_window_token, next_check_at, updated_at
		)
		SELECT id, $2, 'pending', FLOOR(EXTRACT(EPOCH FROM NOW()) / 3600)::bigint, NOW(), NOW()
		FROM free_proxies
		WHERE proxy_url = ANY($1)
		ON CONFLICT (proxy_id, region) DO UPDATE
		SET status = 'pending', success_count = 0, last_checked_at = NULL,
			candidate_window_token = FLOOR(EXTRACT(EPOCH FROM NOW()) / 3600)::bigint,
			next_check_at = NOW(), updated_at = NOW()`,
		pq.Array([]string{affineURL, genericURL}),
		region,
	); err != nil {
		t.Fatalf("seed affinity health rows: %v", err)
	}

	candidates, err := store.ClaimFreeProxiesDueForCheck(ctx, []string{region}, 10, true)
	if err != nil {
		t.Fatalf("claim affinity candidates: %v", err)
	}
	if len(candidates) < 1 {
		t.Fatal("regional affinity lane returned no candidate")
	}
	if candidates[0].ProxyURL != affineURL || candidates[0].Source != regionalHint {
		t.Fatalf("first affinity candidate = %#v, want %s from %s", candidates[0], affineURL, regionalHint)
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
