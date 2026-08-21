package scraper

import (
	"context"
	"encoding/json"
	"log"
	"os"
	"sort"
	"sync"
	"time"
)

// catalogLatencyRingSize bounds the in-process sample ring. Samples are appended
// once per monitor cycle, never once per item, so this stays far cheaper than
// the per-item telemetry channel (which drops silently when full).
const catalogLatencyRingSize = 4096

// catalogLatencySettingKey is the app_settings key the heartbeat writes.
const catalogLatencySettingKey = "catalog_latency_metrics"

// catalogLatencyHeartbeatInterval matches the seller-enrichment heartbeat so the
// worker keeps one observability cadence.
const catalogLatencyHeartbeatInterval = 10 * time.Second

// catalogLatencySample is one completed monitor cycle. fetchUS covers the
// winning catalog request (transport, warmup reuse, and JSON decode inside the
// CatalogFetcher). processUS covers everything the worker does after the fetch
// returns: title/anti-keyword/banned-seller filtering, the new-item diff,
// per-item model building, and enqueueing onto the enrichment and alert
// pipelines. It deliberately excludes the inter-cycle sleep.
type catalogLatencySample struct {
	fetchUS   int64
	processUS int64
	attempts  int
	itemCount int
	newItems  int
}

// catalogLatencyMetrics aggregates catalog cycle timings in process. It exists
// because catalogFetchResult.duration and .attempts were previously discarded,
// leaving no worker-side view of fetch versus post-fetch cost: the only latency
// numbers available were the database timestamps stamped after detection.
type catalogLatencyMetrics struct {
	mu sync.Mutex

	fetchUS   []int64
	processUS []int64

	cycles      uint64
	failedFetch uint64
	attemptsSum uint64
	hedgedWins  uint64
	itemsSeen   uint64
	itemsNew    uint64
}

func newCatalogLatencyMetrics() *catalogLatencyMetrics {
	return &catalogLatencyMetrics{
		fetchUS:   make([]int64, 0, 256),
		processUS: make([]int64, 0, 256),
	}
}

// catalogLatencyMetricsEnabled reports whether the in-worker catalog latency
// aggregation and its heartbeat should run. Set
// CATALOG_LATENCY_METRICS=false to turn both off.
func catalogLatencyMetricsEnabled() bool {
	return os.Getenv("CATALOG_LATENCY_METRICS") != "false"
}

// recordFailedFetch counts a cycle whose catalog fetch did not return 200 so the
// success percentiles are not silently computed over a biased sample.
func (m *catalogLatencyMetrics) recordFailedFetch(attempts int) {
	if m == nil {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.cycles++
	m.failedFetch++
	m.attemptsSum += uint64(max(attempts, 1))
}

// recordCycle stores one successful cycle. It is called once per cycle, holds
// the lock only for the append, and never allocates in the steady state.
func (m *catalogLatencyMetrics) recordCycle(sample catalogLatencySample) {
	if m == nil {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()

	m.cycles++
	attempts := max(sample.attempts, 1)
	m.attemptsSum += uint64(attempts)
	if attempts > 1 {
		m.hedgedWins++
	}
	m.itemsSeen += uint64(max(sample.itemCount, 0))
	m.itemsNew += uint64(max(sample.newItems, 0))

	m.fetchUS = appendCatalogLatencySample(m.fetchUS, sample.fetchUS)
	m.processUS = appendCatalogLatencySample(m.processUS, sample.processUS)
}

// appendCatalogLatencySample keeps the ring bounded by halving it when full,
// matching the existing seller-enrichment ring so memory stays predictable
// under GOMEMLIMIT.
func appendCatalogLatencySample(ring []int64, value int64) []int64 {
	if value < 0 {
		value = 0
	}
	ring = append(ring, value)
	if len(ring) > catalogLatencyRingSize {
		keep := catalogLatencyRingSize / 2
		copy(ring, ring[len(ring)-keep:])
		ring = ring[:keep]
	}
	return ring
}

// catalogLatencyPercentile uses the same index arithmetic as the existing
// enrichment metrics and the control-center SQL percentiles.
func catalogLatencyPercentile(sorted []int64, percentile int) int64 {
	if len(sorted) == 0 {
		return 0
	}
	return sorted[(len(sorted)-1)*percentile/100]
}

func (m *catalogLatencyMetrics) snapshot() map[string]any {
	if m == nil {
		return map[string]any{}
	}
	m.mu.Lock()
	fetchUS := append([]int64(nil), m.fetchUS...)
	processUS := append([]int64(nil), m.processUS...)
	cycles := m.cycles
	failedFetch := m.failedFetch
	attemptsSum := m.attemptsSum
	hedgedWins := m.hedgedWins
	itemsSeen := m.itemsSeen
	itemsNew := m.itemsNew
	m.mu.Unlock()

	sort.Slice(fetchUS, func(i int, j int) bool { return fetchUS[i] < fetchUS[j] })
	sort.Slice(processUS, func(i int, j int) bool { return processUS[i] < processUS[j] })

	averageAttempts := 0.0
	hedgedWinRate := 0.0
	if cycles > 0 {
		averageAttempts = float64(attemptsSum) / float64(cycles)
		hedgedWinRate = float64(hedgedWins) / float64(cycles) * 100
	}

	return map[string]any{
		"samples":         len(fetchUS),
		"cycles":          cycles,
		"failedFetches":   failedFetch,
		"fetchP50Ms":      catalogLatencyPercentile(fetchUS, 50) / 1000,
		"fetchP95Ms":      catalogLatencyPercentile(fetchUS, 95) / 1000,
		"processP50Us":    catalogLatencyPercentile(processUS, 50),
		"processP95Us":    catalogLatencyPercentile(processUS, 95),
		"averageAttempts": averageAttempts,
		"hedgedWinRate":   hedgedWinRate,
		"itemsSeen":       itemsSeen,
		"itemsNew":        itemsNew,
		"updatedAt":       time.Now().UTC().Format(time.RFC3339Nano),
	}
}

// catalogLatencyHeartbeat publishes the aggregate to app_settings on the same
// cadence and with the same failure handling as the enrichment heartbeat. It
// writes one row per interval regardless of catalog volume, so it cannot
// contribute to the per-item telemetry channel dropping events.
func (e *Engine) catalogLatencyHeartbeat() {
	defer e.jobsWG.Done()
	ticker := time.NewTicker(catalogLatencyHeartbeatInterval)
	defer ticker.Stop()
	for {
		payload, err := json.Marshal(e.catalogLatency.snapshot())
		if err == nil {
			ctx, cancel := context.WithTimeout(e.jobsCtx, 3*time.Second)
			err = e.db.SetSettingValueContext(ctx, catalogLatencySettingKey, string(payload))
			cancel()
		}
		if err != nil {
			log.Printf("catalog latency metrics heartbeat: %v", err)
		}
		select {
		case <-e.jobsCtx.Done():
			return
		case <-ticker.C:
		}
	}
}
