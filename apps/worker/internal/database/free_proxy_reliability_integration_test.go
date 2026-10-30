package database

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"testing"
	"time"
)

func freeProxyReliabilityStore(t *testing.T) (*Store, context.Context, string) {
	t.Helper()
	databaseURL := os.Getenv("FREE_PROXY_STORE_INTEGRATION_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("FREE_PROXY_STORE_INTEGRATION_DATABASE_URL is not set")
	}
	db, err := sql.Open("postgres", databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	t.Cleanup(cancel)
	source := fmt.Sprintf("reliability-%d", time.Now().UnixNano())
	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if _, err := db.ExecContext(cleanupCtx, `DELETE FROM free_proxies WHERE source = $1`, source); err != nil {
			t.Error(err)
		}
		if _, err := db.ExecContext(cleanupCtx, `DELETE FROM free_proxy_source_health_stats WHERE source = $1`, source); err != nil {
			t.Error(err)
		}
	})
	return &Store{db: db}, ctx, source
}

func seedReliabilityProxy(t *testing.T, store *Store, ctx context.Context, source, name, status string, streak int) string {
	t.Helper()
	proxyURL := fmt.Sprintf("http://%s-%s.invalid:80", source, name)
	if _, err := store.db.ExecContext(ctx, `
		WITH proxy AS (
			INSERT INTO free_proxies (proxy_url, host, port, protocol, source, success_count)
			VALUES ($1, $2, 80, 'http', $3, $5) RETURNING id
		)
		INSERT INTO free_proxy_health (
			proxy_id, region, status, success_streak, success_count, score,
			last_checked_at, last_success_at, next_check_at
		)
		SELECT id, 'sqlrely', $4, $5, $5, 80,
			NOW() - INTERVAL '2 minutes',
			CASE WHEN $5 > 0 THEN NOW() - INTERVAL '2 minutes' END,
			NOW() - INTERVAL '1 second'
		FROM proxy`, proxyURL, source+"-"+name+".invalid", source, status, streak); err != nil {
		t.Fatal(err)
	}
	return proxyURL
}

func TestFreeProxyRuntimeSuccessCannotPostponeIndependentValidation(t *testing.T) {
	store, ctx, source := freeProxyReliabilityStore(t)
	proxyURL := seedReliabilityProxy(t, store, ctx, source, "busy", "active", 2)
	var beforeChecked, beforeNext time.Time
	if err := store.db.QueryRowContext(ctx, `SELECT last_checked_at, next_check_at FROM free_proxy_health WHERE region='sqlrely' AND proxy_id=(SELECT id FROM free_proxies WHERE proxy_url=$1)`, proxyURL).Scan(&beforeChecked, &beforeNext); err != nil {
		t.Fatal(err)
	}
	for range 3 {
		if err := store.TouchFreeProxyRuntimeSuccessContext(ctx, proxyURL, "sqlrely", 175); err != nil {
			t.Fatal(err)
		}
	}
	var afterChecked, afterNext, lastSuccess time.Time
	var successes, latency int
	if err := store.db.QueryRowContext(ctx, `SELECT last_checked_at, next_check_at, last_success_at, success_count, latency_ms FROM free_proxy_health WHERE region='sqlrely' AND proxy_id=(SELECT id FROM free_proxies WHERE proxy_url=$1)`, proxyURL).Scan(&afterChecked, &afterNext, &lastSuccess, &successes, &latency); err != nil {
		t.Fatal(err)
	}
	if !afterChecked.Equal(beforeChecked) || !afterNext.Equal(beforeNext) {
		t.Fatalf("live traffic moved independent validation: checked %s -> %s, due %s -> %s", beforeChecked, afterChecked, beforeNext, afterNext)
	}
	if !lastSuccess.After(beforeChecked) || successes != 2 || latency != 175 {
		t.Fatalf("runtime evidence not preserved: success=%s count=%d latency=%d", lastSuccess, successes, latency)
	}
	candidates, err := store.ClaimFreeProxiesDueForCheck(ctx, []string{"sqlrely"}, 1, false)
	if err != nil || len(candidates) != 1 || candidates[0].ProxyURL != proxyURL {
		t.Fatalf("busy proxy was not independently rechecked: %#v, %v", candidates, err)
	}
}

func TestFreeProxySecondCheckHasReservedCapacity(t *testing.T) {
	store, ctx, source := freeProxyReliabilityStore(t)
	for i := 0; i < 8; i++ {
		seedReliabilityProxy(t, store, ctx, source, fmt.Sprintf("active-%d", i), "active", 3)
	}
	warming := seedReliabilityProxy(t, store, ctx, source, "warming", "pending", 1)
	candidates, err := store.ClaimFreeProxiesDueForCheck(ctx, []string{"sqlrely"}, 5, true)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, candidate := range candidates {
		found = found || candidate.ProxyURL == warming
	}
	if len(candidates) != 5 || !found {
		t.Fatalf("second confirmation was starved by active checks: %#v", candidates)
	}
	if err := store.RecordFreeProxySuccessContext(ctx, warming, "sqlrely", 200); err != nil {
		t.Fatal(err)
	}
	var status string
	var streak int
	if err := store.db.QueryRowContext(ctx, `SELECT status, success_streak FROM free_proxy_health WHERE proxy_id=(SELECT id FROM free_proxies WHERE proxy_url=$1) AND region='sqlrely'`, warming).Scan(&status, &streak); err != nil {
		t.Fatal(err)
	}
	if status != "active" || streak != 2 {
		t.Fatalf("second check did not build new serving capacity: %s/%d", status, streak)
	}
}

