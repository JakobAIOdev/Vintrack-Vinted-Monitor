package scraper

import "testing"

func TestFreePoolRateLimitBelowThresholdKeepsSession(t *testing.T) {
	policy := failurePolicyWithQuarantineThreshold(429, nil, 1, 3)
	if policy.resetWarmupSession || policy.replaceClient || policy.quarantine != 0 {
		t.Fatalf("isolated rate limit policy = %+v, want a plain cooldown that keeps the session", policy)
	}
	if denied := failurePolicyWithQuarantineThreshold(403, nil, 1, 3); !denied.resetWarmupSession {
		t.Fatal("access denial below the threshold must still discard the session")
	}
	if third := failurePolicyWithQuarantineThreshold(429, nil, 3, 3); !third.replaceClient || third.quarantine == 0 {
		t.Fatalf("third rate limit policy = %+v, want quarantine and replacement", third)
	}
}
