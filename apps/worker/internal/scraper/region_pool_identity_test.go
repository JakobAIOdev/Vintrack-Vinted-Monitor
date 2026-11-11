package scraper

import (
	"testing"

	"vintrack-worker/internal/proxy"
)

// A region leaves the configured set whenever its last free monitor pauses.
// The engine keeps its client pool for that region, so the pool must see the
// proxies again once the region is published a second time.
func TestFreeClientPoolRecoversAfterRegionIsRetainedAway(t *testing.T) {
	pools := proxy.NewRegionPools()
	pools.Publish("de", "http://192.0.2.1:8080\nhttp://192.0.2.2:8080", "ready", 2, "", 2)
	pool := NewClientPool(pools.Manager("de"), "www.vinted.de", 2, nil)
	if got := pool.Size(); got != 2 {
		t.Fatalf("initial pool size = %d, want 2", got)
	}

	pools.Retain(nil)
	pool.Reconcile(2)
	if got := pool.Size(); got != 0 {
		t.Fatalf("pool size after region removal = %d, want 0", got)
	}

	pools.Publish("de", "http://192.0.2.3:8080\nhttp://192.0.2.4:8080", "ready", 2, "", 2)
	pool.Reconcile(2)
	if got := pool.Size(); got != 2 {
		t.Fatalf("pool size after region returned = %d, want 2", got)
	}
}
