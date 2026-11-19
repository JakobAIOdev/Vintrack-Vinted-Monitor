package scraper

import (
	"context"
	"encoding/json"
	"log"
	"math"
	"sort"
	"strings"
	"sync"
	"time"

	"vintrack-worker/internal/database"
)

type freeProxyPacingPolicy struct {
	Enabled                   bool     `json:"adaptivePacingEnabled"`
	Regions                   []string `json:"adaptiveRegions"`
	MaxRequestsPerProxySecond float64  `json:"maxRequestsPerProxySecond"`
	MaxAdmissionDelayMS       int      `json:"maxAdmissionDelayMs"`
	admissionRegion           string
}

func (p freeProxyPacingPolicy) forPool(region string, limited bool) freeProxyPacingPolicy {
	// The adaptive controller is optional; a shared pool's configured rate
	// limit is not. Reaching readiness must not turn admission off.
	p.admissionRegion = strings.ToLower(strings.TrimSpace(region))
	if p.MaxRequestsPerProxySecond <= 0 {
		p.MaxRequestsPerProxySecond = 0.5
	}
	if limited {
		if p.MaxRequestsPerProxySecond > 0.5 {
			p.MaxRequestsPerProxySecond = 0.5
		}
		// Queue a small cohort fairly instead of repeatedly rejecting the same
		// monitors at the normal short admission deadline. All waits remain
		// bounded and cancel immediately when the monitor stops.
		p.MaxAdmissionDelayMS = 30_000
	}
	return p
}

func loadFreeProxyPacingPolicy(store *database.Store) freeProxyPacingPolicy {
	policy := freeProxyPacingPolicy{
		Regions: []string{"de", "fr"}, MaxRequestsPerProxySecond: 0.5, MaxAdmissionDelayMS: 1500,
	}
	if raw, ok, err := store.GetSettingValue("policy.free_proxy"); err == nil && ok {
		_ = json.Unmarshal([]byte(raw), &policy)
	}
	if policy.MaxRequestsPerProxySecond <= 0 {
		policy.MaxRequestsPerProxySecond = 0.5
	}
	if policy.MaxAdmissionDelayMS < 0 {
		policy.MaxAdmissionDelayMS = 0
	}
	for index := range policy.Regions {
		policy.Regions[index] = strings.ToLower(strings.TrimSpace(policy.Regions[index]))
	}
	return policy
}

func (p freeProxyPacingPolicy) applies(region string) bool {
	region = strings.ToLower(strings.TrimSpace(region))
	return (region != "" && region == p.admissionRegion) || p.adapts(region)
}

func (p freeProxyPacingPolicy) adapts(region string) bool {
	if !p.Enabled {
		return false
	}
	region = strings.ToLower(strings.TrimSpace(region))
	for _, candidate := range p.Regions {
		if candidate == region {
			return true
		}
	}
	return false
}

type freeProxyRegionPacer struct {
	mu             sync.Mutex
	region         string
	policy         freeProxyPacingPolicy
	windowStarted  time.Time
	nextAdmission  time.Time
	monitorNext    map[int]time.Time
	waiters        []*freeProxyAdmissionWaiter
	requested      uint64
	admitted       uint64
	successes      uint64
	outcomes       uint64
	rateLimited    uint64
	poolWaits      uint64
	admissionMS    []int64
	capacityFactor float64
	lastWindow     freeProxyRuntimeRegionMetric
}

type freeProxyRuntimeRegionMetric struct {
	Region                    string  `json:"region"`
	RequestedRPS              float64 `json:"requestedRps"`
	AdmittedRPS               float64 `json:"admittedRps"`
	ActiveClients             int     `json:"activeClients"`
	CapacityRPS               float64 `json:"capacityRps"`
	SuccessRate               float64 `json:"successRate"`
	RateLimitedRate           float64 `json:"rateLimitedRate"`
	PoolWaitRate              float64 `json:"poolWaitRate"`
	AdmissionP95MS            int64   `json:"admissionP95Ms"`
	ObservedEffectiveInterval int64   `json:"observedEffectiveIntervalMs"`
	ExecutedRequests          uint64  `json:"executedRequests"`
	CapacityFactor            float64 `json:"capacityFactor"`
	Reason                    string  `json:"reason,omitempty"`
}

