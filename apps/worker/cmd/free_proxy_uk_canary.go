package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"

	"vintrack-worker/internal/database"
)

const (
	freeProxyUKCanaryRegion           = "uk"
	freeProxyUKCanarySettingKey       = "free_proxy_canary_state:uk"
	freeProxyUKCanaryInterval         = 8 * time.Second
	freeProxyUKCanaryWindow           = 30 * time.Minute
	freeProxyUKCanaryOngoingWindow    = 15 * time.Minute
	freeProxyUKCanaryMinimumSamples   = 200
	freeProxyUKCanaryOngoingSamples   = 50
	freeProxyUKCanaryMinimumWindow    = 29 * time.Minute
	freeProxyUKCanaryMinimumSuccess   = 95.0
	freeProxyUKCanaryMaxConcurrency   = 2
	freeProxyUKCanaryPersistenceLimit = 5 * time.Second
)

type freeProxyUKCanaryBucket struct {
	Minute    time.Time `json:"minute"`
	FirstAt   time.Time `json:"firstAt"`
	LastAt    time.Time `json:"lastAt"`
	Checks    int       `json:"checks"`
	Successes int       `json:"successes"`
}

type freeProxyUKCanaryState struct {
	Revision             string                    `json:"revision"`
	Region               string                    `json:"region"`
	State                string                    `json:"state"`
	ReadinessReason      string                    `json:"readinessReason,omitempty"`
	CapacityReady        bool                      `json:"capacityReady"`
	CapacityMature       int                       `json:"capacityMature"`
	CapacityObservations int                       `json:"capacityObservations"`
	CanaryPassed         bool                      `json:"canaryPassed"`
	CertifiedAt          *time.Time                `json:"certifiedAt,omitempty"`
	SampleCount          int                       `json:"sampleCount"`
	SuccessCount         int                       `json:"successCount"`
	SuccessRate          float64                   `json:"successRate"`
	WindowMinutes        float64                   `json:"windowMinutes"`
	OngoingSampleCount   int                       `json:"ongoingSampleCount"`
	OngoingSuccessRate   float64                   `json:"ongoingSuccessRate"`
	LastProbeAt          *time.Time                `json:"lastProbeAt,omitempty"`
	LastSuccessAt        *time.Time                `json:"lastSuccessAt,omitempty"`
	UpdatedAt            time.Time                 `json:"updatedAt"`
	Buckets              []freeProxyUKCanaryBucket `json:"buckets,omitempty"`
}

func newFreeProxyUKCanaryState(now time.Time) freeProxyUKCanaryState {
	return freeProxyUKCanaryState{
		Revision:        freeProxyValidationRevision,
		Region:          freeProxyUKCanaryRegion,
		State:           "building",
		ReadinessReason: "below_minimum_mature",
		UpdatedAt:       now.UTC(),
	}
}

func (s *freeProxyUKCanaryState) observeCapacity(now time.Time, mature int, minimum int) {
	minimum = max(1, minimum)
	exitThreshold := max(1, (minimum*80+99)/100)
	s.CapacityMature = max(0, mature)
	if s.CapacityReady {
		if mature < exitThreshold {
			s.CapacityReady = false
			s.CapacityObservations = 0
			s.State = "building"
			s.ReadinessReason = "below_hysteresis_floor"
		} else {
			s.CapacityObservations = max(2, s.CapacityObservations)
		}
	} else if mature >= minimum {
		s.CapacityObservations++
		if s.CapacityObservations >= 2 {
			s.CapacityReady = true
		}
	} else {
		s.CapacityObservations = 0
		s.State = "building"
		s.ReadinessReason = "below_minimum_mature"
	}
	s.recompute(now)
}

