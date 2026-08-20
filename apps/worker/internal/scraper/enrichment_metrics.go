package scraper

import (
	"context"
	"encoding/json"
	"log"
	"sort"
	"sync"
	"time"
)

type sellerEnrichmentMetrics struct {
	mu              sync.Mutex
	cacheHits       uint64
	cacheMisses     uint64
	timeouts        uint64
	remoteMS        []int64
	remoteSuccesses uint64
	remoteFailures  uint64
	failuresByKind  map[sellerFetchFailureKind]uint64
}

func (m *sellerEnrichmentMetrics) recordCache(hit bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if hit {
		m.cacheHits++
	} else {
		m.cacheMisses++
	}
}

// recordRemote records one completed remote attempt. kind is failureNone for
// a success; any other value buckets the failure so 401/403, 429, 5xx,
// decode errors, empty responses, timeouts, and "no healthy client" are
// visible as distinct counters instead of one opaque failure count.
func (m *sellerEnrichmentMetrics) recordRemote(duration time.Duration, kind sellerFetchFailureKind) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if kind == failureNone {
		m.remoteSuccesses++
	} else {
		m.remoteFailures++
		if kind == failureTimeout {
			m.timeouts++
		}
		if m.failuresByKind == nil {
			m.failuresByKind = make(map[sellerFetchFailureKind]uint64)
		}
		m.failuresByKind[kind]++
	}
	m.remoteMS = append(m.remoteMS, duration.Milliseconds())
	if len(m.remoteMS) > 4096 {
		copy(m.remoteMS, m.remoteMS[len(m.remoteMS)-2048:])
		m.remoteMS = m.remoteMS[:2048]
	}
}

// snapshot builds the JSON payload consumed by
// apps/control-center/src/actions/admin.ts. All pre-existing keys
// (queueAgeMs, cacheHitRate, cacheHits, cacheMisses, remoteP95Ms, timeouts,
// updatedAt) keep their exact names and types; every field below that line
// is additive so an older or newer consumer never breaks on either side.
func (m *sellerEnrichmentMetrics) snapshot(queueAge, strictRetryQueueAge, backgroundQueueAge time.Duration, negativeCacheHits uint64) map[string]any {
	m.mu.Lock()
	defer m.mu.Unlock()
	totalCache := m.cacheHits + m.cacheMisses
	hitRate := 0.0
	if totalCache > 0 {
		hitRate = float64(m.cacheHits) / float64(totalCache) * 100
	}
	durations := append([]int64(nil), m.remoteMS...)
	sort.Slice(durations, func(i, j int) bool { return durations[i] < durations[j] })
	percentile := func(p int) int64 {
		if len(durations) == 0 {
			return 0
		}
		return durations[(len(durations)-1)*p/100]
	}
	remoteP95 := percentile(95)
	remoteP50 := percentile(50)
	totalRemote := m.remoteSuccesses + m.remoteFailures
	successRate := 0.0
	if totalRemote > 0 {
		successRate = float64(m.remoteSuccesses) / float64(totalRemote) * 100
	}
	failuresByKind := make(map[string]uint64, len(m.failuresByKind))
	for kind, count := range m.failuresByKind {
		failuresByKind[kind.String()] = count
	}
	return map[string]any{
		"queueAgeMs":   queueAge.Milliseconds(),
		"cacheHitRate": hitRate,
		"cacheHits":    m.cacheHits,
		"cacheMisses":  m.cacheMisses,
		"remoteP95Ms":  remoteP95,
		"timeouts":     m.timeouts,
		"updatedAt":    time.Now().UTC().Format(time.RFC3339Nano),

		"remoteP50Ms":           remoteP50,
		"remoteAttempts":        totalRemote,
		"remoteSuccesses":       m.remoteSuccesses,
		"remoteFailures":        m.remoteFailures,
		"remoteSuccessRate":     successRate,
		"remoteFailuresByKind":  failuresByKind,
		"negativeCacheHits":     negativeCacheHits,
		"strictRetryQueueAgeMs": strictRetryQueueAge.Milliseconds(),
		"backgroundQueueAgeMs":  backgroundQueueAge.Milliseconds(),
	}
}

func (e *Engine) enrichmentMetricsHeartbeat() {
	defer e.jobsWG.Done()
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	for {
		now := time.Now()
		snapshot := e.enrichmentMetrics.snapshot(
			e.enrichmentScheduler.QueueAge(now),
			e.enrichmentScheduler.StrictRetryQueueAge(now),
			e.enrichmentScheduler.BackgroundQueueAge(now),
			sellerNegativeCache.HitCount(),
		)
		payload, err := json.Marshal(snapshot)
		if err == nil {
			ctx, cancel := context.WithTimeout(e.jobsCtx, 3*time.Second)
			err = e.db.SetSettingValueContext(ctx, "seller_enrichment_metrics", string(payload))
			cancel()
		}
		if err != nil {
			log.Printf("seller enrichment metrics heartbeat: %v", err)
		}
		select {
		case <-e.jobsCtx.Done():
			return
		case <-ticker.C:
		}
	}
}