func (e *Engine) freeProxyRuntimeMetricsHeartbeat() {
	defer e.jobsWG.Done()
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	for {
		e.freePacersMu.Lock()
		metrics := make([]freeProxyRuntimeRegionMetric, 0, len(e.freePacers))
		for region, pacer := range e.freePacers {
			metrics = append(metrics, pacer.snapshot(e.freeProxy.Manager(region).Count()))
		}
		e.freePacersMu.Unlock()
		sort.Slice(metrics, func(i, j int) bool { return metrics[i].Region < metrics[j].Region })
		if len(metrics) > 50 {
			metrics = metrics[:50]
		}
		payload, err := json.Marshal(map[string]any{
			"updatedAt":       time.Now().UTC().Format(time.RFC3339Nano),
			"regions":         metrics,
			"sharedAdmission": e.freeProxyAdmission.snapshot(),
		})
		if err == nil {
			writeCtx, cancel := context.WithTimeout(e.jobsCtx, 3*time.Second)
			err = e.db.SetSettingValueContext(writeCtx, "free_proxy_runtime_metrics", string(payload))
			cancel()
		}
		if err != nil && e.jobsCtx.Err() == nil {
			log.Printf("free proxy runtime metrics heartbeat: %v", err)
		}
		select {
		case <-e.jobsCtx.Done():
			return
		case <-ticker.C:
		}
	}
}

func newFreeProxyRegionPacer(region string, policy freeProxyPacingPolicy) *freeProxyRegionPacer {
	return &freeProxyRegionPacer{
		region: region, policy: policy, windowStarted: time.Now(), capacityFactor: 1,
		monitorNext: make(map[int]time.Time),
	}
}

func (p *freeProxyRegionPacer) applyPolicy(policy freeProxyPacingPolicy) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.policy = policy
	if !policy.adapts(p.region) {
		p.capacityFactor = 1
	}
}

type freeProxyAdmissionWaiter struct{ queued bool }

func (p *freeProxyRegionPacer) admit(ctx context.Context, monitorID int, desiredInterval time.Duration, clients int) (time.Duration, bool) {
	started := time.Now()
	if ctx.Err() != nil {
		return 0, false
	}
	p.mu.Lock()
	p.rotateLocked(started, clients)
	p.requested++
	maxDelay := time.Duration(p.policy.MaxAdmissionDelayMS) * time.Millisecond
	if len(p.waiters) >= maxPoolAdmissionWaiters {
		p.poolWaits++
		p.mu.Unlock()
		return 0, false
	}
	waiter := &freeProxyAdmissionWaiter{queued: true}
	p.waiters = append(p.waiters, waiter)
	p.mu.Unlock()
	defer func() {
		p.mu.Lock()
		defer p.mu.Unlock()
		for i, w := range p.waiters {
			if w == waiter {
				copy(p.waiters[i:], p.waiters[i+1:])
				p.waiters[len(p.waiters)-1] = nil
				p.waiters = p.waiters[:len(p.waiters)-1]
				return
			}
		}
	}()
	deadline := started.Add(maxDelay)
	for {
		if ctx.Err() != nil {
			return time.Since(started), false
		}
		now := time.Now()
		p.mu.Lock()
		p.rotateLocked(now, clients)
		if p.monitorNext == nil {
			p.monitorNext = make(map[int]time.Time)
		}
		eligibleAt := p.nextAdmission
		if ready := p.monitorNext[monitorID]; ready.After(eligibleAt) {
			eligibleAt = ready
		}
		// A monitor whose own search interval has not elapsed must not hold the
		// regional queue in front of monitors that are already eligible.
		if p.waiters[0] == waiter && p.monitorNext[monitorID].After(now) && len(p.waiters) > 1 {
			copy(p.waiters, p.waiters[1:])
			p.waiters[len(p.waiters)-1] = waiter
		}
		if p.waiters[0] == waiter && !eligibleAt.After(now) {
			rate := math.Max(0.05, float64(max(1, clients))*p.policy.MaxRequestsPerProxySecond*p.capacityFactor)
			spacing := time.Duration(float64(time.Second) / rate)
			p.nextAdmission = now.Add(spacing)
			desiredInterval = max(desiredInterval, spacing)
			p.monitorNext[monitorID] = now.Add(desiredInterval)
			p.admitted++
			waited := now.Sub(started)
			p.recordAdmissionLocked(waited)
			p.mu.Unlock()
			return waited, true
		}
		if maxDelay <= 0 || !now.Before(deadline) {
			p.poolWaits++
			waited := now.Sub(started)
			p.recordAdmissionLocked(waited)
			p.mu.Unlock()
			return waited, false
		}
		p.mu.Unlock()
		timer := time.NewTimer(min(10*time.Millisecond, time.Until(deadline)))
		select {
		case <-ctx.Done():
			timer.Stop()
			return time.Since(started), false
		case <-timer.C:
		}
	}
}

func (p *freeProxyRegionPacer) recordAdmissionLocked(wait time.Duration) {
	p.admissionMS = append(p.admissionMS, wait.Milliseconds())
	if len(p.admissionMS) > 1024 {
		copy(p.admissionMS, p.admissionMS[len(p.admissionMS)-512:])
		p.admissionMS = p.admissionMS[:512]
	}
}

