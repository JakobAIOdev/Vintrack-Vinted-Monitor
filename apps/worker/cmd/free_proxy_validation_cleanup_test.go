package main

import (
	"context"
	"errors"
	"testing"
	"time"

	"vintrack-worker/internal/database"
	"vintrack-worker/internal/scraper"
)

type canceledValidationStore struct {
	writes     int
	released   int
	cleanupErr error
}

func (s *canceledValidationStore) RecordFreeProxySuccessContext(context.Context, string, string, int) error {
	s.writes++
	return nil
}
func (s *canceledValidationStore) RecordFreeProxyFailureStageContext(context.Context, string, string, int, string, string, string, int, int) error {
	s.writes++
	return nil
}
func (s *canceledValidationStore) RecordFreeProxyInfrastructureFailureContext(context.Context, string, string, int, string, string, string) error {
	s.writes++
	return nil
}
func (s *canceledValidationStore) ReleaseFreeProxyCheckClaimsContext(ctx context.Context, candidates []database.FreeProxyCandidate) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	s.released += len(candidates)
	return s.cleanupErr
}

func TestFreeProxyWaveReleasesCanceledChecksWithoutRecordingFailures(t *testing.T) {
	for _, beforeStart := range []bool{true, false} {
		t.Run(map[bool]string{true: "before_start", false: "during_validation"}[beforeStart], func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if beforeStart {
				cancel()
			}
			store := &canceledValidationStore{}
			stats := validateFreeProxyWaveWithValidator(ctx, store, []database.FreeProxyCandidate{
				{ProxyURL: "http://cancel.invalid:80", Region: "uk", ClaimedUntil: time.Now().Add(time.Minute)},
			}, time.Second, 2500, 3, 30, 1,
				func(context.Context, string, string, int) (scraper.FreeProxyValidationResult, error) {
					cancel()
					return scraper.FreeProxyValidationResult{}, context.Canceled
				})
			if stats.Checked != 0 || stats.Canceled != 1 || stats.PersistenceFailed != 0 || store.writes != 0 || store.released != 1 {
				t.Fatalf("canceled wave: stats=%+v store=%+v", stats, store)
			}
		})
	}
}

func TestFreeProxyWaveReportsClaimCleanupFailure(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	store := &canceledValidationStore{cleanupErr: errors.New("synthetic unavailable database")}
	stats := validateFreeProxyWaveWithValidator(ctx, store, []database.FreeProxyCandidate{{Region: "uk"}}, time.Second, 2500, 3, 30, 1, nil)
	if stats.PersistenceFailed != 1 || stats.Canceled != 1 {
		t.Fatalf("claim cleanup failure was hidden: %+v", stats)
	}
}
