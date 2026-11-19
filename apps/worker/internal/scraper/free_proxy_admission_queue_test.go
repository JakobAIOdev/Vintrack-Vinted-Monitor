package scraper

import (
	"context"
	"testing"
	"time"
)

func waitForRegionAdmissionQueue(t *testing.T, p *freeProxyRegionPacer, size int) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		p.mu.Lock()
		n := len(p.waiters)
		p.mu.Unlock()
		if n == size {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("regional queue did not reach size %d", size)
}

func TestFreeProxyRegionAdmissionPreservesArrivalOrder(t *testing.T) {
	p := newFreeProxyRegionPacer("pl", freeProxyPacingPolicy{MaxRequestsPerProxySecond: 0.5, MaxAdmissionDelayMS: 1000})
	p.nextAdmission = time.Now().Add(time.Hour)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	order := make(chan int, 3)
	for id := 1; id <= 3; id++ {
		go func(id int) {
			if _, ok := p.admit(ctx, id, time.Second, 100); ok {
				order <- id
			}
		}(id)
		waitForRegionAdmissionQueue(t, p, id)
	}
	p.mu.Lock()
	p.nextAdmission = time.Now()
	p.mu.Unlock()
	for range 3 {
		select {
		case <-order:
		case <-ctx.Done():
			t.Fatal("queued monitor did not advance")
		}
	}
	waitForRegionAdmissionQueue(t, p, 0)
	if !p.monitorNext[1].Before(p.monitorNext[2]) || !p.monitorNext[2].Before(p.monitorNext[3]) {
		t.Fatal("regional admission grants did not preserve arrival order")
	}
}

func TestFreeProxyRegionAdmissionCancellationReleasesHead(t *testing.T) {
	p := newFreeProxyRegionPacer("pl", freeProxyPacingPolicy{MaxRequestsPerProxySecond: 0.5, MaxAdmissionDelayMS: 1000})
	p.nextAdmission = time.Now().Add(time.Hour)
	firstCtx, cancelFirst := context.WithCancel(context.Background())
	first := make(chan bool, 1)
	go func() { _, ok := p.admit(firstCtx, 1, time.Second, 100); first <- ok }()
	waitForRegionAdmissionQueue(t, p, 1)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	second := make(chan bool, 1)
	go func() { _, ok := p.admit(ctx, 2, time.Second, 100); second <- ok }()
	waitForRegionAdmissionQueue(t, p, 2)
	cancelFirst()
	if <-first {
		t.Fatal("canceled head was admitted")
	}
	waitForRegionAdmissionQueue(t, p, 1)
	p.mu.Lock()
	p.nextAdmission = time.Now()
	p.mu.Unlock()
	select {
	case ok := <-second:
		if !ok {
			t.Fatal("next monitor was rejected")
		}
	case <-ctx.Done():
		t.Fatal("canceled head blocked next monitor")
	}
	waitForRegionAdmissionQueue(t, p, 0)
}

func TestFreeProxyRegionAdmissionOwnIntervalDoesNotBlockOthers(t *testing.T) {
	p := newFreeProxyRegionPacer("pl", freeProxyPacingPolicy{MaxRequestsPerProxySecond: 0.5, MaxAdmissionDelayMS: 200})
	p.monitorNext[1] = time.Now().Add(time.Hour)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	first := make(chan bool, 1)
	go func() { _, ok := p.admit(ctx, 1, time.Second, 100); first <- ok }()
	waitForRegionAdmissionQueue(t, p, 1)
	if _, ok := p.admit(ctx, 2, time.Second, 100); !ok {
		t.Fatal("a future search interval blocked an eligible monitor")
	}
	if <-first {
		t.Fatal("monitor ran before its own search interval")
	}
	waitForRegionAdmissionQueue(t, p, 0)
}
