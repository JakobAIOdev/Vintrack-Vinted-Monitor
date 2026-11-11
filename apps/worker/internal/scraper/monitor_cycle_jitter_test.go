package scraper

import (
	"testing"
	"time"
)

func TestMonitorCycleJitterIsCentredOnZero(t *testing.T) {
	limit := time.Duration(monitorCycleJitterMS) * time.Millisecond
	var sum time.Duration
	sawNegative, sawPositive := false, false
	const samples = 20000
	for i := 0; i < samples; i++ {
		jitter := monitorCycleJitter()
		if jitter < -limit || jitter > limit {
			t.Fatalf("jitter %s outside ±%s", jitter, limit)
		}
		sawNegative = sawNegative || jitter < 0
		sawPositive = sawPositive || jitter > 0
		sum += jitter
	}
	if !sawNegative || !sawPositive {
		t.Fatal("jitter is one-sided")
	}
	if mean := sum / samples; mean < -3*time.Millisecond || mean > 3*time.Millisecond {
		t.Fatalf("mean jitter = %s, want about zero", mean)
	}
}
