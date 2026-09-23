package scraper

import (
	"context"
	"testing"
	"time"
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
