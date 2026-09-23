package main

import (
	"encoding/json"
	"math"
	"testing"
	"time"
)

func TestFreeProxyUKCanaryRequiresTwoCapacityObservations(t *testing.T) {
	now := time.Date(2026, time.September, 22, 12, 0, 0, 0, time.UTC)
	state := newFreeProxyUKCanaryState(now)
	state.observeCapacity(now, 10, 10)
	if state.CapacityReady || state.CapacityObservations != 1 {
		t.Fatalf("first observation = ready %v observations %d", state.CapacityReady, state.CapacityObservations)
	}
	state.observeCapacity(now.Add(8*time.Second), 10, 10)
	if !state.CapacityReady || state.CapacityObservations != 2 {
		t.Fatalf("second observation = ready %v observations %d", state.CapacityReady, state.CapacityObservations)
	}
	state.observeCapacity(now.Add(16*time.Second), 8, 10)
	if !state.CapacityReady {
		t.Fatal("capacity closed at the 80 percent hysteresis floor")
	}
	state.observeCapacity(now.Add(24*time.Second), 7, 10)
	if state.CapacityReady || state.CanaryPassed || state.ReadinessReason != "below_hysteresis_floor" {
		t.Fatalf("below floor state = %#v", state)
	}
}

func TestFreeProxyUKCanaryPassesAfterTwoHundredStableProbes(t *testing.T) {
	startedAt := time.Date(2026, time.September, 22, 12, 0, 0, 0, time.UTC)
	state := readyUKCanaryState(startedAt)
	for index := 0; index < 200; index++ {
		state.recordProbe(startedAt.Add(time.Duration(index)*9*time.Second), index >= 10)
	}
	if !state.CanaryPassed || state.State != "passed" {
		t.Fatalf("canary did not pass: %#v", state)
	}
	if state.SampleCount != 200 || math.Abs(state.SuccessRate-95) > 0.001 {
		t.Fatalf("samples/rate = %d/%.2f", state.SampleCount, state.SuccessRate)
	}
	if state.WindowMinutes < 29 {
		t.Fatalf("window = %.2f minutes, want at least 29", state.WindowMinutes)
	}
}

func TestFreeProxyUKCanaryFailsBelowTarget(t *testing.T) {
	startedAt := time.Date(2026, time.September, 22, 12, 0, 0, 0, time.UTC)
	state := readyUKCanaryState(startedAt)
	for index := 0; index < 200; index++ {
		state.recordProbe(startedAt.Add(time.Duration(index)*9*time.Second), index >= 11)
	}
	if state.CanaryPassed || state.State != "failed" || state.ReadinessReason != "uk_canary_below_target" {
		t.Fatalf("below-target state = %#v", state)
	}
}

func TestFreeProxyUKCanaryOngoingWindowClosesPassedPool(t *testing.T) {
	startedAt := time.Date(2026, time.September, 22, 12, 0, 0, 0, time.UTC)
	state := readyUKCanaryState(startedAt)
	for index := 0; index < 200; index++ {
		state.recordProbe(startedAt.Add(time.Duration(index)*9*time.Second), true)
	}
	if !state.CanaryPassed {
		t.Fatal("healthy initial canary did not pass")
	}
	failedAt := startedAt.Add(30 * time.Minute)
	for index := 0; index < 50; index++ {
		state.recordProbe(failedAt.Add(time.Duration(index)*8*time.Second), index >= 10)
	}
	if state.CanaryPassed || state.OngoingSuccessRate >= 95 {
		t.Fatalf("ongoing degradation did not close canary: %#v", state)
	}
	if state.CertifiedAt != nil {
		t.Fatalf("ongoing degradation retained certification: %#v", state.CertifiedAt)
	}
}

