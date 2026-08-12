package telegram

import (
	"context"
	"testing"
	"time"
)

func TestTokenBucketServesBurstImmediatelyThenPaces(t *testing.T) {
	bucket := &tokenBucket{interval: 40 * time.Millisecond, burst: 120 * time.Millisecond}
	now := time.Now()

	// A burst of three intervals covers three backlogged slots plus the one due
	// right now, so four callers are served without waiting.
	for i := 0; i < 4; i++ {
		if delay := bucket.reserve(now); delay != 0 {
			t.Fatalf("burst slot %d should be immediate, got %s", i, delay)
		}
	}

	delay := bucket.reserve(now)
	if delay <= 0 || delay > 40*time.Millisecond {
		t.Fatalf("expected a delay within one interval, got %s", delay)
	}
}

func TestTokenBucketReservationsDoNotOverlap(t *testing.T) {
	bucket := &tokenBucket{interval: 40 * time.Millisecond, burst: 0}
	now := time.Now()

	first := bucket.reserve(now)
	second := bucket.reserve(now)
	if second-first != 40*time.Millisecond {
		t.Fatalf("consecutive reservations must be one interval apart, got %s and %s", first, second)
	}
}

func TestTokenBucketPauseHoldsBackEveryCaller(t *testing.T) {
	bucket := &tokenBucket{interval: time.Millisecond, burst: 10 * time.Millisecond}
	bucket.pause(2 * time.Second)

	delay := bucket.reserve(time.Now())
	if delay < 1500*time.Millisecond {
		t.Fatalf("a bot-wide pause must hold every chat back, got %s", delay)
	}
}

func TestTokenBucketPauseNeverShortensAnExistingPause(t *testing.T) {
	bucket := &tokenBucket{interval: time.Millisecond, burst: 0}
	bucket.pause(5 * time.Second)
	bucket.pause(time.Second)

	if delay := bucket.reserve(time.Now()); delay < 4*time.Second {
		t.Fatalf("the longer pause must win, got %s", delay)
	}
}

func TestTokenBucketWaitHonoursContextCancellation(t *testing.T) {
	bucket := &tokenBucket{interval: time.Second, burst: 0}
	bucket.pause(30 * time.Second)

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()

	started := time.Now()
	if err := bucket.wait(ctx); err == nil {
		t.Fatal("expected wait to fail once the attempt deadline passed")
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("wait should return with the context, not the reservation, took %s", elapsed)
	}
}

func TestTokenBucketResetClearsPacingState(t *testing.T) {
	bucket := &tokenBucket{interval: time.Second, burst: 0}
	bucket.pause(30 * time.Second)
	bucket.reset()

	if delay := bucket.reserve(time.Now()); delay != 0 {
		t.Fatalf("reset should clear the pause, got %s", delay)
	}
}
