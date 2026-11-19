package scraper

import (
	"context"
	"sync/atomic"
	"testing"
	"time"
)

func waitForPoolAdmissionQueue(t *testing.T, p *ClientPool, size int) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		p.mu.Lock()
		n := len(p.admissionWaiters)
		p.mu.Unlock()
		if n == size {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("admission queue did not reach size %d", size)
}

func TestFreeProxyAdmissionWaiterCannotBeOvertaken(t *testing.T) {
	var clock atomic.Int64
	clock.Store(time.Now().UnixNano())
	client := &Client{ProxyURL: "http://198.18.2.10:8080"}
	p := &ClientPool{states: []*clientState{{client: client, nextAdmission: time.Unix(0, clock.Load()).Add(time.Second)}}, maxRequestsPerSecond: 0.5, now: func() time.Time { return time.Unix(0, clock.Load()) }}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	result := make(chan *Client, 1)
	go func() { c, _, _ := p.AcquireWithAdmission(ctx, nil, time.Second); result <- c }()
	waitForPoolAdmissionQueue(t, p, 1)
	clock.Add(int64(time.Second))
	if p.Acquire(nil) != nil || p.AcquireRoundRobin() != nil {
		t.Fatal("a new request overtook an older queued monitor")
	}
	select {
	case got := <-result:
		if got != client {
			t.Fatal("older waiter was not admitted")
		}
	case <-ctx.Done():
		t.Fatal("older waiter was stranded")
	}
	waitForPoolAdmissionQueue(t, p, 0)
}

func TestFreeProxyAdmissionCancellationReleasesQueueHead(t *testing.T) {
	var clock atomic.Int64
	clock.Store(time.Now().UnixNano())
	client := &Client{ProxyURL: "http://198.18.2.11:8080"}
	p := &ClientPool{states: []*clientState{{client: client, nextAdmission: time.Unix(0, clock.Load()).Add(time.Second)}}, maxRequestsPerSecond: 0.5, now: func() time.Time { return time.Unix(0, clock.Load()) }}
	firstCtx, cancelFirst := context.WithCancel(context.Background())
	first := make(chan error, 1)
	go func() { _, _, err := p.AcquireWithAdmission(firstCtx, nil, time.Second); first <- err }()
	waitForPoolAdmissionQueue(t, p, 1)
	secondCtx, cancelSecond := context.WithTimeout(context.Background(), time.Second)
	defer cancelSecond()
	second := make(chan *Client, 1)
	go func() { c, _, _ := p.AcquireWithAdmission(secondCtx, nil, time.Second); second <- c }()
	waitForPoolAdmissionQueue(t, p, 2)
	cancelFirst()
	if err := <-first; err != context.Canceled {
		t.Fatalf("head cancellation=%v", err)
	}
	waitForPoolAdmissionQueue(t, p, 1)
	clock.Add(int64(time.Second))
	select {
	case got := <-second:
		if got != client {
			t.Fatal("next waiter did not advance")
		}
	case <-secondCtx.Done():
		t.Fatal("canceled head blocked next waiter")
	}
	waitForPoolAdmissionQueue(t, p, 0)
}

func TestFreeProxyAdmissionQueueIsBounded(t *testing.T) {
	p := &ClientPool{admissionWaiters: make([]*poolAdmissionWaiter, maxPoolAdmissionWaiters)}
	started := time.Now()
	if c, _, err := p.AcquireWithAdmission(context.Background(), nil, time.Second); c != nil || err == nil || time.Since(started) > 200*time.Millisecond {
		t.Fatalf("full queue admission=%v,%v", c, err)
	}
	if len(p.admissionWaiters) != maxPoolAdmissionWaiters {
		t.Fatal("admission queue exceeded its bound")
	}
}
