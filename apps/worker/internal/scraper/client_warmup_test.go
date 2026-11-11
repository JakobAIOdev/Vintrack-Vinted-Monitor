package scraper

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestEnsureWarmContextSharesOneWarmupAcrossConcurrentCallers(t *testing.T) {
	var warmups atomic.Int32
	release := make(chan struct{})
	client := &Client{warmUp: func(context.Context, string) error {
		warmups.Add(1)
		<-release
		return nil
	}}

	const callers = 20
	errs := make(chan error, callers)
	for i := 0; i < callers; i++ {
		go func() { errs <- client.EnsureWarmContext(context.Background(), "www.vinted.de") }()
	}
	deadline := time.Now().Add(2 * time.Second)
	for warmups.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	// Give the remaining callers time to reach the in-flight warmup.
	time.Sleep(20 * time.Millisecond)
	close(release)
	for i := 0; i < callers; i++ {
		if err := <-errs; err != nil {
			t.Fatalf("caller %d: %v", i, err)
		}
	}
	if got := warmups.Load(); got != 1 {
		t.Fatalf("warmup requests = %d, want 1", got)
	}
	if err := client.EnsureWarmContext(context.Background(), "www.vinted.de"); err != nil || warmups.Load() != 1 {
		t.Fatalf("warmed client warmed again: err=%v warmups=%d", err, warmups.Load())
	}
}

func TestEnsureWarmContextWaiterSurvivesCancelledLeader(t *testing.T) {
	var warmups atomic.Int32
	leaderStarted := make(chan struct{})
	client := &Client{warmUp: func(ctx context.Context, _ string) error {
		if warmups.Add(1) == 1 {
			close(leaderStarted)
			<-ctx.Done()
			return ctx.Err()
		}
		return nil
	}}

	leaderCtx, cancelLeader := context.WithCancel(context.Background())
	leaderErr := make(chan error, 1)
	go func() { leaderErr <- client.EnsureWarmContext(leaderCtx, "www.vinted.de") }()
	<-leaderStarted

	waiterErr := make(chan error, 1)
	go func() { waiterErr <- client.EnsureWarmContext(context.Background(), "www.vinted.de") }()
	time.Sleep(20 * time.Millisecond)
	cancelLeader()

	if err := <-leaderErr; !errors.Is(err, context.Canceled) {
		t.Fatalf("leader error = %v, want context.Canceled", err)
	}
	if err := <-waiterErr; err != nil {
		t.Fatalf("waiter inherited the leader's cancellation: %v", err)
	}
	if got := warmups.Load(); got != 2 {
		t.Fatalf("warmup requests = %d, want 2", got)
	}
}

func TestEnsureWarmContextReturnsSharedWarmupFailure(t *testing.T) {
	denied := &httpStatusError{operation: "warmup www.vinted.de", statusCode: 403}
	client := &Client{warmUp: func(context.Context, string) error { return denied }}
	if err := client.EnsureWarmContext(context.Background(), "www.vinted.de"); !errors.Is(err, denied) {
		t.Fatalf("error = %v, want the warmup failure", err)
	}
	if client.warmed["www.vinted.de"] {
		t.Fatal("failed warmup marked the client warm")
	}
}

func TestResetWarmIfGenerationKeepsSessionReplacedByAnotherRequest(t *testing.T) {
	var warmups atomic.Int32
	client := &Client{warmUp: func(context.Context, string) error {
		warmups.Add(1)
		return nil
	}}
	const domain = "www.vinted.de"
	if err := client.EnsureWarmContext(context.Background(), domain); err != nil {
		t.Fatal(err)
	}
	rejected := client.warmGeneration(domain)

	// Several requests saw the same session rejected. Only the first one may
	// discard it; the others must reuse the replacement.
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			client.resetWarmIfGeneration(domain, rejected)
			if err := client.EnsureWarmContext(context.Background(), domain); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	if got := warmups.Load(); got != 2 {
		t.Fatalf("warmup requests = %d, want 2 (initial + one rewarm)", got)
	}
	if !client.warmed[domain] {
		t.Fatal("a late reset discarded the replacement session")
	}
}
