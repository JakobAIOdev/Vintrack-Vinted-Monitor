package database

import (
	"context"
	"crypto/md5"
	"fmt"
	"testing"
	"time"
)

func rankedFreeProxyCandidateTestURL(t *testing.T, ctx context.Context, store *Store, label string, first bool) string {
	t.Helper()
	var hour int64
	if err := store.db.QueryRowContext(ctx, `SELECT FLOOR(EXTRACT(EPOCH FROM NOW()) / 3600)::bigint`).Scan(&hour); err != nil {
		t.Fatal(err)
	}
	// Pick deterministic URLs whose hourly order puts the newcomer first.
	// Include the next bucket so crossing an hour cannot make the test flaky.
	for index := 0; index < 10000; index++ {
		url := fmt.Sprintf("http://window-%s-%d.invalid:80", label, index)
		matches := true
		for _, bucket := range []int64{hour, hour + 1} {
			digest := md5.Sum([]byte(fmt.Sprintf("%s:%d", url, bucket)))
			matches = matches && ((digest[0] < 128) == first)
		}
		if matches {
			return url
		}
	}
	t.Fatal("could not construct candidate ordering")
	return ""
}

func TestFreeProxyCandidateWindowPreservesNewCandidatesDuringFanout(t *testing.T) {
	store := freeProxyImportTestStore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	newURL := rankedFreeProxyCandidateTestURL(t, ctx, store, "new", true)
	const region = "windowtest"
	// The new import has a larger database ID than both older untested rows.
	// It already won a place in this hour's window before fanout adds a proven
	// candidate. Trimming must not discard it just because its ID is newer.
	for _, url := range []string{
		rankedFreeProxyCandidateTestURL(t, ctx, store, "old-a", false),
		rankedFreeProxyCandidateTestURL(t, ctx, store, "old-b", false),
		newURL,
	} {
		if _, err := store.db.ExecContext(ctx, `
			WITH inserted AS (
				INSERT INTO free_proxies (proxy_url) VALUES ($1) RETURNING id
			)
			INSERT INTO free_proxy_health (proxy_id, region)
			SELECT id, $2 FROM inserted`, url, region); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := store.db.ExecContext(ctx, `
		INSERT INTO free_proxies (proxy_url, success_count, last_success_at)
		VALUES ('http://globally-proven.invalid:80', 1, NOW())`); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err := store.EnsureFreeProxyHealthRowsWithLimitsContext(ctx, map[string]int{region: 3}); err != nil {
			t.Fatal(err)
		}
		var newIncluded, provenIncluded bool
		var count int
		if err := store.db.QueryRowContext(ctx, `
			SELECT COUNT(*),
				COALESCE(BOOL_OR(fp.proxy_url = $2), FALSE),
				COALESCE(BOOL_OR(fp.proxy_url = 'http://globally-proven.invalid:80'), FALSE)
			FROM free_proxy_health fph JOIN free_proxies fp ON fp.id = fph.proxy_id
			WHERE fph.region = $1 AND fph.candidate_window_token =
				FLOOR(EXTRACT(EPOCH FROM NOW()) / 3600)::bigint`, region, newURL).Scan(&count, &newIncluded, &provenIncluded); err != nil {
			t.Fatal(err)
		}
		if count != 3 || !newIncluded || !provenIncluded {
			t.Fatalf("trimmed window: count=%d new=%t proven=%t; want a bounded window retaining both", count, newIncluded, provenIncluded)
		}
	}
}

