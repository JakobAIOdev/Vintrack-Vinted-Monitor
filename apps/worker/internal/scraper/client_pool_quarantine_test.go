package scraper

import (
	"context"
	"errors"
	"testing"
	"time"

	"vintrack-worker/internal/proxy"
)

func TestFailurePolicyQuarantineDurations(t *testing.T) {
	tests := []struct {
		name     string
		status   int
		err      error
		failures int
		code     string
		duration time.Duration
	}{
		{name: "vinted access denied", status: 403, failures: 1, code: proxyErrorVintedAccessDenied, duration: 10 * time.Minute},
		{name: "proxy auth", status: 407, failures: 1, code: proxyErrorAuthenticationFailed, duration: 30 * time.Minute},
		{name: "proxy auth transport error", err: errors.New("Proxy responded with non 200 code: 407 Proxy Authentication Required"), failures: 1, code: proxyErrorAuthenticationFailed, duration: 30 * time.Minute},
		{name: "rate limited", status: 429, failures: 1, code: proxyErrorVintedRateLimited, duration: time.Minute},
		{name: "session rejected", status: 401, failures: 1, code: proxyErrorVintedSessionRejected, duration: 2 * time.Minute},
		{name: "second timeout", err: context.DeadlineExceeded, failures: 2, code: proxyErrorTimeout, duration: 30 * time.Second},
		{name: "first timeout", err: context.DeadlineExceeded, failures: 1, code: proxyErrorTimeout},
		{name: "vinted server error", status: 503, failures: 1, code: proxyErrorVintedServer},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			policy := failurePolicy(tt.status, tt.err, tt.failures)
			if policy.code != tt.code {
				t.Fatalf("failurePolicy() code = %q, want %q", policy.code, tt.code)
			}
			if policy.quarantine != tt.duration {
				t.Fatalf("failurePolicy() quarantine = %s, want %s", policy.quarantine, tt.duration)
			}
		})
	}
}

func TestClientPoolWaitsWhenEveryProxyIsQuarantined(t *testing.T) {
	now := time.Date(2026, time.July, 28, 8, 0, 0, 0, time.UTC)
	manager := proxy.FromString("http://1.2.3.4:8080")
	client := &Client{ProxyURL: "http://1.2.3.4:8080", warmed: make(map[string]bool)}
	pool := &ClientPool{
		states:       []*clientState{{client: client}},
		pm:           manager,
		domain:       "www.vinted.de",
		requireProxy: true,
		quarantined:  make(map[string]proxyQuarantine),
		reserved:     make(map[string]bool),
		now:          func() time.Time { return now },
	}

	pool.Report(client, 403, 50*time.Millisecond, errors.New("blocked"))

	waitErr := pool.WaitError()
	if waitErr == nil {
		t.Fatal("WaitError() = nil, want quarantined pool state")
	}
	if waitErr.ErrorCode != proxyErrorVintedAccessDenied {
		t.Fatalf("WaitError() code = %q, want %q", waitErr.ErrorCode, proxyErrorVintedAccessDenied)
	}
	if want := now.Add(vintedAccessDeniedQuarantine); !waitErr.RetryAt.Equal(want) {
		t.Fatalf("WaitError() retry = %s, want %s", waitErr.RetryAt, want)
	}
	if got := pool.Acquire(nil); got != nil {
		t.Fatalf("Acquire() returned quarantined client %v", got)
	}

	deadline := time.Now().Add(time.Second)
	for {
		pool.mu.Lock()
		replacing := pool.states[0].replacing
		pool.mu.Unlock()
		if !replacing {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("replacement search did not finish")
		}
		time.Sleep(time.Millisecond)
	}

	now = now.Add(vintedAccessDeniedQuarantine + time.Second)
	if got := pool.Acquire(nil); got != client {
		t.Fatalf("Acquire() after expiry = %v, want original client", got)
	}
}

func TestClientPoolReplacesBlockedProxyWithUnusedHealthyProxy(t *testing.T) {
	manager := proxy.FromString("http://1.2.3.4:8080\nhttp://5.6.7.8:8080")
	blocked := &Client{ProxyURL: "http://1.2.3.4:8080", warmed: make(map[string]bool)}
	pool := &ClientPool{
		states:         []*clientState{{client: blocked}},
		pm:             manager,
		domain:         "www.vinted.de",
		requestTimeout: time.Second,
		requireProxy:   true,
		quarantined:    make(map[string]proxyQuarantine),
		reserved:       make(map[string]bool),
		now:            time.Now,
	}

	pool.Report(blocked, 403, 50*time.Millisecond, errors.New("blocked"))

	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		pool.mu.Lock()
		replacement := pool.states[0].client
		replacing := pool.states[0].replacing
		pool.mu.Unlock()
		if !replacing && replacement != blocked {
			if replacement.ProxyURL != "http://5.6.7.8:8080" {
				t.Fatalf("replacement proxy = %q, want healthy unused proxy", replacement.ProxyURL)
			}
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("blocked proxy was not replaced")
}

func TestClientPoolExpandsAfterProxyManagerRecovery(t *testing.T) {
	manager := proxy.FromString("http://1.2.3.4:8080")
	pool := NewClientPool(manager, "www.vinted.de", 50, nil)
	if got := pool.Size(); got != 1 {
		t.Fatalf("initial pool size = %d, want 1", got)
	}

	manager.ReplaceFromString(
		"http://1.2.3.4:8080\nhttp://5.6.7.8:8080\nhttp://9.10.11.12:8080",
	)
	pool.EnsureSize(50)

	if got := pool.Size(); got != 3 {
		t.Fatalf("expanded pool size = %d, want 3", got)
	}
	seen := make(map[string]bool)
	pool.mu.Lock()
	for _, state := range pool.states {
		if seen[state.client.ProxyURL] {
			pool.mu.Unlock()
			t.Fatalf("expanded pool contains duplicate proxy %q", state.client.ProxyURL)
		}
		seen[state.client.ProxyURL] = true
	}
	pool.mu.Unlock()
}

func TestClientPoolCapsConcurrentRequestsPerProxy(t *testing.T) {
	client := &Client{ProxyURL: "http://1.2.3.4:8080"}
	pool := &ClientPool{states: []*clientState{{client: client}}}
	pool.SetMaxInFlightPerClient(1)

	if got := pool.Acquire(nil); got != client {
		t.Fatalf("first Acquire() = %v, want client", got)
	}
	if got := pool.Acquire(nil); got != nil {
		t.Fatalf("second Acquire() = %v, want load shedding", got)
	}

	pool.Report(client, 200, 50*time.Millisecond, nil)
	if got := pool.Acquire(nil); got != client {
		t.Fatalf("Acquire() after Report() = %v, want client", got)
	}
}

func TestWaitForProxyRetryHonorsCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if waitForProxyRetry(ctx, time.Now().Add(time.Hour)) {
		t.Fatal("waitForProxyRetry() ignored cancellation")
	}
}
