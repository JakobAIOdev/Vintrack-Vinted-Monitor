package scraper

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"vintrack-worker/internal/proxy"
)

func TestFreeProxyAdmissionIsSharedAcrossRegionalPools(t *testing.T) {
	now := time.Now()
	e := &Engine{pools: make(map[string]*ClientPool)}
	makePool := func(domain string) *ClientPool {
		p := e.GetOrCreatePoolSized(proxy.FromString("http://198.18.1.10:8080"), domain, "free:test", nil, "free", 1)
		p.now = func() time.Time { return now }
		p.SetMaxRequestsPerSecond(0.5)
		t.Cleanup(func() {
			for _, state := range p.states {
				state.client.Close()
			}
		})
		return p
	}
	de, fr := makePool("www.vinted.de"), makePool("www.vinted.fr")
	if de.Acquire(nil) == nil {
		t.Fatal("first regional request was not admitted")
	}
	if fr.Acquire(nil) != nil {
		t.Fatal("same exit received a second regional budget inside the two-second interval")
	}
	now = now.Add(2 * time.Second)
	if fr.Acquire(nil) == nil {
		t.Fatal("shared exit was not released at the next admission interval")
	}
}

func TestFreeProxySellerPoolSharesCatalogBudget(t *testing.T) {
	t.Setenv("FREE_SELLER_CLIENT_POOL_SIZE", "1")
	now := time.Now()
	e := &Engine{pools: make(map[string]*ClientPool), enrichers: make(map[string]*SellerEnricher)}
	manager := proxy.FromString("http://198.18.1.12:8080")
	catalog := e.GetOrCreatePoolSized(manager, "www.vinted.de", "free:de", nil, "free", 1)
	seller := e.GetOrCreateEnricher(manager, "www.vinted.fr", "free:fr", nil, "free").pool
	for _, p := range []*ClientPool{catalog, seller} {
		p.now = func() time.Time { return now }
		t.Cleanup(func() {
			for _, state := range p.states {
				state.client.Close()
			}
		})
	}
	if catalog.Acquire(nil) == nil {
		t.Fatal("catalog request was not admitted")
	}
	if seller.Acquire(nil) != nil {
		t.Fatal("seller pool minted another budget for the same exit")
	}
	// Replacing a regional pool must not reset the shared reservation.
	delete(e.pools, "www.vinted.de:free:de")
	rebuilt := e.GetOrCreatePoolSized(manager, "www.vinted.de", "free:de", nil, "free", 1)
	rebuilt.now = func() time.Time { return now }
	t.Cleanup(func() {
		for _, state := range rebuilt.states {
			state.client.Close()
		}
	})
	if rebuilt.Acquire(nil) != nil {
		t.Fatal("recreating a pool reset the exit budget")
	}
}

func TestFreeProxySharedAdmissionConcurrentAndIndependentExits(t *testing.T) {
	now := time.Now()
	a := &sharedProxyAdmission{}
	var admitted atomic.Int32
	var wg sync.WaitGroup
	for range 100 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if a.acquire("http://198.18.1.13:8080", now) {
				admitted.Add(1)
			}
		}()
	}
	wg.Wait()
	if got := admitted.Load(); got != 1 {
		t.Fatalf("concurrent admissions=%d, want 1", got)
	}
	if !a.acquire("http://198.18.1.14:8080", now) {
		t.Fatal("independent exit was blocked")
	}
	a.setRate(1)
	if a.acquire("http://198.18.1.13:8080/", now) {
		t.Fatal("policy refresh or URL slash reset the outstanding reservation")
	}
	if !a.acquire("http://198.18.1.13:8080", now.Add(2*time.Second)) {
		t.Fatal("expired reservation was not released")
	}
	metric := a.snapshot()
	if metric.AdmittedRequests != 3 || metric.MinimumIntervalMS != 2000 || metric.MaxRequestsPerProxySecond != 1 {
		t.Fatalf("shared admission evidence = %+v", metric)
	}
}

func TestFreeProxySharedAdmissionBoundsAndExpiresEntries(t *testing.T) {
	now := time.Now()
	a := &sharedProxyAdmission{next: make(map[string]sharedProxyAdmissionEntry), prunedAt: now}
	for i := 0; i < maxSharedProxyAdmissionEntries; i++ {
		a.next[fmt.Sprint(i)] = sharedProxyAdmissionEntry{next: now.Add(2 * time.Second), admittedAt: now}
	}
	if a.acquire("new-exit", now) {
		t.Fatal("registry exceeded its memory bound")
	}
	if !a.acquire("new-exit", now.Add(3*time.Second)) {
		t.Fatal("expired entries did not release registry capacity")
	}
	if len(a.next) != 1 {
		t.Fatalf("retained entries=%d, want 1", len(a.next))
	}
}

func TestFreeProxySharedAdmissionWaitHonorsCancellation(t *testing.T) {
	now := time.Now()
	a := &sharedProxyAdmission{}
	a.acquire("http://198.18.1.15:8080", now)
	p := &ClientPool{states: []*clientState{{client: &Client{ProxyURL: "http://198.18.1.15:8080"}}}, sharedAdmission: a}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if client, _, err := p.AcquireWithAdmission(ctx, nil, time.Second); client != nil || err != context.Canceled {
		t.Fatalf("canceled admission = %v, %v", client, err)
	}
}

func TestFreeProxySharedAdmissionUsesOtherAvailableExit(t *testing.T) {
	now := time.Now()
	a := &sharedProxyAdmission{}
	a.acquire("http://198.18.1.16:8080", now)
	first := &Client{ProxyURL: "http://198.18.1.16:8080"}
	second := &Client{ProxyURL: "http://198.18.1.17:8080"}
	p := &ClientPool{states: []*clientState{{client: first}, {client: second}}, sharedAdmission: a, now: func() time.Time { return now }}
	if got := p.Acquire(nil); got != second {
		t.Fatal("busy shared exit withheld an independent available exit")
	}
}

func TestFreeProxySharedAdmissionDoesNotLimitOwnedPool(t *testing.T) {
	now := time.Now()
	e := &Engine{pools: make(map[string]*ClientPool)}
	manager := proxy.FromString("http://198.18.1.18:8080")
	free := e.GetOrCreatePoolSized(manager, "www.vinted.de", "free:de", nil, "free", 1)
	owned := e.GetOrCreatePoolSized(manager, "www.vinted.fr", "group:owned", nil, "group:owned", 1)
	for _, p := range []*ClientPool{free, owned} {
		p.now = func() time.Time { return now }
		t.Cleanup(func() {
			for _, state := range p.states {
				state.client.Close()
			}
		})
	}
	if free.Acquire(nil) == nil || owned.Acquire(nil) == nil {
		t.Fatal("free budget affected an independently configured owned pool")
	}
}

func TestFreeProxyRoundRobinHonorsCatalogAdmission(t *testing.T) {
	now := time.Now()
	client := &Client{ProxyURL: "http://198.18.1.11:8080"}
	p := &ClientPool{states: []*clientState{{client: client}}, now: func() time.Time { return now }}
	p.SetMaxRequestsPerSecond(0.5)
	if p.Acquire(nil) == nil {
		t.Fatal("catalog request was not admitted")
	}
	if p.AcquireRoundRobin() != nil {
		t.Fatal("background request bypassed the configured proxy rate")
	}
}
