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
