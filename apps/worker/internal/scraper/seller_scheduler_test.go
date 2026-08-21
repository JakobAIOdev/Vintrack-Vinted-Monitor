package scraper

import (
	"context"
	"testing"
	"time"

	"vintrack-worker/internal/model"
)

func TestSellerEnrichmentSchedulerFairAcrossSources(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	scheduler := NewSellerEnrichmentScheduler(16, 1)
	go scheduler.Run(ctx)
	readyAt := time.Now().Add(100 * time.Millisecond)
	jobs := []enrichmentJob{
		{proxySource: "server", item: itemWithID(1), readyAt: readyAt},
		{proxySource: "server", item: itemWithID(2), readyAt: readyAt},
		{proxySource: "free", item: itemWithID(3), readyAt: readyAt},
		{proxySource: "server", item: itemWithID(4), readyAt: readyAt},
	}
	for _, job := range jobs {
		if !scheduler.Submit(ctx, job) {
			t.Fatal("submit failed")
		}
	}
	got := make([]int64, 0, len(jobs))
	for range jobs {
		select {
		case job := <-scheduler.Work():
			got = append(got, job.item.ID)
		case <-time.After(time.Second):
			t.Fatal("timed out waiting for scheduled work")
		}
	}
	if got[0] != 1 || got[1] != 3 || got[2] != 2 || got[3] != 4 {
		t.Fatalf("unfair order: %v", got)
	}
}

func TestSellerEnrichmentSchedulerPrioritizesNewAlerts(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	scheduler := NewSellerEnrichmentScheduler(16, 1)
	go scheduler.Run(ctx)

	readyAt := time.Now().Add(100 * time.Millisecond)
	jobs := []enrichmentJob{
		{proxySource: "server", item: itemWithID(1), backgroundOnly: true, readyAt: readyAt},
		{proxySource: "server", item: itemWithID(2), strictAttempt: 1, readyAt: readyAt},
		{proxySource: "server", item: itemWithID(3), readyAt: readyAt},
	}
	for _, job := range jobs {
		if !scheduler.Submit(ctx, job) {
			t.Fatal("submit failed")
		}
	}

	want := []int64{3, 2, 1}
	for i, expected := range want {
		select {
		case job := <-scheduler.Work():
			if job.item.ID != expected {
				t.Fatalf("job %d = %d, want %d", i, job.item.ID, expected)
			}
		case <-time.After(time.Second):
			t.Fatal("timed out waiting for scheduled work")
		}
	}
}

func TestSellerEnrichmentSchedulerDoesNotPrefetchBackgroundWork(t *testing.T) {
	scheduler := NewSellerEnrichmentScheduler(16, 24)
	if capacity := cap(scheduler.Work()); capacity != 0 {
		t.Fatalf("work channel capacity = %d, want 0", capacity)
	}
}

func TestSellerEnrichmentSchedulerBackgroundInputCannotBlockNewAlert(t *testing.T) {
	scheduler := NewSellerEnrichmentScheduler(1, 1)
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()

	if !scheduler.Submit(ctx, enrichmentJob{backgroundOnly: true, item: itemWithID(1)}) {
		t.Fatal("background submit failed")
	}
	if !scheduler.Submit(ctx, enrichmentJob{item: itemWithID(2)}) {
		t.Fatal("foreground submit was blocked by full background input")
	}
}

// TestSellerEnrichmentSchedulerQueueAgeByPriority pins that QueueAge only
// ever reflects the foreground lane (as documented), while the new
// StrictRetryQueueAge/BackgroundQueueAge accessors independently surface the
// other two priority classes instead of leaving them invisible.
func TestSellerEnrichmentSchedulerQueueAgeByPriority(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	// A single worker that never drains work lets all three submitted jobs
	// sit in their lanes so their queue ages are observable.
	scheduler := NewSellerEnrichmentScheduler(16, 1)
	go scheduler.Run(ctx)

	farFuture := time.Now().Add(time.Hour)
	if !scheduler.Submit(ctx, enrichmentJob{proxySource: "server", item: itemWithID(1), backgroundOnly: true, readyAt: farFuture}) {
		t.Fatal("background submit failed")
	}
	if !scheduler.Submit(ctx, enrichmentJob{proxySource: "server", item: itemWithID(2), strictAttempt: 1, readyAt: farFuture}) {
		t.Fatal("strict-retry submit failed")
	}
	if !scheduler.Submit(ctx, enrichmentJob{proxySource: "server", item: itemWithID(3), readyAt: farFuture}) {
		t.Fatal("foreground submit failed")
	}

	// Give the scheduler goroutine a moment to ingest the submissions and
	// recompute the per-priority oldest timestamps.
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		now := time.Now()
		if scheduler.QueueAge(now) > 0 && scheduler.StrictRetryQueueAge(now) > 0 && scheduler.BackgroundQueueAge(now) > 0 {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	now := time.Now()
	t.Fatalf("expected all three queue ages to become positive; foreground=%v strict=%v background=%v",
		scheduler.QueueAge(now), scheduler.StrictRetryQueueAge(now), scheduler.BackgroundQueueAge(now))
}

func itemWithID(id int64) model.Item { return model.Item{ID: id} }
