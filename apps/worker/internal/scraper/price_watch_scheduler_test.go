package scraper

import (
	"context"
	"errors"
	"testing"
	"time"

	"vintrack-worker/internal/model"
)

func testPriceWatchPool(clients ...*Client) *ClientPool {
	states := make([]*clientState, 0, len(clients))
	for _, client := range clients {
		states = append(states, &clientState{client: client})
	}
	return &ClientPool{states: states, now: time.Now}
}

func TestNewDirectPriceWatchPool(t *testing.T) {
	pool := NewClientPoolWithTimeout(nil, "www.vinted.de", 4, nil, time.Second)
	if pool.Size() != 1 {
		t.Fatalf("direct pool size = %d, want 1", pool.Size())
	}
	client := pool.AcquireRoundRobin()
	if client == nil || client.ProxyURL != "" {
		t.Fatalf("unexpected direct client: %#v", client)
	}
	pool.Report(client, 200, time.Millisecond, nil)
	client.Close()
}

func TestFetchPriceWatchAutoUsesProxyPathFirst(t *testing.T) {
	direct := &Client{}
	proxy := &Client{ProxyURL: "http://proxy.invalid:8080"}
	calls := make([]*Client, 0, 2)
	page, err := fetchPriceWatchWithFallbacks(
		context.Background(),
		model.PriceWatchTarget{ID: 1},
		time.Second,
		priceWatchTransportAuto,
		testPriceWatchPool(direct),
		testPriceWatchPool(proxy),
		func(_ context.Context, client *Client, _ model.PriceWatchTarget) (PriceWatchPage, error) {
			calls = append(calls, client)
			return PriceWatchPage{PriceMinor: 1299, CurrencyCode: "EUR", Available: true}, nil
		},
	)
	if err != nil || page.PriceMinor != 1299 {
		t.Fatalf("proxy fetch = %+v, %v", page, err)
	}
	if len(calls) != 1 || calls[0] != proxy {
		t.Fatalf("fetch order = %#v", calls)
	}
}

func TestFetchPriceWatchAutoFallsBackFromProxyToDirect(t *testing.T) {
	direct := &Client{}
	proxyOne := &Client{ProxyURL: "http://proxy-one.invalid:8080"}
	proxyTwo := &Client{ProxyURL: "http://proxy-two.invalid:8080"}
	calls := make([]*Client, 0, 3)
	page, err := fetchPriceWatchWithFallbacks(
		context.Background(),
		model.PriceWatchTarget{ID: 1},
		time.Second,
		priceWatchTransportAuto,
		testPriceWatchPool(direct),
		testPriceWatchPool(proxyOne, proxyTwo),
		func(_ context.Context, client *Client, _ model.PriceWatchTarget) (PriceWatchPage, error) {
			calls = append(calls, client)
			if client.ProxyURL != "" {
				return PriceWatchPage{}, &PriceWatchFetchError{Code: "network_error"}
			}
			return PriceWatchPage{PriceMinor: 1299, CurrencyCode: "EUR", Available: true}, nil
		},
	)
	if err != nil || page.PriceMinor != 1299 {
		t.Fatalf("fallback fetch = %+v, %v", page, err)
	}
	if len(calls) != 3 || calls[0] != proxyOne || calls[1] != proxyTwo || calls[2] != direct {
		t.Fatalf("fetch order = %#v", calls)
	}
}

func TestFetchPriceWatchAutoUsesDirectWhenNoProxyPoolExists(t *testing.T) {
	direct := &Client{}
	calls := make([]*Client, 0, 1)
	page, err := fetchPriceWatchWithFallbacks(
		context.Background(),
		model.PriceWatchTarget{ID: 1},
		time.Second,
		priceWatchTransportAuto,
		testPriceWatchPool(direct),
		nil,
		func(_ context.Context, client *Client, _ model.PriceWatchTarget) (PriceWatchPage, error) {
			calls = append(calls, client)
			return PriceWatchPage{PriceMinor: 1299, CurrencyCode: "EUR", Available: true}, nil
		},
	)
	if err != nil || page.PriceMinor != 1299 {
		t.Fatalf("direct fetch = %+v, %v", page, err)
	}
	if len(calls) != 1 || calls[0] != direct {
		t.Fatalf("fetch order = %#v", calls)
	}
}

func TestFetchPriceWatchDirectModeNeverUsesProxy(t *testing.T) {
	direct := &Client{}
	proxy := &Client{ProxyURL: "http://proxy.invalid:8080"}
	calls := make([]*Client, 0, 1)
	_, err := fetchPriceWatchWithFallbacks(
		context.Background(),
		model.PriceWatchTarget{ID: 1},
		time.Second,
		priceWatchTransportDirect,
		testPriceWatchPool(direct),
		testPriceWatchPool(proxy),
		func(_ context.Context, client *Client, _ model.PriceWatchTarget) (PriceWatchPage, error) {
			calls = append(calls, client)
			return PriceWatchPage{}, &PriceWatchFetchError{Code: "network_error"}
		},
	)
	if err == nil {
		t.Fatal("direct fetch unexpectedly succeeded")
	}
	if len(calls) != 1 || calls[0] != direct {
		t.Fatalf("fetch order = %#v", calls)
	}
}

