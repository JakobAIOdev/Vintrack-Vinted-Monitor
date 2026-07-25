package scraper

import (
	"context"
	"errors"
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

type ClientPool struct {
	states          []*clientState
	index           int
	mu              sync.Mutex
	pm              *proxy.Manager
	domain          string
	trafficRecorder func(txBytes int64, rxBytes int64)
	requestTimeout  time.Duration
	requireProxy    bool
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

	now := time.Now()
	var best *clientState
	bestScore := float64(0)
	for _, state := range p.states {
		if excluded[state.client] || state.cooldownUntil.After(now) || state.replacing {
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
	now := time.Now()
	for offset := 0; offset < len(p.states); offset++ {
		index := (p.index + offset) % len(p.states)
		state := p.states[index]
		if state.cooldownUntil.After(now) || state.replacing {
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
		p.mu.Unlock()
		return
	}

	state.failures++
	shouldReplace := false
	cooldown := 2 * time.Second
	switch status {
	case 401, 403:
		cooldown = 30 * time.Second
		client.ResetWarm(p.domain)
	case 407:
		cooldown = 5 * time.Minute
		client.ResetWarm(p.domain)
	case 429:
		cooldown = 10 * time.Second
		client.ResetWarm(p.domain)
	default:
		if err != nil {
			cooldown = 5 * time.Second
			shouldReplace = state.failures >= 2
		}
	}
	shouldReplace = shouldReplace || shouldReplaceClientForStatus(status)
	state.cooldownUntil = time.Now().Add(cooldown)
	p.mu.Unlock()
	if shouldReplace {
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
		c, err := newPoolClient(p.pm, p.trafficRecorder, p.requestTimeout, p.requireProxy)
		p.mu.Lock()
		defer p.mu.Unlock()
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
