package scraper

import (
	"context"
	"testing"
	"time"

	"vintrack-worker/internal/proxy"
)

func TestFreeProxyPacerHalvesCapacityOnPressure(t *testing.T) {
	pacer := newFreeProxyRegionPacer("de", freeProxyPacingPolicy{
		Enabled: true, Regions: []string{"de"}, MaxRequestsPerProxySecond: 0.5, MaxAdmissionDelayMS: 10,
	})
	pacer.windowStarted = time.Now().Add(-61 * time.Second)
	pacer.requested = 100
	pacer.admitted = 100
	pacer.outcomes = 100
	pacer.successes = 89
	pacer.rotateLocked(time.Now(), 50)
	if pacer.capacityFactor != 0.5 {
		t.Fatalf("capacity factor = %v, want 0.5", pacer.capacityFactor)
	}
}

func TestFreeProxyPacerRecoversAfterFiveHealthyWindows(t *testing.T) {
	pacer := newFreeProxyRegionPacer("fr", freeProxyPacingPolicy{
		Enabled: true, Regions: []string{"fr"}, MaxRequestsPerProxySecond: 0.5, MaxAdmissionDelayMS: 10,
	})
	pacer.capacityFactor = 0.5
	for range 5 {
		pacer.windowStarted = time.Now().Add(-61 * time.Second)
		pacer.requested = 100
		pacer.admitted = 100
		pacer.outcomes = 100
		pacer.successes = 100
		pacer.rotateLocked(time.Now(), 50)
	}
	if pacer.capacityFactor != 1 {
		t.Fatalf("capacity factor = %v, want 1", pacer.capacityFactor)
	}
}

func TestFreeProxyPacerDoesNotPenalizeIdleWindow(t *testing.T) {
	pacer := newFreeProxyRegionPacer("de", freeProxyPacingPolicy{
		Enabled: true, Regions: []string{"de"}, MaxRequestsPerProxySecond: 0.5, MaxAdmissionDelayMS: 10,
	})
	pacer.capacityFactor = 0.5
	pacer.windowStarted = time.Now().Add(-61 * time.Second)
	pacer.rotateLocked(time.Now(), 50)
	if pacer.capacityFactor != 0.5 {
		t.Fatalf("capacity factor = %v, want unchanged 0.5", pacer.capacityFactor)
	}
}

func TestFreeProxyPacingPolicyIsCanaryScoped(t *testing.T) {
	policy := freeProxyPacingPolicy{Enabled: true, Regions: []string{"de", "fr"}}
	if !policy.applies("DE") || policy.applies("it") {
		t.Fatalf("unexpected canary scope")
	}
}

func TestFreeProxyPacerKeepsPerMonitorAdmissionFair(t *testing.T) {
	pacer := newFreeProxyRegionPacer("uk", freeProxyPacingPolicy{
		Enabled: true, Regions: []string{"uk"}, MaxRequestsPerProxySecond: 10, MaxAdmissionDelayMS: 0,
	})
	if _, admitted := pacer.admit(context.Background(), 1, time.Second, 10); !admitted {
		t.Fatal("first monitor was not admitted")
	}
	if _, admitted := pacer.admit(context.Background(), 1, time.Second, 10); admitted {
		t.Fatal("same monitor received a second permit before its desired interval")
	}
	pacer.nextAdmission = time.Time{}
	if _, admitted := pacer.admit(context.Background(), 2, time.Second, 10); !admitted {
		t.Fatal("second monitor was starved by first monitor")
	}
}

func TestFreeProxyPacerTreatsBelowNinetyFivePercentAsPressure(t *testing.T) {
	pacer := newFreeProxyRegionPacer("uk", freeProxyPacingPolicy{
		Enabled: true, Regions: []string{"uk"}, MaxRequestsPerProxySecond: 0.5, MaxAdmissionDelayMS: 10,
	})
	pacer.windowStarted = time.Now().Add(-61 * time.Second)
	pacer.requested = 100
	pacer.admitted = 100
	pacer.outcomes = 100
	pacer.successes = 94
	pacer.rotateLocked(time.Now(), 50)
	if pacer.capacityFactor != 0.5 {
		t.Fatalf("capacity factor at 94%% success = %v, want 0.5", pacer.capacityFactor)
	}
}

func TestFreeProxyRuntimeMetricsKeepLastCompletedWindowWhileIdle(t *testing.T) {
	pacer := newFreeProxyRegionPacer("uk", freeProxyPacingPolicy{
		Enabled: true, Regions: []string{"uk"}, MaxRequestsPerProxySecond: 0.5, MaxAdmissionDelayMS: 10,
	})
	pacer.windowStarted = time.Now().Add(-61 * time.Second)
	pacer.requested = 100
	pacer.admitted = 100
	pacer.outcomes = 100
	pacer.successes = 97
	pacer.rotateLocked(time.Now(), 50)
	metric := pacer.snapshot(50)
	if metric.SuccessRate != 97 || metric.ExecutedRequests != 100 {
		t.Fatalf("idle metric = %#v, want last completed 97%%/100 window", metric)
	}
}

