package scraper

import (
	"context"
	"errors"
	"fmt"
	"log"
	"sync"
	"time"

	"vintrack-worker/internal/proxy"
)

type clientState struct {
	client        *Client
	ewmaLatencyMS float64
	failures      int
	inFlight      int
	cooldownUntil time.Time
	replacing     bool
}

type proxyQuarantine struct {
	until time.Time
	code  string
	label string
}

type proxyPoolWaitError struct {
	RetryAt    time.Time
	ErrorCode  string
	ProxyLabel string
}

func (e *proxyPoolWaitError) Error() string {
	if e == nil {
		return "all configured proxies are temporarily unavailable"
	}
	if e.RetryAt.IsZero() {
		return "all configured proxies are temporarily unavailable"
	}
	return fmt.Sprintf("all configured proxies are temporarily unavailable until %s", e.RetryAt.UTC().Format(time.RFC3339))
}

type ClientPool struct {
	states          []*clientState
	index           int
	mu              sync.Mutex
	pm              *proxy.Manager
	domain          string
	trafficRecorder func(txBytes int64, rxBytes int64)
	requestTimeout  time.Duration
	requireProxy    bool
	quarantined     map[string]proxyQuarantine
	reserved        map[string]bool
	resizing        bool
	maxInFlight     int
	now             func() time.Time
}

func NewClientPool(pm *proxy.Manager, domain string, size int, trafficRecorder func(txBytes int64, rxBytes int64)) *ClientPool {
	return NewClientPoolWithTimeout(pm, domain, size, trafficRecorder, 3*time.Second)
}

func NewClientPoolWithTimeout(pm *proxy.Manager, domain string, size int, trafficRecorder func(txBytes int64, rxBytes int64), requestTimeout time.Duration) *ClientPool {
	if size < 1 {
		size = 1
	}
	proxyCount := pm.Count()
	if size > proxyCount {
		size = proxyCount
	}
	if requestTimeout <= 0 {
		requestTimeout = 3 * time.Second
	}

	pool := &ClientPool{
		states:          make([]*clientState, 0, size),
		pm:              pm,
		domain:          domain,
		trafficRecorder: trafficRecorder,
		requestTimeout:  requestTimeout,
		requireProxy:    proxyCount > 0,
		quarantined:     make(map[string]proxyQuarantine),
		reserved:        make(map[string]bool),
		now:             time.Now,
	}

	var wg sync.WaitGroup
	var mu sync.Mutex
	for i := 0; i < size; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			c, err := newPoolClient(pm, trafficRecorder, requestTimeout, pool.requireProxy)
			if err != nil {
				log.Printf("pool: client creation failed: %v", err)
				return
			}
			mu.Lock()
			pool.states = append(pool.states, &clientState{client: c})
			mu.Unlock()
		}()
	}
	wg.Wait()

	if len(pool.states) == 0 {
		c, err := newPoolClient(pm, trafficRecorder, requestTimeout, pool.requireProxy)
		if err == nil {
			pool.states = append(pool.states, &clientState{client: c})
		}
	}

	return pool
}

func newPoolClient(pm *proxy.Manager, trafficRecorder func(txBytes int64, rxBytes int64), requestTimeout time.Duration, requireProxy bool) (*Client, error) {
	proxyURL := pm.Next()
	if requireProxy && proxyURL == "" {
		return nil, errors.New("proxy pool is empty")
	}
	return NewClientWithTimeout(proxyURL, trafficRecorder, requestTimeout)
}

func (p *ClientPool) Acquire(exclude *Client) *Client {
	excluded := make(map[*Client]bool, 1)
	if exclude != nil {
		excluded[exclude] = true
	}
	return p.AcquireExcluding(excluded)
}

func (p *ClientPool) AcquireExcluding(excluded map[*Client]bool) *Client {
	p.mu.Lock()
	defer p.mu.Unlock()

	now := p.currentTime()
	p.clearExpiredQuarantinesLocked(now)
	var best *clientState
	bestScore := float64(0)
	for _, state := range p.states {
		if excluded[state.client] ||
			state.cooldownUntil.After(now) ||
			state.replacing ||
			(p.maxInFlight > 0 && state.inFlight >= p.maxInFlight) ||
			p.proxyIsQuarantinedLocked(state.client.ProxyURL, now) {
			continue
		}
		latency := state.ewmaLatencyMS
		if latency <= 0 {
			latency = 750
		}
		score := latency + float64(state.failures*500) + float64(state.inFlight*1000)
		if best == nil || score < bestScore {
			best = state
			bestScore = score
		}
	}
	if best == nil {
		return nil
	}
	best.inFlight++
	return best.client
}

