package scraper

import (
	"context"
	"errors"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	"vintrack-worker/internal/model"
)

type catalogFailoverFetcher struct {
	status int
	err    error
	calls  atomic.Int32
	delay  time.Duration
	active atomic.Int32
	peak   atomic.Int32
}

func (*catalogFailoverFetcher) Name() string          { return "failover-test" }
func (*catalogFailoverFetcher) RequiresNetwork() bool { return false }
func (f *catalogFailoverFetcher) FetchCatalog(ctx context.Context, _ *Client, _ string, _ string) ([]model.VintedItem, int, error) {
	call := f.calls.Add(1)
	active := f.active.Add(1)
	defer f.active.Add(-1)
	for peak := f.peak.Load(); active > peak; peak = f.peak.Load() {
		if f.peak.CompareAndSwap(peak, active) {
			break
		}
	}
	if call == 1 {
		if f.delay > 0 {
			select {
			case <-ctx.Done():
				return nil, 0, ctx.Err()
			case <-time.After(f.delay):
			}
		}
		return nil, f.status, f.err
	}
	return []model.VintedItem{{ID: 42}}, 200, nil
}

func TestFreeProxySequentialFailoverDoesNotLaunchParallelRequests(t *testing.T) {
	t.Setenv("CATALOG_MAX_ATTEMPTS", "2")
	f := &catalogFailoverFetcher{err: errors.New("connection refused"), delay: 20 * time.Millisecond}
	e := &Engine{fetcher: f}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	r := e.fetchCatalogHedgedWithCapacity(ctx, catalogFailoverPool(), "https://example.invalid/catalog", "example.invalid", time.Millisecond, false)
	if r.err != nil || r.status != 200 || f.calls.Load() != 2 || f.peak.Load() != 1 {
		t.Fatalf("failover calls=%d peak concurrency=%d err=%v", f.calls.Load(), f.peak.Load(), r.err)
	}
}

func TestFreeProxySequentialFailoverHonorsOriginalDeadline(t *testing.T) {
	f := &catalogFailoverFetcher{err: errors.New("connection refused"), delay: time.Second}
	e := &Engine{fetcher: f}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	r := e.fetchCatalogHedgedWithCapacity(ctx, catalogFailoverPool(), "https://example.invalid/catalog", "example.invalid", time.Millisecond, false)
	if !errors.Is(r.err, context.DeadlineExceeded) || f.calls.Load() != 1 {
		t.Fatalf("expired failover calls=%d err=%v", f.calls.Load(), r.err)
	}
}
func catalogFailoverPool() *ClientPool {
	return &ClientPool{states: []*clientState{{client: &Client{ProxyURL: "http://198.18.3.10:8080"}}, {client: &Client{ProxyURL: "http://198.18.3.11:8080"}}}, quarantineAfter: 3, sharedAdmission: &sharedProxyAdmission{}}
}

func TestFreeProxySequentialFailoverWorksWithoutSpeculativeHedges(t *testing.T) {
	t.Setenv("CATALOG_MAX_ATTEMPTS", "2")
	f := &catalogFailoverFetcher{err: errors.New("connection refused")}
	e := &Engine{fetcher: f}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	r := e.fetchCatalogHedgedWithCapacity(ctx, catalogFailoverPool(), "https://example.invalid/catalog", "example.invalid", time.Hour, false)
	if r.err != nil || r.status != 200 || f.calls.Load() != 2 || len(r.attempts) != 2 {
		t.Fatalf("sequential failover result=%d/%v, calls=%d attempts=%d", r.status, r.err, f.calls.Load(), len(r.attempts))
	}
}

func TestFreeProxySequentialFailoverRespectsSharedBudget(t *testing.T) {
	t.Setenv("CATALOG_MAX_ATTEMPTS", "2")
	f := &catalogFailoverFetcher{err: errors.New("connection refused")}
	p := catalogFailoverPool()
	p.sharedAdmission.acquire(p.states[1].client.ProxyURL, time.Now())
	e := &Engine{fetcher: f}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	r := e.fetchCatalogHedgedWithCapacity(ctx, p, "https://example.invalid/catalog", "example.invalid", time.Hour, false)
	if r.err == nil || f.calls.Load() != 1 {
		t.Fatalf("busy exit was reused: calls=%d err=%v", f.calls.Load(), r.err)
	}
}

func TestFreeProxySequentialFailoverWaitsForNextEligibleSlot(t *testing.T) {
	t.Setenv("CATALOG_MAX_ATTEMPTS", "2")
	f := &catalogFailoverFetcher{err: errors.New("connection refused")}
	p := catalogFailoverPool()
	now := time.Now()
	p.sharedAdmission.next = map[string]sharedProxyAdmissionEntry{
		p.states[1].client.ProxyURL: {next: now.Add(30 * time.Millisecond), admittedAt: now.Add(-1970 * time.Millisecond)},
	}
	e := &Engine{fetcher: f}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	r := e.fetchCatalogHedgedWithCapacity(ctx, p, "https://example.invalid/catalog", "example.invalid", time.Hour, false)
	if r.err != nil || r.status != 200 || f.calls.Load() != 2 {
		t.Fatalf("eligible retry was lost: calls=%d result=%d/%v", f.calls.Load(), r.status, r.err)
	}
	if p.sharedAdmission.snapshot().MinimumIntervalMS < 2000 {
		t.Fatal("waiting retry bypassed the shared exit interval")
	}
}

func TestFreeProxySequentialAdmissionWaitDoesNotExtendDeadline(t *testing.T) {
	f := &catalogFailoverFetcher{err: errors.New("connection refused")}
	p := catalogFailoverPool()
	p.sharedAdmission.acquire(p.states[1].client.ProxyURL, time.Now())
	e := &Engine{fetcher: f}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	started := time.Now()
	r := e.fetchCatalogHedgedWithCapacity(ctx, p, "https://example.invalid/catalog", "example.invalid", time.Hour, false)
	if r.err == nil || f.calls.Load() != 1 || time.Since(started) > 200*time.Millisecond {
		t.Fatalf("retry exceeded deadline: calls=%d elapsed=%s err=%v", f.calls.Load(), time.Since(started), r.err)
	}
}

func TestFreeProxySequentialFailoverStopsOnAccessAndRateLimitResponses(t *testing.T) {
	for _, status := range []int{401, 403, 407, 429} {
		t.Run(strconv.Itoa(status), func(t *testing.T) {
			f := &catalogFailoverFetcher{status: status}
			e := &Engine{fetcher: f}
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			r := e.fetchCatalogHedgedWithCapacity(ctx, catalogFailoverPool(), "https://example.invalid/catalog", "example.invalid", time.Hour, false)
			if r.status != status || f.calls.Load() != 1 {
				t.Fatalf("response %d triggered failover: calls=%d result=%d", status, f.calls.Load(), r.status)
			}
		})
	}
}
