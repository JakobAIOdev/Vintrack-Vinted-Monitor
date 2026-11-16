package main

import (
	"fmt"
	"reflect"
	"testing"

	"github.com/lib/pq"
)

func TestFreeProxyClaimsRespectRegionSlotsAcrossPriorityLanes(t *testing.T) {
	for _, bootstrap := range []bool{true, false} {
		t.Run(fmt.Sprintf("bootstrap=%t", bootstrap), func(t *testing.T) {
			store, db, ctx := freeProxyMaintainerTestStore(t)
			regions := []string{"us", "de", "fr", "gb", "it"}
			if _, err := db.ExecContext(ctx, `
				WITH seeded AS (
					INSERT INTO free_proxies (proxy_url, host, port, protocol, source, success_count)
					SELECT 'http://' || region || '-' || n || '.invalid:80',
						region || '-' || n || '.invalid', 80, 'http', 'region-slots',
						CASE WHEN region='fr' THEN 0 ELSE 2 END
					FROM unnest($1::text[]) region CROSS JOIN generate_series(1, 40) n
					RETURNING id, host
				)
				INSERT INTO free_proxy_health (
					proxy_id, region, status, score, success_streak, success_count,
					last_checked_at, last_success_at, next_check_at, candidate_window_token
				)
				SELECT id, split_part(host, '-', 1),
					CASE WHEN host LIKE 'de-%' OR host LIKE 'fr-%' THEN 'pending' ELSE 'active' END,
					80, CASE WHEN host LIKE 'de-%' THEN 1 WHEN host LIKE 'fr-%' THEN 0 ELSE 2 END,
					CASE WHEN host LIKE 'fr-%' THEN 0 ELSE 2 END,
					CASE WHEN host NOT LIKE 'fr-%' THEN NOW()-INTERVAL '2 minutes' END,
					CASE WHEN host NOT LIKE 'fr-%' THEN NOW()-INTERVAL '2 minutes' END,
					NOW()-INTERVAL '1 second', FLOOR(EXTRACT(EPOCH FROM NOW()) / 3600)::bigint
				FROM seeded`, pq.Array(regions)); err != nil {
				t.Fatal(err)
			}
			limits := map[string]int{"us": 4, "de": 4, "fr": 4, "gb": 0}
			for wave := range 2 {
				candidates, err := store.ClaimFreeProxiesDueForCheckWithRegionLimits(ctx, regions, 24, bootstrap, limits)
				if err != nil {
					t.Fatal(err)
				}
				counts := make(map[string]int)
				seen := make(map[string]bool)
				for _, candidate := range candidates {
					counts[candidate.Region]++
					if seen[candidate.ProxyURL] {
						t.Fatalf("wave %d claimed one proxy more than once", wave)
					}
					seen[candidate.ProxyURL] = true
				}
				if !reflect.DeepEqual(counts, map[string]int{"us": 4, "de": 4, "fr": 4}) {
					t.Fatalf("wave %d distribution = %v; want four per allowed region across all lanes", wave, counts)
				}
				if !reflect.DeepEqual(limits, map[string]int{"us": 4, "de": 4, "fr": 4, "gb": 0}) {
					t.Fatalf("claim mutated caller's slot budget: %v", limits)
				}
			}
		})
	}
}

func TestFreeProxyRegionSlotsApplyAfterSourceDiversity(t *testing.T) {
	store, db, ctx := freeProxyMaintainerTestStore(t)
	if _, err := db.ExecContext(ctx, `
		WITH seeded AS (
			INSERT INTO free_proxies (
				proxy_url, host, port, protocol, source, success_count, last_success_at
			)
			SELECT 'http://' || region || '-' || source || '-' || n || '.invalid:80',
				region || '-' || source || '-' || n || '.invalid', 80, 'http', source, 2,
				NOW() - CASE WHEN (region='de' AND source='preferred') OR (region='fr' AND source='fallback')
					THEN INTERVAL '2 minutes' ELSE INTERVAL '10 minutes' END
			FROM unnest(ARRAY['de','fr']) region
			CROSS JOIN unnest(ARRAY['preferred','fallback']) source
			CROSS JOIN generate_series(1, 20) n
			RETURNING id, host, last_success_at
		)
		INSERT INTO free_proxy_health (
			proxy_id, region, status, score, success_streak, success_count,
			last_checked_at, last_success_at, next_check_at, candidate_window_token
		)
		SELECT id, split_part(host, '-', 1), 'active', 80, 2, 2,
			last_success_at, last_success_at, NOW()-INTERVAL '1 second',
			FLOOR(EXTRACT(EPOCH FROM NOW()) / 3600)::bigint
		FROM seeded;
		INSERT INTO free_proxy_source_health_stats (
			source, region, protocol, success_count, failure_count, success_ewma
		)
		SELECT source, region, 'http', CASE WHEN source='preferred' THEN 100 ELSE 1 END,
			CASE WHEN source='preferred' THEN 0 ELSE 10 END,
			CASE WHEN source='preferred' THEN 1.0 ELSE 0.1 END
		FROM unnest(ARRAY['de','fr']) region
		CROSS JOIN unnest(ARRAY['preferred','fallback']) source;`); err != nil {
		t.Fatal(err)
	}
	candidates, err := store.ClaimFreeProxiesDueForCheckWithRegionLimits(ctx, []string{"de", "fr"}, 8, false, map[string]int{"de": 4, "fr": 4})
	if err != nil {
		t.Fatal(err)
	}
	counts := make(map[string]int)
	for _, candidate := range candidates {
		counts[candidate.Region]++
	}
	if !reflect.DeepEqual(counts, map[string]int{"de": 4, "fr": 4}) {
		t.Fatalf("source diversity consumed regional slots without claims: %v", counts)
	}
}