func TestFreeProxyUKCanaryCapacityLossPreservesCertification(t *testing.T) {
	startedAt := time.Date(2026, time.September, 22, 12, 0, 0, 0, time.UTC)
	state := readyUKCanaryState(startedAt)
	for index := 0; index < 200; index++ {
		state.recordProbe(startedAt.Add(time.Duration(index)*9*time.Second), true)
	}
	if !state.CanaryPassed || state.CertifiedAt == nil {
		t.Fatalf("healthy canary was not certified: %#v", state)
	}

	state.observeCapacity(startedAt.Add(31*time.Minute), 0, 10)
	if state.CapacityReady || !state.CanaryPassed || state.CertifiedAt == nil {
		t.Fatalf("capacity loss erased transport certification: %#v", state)
	}
	state.observeCapacity(startedAt.Add(32*time.Minute), 10, 10)
	state.observeCapacity(startedAt.Add(32*time.Minute+8*time.Second), 10, 10)
	if !state.CapacityReady || !state.CanaryPassed || state.State != "passed" {
		t.Fatalf("recovered capacity did not reuse certification: %#v", state)
	}
}

func TestFreeProxyUKCanaryMigratesLegacyPassedCertificate(t *testing.T) {
	now := time.Date(2026, time.September, 22, 12, 0, 0, 0, time.UTC)
	state := readyUKCanaryState(now)
	state.CanaryPassed = true
	state.State = "passed"
	state.UpdatedAt = now
	raw, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := decodeFreeProxyUKCanaryState(string(raw), now.Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if !decoded.CanaryPassed || decoded.CertifiedAt == nil {
		t.Fatalf("legacy passed state lost certification: %#v", decoded)
	}
}

func TestFreeProxyUKCanaryPrunesExpiredBuckets(t *testing.T) {
	startedAt := time.Date(2026, time.September, 22, 12, 0, 0, 0, time.UTC)
	state := readyUKCanaryState(startedAt)
	state.recordProbe(startedAt, true)
	state.recordProbe(startedAt.Add(31*time.Minute), true)
	if state.SampleCount != 1 || len(state.Buckets) != 1 {
		t.Fatalf("expired samples retained: samples=%d buckets=%d", state.SampleCount, len(state.Buckets))
	}
}

func TestFreeProxyUKCanaryRevisionMismatchResetsEvidence(t *testing.T) {
	now := time.Date(2026, time.September, 22, 12, 0, 0, 0, time.UTC)
	state := readyUKCanaryState(now)
	state.Revision = "old-request-path"
	state.recordProbe(now, true)
	raw, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := decodeFreeProxyUKCanaryState(string(raw), now.Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if decoded.Revision != freeProxyValidationRevision || decoded.SampleCount != 0 || decoded.CanaryPassed {
		t.Fatalf("revision mismatch retained evidence: %#v", decoded)
	}
}

func TestFreeProxyUKCanaryDoesNotClaimProxyTwice(t *testing.T) {
	runner := newFreeProxyUKCanaryRunner(nil, nil)
	first, ok := runner.claimProxy([]string{"http://one.invalid:1"})
	if !ok || first == "" {
		t.Fatal("first proxy was not claimed")
	}
	if _, ok := runner.claimProxy([]string{"http://one.invalid:1"}); ok {
		t.Fatal("in-flight proxy was claimed twice")
	}
}

func TestFreeProxyUKCanaryClaimsLeastRecentlyUsedProxy(t *testing.T) {
	runner := newFreeProxyUKCanaryRunner(nil, nil)
	first, ok := runner.claimProxy([]string{"http://two.invalid:1", "http://one.invalid:1"})
	if !ok || first != "http://two.invalid:1" {
		t.Fatalf("first claim = %q, want highest-ranked proxy", first)
	}
	runner.mu.Lock()
	delete(runner.inFlight, first)
	runner.mu.Unlock()
	second, ok := runner.claimProxy([]string{"http://one.invalid:1", "http://two.invalid:1"})
	if !ok || second != "http://one.invalid:1" {
		t.Fatalf("second claim = %q, want least recently used proxy", second)
	}
}

func readyUKCanaryState(now time.Time) freeProxyUKCanaryState {
	state := newFreeProxyUKCanaryState(now)
	state.observeCapacity(now, 10, 10)
	state.observeCapacity(now.Add(8*time.Second), 10, 10)
	return state
}
