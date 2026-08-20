package scraper

import (
	"encoding/json"
	"testing"
)

func TestCatalogLatencyMetricsNilReceiverIsSafe(t *testing.T) {
	var metrics *catalogLatencyMetrics
	// A disabled engine leaves the field nil; recording must stay a no-op rather
	// than panicking inside the monitor cycle.
	metrics.recordCycle(catalogLatencySample{fetchUS: 1000, processUS: 10})
	metrics.recordFailedFetch(3)
}

func TestCatalogLatencyMetricsSnapshotAggregates(t *testing.T) {
	metrics := newCatalogLatencyMetrics()
	// fetch 100ms..1000ms in 100ms steps, process 100us..1000us
	for i := 1; i <= 10; i++ {
		metrics.recordCycle(catalogLatencySample{
			fetchUS:   int64(i) * 100_000,
			processUS: int64(i) * 100,
			attempts:  1,
			itemCount: 20,
			newItems:  i % 2,
		})
	}
	// two hedged cycles and one outright failure
	metrics.recordCycle(catalogLatencySample{fetchUS: 250_000, processUS: 250, attempts: 3, itemCount: 20})
	metrics.recordCycle(catalogLatencySample{fetchUS: 250_000, processUS: 250, attempts: 2, itemCount: 20})
	metrics.recordFailedFetch(4)

	snapshot := metrics.snapshot()

	if got := snapshot["samples"].(int); got != 12 {
		t.Fatalf("samples = %d, want 12", got)
	}
	if got := snapshot["cycles"].(uint64); got != 13 {
		t.Fatalf("cycles = %d, want 13", got)
	}
	if got := snapshot["failedFetches"].(uint64); got != 1 {
		t.Fatalf("failedFetches = %d, want 1", got)
	}
	if got := snapshot["itemsSeen"].(uint64); got != 240 {
		t.Fatalf("itemsSeen = %d, want 240", got)
	}
	if got := snapshot["itemsNew"].(uint64); got != 5 {
		t.Fatalf("itemsNew = %d, want 5", got)
	}
	// 12 successful cycles + 1 failure, attempts 10*1 + 3 + 2 + 4 = 19
	if got := snapshot["averageAttempts"].(float64); got < 1.46 || got > 1.47 {
		t.Fatalf("averageAttempts = %f, want ~1.4615", got)
	}
	// 2 of 13 counted cycles needed more than one attempt
	if got := snapshot["hedgedWinRate"].(float64); got < 15.3 || got > 15.4 {
		t.Fatalf("hedgedWinRate = %f, want ~15.38", got)
	}
	// sorted fetch samples in ms: 100 200 250 250 300 400 500 600 700 800 900 1000
	if got := snapshot["fetchP50Ms"].(int64); got != 400 {
		t.Fatalf("fetchP50Ms = %d, want 400", got)
	}
	// index (12-1)*95/100 = 10, matching the existing percentile arithmetic
	if got := snapshot["fetchP95Ms"].(int64); got != 900 {
		t.Fatalf("fetchP95Ms = %d, want 900", got)
	}
	if got := snapshot["processP50Us"].(int64); got != 400 {
		t.Fatalf("processP50Us = %d, want 400", got)
	}

	// The heartbeat marshals this map, so it must be JSON-encodable.
	if _, err := json.Marshal(snapshot); err != nil {
		t.Fatalf("marshal snapshot: %v", err)
	}
}

func TestCatalogLatencyMetricsSnapshotOfEmptyRing(t *testing.T) {
	snapshot := newCatalogLatencyMetrics().snapshot()
	if got := snapshot["samples"].(int); got != 0 {
		t.Fatalf("samples = %d, want 0", got)
	}
	if got := snapshot["fetchP95Ms"].(int64); got != 0 {
		t.Fatalf("fetchP95Ms = %d, want 0", got)
	}
	if got := snapshot["averageAttempts"].(float64); got != 0 {
		t.Fatalf("averageAttempts = %f, want 0", got)
	}
}

