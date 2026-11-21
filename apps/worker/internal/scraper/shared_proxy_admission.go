package scraper

import (
	"strings"
	"sync"
	"time"
)

const maxSharedProxyAdmissionEntries = 32768

// A free exit belongs to the worker, not to an individual regional or seller
// pool. Recreating a client or using another regional host must not mint a new
// request budget for the same exit. Admission never reserves future queue slots.
type sharedProxyAdmission struct {
	mu       sync.Mutex
	next     map[string]sharedProxyAdmissionEntry
	rate     float64
	prunedAt time.Time
	admitted uint64
	minGap   time.Duration
}

type sharedProxyAdmissionEntry struct {
	next, admittedAt time.Time
}

type sharedProxyAdmissionMetric struct {
	MaxRequestsPerProxySecond float64 `json:"maxRequestsPerProxySecond"`
	TrackedExits              int     `json:"trackedExits"`
	AdmittedRequests          uint64  `json:"admittedRequests"`
	MinimumIntervalMS         int64   `json:"minimumIntervalMs"`
}

func (a *sharedProxyAdmission) snapshot() sharedProxyAdmissionMetric {
	a.mu.Lock()
	defer a.mu.Unlock()
	rate := a.rate
	if rate <= 0 {
		rate = 0.5
	}
	return sharedProxyAdmissionMetric{rate, len(a.next), a.admitted, a.minGap.Milliseconds()}
}

func (a *sharedProxyAdmission) setRate(rate float64) {
	a.mu.Lock()
	a.rate = rate
	a.mu.Unlock()
}

func (a *sharedProxyAdmission) available(proxyURL string, now time.Time) bool {
	if a == nil || proxyURL == "" {
		return true
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	return !a.next[strings.TrimSuffix(proxyURL, "/")].next.After(now)
}

func (a *sharedProxyAdmission) acquire(proxyURL string, now time.Time) bool {
	if a == nil || proxyURL == "" {
		return true
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	key := strings.TrimSuffix(proxyURL, "/")
	previous := a.next[key]
	if previous.next.After(now) {
		return false
	}
	if a.next == nil {
		a.next = make(map[string]sharedProxyAdmissionEntry)
	}
	if now.Sub(a.prunedAt) >= time.Minute ||
		(len(a.next) >= maxSharedProxyAdmissionEntries && now.Sub(a.prunedAt) >= time.Second) {
		for key, next := range a.next {
			if !next.next.After(now) {
				delete(a.next, key)
			}
		}
		a.prunedAt = now
	}
	if _, exists := a.next[key]; !exists && len(a.next) >= maxSharedProxyAdmissionEntries {
		return false
	}
	rate := a.rate
	if rate <= 0 {
		rate = 0.5
	}
	a.next[key] = sharedProxyAdmissionEntry{next: now.Add(time.Duration(float64(time.Second) / rate)), admittedAt: now}
	a.admitted++
	if !previous.admittedAt.IsZero() {
		gap := now.Sub(previous.admittedAt)
		if a.minGap == 0 || gap < a.minGap {
			a.minGap = gap
		}
	}
	return true
}
