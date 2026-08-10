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
	mu          sync.Mutex
	cacheHits   uint64
	cacheMisses uint64
	timeouts    uint64
	remoteMS    []int64
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

func (m *sellerEnrichmentMetrics) recordRemote(duration time.Duration, timedOut bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if timedOut {
		m.timeouts++
	}
	m.remoteMS = append(m.remoteMS, duration.Milliseconds())
	if len(m.remoteMS) > 4096 {
		copy(m.remoteMS, m.remoteMS[len(m.remoteMS)-2048:])
		m.remoteMS = m.remoteMS[:2048]
	}
}

func (m *sellerEnrichmentMetrics) snapshot(queueAge time.Duration) map[string]any {
	m.mu.Lock()
	defer m.mu.Unlock()
	totalCache := m.cacheHits + m.cacheMisses
	hitRate := 0.0
	if totalCache > 0 {
		hitRate = float64(m.cacheHits) / float64(totalCache) * 100
	}
	durations := append([]int64(nil), m.remoteMS...)
	sort.Slice(durations, func(i, j int) bool { return durations[i] < durations[j] })
	remoteP95 := int64(0)
	if len(durations) > 0 {
		remoteP95 = durations[(len(durations)-1)*95/100]
	}
	return map[string]any{
		"queueAgeMs":   queueAge.Milliseconds(),
		"cacheHitRate": hitRate,
		"cacheHits":    m.cacheHits,
		"cacheMisses":  m.cacheMisses,
		"remoteP95Ms":  remoteP95,
		"timeouts":     m.timeouts,
		"updatedAt":    time.Now().UTC().Format(time.RFC3339Nano),
	}
}

func (e *Engine) enrichmentMetricsHeartbeat() {
	defer e.jobsWG.Done()
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	for {
		payload, err := json.Marshal(e.enrichmentMetrics.snapshot(e.enrichmentScheduler.QueueAge(time.Now())))
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