func TestFetchPriceWatchProxyModeNeverUsesDirect(t *testing.T) {
	direct := &Client{}
	proxyOne := &Client{ProxyURL: "http://proxy-one.invalid:8080"}
	proxyTwo := &Client{ProxyURL: "http://proxy-two.invalid:8080"}
	calls := make([]*Client, 0, priceWatchProxyAttempts)
	_, err := fetchPriceWatchWithFallbacks(
		context.Background(),
		model.PriceWatchTarget{ID: 1},
		time.Second,
		priceWatchTransportProxy,
		testPriceWatchPool(direct),
		testPriceWatchPool(proxyOne, proxyTwo),
		func(_ context.Context, client *Client, _ model.PriceWatchTarget) (PriceWatchPage, error) {
			calls = append(calls, client)
			return PriceWatchPage{}, &PriceWatchFetchError{Code: "network_error"}
		},
	)
	if err == nil {
		t.Fatal("proxy fetch unexpectedly succeeded")
	}
	if len(calls) != priceWatchProxyAttempts {
		t.Fatalf("proxy attempts = %d, want %d", len(calls), priceWatchProxyAttempts)
	}
	if calls[0] != proxyOne || calls[1] != proxyTwo {
		t.Fatalf("fetch order = %#v", calls)
	}
}

func TestFetchPriceWatchDoesNotRetryInvalidURL(t *testing.T) {
	direct := &Client{}
	proxy := &Client{ProxyURL: "http://proxy.invalid:8080"}
	calls := 0
	_, err := fetchPriceWatchWithFallbacks(
		context.Background(),
		model.PriceWatchTarget{ID: 1},
		time.Second,
		priceWatchTransportAuto,
		testPriceWatchPool(direct),
		testPriceWatchPool(proxy),
		func(_ context.Context, _ *Client, _ model.PriceWatchTarget) (PriceWatchPage, error) {
			calls++
			return PriceWatchPage{}, &PriceWatchFetchError{Code: "invalid_item_url"}
		},
	)
	var fetchErr *PriceWatchFetchError
	if !errors.As(err, &fetchErr) || fetchErr.Code != "invalid_item_url" {
		t.Fatalf("unexpected error: %v", err)
	}
	if calls != 1 {
		t.Fatalf("invalid URL attempts = %d, want 1", calls)
	}
}

func TestPriceWatchSuccessDelayIsStableAndBounded(t *testing.T) {
	for _, targetID := range []int64{1, 2, 31, 999999, -9} {
		delay := priceWatchSuccessDelay(targetID, 7*time.Minute)
		if delay < 7*time.Minute || delay > 7*time.Minute+30*time.Second {
			t.Fatalf("target %d delay = %s", targetID, delay)
		}
		if repeated := priceWatchSuccessDelay(targetID, 7*time.Minute); repeated != delay {
			t.Fatalf("target %d jitter changed from %s to %s", targetID, delay, repeated)
		}
	}
}

func TestPriceWatchErrorBackoff(t *testing.T) {
	want := []time.Duration{
		time.Minute,
		2 * time.Minute,
		5 * time.Minute,
		10 * time.Minute,
		20 * time.Minute,
		30 * time.Minute,
	}
	for index, expected := range want {
		if actual := priceWatchErrorBackoff(index + 1); actual != expected {
			t.Fatalf("attempt %d = %s, want %s", index+1, actual, expected)
		}
	}
	if actual := priceWatchErrorBackoff(99); actual != 30*time.Minute {
		t.Fatalf("capped backoff = %s", actual)
	}
}

func TestPriceWatchAttemptBudgetsAreIsolatedAndCountEveryAttempt(t *testing.T) {
	engine := &Engine{priceWatchRateWindows: make(map[string]*priceWatchRateWindow)}
	if retry := engine.reservePriceWatchAttempt("shared", 2); retry != 0 {
		t.Fatalf("first shared attempt delayed by %s", retry)
	}
	if retry := engine.reservePriceWatchAttempt("shared", 2); retry != 0 {
		t.Fatalf("second shared attempt delayed by %s", retry)
	}
	if retry := engine.reservePriceWatchAttempt("shared", 2); retry <= 0 {
		t.Fatal("third shared attempt should be capacity limited")
	}
	if retry := engine.reservePriceWatchAttempt("proxy:17", 2); retry != 0 {
		t.Fatalf("personal lane inherited shared exhaustion: %s", retry)
	}
	if retry := engine.reservePriceWatchAttempt("proxy:18", 1); retry != 0 {
		t.Fatalf("one personal group affected another: %s", retry)
	}
}

func TestPriceWatchPersonalCapacityScalesAndCapsPerGroup(t *testing.T) {
	engine := &Engine{}
	engine.priceWatchPersonalRPM.Store(2)
	key, limit := engine.priceWatchRatePolicy(model.PriceWatchTarget{
		TransportKind: "proxy_group", ProxyGroupID: intPointer(42), WorkingProxyCount: 4,
	})
	if key != "proxy:42" || limit != 8 {
		t.Fatalf("personal policy = %q/%d, want proxy:42/8", key, limit)
	}
	_, capped := engine.priceWatchRatePolicy(model.PriceWatchTarget{
		TransportKind: "proxy_group", ProxyGroupID: intPointer(42), WorkingProxyCount: 100,
	})
	if capped != 60 {
		t.Fatalf("personal capacity cap = %d, want 60", capped)
	}
}

func intPointer(value int) *int { return &value }