func (s *freeProxyUKCanaryState) recordProbe(now time.Time, success bool) {
	now = now.UTC()
	minute := now.Truncate(time.Minute)
	index := -1
	for candidate := range s.Buckets {
		if s.Buckets[candidate].Minute.Equal(minute) {
			index = candidate
			break
		}
	}
	if index < 0 {
		s.Buckets = append(s.Buckets, freeProxyUKCanaryBucket{
			Minute:  minute,
			FirstAt: now,
			LastAt:  now,
		})
		index = len(s.Buckets) - 1
	}
	bucket := &s.Buckets[index]
	if bucket.FirstAt.IsZero() || now.Before(bucket.FirstAt) {
		bucket.FirstAt = now
	}
	if bucket.LastAt.IsZero() || now.After(bucket.LastAt) {
		bucket.LastAt = now
	}
	bucket.Checks++
	if success {
		bucket.Successes++
		successAt := now
		s.LastSuccessAt = &successAt
	}
	probeAt := now
	s.LastProbeAt = &probeAt
	s.recompute(now)
}

func (s *freeProxyUKCanaryState) recompute(now time.Time) {
	now = now.UTC()
	if s.CertifiedAt != nil {
		s.CanaryPassed = true
	}
	cutoff := now.Add(-freeProxyUKCanaryWindow)
	kept := s.Buckets[:0]
	for _, bucket := range s.Buckets {
		if !bucket.LastAt.Before(cutoff) {
			kept = append(kept, bucket)
		}
	}
	s.Buckets = kept
	s.SampleCount = 0
	s.SuccessCount = 0
	s.OngoingSampleCount = 0
	ongoingSuccesses := 0
	var firstAt time.Time
	var lastAt time.Time
	ongoingCutoff := now.Add(-freeProxyUKCanaryOngoingWindow)
	for _, bucket := range s.Buckets {
		s.SampleCount += bucket.Checks
		s.SuccessCount += bucket.Successes
		if firstAt.IsZero() || bucket.FirstAt.Before(firstAt) {
			firstAt = bucket.FirstAt
		}
		if lastAt.IsZero() || bucket.LastAt.After(lastAt) {
			lastAt = bucket.LastAt
		}
		if !bucket.LastAt.Before(ongoingCutoff) {
			s.OngoingSampleCount += bucket.Checks
			ongoingSuccesses += bucket.Successes
		}
	}
	s.SuccessRate = percent(s.SuccessCount, s.SampleCount)
	s.OngoingSuccessRate = percent(ongoingSuccesses, s.OngoingSampleCount)
	s.WindowMinutes = 0
	if !firstAt.IsZero() && !lastAt.IsZero() && lastAt.After(firstAt) {
		s.WindowMinutes = lastAt.Sub(firstAt).Minutes()
	}

	if !s.CapacityReady {
		s.State = "building"
		if s.ReadinessReason == "" {
			s.ReadinessReason = "below_minimum_mature"
		}
		s.UpdatedAt = now
		return
	}

	if s.CanaryPassed &&
		s.OngoingSampleCount >= freeProxyUKCanaryOngoingSamples &&
		s.OngoingSuccessRate < freeProxyUKCanaryMinimumSuccess {
		s.CanaryPassed = false
		s.CertifiedAt = nil
		s.State = "failed"
		s.ReadinessReason = "uk_canary_below_target"
	}
	ongoingHealthy := s.OngoingSampleCount < freeProxyUKCanaryOngoingSamples ||
		s.OngoingSuccessRate >= freeProxyUKCanaryMinimumSuccess
	eligible := ongoingHealthy &&
		s.SampleCount >= freeProxyUKCanaryMinimumSamples &&
		time.Duration(s.WindowMinutes*float64(time.Minute)) >= freeProxyUKCanaryMinimumWindow &&
		s.SuccessRate >= freeProxyUKCanaryMinimumSuccess
	if eligible {
		if s.CertifiedAt == nil {
			certifiedAt := now
			s.CertifiedAt = &certifiedAt
		}
		s.CanaryPassed = true
		s.State = "passed"
		s.ReadinessReason = ""
	} else if s.CanaryPassed {
		s.State = "passed"
		s.ReadinessReason = ""
	} else if !s.CanaryPassed {
		s.State = "collecting"
		switch {
		case s.SampleCount < freeProxyUKCanaryMinimumSamples:
			s.ReadinessReason = "collecting_uk_canary"
		case time.Duration(s.WindowMinutes*float64(time.Minute)) < freeProxyUKCanaryMinimumWindow:
			s.ReadinessReason = "collecting_uk_canary_window"
		default:
			s.State = "failed"
			s.ReadinessReason = "uk_canary_below_target"
		}
	}
	s.UpdatedAt = now
}

