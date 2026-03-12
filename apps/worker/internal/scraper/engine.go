package scraper

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"vintrack-worker/internal/database"
	"vintrack-worker/internal/discord"
	"vintrack-worker/internal/model"
	"vintrack-worker/internal/proxy"

	http "github.com/bogdanfinn/fhttp"
)

const maxAPIResponseBytes = 2 * 1024 * 1024 // 2 MB

type Engine struct {
	db           *database.Store
	serverProxy  *proxy.Manager
	enrichSeller bool
	poolSize     int
	pools        map[string]*ClientPool
	poolsMu      sync.RWMutex
	scrapers     map[string]*HTMLScraper
	scrapersMu   sync.RWMutex
}

func NewEngine(db *database.Store, pm *proxy.Manager) *Engine {
	enrich := os.Getenv("ENRICH_SELLER_INFO") != "false"
	poolSize := getEnvInt("CLIENT_POOL_SIZE", 5)
	log.Printf("Seller enrichment (region/rating): %v, client pool size: %d", enrich, poolSize)
	return &Engine{
		db:           db,
		serverProxy:  pm,
		enrichSeller: enrich,
		poolSize:     poolSize,
		pools:        make(map[string]*ClientPool),
		scrapers:     make(map[string]*HTMLScraper),
	}
}

func (e *Engine) GetOrCreateScraper(pm *proxy.Manager, domain string, proxySource string) *HTMLScraper {
	key := fmt.Sprintf("%s:%s", domain, proxySource)

	e.scrapersMu.RLock()
	s, ok := e.scrapers[key]
	e.scrapersMu.RUnlock()

	if ok {
		return s
	}

	e.scrapersMu.Lock()
	defer e.scrapersMu.Unlock()

	if s, ok = e.scrapers[key]; ok {
		return s
	}

	log.Printf("Creating new HTML scraper for %s (source: %s)", domain, proxySource)
	s = NewHTMLScraper(pm, e.db, domain, e.poolSize)
	e.scrapers[key] = s
	return s
}

func (e *Engine) GetOrCreatePool(pm *proxy.Manager, domain string, proxySource string) *ClientPool {
	key := fmt.Sprintf("%s:%s", domain, proxySource)

	e.poolsMu.RLock()
	pool, ok := e.pools[key]
	e.poolsMu.RUnlock()

	if ok {
		return pool
	}

	e.poolsMu.Lock()
	defer e.poolsMu.Unlock()

	// Double check
	if pool, ok = e.pools[key]; ok {
		return pool
	}

	log.Printf("Creating new client pool for %s (source: %s)", domain, proxySource)
	pool = NewClientPool(pm, domain, e.poolSize)
	e.pools[key] = pool
	return pool
}

func (e *Engine) getProxyManager(m model.Monitor) *proxy.Manager {
	if m.Proxies.Valid && m.Proxies.String != "" {
		return proxy.FromString(m.Proxies.String)
	}
	return e.serverProxy
}

