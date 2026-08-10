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

func itemWithID(id int64) model.Item { return model.Item{ID: id} }