func (p *freeProxyRegionPacer) recordResult(status int, success bool, clients int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.rotateLocked(time.Now(), clients)
	p.outcomes++
	if success {
		p.successes++
	}
	if status == 429 {
		p.rateLimited++
	}
}

func (p *freeProxyRegionPacer) recordPoolWait() {
	p.mu.Lock()
	p.poolWaits++
	p.mu.Unlock()
}

func (p *freeProxyRegionPacer) allowHedge() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.capacityFactor >= 1 && p.poolWaits == 0
}

func (p *freeProxyRegionPacer) limits() (float64, time.Duration) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.policy.MaxRequestsPerProxySecond,
		time.Duration(p.policy.MaxAdmissionDelayMS) * time.Millisecond
}

func (p *freeProxyRegionPacer) rotateLocked(now time.Time, clients int) {
	if now.Sub(p.windowStarted) < time.Minute {
		return
	}
	adaptive := p.policy.adapts(p.region)
	if !adaptive {
		p.capacityFactor = 1
	}
	p.lastWindow = p.snapshotLocked(now, clients)
	if !adaptive || p.outcomes == 0 {
		p.resetWindowLocked(now)
		return
	}
	attempts := max(uint64(1), p.outcomes)
	rateLimitedRate := float64(p.rateLimited) / float64(attempts)
	// Transport failures retire/cool individual clients; they are not evidence
	// that every healthy exit is over its request budget. Only sufficiently
	// sampled upstream rate limits justify reducing the whole region. Sparse
	// 429s still receive the individual client's normal backoff immediately.
	unhealthy := p.outcomes >= 20 && rateLimitedRate >= 0.05
	if unhealthy {
		p.capacityFactor = math.Max(0.0625, p.capacityFactor/2)
	} else if p.rateLimited == 0 {
		// Restore one step per active rate-limit-free window. Requiring five
		// windows per step stranded small cohorts for twenty minutes or more;
		// the shared per-exit limiter remains a hard upper bound throughout.
		p.capacityFactor = math.Min(1, p.capacityFactor*2)
	}
	p.resetWindowLocked(now)
}

func (p *freeProxyRegionPacer) resetWindowLocked(now time.Time) {
	for monitorID, next := range p.monitorNext {
		if next.Before(now.Add(-10 * time.Minute)) {
			delete(p.monitorNext, monitorID)
		}
	}
	p.windowStarted = now
	p.requested, p.admitted, p.successes, p.outcomes, p.rateLimited, p.poolWaits = 0, 0, 0, 0, 0, 0
	p.admissionMS = p.admissionMS[:0]
}

func (p *freeProxyRegionPacer) snapshot(clients int) freeProxyRuntimeRegionMetric {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.snapshotLocked(time.Now(), clients)
}

func (p *freeProxyRegionPacer) snapshotLocked(now time.Time, clients int) freeProxyRuntimeRegionMetric {
	if p.requested == 0 && p.outcomes == 0 && p.poolWaits == 0 && p.lastWindow.Region != "" {
		metric := p.lastWindow
		metric.ActiveClients = clients
		metric.CapacityRPS = float64(max(1, clients)) * p.policy.MaxRequestsPerProxySecond * p.capacityFactor
		metric.CapacityFactor = p.capacityFactor
		return metric
	}
	duration := math.Max(1, now.Sub(p.windowStarted).Seconds())
	attempts := max(uint64(1), p.outcomes)
	waits := append([]int64(nil), p.admissionMS...)
	sort.Slice(waits, func(i, j int) bool { return waits[i] < waits[j] })
	p95 := int64(0)
	if len(waits) > 0 {
		p95 = waits[(len(waits)-1)*95/100]
	}
	metric := freeProxyRuntimeRegionMetric{
		Region:           p.region,
		RequestedRPS:     float64(p.requested) / duration,
		AdmittedRPS:      float64(p.admitted) / duration,
		ActiveClients:    clients,
		CapacityRPS:      float64(max(1, clients)) * p.policy.MaxRequestsPerProxySecond * p.capacityFactor,
		SuccessRate:      float64(p.successes) / float64(attempts) * 100,
		RateLimitedRate:  float64(p.rateLimited) / float64(attempts) * 100,
		PoolWaitRate:     float64(p.poolWaits) / float64(max(uint64(1), p.requested)) * 100,
		AdmissionP95MS:   p95,
		ExecutedRequests: p.outcomes,
		CapacityFactor:   p.capacityFactor,
	}
	if metric.AdmittedRPS > 0 {
		metric.ObservedEffectiveInterval = int64(1000 / metric.AdmittedRPS)
	}
	if p.capacityFactor < 1 {
		metric.Reason = "adaptive_pressure"
	} else if metric.PoolWaitRate > 0 {
		metric.Reason = "admission_wait"
	}
	return metric
}
