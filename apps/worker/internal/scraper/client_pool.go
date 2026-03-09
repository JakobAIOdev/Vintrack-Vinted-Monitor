package scraper

import (
	"log"
	"sync"

	"vintrack-worker/internal/proxy"
)

type ClientPool struct {
	clients []*Client
	index   int
	mu      sync.Mutex
	pm      *proxy.Manager
	domain  string
}

func NewClientPool(pm *proxy.Manager, domain string, size int) *ClientPool {
	if size < 1 {
		size = 1
	}
	if size > pm.Count() {
		size = pm.Count()
	}

	pool := &ClientPool{
		clients: make([]*Client, 0, size),
		pm:      pm,
		domain:  domain,
	}

	var wg sync.WaitGroup
	var mu sync.Mutex
	for i := 0; i < size; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			c, err := NewClient(pm.Next())
			if err != nil {
				log.Printf("pool: client creation failed: %v", err)
				return
			}
			if err := c.WarmUpRegion(domain); err != nil {
				log.Printf("pool: warmup warning: %v", err)
			}
			mu.Lock()
			pool.clients = append(pool.clients, c)
			mu.Unlock()
		}()
	}
	wg.Wait()

	if len(pool.clients) == 0 {
		c, err := NewClient(pm.Next())
		if err == nil {
			_ = c.WarmUpRegion(domain)
			pool.clients = append(pool.clients, c)
		}
	}

	return pool
}

func (p *ClientPool) Next() *Client {
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.clients) == 0 {
		return nil
	}
	c := p.clients[p.index]
	p.index = (p.index + 1) % len(p.clients)
	return c
}

func (p *ClientPool) RaceClients(n int) []*Client {
	p.mu.Lock()
	defer p.mu.Unlock()
	if n > len(p.clients) {
		n = len(p.clients)
	}
	result := make([]*Client, n)
	for i := 0; i < n; i++ {
		result[i] = p.clients[(p.index+i)%len(p.clients)]
	}
	p.index = (p.index + n) % len(p.clients)
	return result
}

func (p *ClientPool) Replace(bad *Client) {
	go func() {
		c, err := NewClient(p.pm.Next())
		if err != nil {
			log.Printf("pool: replace failed: %v", err)
			return
		}
		_ = c.WarmUpRegion(p.domain)

		p.mu.Lock()
		defer p.mu.Unlock()
		for i, existing := range p.clients {
			if existing == bad {
				p.clients[i] = c
				return
			}
		}
	}()
}

func (p *ClientPool) Size() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.clients)
}