func TestFreeProxyCandidateClaimsUseHourlyOrder(t *testing.T) {
	store := freeProxyImportTestStore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	newURL := rankedFreeProxyCandidateTestURL(t, ctx, store, "claim-new", true)
	const region = "windowtest"
	for _, url := range []string{
		rankedFreeProxyCandidateTestURL(t, ctx, store, "claim-old-a", false),
		rankedFreeProxyCandidateTestURL(t, ctx, store, "claim-old-b", false),
		newURL,
	} {
		if _, err := store.db.ExecContext(ctx, `
			WITH inserted AS (
				INSERT INTO free_proxies (proxy_url) VALUES ($1) RETURNING id
			)
			INSERT INTO free_proxy_health (proxy_id, region)
			SELECT id, $2 FROM inserted`, url, region); err != nil {
			t.Fatal(err)
		}
	}
	claimed, err := store.ClaimFreeProxiesDueForCheck(ctx, []string{region}, 1, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(claimed) != 1 || claimed[0].ProxyURL != newURL {
		t.Fatalf("exploration picked database insertion order instead of the candidate order: %#v", claimed)
	}
}

func TestFreeProxyCandidateWindowBalancesColdProtocolsAndRetainsHealthyRows(t *testing.T) {
	store := freeProxyImportTestStore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_, err := store.db.ExecContext(ctx, `
		INSERT INTO free_proxies (proxy_url, protocol)
		SELECT 'http://cold-' || n || '.invalid:80', 'http' FROM generate_series(1, 200) n;
		INSERT INTO free_proxies (proxy_url, protocol)
		SELECT protocol || '://cold-' || n || '.invalid:80', protocol
		FROM unnest(ARRAY['https','socks5','socks4']) protocol, generate_series(1, 20) n;
		UPDATE free_proxies SET source = 'iplocate:de' WHERE protocol = 'http';
		WITH inserted AS (
			INSERT INTO free_proxies (proxy_url, success_count, last_success_at)
			VALUES ('http://healthy.invalid:80', 10, NOW()) RETURNING id
		)
		INSERT INTO free_proxy_health (proxy_id, region, status, success_count, last_success_at, candidate_window_token)
		SELECT id, 'de', 'active', 10, NOW(), NULL FROM inserted;`)
	if err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err := store.EnsureFreeProxyHealthRowsWithLimitsContext(ctx, map[string]int{"de": 41}); err != nil {
			t.Fatal(err)
		}
		rows, err := store.db.QueryContext(ctx, `
			SELECT fp.protocol, COUNT(*)
			FROM free_proxy_health fph JOIN free_proxies fp ON fp.id = fph.proxy_id
			WHERE fph.region = 'de' AND fph.candidate_window_token =
				FLOOR(EXTRACT(EPOCH FROM NOW()) / 3600)::bigint
			  AND fp.proxy_url <> 'http://healthy.invalid:80'
			GROUP BY fp.protocol`)
		if err != nil {
			t.Fatal(err)
		}
		counts := make(map[string]int)
		for rows.Next() {
			var protocol string
			var count int
			if err := rows.Scan(&protocol, &count); err != nil {
				t.Fatal(err)
			}
			counts[protocol] = count
		}
		if err := rows.Err(); err != nil {
			t.Fatal(err)
		}
		rows.Close()
		for _, protocol := range []string{"http", "https", "socks5", "socks4"} {
			if counts[protocol] != 10 {
				t.Fatalf("cold protocol %s has %d candidates, want 10: %v", protocol, counts[protocol], counts)
			}
		}
		var healthy bool
		if err := store.db.QueryRowContext(ctx, `
			SELECT candidate_window_token = FLOOR(EXTRACT(EPOCH FROM NOW()) / 3600)::bigint
			FROM free_proxy_health WHERE status = 'active'`).Scan(&healthy); err != nil || !healthy {
			t.Fatalf("healthy proxy lost its candidate slot: %v, %v", healthy, err)
		}
	}
}

func TestFreeProxyCandidateWindowBalancesAtInventoryLimit(t *testing.T) {
	store := freeProxyImportTestStore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	_, err := store.db.ExecContext(ctx, `
		INSERT INTO free_proxies (proxy_url, protocol)
		SELECT protocol || '://load-' || n || '.invalid:80', protocol
		FROM (VALUES ('http', 21000), ('socks5', 6000), ('socks4', 1800), ('https', 1200)) counts(protocol, total)
		CROSS JOIN LATERAL generate_series(1, total) n;`)
	if err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	if err := store.EnsureFreeProxyHealthRowsWithLimitsContext(ctx, map[string]int{"de": 10000, "uk": 1000}); err != nil {
		t.Fatal(err)
	}
	t.Logf("filled regional candidate windows from 30,000 entries in %s", time.Since(started))
	for region, want := range map[string]map[string]int{
		"de": {"http": 3500, "socks5": 3500, "socks4": 1800, "https": 1200},
		"uk": {"http": 250, "socks5": 250, "socks4": 250, "https": 250},
	} {
		for protocol, wantCount := range want {
			var count int
			if err := store.db.QueryRowContext(ctx, `
				SELECT COUNT(*) FROM free_proxy_health fph JOIN free_proxies fp ON fp.id = fph.proxy_id
				WHERE fph.region = $1 AND fp.protocol = $2 AND fph.candidate_window_token =
					FLOOR(EXTRACT(EPOCH FROM NOW()) / 3600)::bigint`, region, protocol).Scan(&count); err != nil {
				t.Fatal(err)
			}
			if count != wantCount {
				t.Fatalf("%s/%s candidates = %d, want %d (unused quota must flow to available protocols)", region, protocol, count, wantCount)
			}
		}
	}
}