func percent(successes int, checks int) float64 {
	if checks <= 0 {
		return 0
	}
	return float64(successes) / float64(checks) * 100
}

func readFreeProxyUKCanaryStateContext(
	ctx context.Context,
	store *database.Store,
	now time.Time,
) (freeProxyUKCanaryState, error) {
	state := newFreeProxyUKCanaryState(now)
	raw, ok, err := store.GetSettingValueContext(ctx, freeProxyUKCanarySettingKey)
	if err != nil || !ok || strings.TrimSpace(raw) == "" {
		return state, err
	}
	return decodeFreeProxyUKCanaryState(raw, now)
}

func decodeFreeProxyUKCanaryState(raw string, now time.Time) (freeProxyUKCanaryState, error) {
	state := newFreeProxyUKCanaryState(now)
	if err := json.Unmarshal([]byte(raw), &state); err != nil {
		return newFreeProxyUKCanaryState(now), fmt.Errorf("decode UK canary state: %w", err)
	}
	if state.Revision != freeProxyValidationRevision || state.Region != freeProxyUKCanaryRegion {
		return newFreeProxyUKCanaryState(now), nil
	}
	// Preserve a certificate written by the pre-CertifiedAt format. Capacity
	// freshness and transport quality are independent: a restart or host sleep
	// may make every proxy stale, but it did not itself disprove the validated
	// request path.
	if state.CanaryPassed && state.CertifiedAt == nil {
		certifiedAt := state.UpdatedAt.UTC()
		if state.LastProbeAt != nil {
			certifiedAt = state.LastProbeAt.UTC()
		}
		state.CertifiedAt = &certifiedAt
	}
	state.recompute(now)
	return state, nil
}

func writeFreeProxyUKCanaryStateContext(
	ctx context.Context,
	store *database.Store,
	state freeProxyUKCanaryState,
) error {
	payload, err := json.Marshal(state)
	if err != nil {
		return err
	}
	return store.SetSettingValueContext(ctx, freeProxyUKCanarySettingKey, string(payload))
}

type freeProxyUKCanaryRunner struct {
	store     *database.Store
	validator freeProxyValidator

	mu       sync.Mutex
	probes   sync.WaitGroup
	state    freeProxyUKCanaryState
	inFlight map[string]bool
	claimed  map[string]time.Time
	slots    chan struct{}
}

func newFreeProxyUKCanaryRunner(
	store *database.Store,
	validator freeProxyValidator,
) *freeProxyUKCanaryRunner {
	return &freeProxyUKCanaryRunner{
		store:     store,
		validator: validator,
		state:     newFreeProxyUKCanaryState(time.Now()),
		inFlight:  make(map[string]bool),
		claimed:   make(map[string]time.Time),
		slots:     make(chan struct{}, freeProxyUKCanaryMaxConcurrency),
	}
}

func (r *freeProxyUKCanaryRunner) run(ctx context.Context) {
	for ctx.Err() == nil {
		leaseCtx, cancelLease := context.WithTimeout(ctx, 5*time.Second)
		release, acquired, err := r.store.TryAcquireFreeProxyUKCanaryLeaseContext(leaseCtx)
		cancelLease()
		if err != nil {
			log.Printf("UK free proxy canary lease failed: %v", err)
		} else if acquired {
			r.runWithLease(ctx)
			release()
			return
		}
		timer := time.NewTimer(30 * time.Second)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
	}
}

func (r *freeProxyUKCanaryRunner) runWithLease(ctx context.Context) {
	defer r.probes.Wait()
	loadCtx, cancelLoad := context.WithTimeout(ctx, freeProxyUKCanaryPersistenceLimit)
	state, err := readFreeProxyUKCanaryStateContext(loadCtx, r.store, time.Now())
	cancelLoad()
	if err != nil {
		log.Printf("UK free proxy canary state load failed: %v", err)
		state = newFreeProxyUKCanaryState(time.Now())
	}
	r.mu.Lock()
	r.state = state
	r.mu.Unlock()
	r.tick(ctx)
	ticker := time.NewTicker(freeProxyUKCanaryInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			r.tick(ctx)
		}
	}
}