func TestFreeProxyCanceledClaimCanBeRetriedWithoutReleasingAnotherOwner(t *testing.T) {
	store, ctx, source := freeProxyReliabilityStore(t)
	proxyURL := seedReliabilityProxy(t, store, ctx, source, "cancel", "active", 2)
	claim := func() FreeProxyCandidate {
		t.Helper()
		candidates, err := store.ClaimFreeProxiesDueForCheck(ctx, []string{"sqlrely"}, 1, false)
		if err != nil || len(candidates) != 1 || candidates[0].ClaimedUntil.IsZero() {
			t.Fatalf("claim = %#v, %v", candidates, err)
		}
		return candidates[0]
	}
	first := claim()
	if err := store.ReleaseFreeProxyCheckClaimsContext(ctx, []FreeProxyCandidate{first}); err != nil {
		t.Fatal(err)
	}
	second := claim() // No six-minute lease or ten-minute schedule wait.
	if err := store.ReleaseFreeProxyCheckClaimsContext(ctx, []FreeProxyCandidate{first}); err != nil {
		t.Fatal(err)
	}
	var currentClaim time.Time
	var due bool
	if err := store.db.QueryRowContext(ctx, `SELECT p.check_claimed_until, h.next_check_at<=NOW() FROM free_proxies p JOIN free_proxy_health h ON h.proxy_id=p.id WHERE p.proxy_url=$1 AND h.region='sqlrely'`, proxyURL).Scan(&currentClaim, &due); err != nil {
		t.Fatal(err)
	}
	if !currentClaim.Equal(second.ClaimedUntil) || due {
		t.Fatal("stale cleanup released another validator's claim or scheduling hold")
	}
	if err := store.RecordFreeProxyFailureStageContext(ctx, proxyURL, "sqlrely", 429, "synthetic rate limit", "vinted_429", "catalog", 3, 30); err != nil {
		t.Fatal(err)
	}
	if err := store.ReleaseFreeProxyCheckClaimsContext(ctx, []FreeProxyCandidate{second}); err != nil {
		t.Fatal(err)
	}
	var status string
	var failures int
	if err := store.db.QueryRowContext(ctx, `SELECT status, failure_streak, next_check_at<=NOW() FROM free_proxy_health WHERE proxy_id=(SELECT id FROM free_proxies WHERE proxy_url=$1) AND region='sqlrely'`, proxyURL).Scan(&status, &failures, &due); err != nil {
		t.Fatal(err)
	}
	if due || status != "cooldown" || failures != 1 {
		t.Fatalf("cleanup discarded rate-limit backoff: due=%v status=%s failures=%d", due, status, failures)
	}
}

func TestFreeProxyRegionalFailuresPreserveRecentlyWorkingRegions(t *testing.T) {
	store, ctx, source := freeProxyReliabilityStore(t)
	proxyURL := seedReliabilityProxy(t, store, ctx, source, "regional", "active", 2)
	if _, err := store.db.ExecContext(ctx, `
		INSERT INTO free_proxy_health (
			proxy_id, region, status, success_streak, failure_streak,
			success_count, last_success_at, last_failure_at, last_error_code, score
		)
		SELECT id, 'sqlfailed', 'cooldown', 0, 1, 2,
			NOW()-INTERVAL '10 minutes', NOW()-INTERVAL '1 minute', 'timeout', 50
		FROM free_proxies WHERE proxy_url=$1
		UNION ALL
		SELECT id, 'sqlhealthy', 'active', 2, 0, 2, NOW(), NULL, NULL, 80
		FROM free_proxies WHERE proxy_url=$1`, proxyURL); err != nil {
		t.Fatal(err)
	}
	if err := store.RecordFreeProxyFailureStageContext(ctx, proxyURL, "sqlrely", 0, "synthetic regional timeout", "timeout", "warmup", 3, 30); err != nil {
		t.Fatal(err)
	}
	healthy, err := store.GetActiveFreeProxiesContext(ctx, "sqlhealthy", 10)
	if err != nil || len(healthy) != 1 {
		t.Fatalf("regional timeout removed a recently working exit elsewhere: %v, %v", healthy, err)
	}
	failed, err := store.GetActiveFreeProxiesContext(ctx, "sqlrely", 10)
	if err != nil || len(failed) != 0 {
		t.Fatalf("failed region remained eligible: %v, %v", failed, err)
	}
	// Old evidence cannot protect an endpoint that now fails in multiple
	// regions. Global quarantine must still remove it from every pool.
	if _, err := store.db.ExecContext(ctx, `UPDATE free_proxy_health SET last_success_at=NOW()-INTERVAL '3 minutes' WHERE region='sqlhealthy' AND proxy_id=(SELECT id FROM free_proxies WHERE proxy_url=$1)`, proxyURL); err != nil {
		t.Fatal(err)
	}
	if err := store.RecordFreeProxyFailureStageContext(ctx, proxyURL, "sqlrely", 0, "synthetic correlated outage", "timeout", "warmup", 3, 30); err != nil {
		t.Fatal(err)
	}
	healthy, err = store.GetActiveFreeProxiesContext(ctx, "sqlhealthy", 10)
	if err != nil || len(healthy) != 0 {
		t.Fatalf("correlated failure with no fresh success escaped quarantine: %v, %v", healthy, err)
	}
}