func (e *Engine) MonitorTask(ctx context.Context, m model.Monitor) {
	pm := e.getProxyManager(m)
	domain := model.RegionDomain(m.Region)

	proxySource := "server"
	if m.ProxyGroupName.Valid && m.ProxyGroupName.String != "" {
		proxySource = fmt.Sprintf("group:%s", m.ProxyGroupName.String)
	}

	if pm.Count() == 0 {
		log.Printf("[%d] ❌ ERROR: no valid proxies available (source: %s) — skipping monitor", m.ID, proxySource)
		e.db.UpdateMonitorHealth(model.MonitorHealth{
			MonitorID:       m.ID,
			ConsecutiveErrs: -1,
			LastError:       "no valid proxies available",
			UpdatedAt:       time.Now().UTC().Format(time.RFC3339),
		})
		return
	}
	log.Printf("[%d] proxy source: %s (%d proxies)", m.ID, proxySource, pm.Count())

	pool := e.GetOrCreatePool(pm, domain, proxySource)
	log.Printf("[%d] using client pool: %d clients", m.ID, pool.Size())

	var scraper *HTMLScraper
	if e.enrichSeller {
		scraper = e.GetOrCreateScraper(pm, domain, proxySource)
	}

	apiURL := BuildVintedURL(m)

	interval := getEnvInt("CHECK_INTERVAL_MS", 500)
	maxConsecutiveErrors := getEnvInt("MAX_CONSECUTIVE_ERRORS", 50)
	raceFetchers := getEnvInt("RACE_FETCHERS", 2)
	consecutiveErrors := 0
	checks := 0
	var totalErrors int64

	log.Printf("[%d] started | query=%q | race=%d | url=%s", m.ID, m.Query, raceFetchers, apiURL)

	reportHealth := func(lastErr string) {
		h := model.MonitorHealth{
			MonitorID:       m.ID,
			TotalChecks:     int64(checks),
			TotalErrors:     totalErrors,
			ConsecutiveErrs: consecutiveErrors,
			UpdatedAt:       time.Now().UTC().Format(time.RFC3339),
		}
		if lastErr != "" {
			h.LastError = lastErr
		}
		e.db.UpdateMonitorHealth(h)
	}

	defer func() {
		e.db.ClearMonitorHealth(m.ID)
	}()

	intervalDuration := time.Duration(interval) * time.Millisecond

	for {
		cycleStart := time.Now()

		select {
		case <-ctx.Done():
			log.Printf("[%d] stopped gracefully", m.ID)
			return
		default:
		}

		checks++

		if checks%20 == 0 {
			if updated, err := e.db.GetMonitorByID(m.ID); err == nil {
				if m.Status != "active" {
					log.Printf("[%d] paused via dashboard", m.ID)
					return
				}
				if updated.Query != m.Query || updated.Region != m.Region ||
					(updated.Proxies.Valid != m.Proxies.Valid) ||
					(updated.Proxies.Valid && updated.Proxies.String != m.Proxies.String) {
					log.Printf("[%d] config changed (query/region/proxy), will be restarted by sync loop", m.ID)
					return
				}
				m.DiscordWebhook = updated.DiscordWebhook
				m.WebhookActive = updated.WebhookActive
				m.Status = updated.Status
			}
		}

		type fetchResult struct {
			items  []model.VintedItem
			status int
			err    error
			client *Client
		}

		clients := pool.RaceClients(raceFetchers)
		resultCh := make(chan fetchResult, len(clients))

		for _, c := range clients {
			go func(cl *Client) {
				items, status, err := e.fetchCatalog(ctx, cl, apiURL, domain)
				resultCh <- fetchResult{items, status, err, cl}
			}(c)
		}

		var items []model.VintedItem
		gotSuccess := false
		remaining := len(clients)

		timeout := time.NewTimer(3 * time.Second)
	collectLoop:
		for remaining > 0 {
			select {
			case r := <-resultCh:
				remaining--
				if r.err != nil {
					continue
				}
				if r.status == 200 && !gotSuccess {
					items = r.items
					gotSuccess = true
					if remaining > 0 {
						go func(ch chan fetchResult, n int, p *ClientPool) {
							for i := 0; i < n; i++ {
								r := <-ch
								if r.status == 403 {
									p.Replace(r.client)
								}
							}
						}(resultCh, remaining, pool)
					}
					break collectLoop
				} else if r.status == 403 {
					pool.Replace(r.client)
				}
			case <-timeout.C:
				if remaining > 0 {
					go func(ch chan fetchResult, n int, p *ClientPool) {
						for i := 0; i < n; i++ {
							r := <-ch
							if r.status == 403 {
								p.Replace(r.client)
							}
						}
					}(resultCh, remaining, pool)
				}
				break collectLoop
			}
		}
		if !timeout.Stop() {
			select {
			case <-timeout.C:
			default:
			}
		}

		if !gotSuccess {
			consecutiveErrors++
			totalErrors++
			if consecutiveErrors%5 == 0 {
				reportHealth("all fetchers failed")
				log.Printf("[%d] %d consecutive failures, backing off...", m.ID, consecutiveErrors)
			}
			if consecutiveErrors >= maxConsecutiveErrors {
				log.Printf("[%d] ❌ auto-stopping: %d consecutive errors", m.ID, consecutiveErrors)
				e.db.SetMonitorStatus(m.ID, "error")
				return
			}
			backoff := time.Duration(300+consecutiveErrors*200) * time.Millisecond
			if backoff > 3*time.Second {
				backoff = 3 * time.Second
			}
			time.Sleep(backoff)
			continue
		}

		consecutiveErrors = 0
		if checks%5 == 0 || checks <= 3 {
			reportHealth("")
		}

		ids := make([]int64, len(items))
		for i, item := range items {
			ids[i] = item.ID
		}

		newMap := e.db.BatchIsNew(ids)

		var newItems []model.VintedItem
		for _, item := range items {
			if newMap[item.ID] {
				newItems = append(newItems, item)
			}
		}

		fmt.Printf("\r[%d] #%d | %d items | %d new | %dms", m.ID, checks, len(items), len(newItems), time.Since(cycleStart).Milliseconds())

		if len(newItems) == 0 {
			if remaining := intervalDuration - time.Since(cycleStart); remaining > 0 {
				time.Sleep(remaining)
			}
			continue
		}

		newIDs := make([]int64, len(newItems))
		for i, item := range newItems {
			newIDs[i] = item.ID
		}
		e.db.MarkItemsSeen(newIDs)

		builtItems := e.buildItems(m, newItems)

		if e.enrichSeller {
			for i, vItem := range newItems {
				if info, ok := LookupCachedSellerInfo(e.db, vItem.User.ID); ok {
					builtItems[i].Location = info.Region
					builtItems[i].Rating = info.Rating
				}
			}
		}

		for _, item := range builtItems {
			fmt.Printf("\n  NEW [%d]: %s (%s) [%s]", m.ID, item.Title, item.Price, item.Size)
		}
		fmt.Println()

		go func(ctx context.Context, items []model.Item, vItems []model.VintedItem, monitorID int, webhook string, webhookActive bool, query string, ps string, scr *HTMLScraper, dom string) {
			if e.enrichSeller && scr != nil {
				sem := make(chan struct{}, 10)
				var wg sync.WaitGroup
				for i := range items {
					if items[i].Location != "" {
						continue
					}
					select {
					case <-ctx.Done():
						return
					default:
					}

					itemURL := vItems[i].Url
					if !strings.HasPrefix(itemURL, "http") {
						itemURL = fmt.Sprintf("https://%s%s", dom, itemURL)
					}

					wg.Add(1)
					go func(idx int, url string, userID int64) {
						defer wg.Done()
						sem <- struct{}{}
						defer func() { <-sem }()

						info := scr.FetchSellerInfo(url, userID)
						if info.Region != "" && info.Region != "NaN" {
							items[idx].Location = info.Region
							items[idx].Rating = info.Rating
						}
					}(i, itemURL, vItems[i].User.ID)
				}
				wg.Wait()
			}

			if err := e.db.BatchSaveItems(items); err != nil {
				log.Printf("[%d] batch save error: %v", monitorID, err)
			}

			for i := range items {
				if items[i].Location != "" {
					_ = e.db.UpdateItemSellerInfo(items[i].ID, items[i].Location, items[i].Rating)
				}

				if err := e.db.PublishItem(items[i]); err != nil {
					log.Printf("[%d] publish error: %v", monitorID, err)
				}

				if webhook != "" && webhookActive {
					select {
					case <-ctx.Done():
						return
					default:
					}
					discord.SendWebhook(webhook, items[i], query, ps)
				}
			}
		}(ctx, builtItems, newItems, m.ID, m.DiscordWebhook.String, m.WebhookActive, m.Query, proxySource, scraper, domain)

		if remaining := intervalDuration - time.Since(cycleStart); remaining > 0 {
			time.Sleep(remaining)
		}
	}
}

