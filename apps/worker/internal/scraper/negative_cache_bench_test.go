package scraper

import (
	"context"
	"errors"
	"testing"
	"time"
)

// These benchmarks quantify the negative-cache latency claim: a burst of
// items detected for the same persistently-failing seller (e.g. a 503 or a
// malformed profile) within the negative-cache TTL should cost one simulated
// remote round trip total instead of one per item. negativeTTL: 0 disables
// the cache entirely and reproduces the pre-change behavior for comparison.
func benchmarkRepeatedSellerFailure(b *testing.B, negativeTTL time.Duration) {
	sellerID := time.Now().UnixNano()
	enricher := &SellerEnricher{
		domain: "bench.vinted.test", cacheTTL: time.Minute, negativeTTL: negativeTTL,
		remoteFetch: func(ctx context.Context, id int64) (SellerInfo, error) {
			time.Sleep(5 * time.Millisecond) // simulated remote round trip to a failing seller endpoint
			return SellerInfo{}, &sellerFetchError{kind: failureServerError, status: 503, err: errors.New("seller api status 503")}
		},
	}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_, _ = enricher.FetchSellerInfo(context.Background(), sellerID)
	}
}

func BenchmarkRepeatedSellerFailure_NegativeCacheDisabled(b *testing.B) {
	benchmarkRepeatedSellerFailure(b, 0)
}

func BenchmarkRepeatedSellerFailure_NegativeCacheEnabled(b *testing.B) {
	benchmarkRepeatedSellerFailure(b, time.Minute)
}
