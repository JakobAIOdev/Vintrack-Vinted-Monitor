package scraper

import (
	"context"
	"strings"
	"sync/atomic"
	"time"
)

// SellerEnrichmentScheduler keeps independent FIFO lanes per domain and proxy
// source. A noisy monitor/source can therefore consume at most every Nth slot.
type SellerEnrichmentScheduler struct {
	input           chan enrichmentJob
	backgroundInput chan enrichmentJob
	work            chan enrichmentJob
	oldestNanos     atomic.Int64
}

func NewSellerEnrichmentScheduler(capacity int, workers int) *SellerEnrichmentScheduler {
	if capacity < 1 {
		capacity = 4096
	}
	if workers < 1 {
		workers = 24
	}
	return &SellerEnrichmentScheduler{
		input:           make(chan enrichmentJob, capacity),
		backgroundInput: make(chan enrichmentJob, capacity),
		// Keep dispatch unbuffered so queued background work cannot be prefetched
		// into a hidden worker-sized buffer ahead of a newly detected alert.
		work: make(chan enrichmentJob),
	}
}

func (s *SellerEnrichmentScheduler) Submit(ctx context.Context, job enrichmentJob) bool {
	if job.enqueuedAt.IsZero() {
		job.enqueuedAt = time.Now()
	}
	input := s.input
	if job.backgroundOnly {
		input = s.backgroundInput
	}
	select {
	case input <- job:
		return true
	case <-ctx.Done():
		return false
	}
}

func (s *SellerEnrichmentScheduler) Work() <-chan enrichmentJob { return s.work }

func (s *SellerEnrichmentScheduler) QueueAge(now time.Time) time.Duration {
	nanos := s.oldestNanos.Load()
	if nanos == 0 {
		return 0
	}
	age := now.Sub(time.Unix(0, nanos))
	if age < 0 {
		return 0
	}
	return age
}

func (s *SellerEnrichmentScheduler) Run(ctx context.Context) {
	type lane struct {
		key  string
		jobs []enrichmentJob
	}
	lanes := make([]lane, 0, 16)
	laneIndex := make(map[string]int)
	nextLane := 0
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	defer close(s.work)

	refreshOldest := func() {
		var oldest time.Time
		for i := range lanes {
			if strings.HasPrefix(lanes[i].key, "strict-retry:") || strings.HasPrefix(lanes[i].key, "background:") {
				continue
			}
			if len(lanes[i].jobs) == 0 {
				continue
			}
			job := lanes[i].jobs[0]
			if oldest.IsZero() || job.enqueuedAt.Before(oldest) {
				oldest = job.enqueuedAt
			}
		}
		if oldest.IsZero() {
			s.oldestNanos.Store(0)
		} else {
			s.oldestNanos.Store(oldest.UnixNano())
		}
	}

	add := func(job enrichmentJob) {
		key := job.proxySource
		if job.enricher != nil {
			key = job.enricher.domain + ":" + key
		}
		if job.backgroundOnly {
			key = "background:" + key
		} else if job.strictAttempt > 0 {
			key = "strict-retry:" + key
		}
		if index, ok := laneIndex[key]; ok {
			insertAt := len(lanes[index].jobs)
			if !job.readyAt.IsZero() {
				for i, queued := range lanes[index].jobs {
					if !queued.readyAt.IsZero() && job.readyAt.Before(queued.readyAt) {
						insertAt = i
						break
					}
				}
			}
			lanes[index].jobs = append(lanes[index].jobs, enrichmentJob{})
			copy(lanes[index].jobs[insertAt+1:], lanes[index].jobs[insertAt:])
			lanes[index].jobs[insertAt] = job
		} else {
			laneIndex[key] = len(lanes)
			lanes = append(lanes, lane{key: key, jobs: []enrichmentJob{job}})
		}
		refreshOldest()
	}

	removeEmptyLane := func(index int) {
		delete(laneIndex, lanes[index].key)
		lanes = append(lanes[:index], lanes[index+1:]...)
		for i := index; i < len(lanes); i++ {
			laneIndex[lanes[i].key] = i
		}
		if len(lanes) == 0 {
			nextLane = 0
		} else if nextLane >= len(lanes) {
			nextLane = 0
		}
	}

	for {
		// Always ingest an already-waiting foreground job before choosing the
		// next worker assignment. Background producers use a separate bounded
		// input, so a restart seed burst cannot sit in front of a fresh alert.
		select {
		case job := <-s.input:
			add(job)
			continue
		default:
		}

		var next enrichmentJob
		var output chan enrichmentJob
		selectedLane := -1
		selectedPriority := 3
		now := time.Now()
		for offset := 0; offset < len(lanes); offset++ {
			index := (nextLane + offset) % len(lanes)
			if len(lanes[index].jobs) == 0 {
				continue
			}
			candidate := lanes[index].jobs[0]
			if !candidate.readyAt.IsZero() && candidate.readyAt.After(now) {
				continue
			}
			priority := enrichmentPriority(candidate)
			if priority >= selectedPriority {
				continue
			}
			next = candidate
			selectedLane = index
			selectedPriority = priority
			output = s.work
			if priority == 0 {
				break
			}
		}

		select {
		case <-ctx.Done():
			return
		case job := <-s.input:
			add(job)
		case job := <-s.backgroundInput:
			add(job)
		case output <- next:
			lanes[selectedLane].jobs = lanes[selectedLane].jobs[1:]
			nextLane = selectedLane + 1
			if len(lanes[selectedLane].jobs) == 0 {
				removeEmptyLane(selectedLane)
			}
			refreshOldest()
		case <-ticker.C:
		}
	}
}

func enrichmentPriority(job enrichmentJob) int {
	if job.backgroundOnly {
		return 2
	}
	if job.strictAttempt > 0 {
		return 1
	}
	return 0
}
