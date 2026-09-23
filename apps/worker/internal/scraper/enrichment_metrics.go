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
	freshHits       uint64
	staleHits       uint64
	redisHits       uint64
	postgresHits    uint64
	refreshes       uint64
	segments        map[string]*sellerMetricSegment
	queueAgeMS      []int64
	timeouts        uint64
	remoteMS        []int64
	remoteSuccesses uint64
	remoteFailures  uint64
	failuresByKind  map[sellerFetchFailureKind]uint64
}

type sellerMetricSegment struct {
	Region          string `json:"region"`
	ProxyType       string `json:"proxyType"`
	FreshHits       uint64 `json:"freshHits"`
	StaleHits       uint64 `json:"staleHits"`
	RedisHits       uint64 `json:"redisHits"`
	DBHits          uint64 `json:"dbHits"`
	RemoteSuccesses uint64 `json:"remoteSuccesses"`
	RemoteFailures  uint64 `json:"remoteFailures"`
	Timeouts        uint64 `json:"timeouts"`
	NoClient        uint64 `json:"noClient"`
	RemoteP50MS     int64  `json:"remoteP50Ms"`
	RemoteP95MS     int64  `json:"remoteP95Ms"`
	remoteMS        []int64
}

func (m *sellerEnrichmentMetrics) segmentLocked(region string, proxyType string) *sellerMetricSegment {
	key := region + "|" + proxyType
	if m.segments == nil {
		m.segments = make(map[string]*sellerMetricSegment)
	}
	if segment := m.segments[key]; segment != nil {
		return segment
	}
	if len(m.segments) >= 64 {
		return nil
	}
	segment := &sellerMetricSegment{Region: region, ProxyType: proxyType}
	m.segments[key] = segment
	return segment
}

func (m *sellerEnrichmentMetrics) recordCacheResult(status sellerCacheStatus, source string, region string, proxyType string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if status == sellerCacheMiss {
		m.cacheMisses++
		return
	}
	m.cacheHits++
	if status == sellerCacheStale {
		m.staleHits++
	} else {
		m.freshHits++
	}
	switch source {
	case "redis":
		m.redisHits++
	case "postgres":
		m.postgresHits++
	}
	if segment := m.segmentLocked(region, proxyType); segment != nil {
		if status == sellerCacheStale {
			segment.StaleHits++
		} else {
			segment.FreshHits++
		}
		if source == "redis" {
			segment.RedisHits++
		}
		if source == "postgres" {
			segment.DBHits++
		}
	}
}

func (m *sellerEnrichmentMetrics) recordRefresh() {
	m.mu.Lock()
	m.refreshes++
	m.mu.Unlock()
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
	m.recordRemoteFor(duration, kind, "", "")
}

func (m *sellerEnrichmentMetrics) recordRemoteFor(duration time.Duration, kind sellerFetchFailureKind, region string, proxyType string) {
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
	if segment := m.segmentLocked(region, proxyType); segment != nil {
		if kind == failureNone {
			segment.RemoteSuccesses++
		} else {
			segment.RemoteFailures++
			if kind == failureTimeout {
				segment.Timeouts++
			}
			if kind == failureNoClient {
				segment.NoClient++
			}
		}
		segment.remoteMS = append(segment.remoteMS, duration.Milliseconds())
		if len(segment.remoteMS) > 512 {
			copy(segment.remoteMS, segment.remoteMS[len(segment.remoteMS)-256:])
			segment.remoteMS = segment.remoteMS[:256]
		}
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
	m.queueAgeMS = append(m.queueAgeMS, queueAge.Milliseconds())
	if len(m.queueAgeMS) > 360 {
		copy(m.queueAgeMS, m.queueAgeMS[len(m.queueAgeMS)-180:])
		m.queueAgeMS = m.queueAgeMS[:180]
	}
	queueSamples := append([]int64(nil), m.queueAgeMS...)
	sort.Slice(queueSamples, func(i, j int) bool { return queueSamples[i] < queueSamples[j] })
	queueP95 := int64(0)
	if len(queueSamples) > 0 {
		queueP95 = queueSamples[(len(queueSamples)-1)*95/100]
	}
	segments := make([]sellerMetricSegment, 0, len(m.segments))
	for _, segment := range m.segments {
		copyOfSegment := *segment
		segmentDurations := append([]int64(nil), segment.remoteMS...)
		sort.Slice(segmentDurations, func(i, j int) bool {
			return segmentDurations[i] < segmentDurations[j]
		})
		if len(segmentDurations) > 0 {
			copyOfSegment.RemoteP50MS = segmentDurations[(len(segmentDurations)-1)*50/100]
			copyOfSegment.RemoteP95MS = segmentDurations[(len(segmentDurations)-1)*95/100]
		}
		copyOfSegment.remoteMS = nil
		segments = append(segments, copyOfSegment)
	}
	sort.Slice(segments, func(i, j int) bool {
		if segments[i].Region == segments[j].Region {
			return segments[i].ProxyType < segments[j].ProxyType
		}
		return segments[i].Region < segments[j].Region
	})
	return map[string]any{
		"queueAgeMs":   queueAge.Milliseconds(),
		"cacheHitRate": hitRate,
		"cacheHits":    m.cacheHits,
		"cacheMisses":  m.cacheMisses,
		"freshHits":    m.freshHits,
		"staleHits":    m.staleHits,
		"redisHits":    m.redisHits,
		"dbHits":       m.postgresHits,
		"refreshes":    m.refreshes,
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
		"readyQueueAgeP95Ms":    queueP95,
		"byRegionProxy":         segments,
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
			if err == nil {
				cachePayload, marshalErr := json.Marshal(e.db.CacheRuntimeMetrics(ctx))
				if marshalErr == nil {
					err = e.db.SetSettingValueContext(ctx, "redis_runtime_metrics", string(cachePayload))
				} else {
					err = marshalErr
				}
			}
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