func (r *freeProxyUKCanaryRunner) tick(ctx context.Context) {
	tickCtx, cancelTick := context.WithTimeout(ctx, freeProxyUKCanaryPersistenceLimit)
	defer cancelTick()
	enabled, err := r.store.FeatureGloballyEnabledContext(
		tickCtx,
		"free_proxy_pool",
		"free_proxy_enabled",
		false,
	)
	if err != nil {
		log.Printf("UK free proxy canary feature check failed: %v", err)
		return
	}
	regions, err := freeProxyRegionsContext(tickCtx, r.store)
	if err != nil {
		log.Printf("UK free proxy canary region check failed: %v", err)
		return
	}
	if !enabled || !stringSliceContains(regions, freeProxyUKCanaryRegion) {
		r.updateCapacity(time.Now(), 0, 1)
		return
	}
	minimum, err := settingIntContext(tickCtx, r.store, "free_proxy_min_active_per_region", 25)
	if err != nil {
		log.Printf("UK free proxy canary minimum load failed: %v", err)
		return
	}
	cohortSize := max(minimum, freeProxyUKCanaryMaxConcurrency)
	proxies, err := r.store.GetDiverseActiveFreeProxiesContext(
		tickCtx,
		freeProxyUKCanaryRegion,
		cohortSize,
	)
	if err != nil {
		log.Printf("UK free proxy canary proxy load failed: %v", err)
		return
	}
	canaryProbe := r.updateCapacity(time.Now(), len(proxies), minimum)
	if !canaryProbe {
		// A host sleep or a stalled discovery cycle can expire serving
		// freshness for an otherwise proven cohort. Revalidate those mature
		// entries directly so recovery does not deadlock on the fresh-only
		// canary query. These requests update health but are deliberately not
		// counted as canary evidence until safe capacity is restored.
		proxies, err = r.store.GetDiverseMatureFreeProxiesForRevalidationContext(
			tickCtx,
			freeProxyUKCanaryRegion,
			cohortSize,
		)
		if err != nil {
			log.Printf("UK free proxy recovery cohort load failed: %v", err)
			return
		}
		if len(proxies) == 0 {
			return
		}
	}
	select {
	case r.slots <- struct{}{}:
	default:
		return
	}
	maxLatencyMs, _ := settingIntContext(tickCtx, r.store, "free_proxy_max_latency_ms", 2500)
	failureThreshold, _ := settingIntContext(tickCtx, r.store, "free_proxy_failure_threshold", 3)
	quarantineMinutes, _ := settingIntContext(tickCtx, r.store, "free_proxy_quarantine_minutes", 30)
	claimDuration := freeProxyValidationTimeout(maxLatencyMs) + freeProxyWriteTimeout
	for range proxies {
		proxyURL, ok := r.claimProxy(proxies)
		if !ok {
			break
		}
		var claimedUntil time.Time
		var claimed bool
		var claimErr error
		if canaryProbe {
			claimedUntil, claimed, claimErr = r.store.TryClaimActiveFreeProxyForCanaryContext(
				tickCtx,
				proxyURL,
				freeProxyUKCanaryRegion,
				claimDuration,
			)
		} else {
			claimedUntil, claimed, claimErr = r.store.TryClaimMatureFreeProxyForRevalidationContext(
				tickCtx,
				proxyURL,
				freeProxyUKCanaryRegion,
				claimDuration,
			)
		}
		if claimErr != nil {
			log.Printf("UK free proxy canary claim failed: %v", claimErr)
			r.releaseLocalClaim(proxyURL)
			break
		}
		if !claimed {
			r.releaseLocalClaim(proxyURL)
			continue
		}
		r.probes.Add(1)
		go r.probe(
			ctx,
			proxyURL,
			claimedUntil,
			maxLatencyMs,
			failureThreshold,
			quarantineMinutes,
			canaryProbe,
		)
		return
	}
	<-r.slots
}

func (r *freeProxyUKCanaryRunner) updateCapacity(now time.Time, mature int, minimum int) bool {
	r.mu.Lock()
	r.state.observeCapacity(now, mature, minimum)
	state := r.state
	r.persistLocked(state)
	ready := state.CapacityReady
	r.mu.Unlock()
	return ready
}

