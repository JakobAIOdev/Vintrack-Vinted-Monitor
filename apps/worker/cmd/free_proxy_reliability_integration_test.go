package main

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"vintrack-worker/internal/database"
	"vintrack-worker/internal/proxy"
	"vintrack-worker/internal/scraper"

	"github.com/lib/pq"
)

func freeProxyMaintainerTestStore(t *testing.T) (*database.Store, *sql.DB, context.Context) {
	t.Helper()
	dsn := os.Getenv("FREE_PROXY_STORE_INTEGRATION_DATABASE_URL")
	if dsn == "" {
		t.Skip("FREE_PROXY_STORE_INTEGRATION_DATABASE_URL is not set")
	}
	admin, err := sql.Open("postgres", dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = admin.Close() })
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	t.Cleanup(cancel)
	schema := pq.QuoteIdentifier(fmt.Sprintf("wave_%d", time.Now().UnixNano()))
	if _, err := admin.ExecContext(ctx, `CREATE SCHEMA `+schema); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if _, err := admin.ExecContext(cleanupCtx, `DROP SCHEMA `+schema+` CASCADE`); err != nil {
			t.Error(err)
		}
	})
	for _, table := range []string{"free_proxies", "free_proxy_health", "free_proxy_source_health_stats", "app_settings", "feature_policies", "monitors"} {
		if _, err := admin.ExecContext(ctx, `CREATE TABLE `+schema+`.`+pq.QuoteIdentifier(table)+` (LIKE public.`+pq.QuoteIdentifier(table)+` INCLUDING ALL)`); err != nil {
			t.Fatal(err)
		}
	}
	parsed, err := url.Parse(dsn)
	if err != nil {
		t.Fatal(err)
	}
	params := parsed.Query()
	params.Set("search_path", strings.Trim(schema, `"`))
	parsed.RawQuery = params.Encode()
	dsn = parsed.String()
	store, err := database.NewStore(dsn, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	db, err := sql.Open("postgres", dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return store, db, ctx
}

// Exercise the real claim -> validation wave -> persistence -> serving path.
// Synthetic validator outcomes avoid sending requests to Vinted or public exits.
func TestFreeProxyMaintainerBuildsReserveWithLargeColdInventory(t *testing.T) {
	store, db, ctx := freeProxyMaintainerTestStore(t)
	source := fmt.Sprintf("wave-%d", time.Now().UnixNano())
	if _, err := db.ExecContext(ctx, `
		WITH proxies AS (
			INSERT INTO free_proxies (proxy_url, host, port, protocol, source, success_count)
			SELECT 'http://' || $1 || '-' || n || '.invalid:80',
				$1 || '-' || n || '.invalid', 80, 'http', $1,
				CASE WHEN n<=12 THEN 2 WHEN n<=18 THEN 1 ELSE 0 END
			FROM generate_series(1, 1018) AS n
			RETURNING id, success_count
		)
		INSERT INTO free_proxy_health (
			proxy_id, region, status, score, success_streak, success_count,
			last_checked_at, last_success_at, next_check_at
		)
		SELECT id, 'sqlwave', CASE WHEN success_count=2 THEN 'active' ELSE 'pending' END,
			80, success_count, success_count,
			CASE WHEN success_count>0 THEN NOW()-INTERVAL '2 minutes' END,
			CASE WHEN success_count>0 THEN NOW()-INTERVAL '2 minutes' END,
			NOW()-INTERVAL '1 second'
		FROM proxies`, source); err != nil {
		t.Fatal(err)
	}
	before, err := store.CountActiveFreeProxiesContext(ctx, "sqlwave")
	if err != nil || before != 12 {
		t.Fatalf("initial pool = %d, %v", before, err)
	}
	candidates, err := store.ClaimFreeProxiesDueForCheck(ctx, []string{"sqlwave"}, 10, true)
	if err != nil || len(candidates) != 10 {
		t.Fatalf("claim = %d, %v", len(candidates), err)
	}
	stats := validateFreeProxyWaveWithValidator(ctx, store, candidates, time.Second, 2500, 3, 30, 4,
		func(ctx context.Context, proxyURL, _ string, _ int) (scraper.FreeProxyValidationResult, error) {
			for n := 1; n <= 18; n++ {
				if strings.Contains(proxyURL, fmt.Sprintf("-%d.invalid:", n)) {
					return scraper.FreeProxyValidationResult{LatencyMs: 150, StatusCode: 200, Stage: scraper.FreeProxyValidationStageCatalog}, nil
				}
			}
			return scraper.FreeProxyValidationResult{ErrorCode: "timeout", Stage: scraper.FreeProxyValidationStageWarmup}, context.DeadlineExceeded
		})
	after, err := store.CountActiveFreeProxiesContext(ctx, "sqlwave")
	if err != nil || after < 14 || stats.Passed < 2 || stats.Failed == 0 || stats.Canceled != 0 || stats.PersistenceFailed != 0 {
		t.Fatalf("reserve did not grow while rejecting broken proxies: before=%d after=%d stats=%+v err=%v", before, after, stats, err)
	}
	serving, err := store.GetActiveFreeProxiesContext(ctx, "sqlwave", 100)
	if err != nil || len(serving) != after {
		t.Fatalf("serving pool = %d, %v; want %d", len(serving), err, after)
	}

	// A canceled following wave must neither shrink the working pool nor
	// leave its replacements blocked for another six to ten minutes.
	candidates, err = store.ClaimFreeProxiesDueForCheck(ctx, []string{"sqlwave"}, 10, true)
	if err != nil || len(candidates) != 10 {
		t.Fatalf("second claim = %d, %v", len(candidates), err)
	}
	canceledCtx, cancelWave := context.WithCancel(ctx)
	cancelWave()
	stats = validateFreeProxyWaveWithValidator(canceledCtx, store, candidates, time.Second, 2500, 3, 30, 4, nil)
	if stats.Canceled != 10 || stats.Checked != 0 || stats.PersistenceFailed != 0 {
		t.Fatalf("canceled wave = %+v", stats)
	}
	var leases int
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM free_proxies WHERE source=$1 AND check_claimed_until IS NOT NULL`, source).Scan(&leases); err != nil || leases != 0 {
		t.Fatalf("stranded reservations = %d, %v", leases, err)
	}
	retried, err := store.ClaimFreeProxiesDueForCheck(ctx, []string{"sqlwave"}, 10, true)
	if err != nil || len(retried) != 10 {
		t.Fatalf("immediate retry = %d, %v", len(retried), err)
	}
	if err := store.ReleaseFreeProxyCheckClaimsContext(ctx, retried); err != nil {
		t.Fatal(err)
	}
	if count, err := store.CountActiveFreeProxiesContext(ctx, "sqlwave"); err != nil || count != after {
		t.Fatalf("cancellation shrank serving pool: %d, %v; want %d", count, err, after)
	}
}

func TestFreeProxyPublicationKeepsValidatedCapacityAtLimitedRate(t *testing.T) {
	store, db, ctx := freeProxyMaintainerTestStore(t)
	for key, value := range map[string]string{"free_proxy_starter_regions": "uk", "free_proxy_min_active_per_region": "10"} {
		if err := store.SetSettingValueContext(ctx, key, value); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO feature_policies (feature, enabled, updated_at) VALUES ('free_proxy_pool',TRUE,NOW())`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `
		WITH proxies AS (
			INSERT INTO free_proxies (proxy_url, host, port, protocol, source, status, quarantined_until)
			SELECT 'http://limited-'||n||'.invalid:80', 'limited-'||n||'.invalid', 80, 'http', 'limited-test',
				CASE WHEN n=11 THEN 'disabled' ELSE 'active' END,
				CASE WHEN n=10 THEN NOW()+INTERVAL '30 minutes' END
			FROM generate_series(1,11) n RETURNING id, proxy_url
		)
		INSERT INTO free_proxy_health (proxy_id, region, status, score, success_streak, success_count, last_success_at)
		SELECT id, 'uk', 'active', 80, CASE WHEN proxy_url='http://limited-8.invalid:80' THEN 1 ELSE 2 END, 2,
			CASE WHEN proxy_url='http://limited-9.invalid:80' THEN NOW()-INTERVAL '21 minutes' ELSE NOW() END
		FROM proxies`); err != nil {
		t.Fatal(err)
	}
	pools := proxy.NewRegionPools()
	refreshFreeProxies(store, pools)
	snapshot := pools.Snapshot("uk")
	if snapshot.State != "limited" || len(snapshot.Proxies) != 7 {
		t.Fatalf("safe degraded capacity was discarded or invalid exits were published: %+v", snapshot)
	}
	manager := pools.Manager("uk")
	if _, err := db.ExecContext(ctx, `UPDATE feature_policies SET enabled=FALSE WHERE feature='free_proxy_pool'`); err != nil {
		t.Fatal(err)
	}
	refreshFreeProxies(store, pools)
	if manager.Count() != 0 {
		t.Fatal("limited operation ignored the feature kill switch")
	}
	if _, err := db.ExecContext(ctx, `UPDATE feature_policies SET enabled=TRUE WHERE feature='free_proxy_pool'`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `UPDATE free_proxy_health SET status='cooldown'`); err != nil {
		t.Fatal(err)
	}
	refreshFreeProxies(store, pools)
	if pools.Manager("uk").Count() != 0 || pools.Snapshot("uk").State == "limited" {
		t.Fatal("zero validated exits were treated as usable capacity")
	}
	if _, err := db.ExecContext(ctx, `UPDATE free_proxy_health SET status='active', success_streak=2, last_success_at=NOW()`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `UPDATE free_proxies SET status='active', quarantined_until=NULL`); err != nil {
		t.Fatal(err)
	}
	refreshFreeProxies(store, pools)
	refreshFreeProxies(store, pools)
	if pools.Snapshot("uk").State != "ready" || pools.Manager("uk").Count() != 11 {
		t.Fatalf("full recovery failed: %+v", pools.Snapshot("uk"))
	}
}
