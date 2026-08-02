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

func TestFreeProxyLaneQuotas(t *testing.T) {
	bootstrap := freeProxyLaneQuotas(100, true)
	wantBootstrap := []freeProxyLaneQuota{
		{name: "explore", limit: 60},
		{name: "fanout", limit: 25},
		{name: "keepalive", limit: 15},
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
		{name: "keepalive", limit: 32},
		{name: "explore", limit: 8},
	}
	for index := range wantMaintenance {
		if maintenance[index] != wantMaintenance[index] {
			t.Fatalf("maintenance lanes = %#v, want %#v", maintenance, wantMaintenance)
		}
	}
}
