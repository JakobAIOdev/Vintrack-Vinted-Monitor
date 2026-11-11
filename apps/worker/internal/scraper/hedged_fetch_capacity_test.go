package scraper

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestHedgedFetchReportsNeverStartedWhenNoClientIsFree(t *testing.T) {
	client := &Client{ProxyURL: "http://192.0.2.1:8080"}
	pool := &ClientPool{
		states:      []*clientState{{client: client, cooldownUntil: time.Now().Add(time.Minute)}},
		quarantined: make(map[string]proxyQuarantine),
		reserved:    make(map[string]bool),
	}
	engine := &Engine{fetcher: VintedCatalogFetcher{}}
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Millisecond)
	defer cancel()
	result := engine.fetchCatalogHedgedWithPrimary(ctx, pool, "https://www.vinted.de/api/v2/catalog/items", "www.vinted.de", 0, true, nil)
	if !result.neverStarted || !errors.Is(result.err, context.DeadlineExceeded) || len(result.attempts) != 0 {
		t.Fatalf("result = %+v, want a never-started deadline", result)
	}
}