// AcquireRoundRobin spreads low-rate background traffic over all available
// sessions while still respecting health cooldowns. Latency-sensitive catalog
// traffic should continue to use Acquire.
func (p *ClientPool) AcquireRoundRobin() *Client {
	p.mu.Lock()
	defer p.mu.Unlock()

	if len(p.states) == 0 {
		return nil
	}
	now := p.currentTime()
	p.clearExpiredQuarantinesLocked(now)
	for offset := 0; offset < len(p.states); offset++ {
		index := (p.index + offset) % len(p.states)
		state := p.states[index]
		if state.cooldownUntil.After(now) ||
			state.replacing ||
			(p.maxInFlight > 0 && state.inFlight >= p.maxInFlight) ||
			p.proxyIsQuarantinedLocked(state.client.ProxyURL, now) {
			continue
		}
		state.inFlight++
		p.index = (index + 1) % len(p.states)
		return state.client
	}
	return nil
}

func (p *ClientPool) Report(client *Client, status int, latency time.Duration, err error) {
	if client == nil {
		return
	}

	p.mu.Lock()
	state := p.findState(client)
	if state == nil {
		p.mu.Unlock()
		return
	}
	if state.inFlight > 0 {
		state.inFlight--
	}

	if errors.Is(err, context.Canceled) {
		p.mu.Unlock()
		return
	}
	if err == nil && status == 200 {
		measured := float64(latency.Milliseconds())
		if measured < 1 {
			measured = 1
		}
		if state.ewmaLatencyMS == 0 {
			state.ewmaLatencyMS = measured
		} else {
			state.ewmaLatencyMS = state.ewmaLatencyMS*0.75 + measured*0.25
		}
		state.failures = 0
		state.cooldownUntil = time.Time{}
		delete(p.quarantined, client.ProxyURL)
		p.mu.Unlock()
		return
	}

	state.failures++
	policy := failurePolicy(status, err, state.failures)
	if policy.resetWarmupSession {
		client.ResetWarm(p.domain)
	}
	now := p.currentTime()
	state.cooldownUntil = now.Add(policy.cooldown)
	if policy.quarantine > 0 && client.ProxyURL != "" {
		until := now.Add(policy.quarantine)
		p.ensureMapsLocked()
		p.quarantined[client.ProxyURL] = proxyQuarantine{
			until: until,
			code:  policy.code,
			label: client.ProxyLabel(),
		}
		state.cooldownUntil = until
	}
	p.mu.Unlock()
	if policy.replaceClient {
		p.Replace(client)
	}
}

func (p *ClientPool) Replace(bad *Client) {
	if p.pm == nil {
		return
	}

	p.mu.Lock()
	state := p.findState(bad)
	if state == nil || state.replacing {
		p.mu.Unlock()
		return
	}
	state.replacing = true
	p.mu.Unlock()

	go func(target *clientState) {
		proxyURL, err := p.reserveReplacementProxy(target)
		if err != nil {
			p.mu.Lock()
			target.replacing = false
			p.mu.Unlock()
			log.Printf("pool: no healthy replacement for %s: %v", p.domain, err)
			return
		}

		c, err := NewClientWithTimeout(proxyURL, p.trafficRecorder, p.requestTimeout)
		p.mu.Lock()
		defer p.mu.Unlock()
		delete(p.reserved, proxyURL)
		if err != nil {
			target.replacing = false
			log.Printf("pool: replace failed: %v", err)
			return
		}
		target.client = c
		target.ewmaLatencyMS = 0
		target.failures = 0
		target.inFlight = 0
		target.cooldownUntil = time.Time{}
		target.replacing = false
	}(state)
}

func (p *ClientPool) reserveReplacementProxy(target *clientState) (string, error) {
	p.mu.Lock()
	defer p.mu.Unlock()

	p.ensureMapsLocked()
	now := p.currentTime()
	p.clearExpiredQuarantinesLocked(now)
	excluded := make(map[string]bool, len(p.quarantined)+len(p.states)+len(p.reserved))
	for proxyURL := range p.quarantined {
		excluded[proxyURL] = true
	}
	for proxyURL := range p.reserved {
		excluded[proxyURL] = true
	}
	for _, state := range p.states {
		if state != target && state.client != nil && state.client.ProxyURL != "" {
			excluded[state.client.ProxyURL] = true
		}
	}

	proxyURL := p.pm.NextExcluding(excluded)
	if proxyURL == "" {
		return "", errors.New("all configured proxies are active or quarantined")
	}
	p.reserved[proxyURL] = true
	return proxyURL, nil
}

