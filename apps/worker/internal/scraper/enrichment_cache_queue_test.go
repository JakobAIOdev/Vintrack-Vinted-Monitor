package scraper

import (
	"context"
	"testing"
	"time"

	"vintrack-worker/internal/model"
)

func TestEnqueueItemDoesNotWaitForSellerCache(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	engine := &Engine{
		jobsCtx: ctx, enrichmentCacheJobs: make(chan enrichmentJob, 20),
	}
	// No database or cache workers: the previous synchronous lookup would
	// access the nil database here. A catalog burst must still reach the queue.
	done := make(chan struct{})
	go func() {
		defer close(done)
		for id := int64(1); id <= 20; id++ {
			engine.enqueueItem(enrichmentJob{
				item:               model.Item{ID: id},
				vintedItem:         model.VintedItem{User: model.VintedUser{ID: id}},
				enricher:           &SellerEnricher{domain: "cache-queue.example"},
				requireSellerMatch: true, alertAfterEnrich: true,
			}, false)
		}
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("catalog burst waited for cache preparation")
	}
	for id := int64(1); id <= 20; id++ {
		job := <-engine.enrichmentCacheJobs
		if job.item.ID != id || !job.requireSellerMatch || !job.alertAfterEnrich {
			t.Fatalf("lost item order or strict seller gate: %+v", job)
		}
		if job.notificationTimer != nil {
			t.Fatal("strict seller filter must not get a fallback alert timer")
		}
	}
}

func TestCacheQueuePreservesAlertDeadlineAndEngineContext(t *testing.T) {
	t.Setenv("SELLER_ENRICHMENT_TIMEOUT_MS", "25")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	engine := &Engine{
		jobsCtx: ctx, enrichmentCacheJobs: make(chan enrichmentJob, 1),
		alertJobs: make(chan alertJob, 1),
	}
	monitorCtx, stopMonitor := context.WithCancel(ctx)
	stopMonitor()
	engine.enqueueItem(enrichmentJob{
		ctx: monitorCtx, item: model.Item{ID: 77, FoundAt: time.Now()},
		vintedItem:       model.VintedItem{User: model.VintedUser{ID: 77}},
		enricher:         &SellerEnricher{domain: "cache-deadline.example"},
		alertAfterEnrich: true,
	}, false)
	job := <-engine.enrichmentCacheJobs
	if job.notificationTimer == nil {
		t.Fatal("alert deadline must start before cache workers run")
	}
	defer job.notificationTimer.Stop()
	if job.ctx.Err() != nil {
		t.Fatal("claimed job inherited the cancelled monitor context")
	}
	select {
	case alert := <-engine.alertJobs:
		if alert.item.ID != 77 || !alert.deliverExternal {
			t.Fatalf("unexpected deadline fallback: %+v", alert)
		}
	case <-time.After(time.Second):
		t.Fatal("cache queue extended the notification deadline")
	}
}

func TestCacheQueueBackpressureHonorsShutdown(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	engine := &Engine{jobsCtx: ctx, enrichmentCacheJobs: make(chan enrichmentJob, 1)}
	engine.enrichmentCacheJobs <- enrichmentJob{}
	done := make(chan struct{})
	go func() {
		defer close(done)
		engine.enqueueItem(enrichmentJob{
			vintedItem: model.VintedItem{User: model.VintedUser{ID: 1}},
			enricher:   &SellerEnricher{},
		}, false)
	}()
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("full cache queue blocked shutdown")
	}
}

func TestEnqueueItemKeepsCachedStrictJobsOnFastLane(t *testing.T) {
	for _, stale := range []bool{false, true} {
		name := "fresh"
		if stale {
			name = "stale"
		}
		t.Run(name, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			domain := "cache-fast-" + name + ".example"
			info := SellerInfo{Region: "🇩🇪 DE", Rating: "5", RatingStars: 5, RatingCount: 12, RatingAvailable: true}
			fetchedAt := time.Now()
			if stale {
				fetchedAt = fetchedAt.Add(-2 * time.Minute)
			}
			sellerCache.Set(domain, 99, info, fetchedAt)
			engine := &Engine{
				jobsCtx: ctx, enrichmentFastJobs: make(chan enrichmentJob, 1),
				enrichmentCacheJobs: make(chan enrichmentJob, 1),
				enrichmentScheduler: NewSellerEnrichmentScheduler(4, 1),
				enrichmentMetrics:   &sellerEnrichmentMetrics{},
			}
			// Even a full preparation queue must not hold up memory hits.
			engine.enrichmentCacheJobs <- enrichmentJob{}
			done := make(chan struct{})
			go func() {
				defer close(done)
				engine.enqueueItem(enrichmentJob{
					ctx: ctx, vintedItem: model.VintedItem{User: model.VintedUser{ID: 99}},
					enricher:           &SellerEnricher{domain: domain, cacheTTL: time.Minute, staleTTL: time.Hour},
					requireSellerMatch: true, alertAfterEnrich: true,
				}, false)
			}()
			select {
			case <-done:
			case <-time.After(time.Second):
				t.Fatal("memory cache hit waited behind cache I/O")
			}
			select {
			case job := <-engine.enrichmentFastJobs:
				if job.cachedInfo == nil || *job.cachedInfo != info || !job.requireSellerMatch || !job.alertAfterEnrich {
					t.Fatalf("cached job lost seller data or strict gate: %+v", job)
				}
			default:
				t.Fatal("cached job waited behind remote lookups")
			}
			if stale {
				select {
				case refresh := <-engine.enrichmentScheduler.backgroundInput:
					if !refresh.refreshOnly || refresh.alertAfterEnrich || refresh.requireSellerMatch || refresh.cachedInfo != nil {
						t.Fatalf("unsafe stale refresh: %+v", refresh)
					}
				default:
					t.Fatal("stale cache hit did not schedule a background refresh")
				}
			}
		})
	}
}

func TestCacheWorkerUsesDataCachedAfterAdmission(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	domain := "cache-after-admission.example"
	t.Cleanup(func() {
		sellerCache.mu.Lock()
		delete(sellerCache.cache, sellerCacheKey(domain, 456))
		sellerCache.mu.Unlock()
	})
	engine := &Engine{
		jobsCtx: ctx, enrichmentCacheJobs: make(chan enrichmentJob, 1),
		enrichmentFastJobs: make(chan enrichmentJob, 1),
	}
	engine.enqueueItem(enrichmentJob{
		item:               model.Item{ID: 456},
		vintedItem:         model.VintedItem{User: model.VintedUser{ID: 456}},
		enricher:           &SellerEnricher{domain: domain},
		requireSellerMatch: true,
	}, false)
	if len(engine.enrichmentCacheJobs) != 1 {
		t.Fatal("test did not admit a cold cache job")
	}
	info := SellerInfo{Region: "🇩🇪 DE", RatingAvailable: true}
	sellerCache.Set(domain, 456, info, time.Now())
	engine.jobsWG.Add(1)
	go engine.enrichmentCacheWorker()
	t.Cleanup(func() {
		cancel()
		engine.jobsWG.Wait()
	})
	select {
	case job := <-engine.enrichmentFastJobs:
		if job.item.ID != 456 || job.cachedInfo == nil || *job.cachedInfo != info || !job.requireSellerMatch {
			t.Fatalf("unexpected prepared job: %+v", job)
		}
		if job.enqueuedAt.IsZero() {
			t.Fatal("cache preparation lost original admission time")
		}
	case <-time.After(time.Second):
		t.Fatal("cache worker did not route newly cached data to the fast lane")
	}
}
