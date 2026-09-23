package proxy

import "testing"

func TestRegionPoolsRetainClearsRemovedManagers(t *testing.T) {
	pools := NewRegionPools()
	removed := pools.Manager("fr")
	pools.Replace("de", "http://1.2.3.4:8080")
	pools.Replace("fr", "http://5.6.7.8:8080")

	pools.Retain([]string{"de"})

	if got := pools.Manager("de").Count(); got != 1 {
		t.Fatalf("retained pool count = %d, want 1", got)
	}
	if got := removed.Count(); got != 0 {
		t.Fatalf("removed manager count = %d, want 0", got)
	}
	if current := pools.Manager("fr"); current == removed {
		t.Fatal("removed region returned its stale manager")
	}
}

func TestRegionPoolsPublishAtomicallyVersionsServingSnapshot(t *testing.T) {
	pools := NewRegionPools()
	if changed := pools.Publish(
		"gb",
		"http://1.2.3.4:8080\nhttp://5.6.7.8:8080",
		"ready",
		2,
		"",
		2,
	); !changed {
		t.Fatal("initial serving snapshot was not published")
	}
	first := pools.Snapshot("gb")
	if first.State != "ready" || first.Mature != 2 || first.ReadyObservations != 2 || len(first.Proxies) != 2 {
		t.Fatalf("initial snapshot = %#v", first)
	}
	if changed := pools.Publish(
		"gb",
		"http://1.2.3.4:8080\nhttp://5.6.7.8:8080",
		"ready",
		2,
		"",
		2,
	); changed {
		t.Fatal("identical serving snapshot incremented the version")
	}
	if current := pools.Snapshot("gb"); current.Version != first.Version {
		t.Fatalf("identical snapshot version = %d, want %d", current.Version, first.Version)
	}
	if changed := pools.Publish("gb", "", "recovering", 1, "below_hysteresis", 0); !changed {
		t.Fatal("fail-closed snapshot was not published")
	}
	closed := pools.Snapshot("gb")
	if closed.State != "recovering" || closed.Mature != 1 || closed.Reason != "below_hysteresis" || len(closed.Proxies) != 0 {
		t.Fatalf("closed snapshot = %#v", closed)
	}
	if closed.Version <= first.Version {
		t.Fatalf("closed snapshot version = %d, want > %d", closed.Version, first.Version)
	}
}