func TestCatalogLatencyMetricsRingStaysBounded(t *testing.T) {
	metrics := newCatalogLatencyMetrics()
	for i := 0; i < catalogLatencyRingSize*3; i++ {
		metrics.recordCycle(catalogLatencySample{fetchUS: int64(i), processUS: int64(i), attempts: 1})
	}

	metrics.mu.Lock()
	fetchLen := len(metrics.fetchUS)
	fetchCap := cap(metrics.fetchUS)
	processLen := len(metrics.processUS)
	cycles := metrics.cycles
	metrics.mu.Unlock()

	if fetchLen > catalogLatencyRingSize || processLen > catalogLatencyRingSize {
		t.Fatalf("ring lengths = %d/%d, want <= %d", fetchLen, processLen, catalogLatencyRingSize)
	}
	if fetchCap > catalogLatencyRingSize*2 {
		t.Fatalf("ring capacity = %d, want <= %d", fetchCap, catalogLatencyRingSize*2)
	}
	// Counters must keep accumulating even though samples are discarded.
	if cycles != uint64(catalogLatencyRingSize*3) {
		t.Fatalf("cycles = %d, want %d", cycles, catalogLatencyRingSize*3)
	}
}

func TestCatalogLatencyMetricsClampsNegativeAndZeroValues(t *testing.T) {
	metrics := newCatalogLatencyMetrics()
	// A zero-value catalogFetchResult (for example a pool wait error) must not
	// poison the ring with negative samples or a zero attempt count.
	metrics.recordCycle(catalogLatencySample{fetchUS: -5, processUS: -1, attempts: 0, itemCount: -3, newItems: -3})

	snapshot := metrics.snapshot()
	if got := snapshot["fetchP50Ms"].(int64); got != 0 {
		t.Fatalf("fetchP50Ms = %d, want 0", got)
	}
	if got := snapshot["itemsSeen"].(uint64); got != 0 {
		t.Fatalf("itemsSeen = %d, want 0", got)
	}
	if got := snapshot["averageAttempts"].(float64); got != 1 {
		t.Fatalf("averageAttempts = %f, want 1", got)
	}
}

func TestCatalogLatencyPercentileMatchesExistingArithmetic(t *testing.T) {
	sorted := []int64{10, 20, 30, 40, 50, 60, 70, 80, 90, 100}
	if got := catalogLatencyPercentile(sorted, 50); got != 50 {
		t.Fatalf("p50 = %d, want 50", got)
	}
	if got := catalogLatencyPercentile(sorted, 95); got != 90 {
		t.Fatalf("p95 = %d, want 90", got)
	}
	if got := catalogLatencyPercentile(nil, 95); got != 0 {
		t.Fatalf("p95 of empty = %d, want 0", got)
	}
}

func TestCatalogLatencyMetricsEnabledByDefaultAndDisablable(t *testing.T) {
	if !catalogLatencyMetricsEnabled() {
		t.Fatal("catalog latency metrics should default to enabled")
	}
	t.Setenv("CATALOG_LATENCY_METRICS", "false")
	if catalogLatencyMetricsEnabled() {
		t.Fatal("CATALOG_LATENCY_METRICS=false should disable the metrics")
	}
	t.Setenv("CATALOG_LATENCY_METRICS", "true")
	if !catalogLatencyMetricsEnabled() {
		t.Fatal("CATALOG_LATENCY_METRICS=true should enable the metrics")
	}
}

func TestCatalogLatencyMetricsConcurrentRecording(t *testing.T) {
	metrics := newCatalogLatencyMetrics()
	const writers = 8
	const perWriter = 500

	done := make(chan struct{}, writers+1)
	for w := 0; w < writers; w++ {
		go func() {
			defer func() { done <- struct{}{} }()
			for i := 0; i < perWriter; i++ {
				metrics.recordCycle(catalogLatencySample{fetchUS: int64(i), processUS: int64(i), attempts: 1})
			}
		}()
	}
	go func() {
		defer func() { done <- struct{}{} }()
		for i := 0; i < 100; i++ {
			_ = metrics.snapshot()
		}
	}()
	for i := 0; i < writers+1; i++ {
		<-done
	}

	metrics.mu.Lock()
	cycles := metrics.cycles
	metrics.mu.Unlock()
	if cycles != writers*perWriter {
		t.Fatalf("cycles = %d, want %d", cycles, writers*perWriter)
	}
}
