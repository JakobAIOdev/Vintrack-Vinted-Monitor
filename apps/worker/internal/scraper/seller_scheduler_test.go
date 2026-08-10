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

func itemWithID(id int64) model.Item { return model.Item{ID: id} }