func (r *freeProxyUKCanaryRunner) claimProxy(proxies []string) (string, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(proxies) == 0 {
		return "", false
	}
	available := make(map[string]bool, len(proxies))
	selected := ""
	var selectedAt time.Time
	for _, proxyURL := range proxies {
		if proxyURL == "" {
			continue
		}
		available[proxyURL] = true
		if r.inFlight[proxyURL] {
			continue
		}
		claimedAt := r.claimed[proxyURL]
		// The database already returns the cohort in quality/diversity order.
		// Preserve that order for never-used entries; once every entry has been
		// sampled, prefer the least recently used one.
		if selected == "" || claimedAt.Before(selectedAt) {
			selected = proxyURL
			selectedAt = claimedAt
		}
	}
	for proxyURL := range r.claimed {
		if !available[proxyURL] && !r.inFlight[proxyURL] {
			delete(r.claimed, proxyURL)
		}
	}
	if selected == "" {
		return "", false
	}
	r.inFlight[selected] = true
	r.claimed[selected] = time.Now()
	return selected, true
}

func (r *freeProxyUKCanaryRunner) releaseLocalClaim(proxyURL string) {
	r.mu.Lock()
	delete(r.inFlight, proxyURL)
	r.mu.Unlock()
}

func (r *freeProxyUKCanaryRunner) probe(
	ctx context.Context,
	proxyURL string,
	claimedUntil time.Time,
	maxLatencyMs int,
	failureThreshold int,
	quarantineMinutes int,
	recordCanaryEvidence bool,
) {
	defer func() {
		releaseCtx, cancelRelease := context.WithTimeout(context.Background(), 2*time.Second)
		if err := r.store.ReleaseFreeProxyCanaryClaimContext(
			releaseCtx,
			proxyURL,
			claimedUntil,
		); err != nil {
			log.Printf("UK free proxy canary claim release failed: %v", err)
		}
		cancelRelease()
		r.releaseLocalClaim(proxyURL)
		<-r.slots
		r.probes.Done()
	}()
	validationCtx, cancelValidation := context.WithTimeout(
		ctx,
		freeProxyValidationTimeout(maxLatencyMs),
	)
	result, validationErr := r.validator(
		validationCtx,
		proxyURL,
		freeProxyUKCanaryRegion,
		maxLatencyMs,
	)
	cancelValidation()
	if ctx.Err() != nil {
		return
	}
	success := validationErr == nil && result.StatusCode == 200
	writeCtx, cancelWrite := context.WithTimeout(ctx, freeProxyWriteTimeout)
	if success {
		if err := r.store.RecordFreeProxySuccessContext(
			writeCtx,
			proxyURL,
			freeProxyUKCanaryRegion,
			result.LatencyMs,
		); err != nil {
			log.Printf("UK free proxy canary success persistence failed: %v", err)
		}
	} else {
		message := "UK canary validation failed"
		if validationErr != nil {
			message = validationErr.Error()
		}
		if err := r.store.RecordFreeProxyFailureStageContext(
			writeCtx,
			proxyURL,
			freeProxyUKCanaryRegion,
			result.StatusCode,
			message,
			result.ErrorCode,
			string(result.Stage),
			failureThreshold,
			quarantineMinutes,
		); err != nil {
			log.Printf("UK free proxy canary failure persistence failed: %v", err)
		}
	}
	cancelWrite()
	if !recordCanaryEvidence {
		return
	}

	r.mu.Lock()
	r.state.recordProbe(time.Now(), success)
	state := r.state
	r.persistLocked(state)
	r.mu.Unlock()
}

func (r *freeProxyUKCanaryRunner) persistLocked(state freeProxyUKCanaryState) {
	writeCtx, cancelWrite := context.WithTimeout(context.Background(), freeProxyUKCanaryPersistenceLimit)
	defer cancelWrite()
	if err := writeFreeProxyUKCanaryStateContext(writeCtx, r.store, state); err != nil {
		log.Printf("UK free proxy canary state persistence failed: %v", err)
	}
}

func stringSliceContains(values []string, target string) bool {
	target = strings.ToLower(strings.TrimSpace(target))
	for _, value := range values {
		if strings.ToLower(strings.TrimSpace(value)) == target {
			return true
		}
	}
	return false
}
