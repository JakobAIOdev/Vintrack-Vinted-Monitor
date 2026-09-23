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

func TestScheduledRetryDoesNotBlockReadyJobInSameLane(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	scheduler := NewSellerEnrichmentScheduler(8, 1)
	go scheduler.Run(ctx)
	if !scheduler.Submit(ctx, enrichmentJob{
		proxySource: "free", item: itemWithID(1), readyAt: time.Now().Add(time.Hour),
	}) {
		t.Fatal("future submit failed")
	}
	if !scheduler.Submit(ctx, enrichmentJob{
		proxySource: "free", item: itemWithID(2),
	}) {
		t.Fatal("ready submit failed")
	}
	select {
	case job := <-scheduler.Work():
		if job.item.ID != 2 {
			t.Fatalf("dispatched item %d, want ready item 2", job.item.ID)
		}
	case <-time.After(time.Second):
		t.Fatal("ready job was blocked behind scheduled retry")
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

// Scheduled retry delay is intentional and must not look like executable
// backlog. Queue ages therefore remain zero until a job is ready.
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

	time.Sleep(25 * time.Millisecond)
	now := time.Now()
	if scheduler.QueueAge(now) != 0 || scheduler.StrictRetryQueueAge(now) != 0 || scheduler.BackgroundQueueAge(now) != 0 {
		t.Fatalf("future jobs counted as ready backlog; foreground=%v strict=%v background=%v",
			scheduler.QueueAge(now), scheduler.StrictRetryQueueAge(now), scheduler.BackgroundQueueAge(now))
	}
}

// TestSellerEnrichmentSchedulerDispatchesUnderContinuousInputPressure guards
// against a regression where the dispatch loop's eager, unbounded drain of
// s.input (`continue`-looping back to the top on every arrival) let a steady
// stream of new submissions win forever on a busy system. The loop never
// reached the dispatch select below, so nothing was ever handed to a worker
// no matter how long it ran.
func TestSellerEnrichmentSchedulerDispatchesUnderContinuousInputPressure(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	scheduler := NewSellerEnrichmentScheduler(4096, 1)
	go scheduler.Run(ctx)

	stop := make(chan struct{})
	defer close(stop)
	go func() {
		for i := int64(0); ; i++ {
			select {
			case <-stop:
				return
			default:
			}
			scheduler.Submit(ctx, enrichmentJob{proxySource: "free", item: itemWithID(i)})
		}
	}()

	select {
	case <-scheduler.Work():
	case <-time.After(2 * time.Second):
		t.Fatal("scheduler never dispatched a job while new submissions kept s.input non-empty")
	}
}

// TestSellerEnrichmentSchedulerStrictRetryEventuallyDispatchedUnderForegroundFlood
// guards against a second, independent starvation mode: pure priority
// selection always dispatches the best-ready lane, so a continuous stream of
// fresh priority-0 foreground jobs (normal on a busy fleet with several
// active monitors) can keep outranking an already-ready strict-retry job
// forever. That job never gets a second attempt, matching the observed
// symptom of every strict retry logging its first attempt and then vanishing.
func TestSellerEnrichmentSchedulerStrictRetryEventuallyDispatchedUnderForegroundFlood(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	scheduler := NewSellerEnrichmentScheduler(4096, 1)
	go scheduler.Run(ctx)

	const strictID = int64(999)
	if !scheduler.Submit(ctx, enrichmentJob{
		proxySource: "free", item: itemWithID(strictID), strictAttempt: 1,
		readyAt: time.Now().Add(-time.Millisecond),
	}) {
		t.Fatal("strict-retry submit failed")
	}

	stop := make(chan struct{})
	defer close(stop)
	go func() {
		for i := int64(1000); ; i++ {
			select {
			case <-stop:
				return
			default:
			}
			scheduler.Submit(ctx, enrichmentJob{proxySource: "free", item: itemWithID(i)})
		}
	}()

	deadline := time.After(5 * time.Second)
	for {
		select {
		case job := <-scheduler.Work():
			if job.item.ID == strictID {
				return
			}
		case <-deadline:
			t.Fatal("strict-retry job starved by continuous foreground flood")
		}
	}
}

func itemWithID(id int64) model.Item { return model.Item{ID: id} }
