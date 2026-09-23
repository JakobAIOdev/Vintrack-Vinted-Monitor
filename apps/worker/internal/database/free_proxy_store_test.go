package database

import "testing"

func TestPruneUnselectedFreeProxiesSkipsEmptyKeepSet(t *testing.T) {
	store := &Store{}

	pruned, err := store.PruneUnselectedFreeProxies(nil)
	if err != nil {
		t.Fatalf("PruneUnselectedFreeProxies(nil) error = %v", err)
	}
	if pruned != 0 {
		t.Fatalf("PruneUnselectedFreeProxies(nil) = %d, want 0", pruned)
	}
}

func TestFreeProxyCandidateWindowWork(t *testing.T) {
	tests := []struct {
		name     string
		counts   freeProxyCandidateWindowCounts
		limit    int
		wantFill bool
		wantTrim bool
	}{
		{
			name:   "stable window",
			counts: freeProxyCandidateWindowCounts{total: 100, eligible: 100},
			limit:  100,
		},
		{
			name:     "underfilled window",
			counts:   freeProxyCandidateWindowCounts{total: 60, eligible: 60},
			limit:    100,
			wantFill: true,
		},
		{
			name:     "overfilled window",
			counts:   freeProxyCandidateWindowCounts{total: 140, eligible: 140},
			limit:    100,
			wantTrim: true,
		},
		{
			name:     "disabled rows need replacement",
			counts:   freeProxyCandidateWindowCounts{total: 100, eligible: 80},
			limit:    100,
			wantFill: true,
			wantTrim: true,
		},
		{
			name:     "overfilled window with disabled rows",
			counts:   freeProxyCandidateWindowCounts{total: 140, eligible: 80},
			limit:    100,
			wantFill: true,
			wantTrim: true,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fill, trim := freeProxyCandidateWindowWork(test.counts, test.limit)
			if fill != test.wantFill || trim != test.wantTrim {
				t.Fatalf(
					"freeProxyCandidateWindowWork(%+v, %d) = (%t, %t), want (%t, %t)",
					test.counts,
					test.limit,
					fill,
					trim,
					test.wantFill,
					test.wantTrim,
				)
			}
		})
	}
}

func TestFreeProxyLaneQuotas(t *testing.T) {
	bootstrap := freeProxyLaneQuotas(100, true)
	wantBootstrap := []freeProxyLaneQuota{
		{name: "keepalive", limit: 40},
		{name: "region_affine", limit: 30},
		{name: "fanout", limit: 20},
		{name: "explore", limit: 10},
	}
	if len(bootstrap) != len(wantBootstrap) {
		t.Fatalf("bootstrap lanes = %#v, want %#v", bootstrap, wantBootstrap)
	}
	for index := range wantBootstrap {
		if bootstrap[index] != wantBootstrap[index] {
			t.Fatalf("bootstrap lanes = %#v, want %#v", bootstrap, wantBootstrap)
		}
	}

	maintenance := freeProxyLaneQuotas(40, false)
	wantMaintenance := []freeProxyLaneQuota{
		{name: "keepalive", limit: 28},
		{name: "fanout", limit: 8},
		{name: "explore", limit: 4},
	}
	for index := range wantMaintenance {
		if maintenance[index] != wantMaintenance[index] {
			t.Fatalf("maintenance lanes = %#v, want %#v", maintenance, wantMaintenance)
		}
	}
}

func TestFreeProxyLaneQuotasNeverExceedSmallBudget(t *testing.T) {
	for limit := 1; limit < 10; limit++ {
		total := 0
		for _, lane := range freeProxyLaneQuotas(limit, true) {
			total += lane.limit
		}
		if total != limit {
			t.Fatalf("limit %d allocated %d", limit, total)
		}
	}
}
