package scraper

import (
	"fmt"
	"sync"

	"vintrack-worker/internal/proxy"

	http "github.com/bogdanfinn/fhttp"
)

type ClientPool struct {
	clients  []*Client
	index    int
	mu       sync.Mutex
	proxyMgr *proxy.Manager
}

func NewClientPool(pm *proxy.Manager, size int) *ClientPool {
	pool := &ClientPool{
		clients:  make([]*Client, 0, size),
		proxyMgr: pm,
	}

	for i := 0; i < size; i++ {
		client, err := pool.warmNewClient()
		if err != nil {
			fmt.Printf("Pool: failed to warm client %d: %v\n", i, err)
			continue
		}
		pool.clients = append(pool.clients, client)
	}

	if len(pool.clients) == 0 {
		client, err := NewRegionClient(pm.Next())
		if err == nil {
			pool.clients = append(pool.clients, client)
		}
	}

	fmt.Printf("Client pool ready: %d warm clients\n", len(pool.clients))
	return pool
}

func (p *ClientPool) warmNewClient() (*Client, error) {
	prx := p.proxyMgr.Next()
	client, err := NewRegionClient(prx)
	if err != nil {
		return nil, err
	}

	req, _ := http.NewRequest("GET", "https://www.vinted.de/", nil)
	req.Header = http.Header{
		"User-Agent":                {"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"},
		"Accept":                    {"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"},
		"Accept-Language":           {"de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7"},
		"Sec-Ch-Ua":                 {`"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"`},
		"Sec-Ch-Ua-Mobile":          {"?0"},
		"Sec-Ch-Ua-Platform":        {`"macOS"`},
		"Sec-Fetch-Dest":            {"document"},
		"Sec-Fetch-Mode":            {"navigate"},
		"Sec-Fetch-Site":            {"none"},
		"Sec-Fetch-User":            {"?1"},
		"Upgrade-Insecure-Requests": {"1"},
	}

	resp, err := client.HttpClient.Do(req)
	if err == nil {
		fmt.Printf("Pool warmup: status=%d\n", resp.StatusCode)
		resp.Body.Close()
	} else {
		fmt.Printf("Pool warmup error: %v\n", err)
	}

	return client, nil
}

func (p *ClientPool) Next() *Client {
	p.mu.Lock()
	defer p.mu.Unlock()

	if len(p.clients) == 0 {
		return nil
	}

	c := p.clients[p.index%len(p.clients)]
	p.index++
	return c
}

func (p *ClientPool) Replace(old *Client) *Client {
	p.mu.Lock()
	defer p.mu.Unlock()

	for i, c := range p.clients {
		if c == old {
			newClient, err := p.warmNewClient()
			if err == nil {
				p.clients[i] = newClient
				return newClient
			}
			break
		}
	}
	return old
}