func (p *ClientPool) WaitError() *proxyPoolWaitError {
	if p == nil || p.pm == nil {
		return nil
	}

	p.mu.Lock()
	defer p.mu.Unlock()
	p.ensureMapsLocked()
	now := p.currentTime()
	p.clearExpiredQuarantinesLocked(now)
	excluded := make(map[string]bool, len(p.quarantined))
	var earliest proxyQuarantine
	for proxyURL, quarantine := range p.quarantined {
		excluded[proxyURL] = true
		if earliest.until.IsZero() || quarantine.until.Before(earliest.until) {
			earliest = quarantine
		}
	}
	if len(excluded) == 0 || p.pm.CountAvailable(excluded) > 0 {
		return nil
	}
	return &proxyPoolWaitError{
		RetryAt: earliest.until, ErrorCode: earliest.code, ProxyLabel: earliest.label,
	}
}

func (p *ClientPool) currentTime() time.Time {
	if p.now != nil {
		return p.now()
	}
	return time.Now()
}

// SetMaxInFlightPerClient bounds concurrent work sent through one exit IP.
// A zero value keeps the historical unlimited behavior for private pools.
func (p *ClientPool) SetMaxInFlightPerClient(limit int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.maxInFlight = max(0, limit)
}

// EnsureSize expands a live pool when its proxy manager gains healthy entries.
// This is especially important while a free pool recovers from zero: monitors
// may start with one proxy and must not remain pinned to that one proxy forever.
func (p *ClientPool) EnsureSize(size int) {
	if p == nil || p.pm == nil || size <= 0 {
		return
	}
	if proxyCount := p.pm.Count(); size > proxyCount {
		size = proxyCount
	}
	if size <= 0 {
		return
	}

	p.mu.Lock()
	if p.resizing || len(p.states) >= size {
		p.mu.Unlock()
		return
	}
	p.resizing = true
	p.mu.Unlock()

	defer func() {
		p.mu.Lock()
		p.resizing = false
		p.mu.Unlock()
	}()

	failed := make(map[string]bool)
	for {
		p.mu.Lock()
		if len(p.states) >= size {
			p.mu.Unlock()
			return
		}
		p.ensureMapsLocked()
		excluded := make(map[string]bool, len(p.states)+len(p.reserved)+len(failed))
		for _, state := range p.states {
			if state.client != nil && state.client.ProxyURL != "" {
				excluded[state.client.ProxyURL] = true
			}
		}
		for proxyURL := range p.reserved {
			excluded[proxyURL] = true
		}
		for proxyURL := range failed {
			excluded[proxyURL] = true
		}
		proxyURL := p.pm.NextExcluding(excluded)
		if proxyURL == "" {
			p.mu.Unlock()
			return
		}
		p.reserved[proxyURL] = true
		p.mu.Unlock()

		client, err := NewClientWithTimeout(proxyURL, p.trafficRecorder, p.requestTimeout)

		p.mu.Lock()
		delete(p.reserved, proxyURL)
		if err == nil {
			p.states = append(p.states, &clientState{client: client})
		} else {
			failed[proxyURL] = true
		}
		p.mu.Unlock()
	}
}

func (p *ClientPool) ensureMapsLocked() {
	if p.quarantined == nil {
		p.quarantined = make(map[string]proxyQuarantine)
	}
	if p.reserved == nil {
		p.reserved = make(map[string]bool)
	}
}

func (p *ClientPool) clearExpiredQuarantinesLocked(now time.Time) {
	for proxyURL, quarantine := range p.quarantined {
		if !quarantine.until.After(now) {
			delete(p.quarantined, proxyURL)
		}
	}
}

func (p *ClientPool) proxyIsQuarantinedLocked(proxyURL string, now time.Time) bool {
	quarantine, ok := p.quarantined[proxyURL]
	return ok && quarantine.until.After(now)
}

func (p *ClientPool) findState(client *Client) *clientState {
	for _, state := range p.states {
		if state.client == client {
			return state
		}
	}
	return nil
}

func (p *ClientPool) Size() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.states)
}