func (e *Engine) fetchCatalog(ctx context.Context, client *Client, apiURL string, domain string) ([]model.VintedItem, int, error) {
	reqURL := apiURL + "&_=" + strconv.FormatInt(time.Now().UnixMilli(), 10)
	req, err := http.NewRequestWithContext(ctx, "GET", reqURL, nil)
	if err != nil {
		return nil, 0, err
	}
	req.Header = newAPIHeaders(domain)

	resp, err := client.HttpClient.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		_, _ = io.Copy(io.Discard, resp.Body)
		return nil, resp.StatusCode, nil
	}

	limitedReader := io.LimitReader(resp.Body, maxAPIResponseBytes)
	var data model.VintedResponse
	if err := json.NewDecoder(limitedReader).Decode(&data); err != nil {
		return nil, 0, fmt.Errorf("json decode: %w", err)
	}

	return data.Items, 200, nil
}

func (e *Engine) buildItems(m model.Monitor, vItems []model.VintedItem) []model.Item {
	domain := model.RegionDomain(m.Region)
	items := make([]model.Item, len(vItems))

	for i, vItem := range vItems {
		itemURL := vItem.Url
		if !strings.HasPrefix(itemURL, "http") {
			itemURL = fmt.Sprintf("https://%s%s", domain, itemURL)
		}
		size := vItem.SizeTitle
		if size == "" {
			size = vItem.Size
		}
		totalPrice := ""
		if vItem.TotalItemPrice != nil {
			totalPrice = vItem.TotalItemPrice.Amount + " " + vItem.TotalItemPrice.Currency
		}
		items[i] = model.Item{
			ID:         vItem.ID,
			MonitorID:  m.ID,
			Title:      vItem.Title,
			Price:      vItem.Price.Amount + " " + vItem.Price.Currency,
			TotalPrice: totalPrice,
			Size:       size,
			Condition:  vItem.Condition,
			URL:        itemURL,
			ImageURL:   vItem.Photo.Url,
			SellerID:   vItem.User.ID,
			FoundAt:    time.Now(),
		}
	}

	return items
}

func getEnvInt(key string, fallback int) int {
	if val, err := strconv.Atoi(os.Getenv(key)); err == nil {
		return val
	}
	return fallback
}