func TestLimitedFreePoolForcesBoundedPacingWithoutChangingNormalPolicy(t *testing.T) {
	policy := freeProxyPacingPolicy{MaxRequestsPerProxySecond: 2, MaxAdmissionDelayMS: 1500}
	limited := policy.forPool("uk", true)
	if !limited.applies("uk") || limited.applies("de") || limited.MaxRequestsPerProxySecond != 0.5 || limited.MaxAdmissionDelayMS != 30_000 {
		t.Fatalf("unsafe limited policy: %+v", limited)
	}
	if policy.Enabled || policy.forPool("uk", false).applies("uk") {
		t.Fatal("limited operation changed the configured normal policy")
	}
	policy.MaxRequestsPerProxySecond = 0.1
	if got := policy.forPool("uk", true).MaxRequestsPerProxySecond; got != 0.1 {
		t.Fatalf("limited operation raised a stricter rate cap: %v", got)
	}
}

func TestLimitedFreePoolPacerReturnsToNormalAfterRecovery(t *testing.T) {
	engine := &Engine{freePacers: make(map[string]*freeProxyRegionPacer)}
	if engine.freeProxyPacer("uk", true) == nil {
		t.Fatal("limited pool did not install admission control")
	}
	if engine.freeProxyPacer("uk", false) != nil || len(engine.freePacers) != 0 {
		t.Fatal("recovered pool retained automatic limited-mode pacing")
	}
}

func TestWorkerPolicyRefreshCannotDisableLimitedPoolAdmissionControl(t *testing.T) {
	pools := proxy.NewRegionPools()
	pools.Publish("uk", "http://limited.invalid:80", "limited", 1, "below_minimum_mature", 0)
	engine := &Engine{freeProxy: pools, freePacers: make(map[string]*freeProxyRegionPacer)}
	pacer := engine.freeProxyPacer("uk", true)
	engine.applyFreeProxyPacingPolicy(freeProxyPacingPolicy{})
	if rate, delay := pacer.limits(); rate != 0.5 || delay != 30*time.Second || engine.freePacers["uk"] != pacer {
		t.Fatalf("policy refresh disabled safe limited operation: rate=%v delay=%s", rate, delay)
	}
	pools.Publish("uk", "http://limited.invalid:80", "ready", 10, "", 2)
	engine.applyFreeProxyPacingPolicy(freeProxyPacingPolicy{})
	if len(engine.freePacers) != 0 {
		t.Fatal("normal operation retained forced pacing after policy refresh")
	}
}

func TestLimitedFreePoolCanQueueBeyondNormalAdmissionDeadline(t *testing.T) {
	pacer := newFreeProxyRegionPacer("uk", freeProxyPacingPolicy{}.forPool("uk", true))
	pacer.nextAdmission = time.Now().Add(1600 * time.Millisecond)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	wait, admitted := pacer.admit(ctx, 1, time.Second, 8)
	if !admitted || wait < 1500*time.Millisecond || wait > 30*time.Second {
		t.Fatalf("bounded limited-mode queue rejected a monitor: wait=%s admitted=%v", wait, admitted)
	}

	pacer.nextAdmission = time.Now().Add(10 * time.Second)
	canceledCtx, stop := context.WithCancel(context.Background())
	stop()
	started := time.Now()
	if _, admitted := pacer.admit(canceledCtx, 2, time.Second, 8); admitted || time.Since(started) > 200*time.Millisecond {
		t.Fatal("stopping a monitor remained blocked behind the admission queue")
	}
}

func TestFreeProxyPacerDoesNotReduceHealthyCapacityBecauseDemandWaits(t *testing.T) {
	for _, outcomes := range []uint64{0, 100} {
		pacer := newFreeProxyRegionPacer("uk", freeProxyPacingPolicy{}.forPool("uk", true))
		pacer.windowStarted = time.Now().Add(-61 * time.Second)
		pacer.requested, pacer.admitted = 100, 100
		pacer.outcomes, pacer.successes = outcomes, outcomes
		pacer.poolWaits = 20
		pacer.rotateLocked(time.Now(), 8)
		if pacer.capacityFactor != 1 {
			t.Fatalf("healthy admission demand reduced capacity with %d outcomes: %v", outcomes, pacer.capacityFactor)
		}
	}
}
