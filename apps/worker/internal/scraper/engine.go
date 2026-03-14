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

	activeMonitors []model.Monitor
	monitorsMu     sync.RWMutex
}

func NewEngine(db *database.Store, pm *proxy.Manager) *Engine {
	enrich := os.Getenv("ENRICH_SELLER_INFO") != "false"
	poolSize := getEnvInt("CLIENT_POOL_SIZE", 5)
	log.Printf("Seller enrichment (region/rating): %v, client pool size: %d", enrich, poolSize)
	return &Engine{
		db:             db,
		serverProxy:    pm,
		enrichSeller:   enrich,
		poolSize:       poolSize,
		pools:          make(map[string]*ClientPool),
		scrapers:       make(map[string]*HTMLScraper),
		activeMonitors: make([]model.Monitor, 0),
	}
}

func (e *Engine) UpdateMonitors(monitors []model.Monitor) {
	e.monitorsMu.Lock()
	defer e.monitorsMu.Unlock()
	e.activeMonitors = monitors
	log.Printf("[GlobalFeed] Updated monitor list, active count: %d", len(e.activeMonitors))
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

func matchQuery(item model.VintedItem, query string) bool {
	q := strings.ToLower(strings.TrimSpace(query))
	if q == "" {
		return true
	}
	t := strings.ToLower(item.Title)
	b := strings.ToLower(item.BrandTitle)

	words := strings.Fields(q)
	for _, w := range words {
		if !strings.Contains(t, w) && !strings.Contains(b, w) {
			return false
		}
	}
	return true
}

func matchPrice(item model.VintedItem, min, max *int) bool {
	if min == nil && max == nil {
		return true
	}
	priceStr := item.Price.Amount
	price, err := strconv.ParseFloat(priceStr, 64)
	if err != nil {
		return true
	}

	if min != nil && price < float64(*min) {
		return false
	}
	if max != nil && price > float64(*max) {
		return false
	}
	return true
}

func matchSize(item model.VintedItem, sizeIDStr *string) bool {
	// Local filtering of SizeID is difficult because item provides SizeTitle, not SizeID.
	// So we pass all sizes.
	return true
}

func (e *Engine) GlobalFeedTask(ctx context.Context, domain string, region string) {
	pm := e.serverProxy
	if pm.Count() == 0 {
		log.Printf("[GlobalFeed] ❌ ERROR: no valid proxies available")
		return
	}

	pool := e.GetOrCreatePool(pm, domain, "server")
	var scraper *HTMLScraper
	if e.enrichSeller {
		scraper = e.GetOrCreateScraper(pm, domain, "server")
	}

	// Fetch without filters to get newest global items
	apiURL := fmt.Sprintf("https://%s/api/v2/catalog/items?order=newest_first&per_page=40", domain)

	interval := getEnvInt("CHECK_INTERVAL_MS", 500)
	raceFetchers := getEnvInt("RACE_FETCHERS", 2)
	checks := 0

	log.Printf("[GlobalFeed] started | race=%d | url=%s", raceFetchers, apiURL)

	intervalDuration := time.Duration(interval) * time.Millisecond

	// Use an in-memory ring buffer to track seen IDs locally to save DB hits
	seenIDs := make(map[int64]time.Time)

	for {
		cycleStart := time.Now()

		select {
		case <-ctx.Done():
			log.Printf("[GlobalFeed] stopped gracefully")
			return
		default:
		}

		// Cleanup seenIDs every 100 checks
		checks++
		if checks%100 == 0 {
			now := time.Now()
			for id, t := range seenIDs {
				if now.Sub(t) > 10*time.Minute {
					delete(seenIDs, id)
				}
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
			time.Sleep(time.Duration(1000) * time.Millisecond)
			continue
		}

		// Filter out items we've already seen globally
		var newGlobalItems []model.VintedItem
		for _, item := range items {
			if _, exists := seenIDs[item.ID]; !exists {
				newGlobalItems = append(newGlobalItems, item)
				seenIDs[item.ID] = time.Now()
			}
		}

		fmt.Printf("\r[GlobalFeed] #%d | %d items | %d new | %dms", checks, len(items), len(newGlobalItems), time.Since(cycleStart).Milliseconds())

		if len(newGlobalItems) == 0 {
			if remaining := intervalDuration - time.Since(cycleStart); remaining > 0 {
				time.Sleep(remaining)
			}
			continue
		}

		e.monitorsMu.RLock()
		activeMonitors := make([]model.Monitor, len(e.activeMonitors))
		copy(activeMonitors, e.activeMonitors)
		e.monitorsMu.RUnlock()

		for _, item := range newGlobalItems {
			for _, m := range activeMonitors {
				if m.Region != region {
					continue
				}

				if !matchQuery(item, m.Query) {
					continue
				}
				if !matchPrice(item, m.PriceMin, m.PriceMax) {
					continue
				}

				// Found a match for this monitor!
				log.Printf("\n  NEW [GlobalFeed->Monitor %d]: %s (%s %s) [%s]", m.ID, item.Title, item.Price.Amount, item.Price.Currency, item.SizeTitle)

				// Wrap in slice to reuse existing logic
				vItemList := []model.VintedItem{item}
				builtItems := e.buildItems(m, vItemList)

				if e.enrichSeller {
					if info, ok := LookupCachedSellerInfo(e.db, item.User.ID); ok {
						builtItems[0].Location = info.Region
						builtItems[0].Rating = info.Rating
					}
				}

				// Mark as seen in DB for this monitor so history works
				e.db.MarkItemsSeen(m.ID, []int64{item.ID})

				go func(ctx context.Context, items []model.Item, vItems []model.VintedItem, monitorID int, webhook string, webhookActive bool, query string, ps string, scr *HTMLScraper, dom string) {
					if err := e.db.BatchSaveItems(items); err != nil {
						log.Printf("[%d] batch save error: %v", monitorID, err)
					}

					for i := range items {
						if err := e.db.PublishItem(items[i]); err != nil {
							log.Printf("[%d] publish error: %v", monitorID, err)
						}
					}

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

									_ = e.db.UpdateItemSellerInfo(items[idx].ID, items[idx].Location, items[idx].Rating)

									if err := e.db.PublishItem(items[idx]); err != nil {
										log.Printf("[%d] publish update error: %v", monitorID, err)
									}
								}
							}(i, itemURL, vItems[i].User.ID)
						}
						wg.Wait()
					}

					if webhook != "" && webhookActive {
						for i := range items {
							select {
							case <-ctx.Done():
								return
							default:
							}
							discord.SendWebhook(webhook, items[i], query, ps)
						}
					}
				}(ctx, builtItems, vItemList, m.ID, m.DiscordWebhook.String, m.WebhookActive, m.Query, "server", scraper, domain)

			}
		}

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

		var extraImages []string
		for idx, photo := range vItem.Photos {
			if idx == 0 {
				continue
			}
			if photo.Url != "" {
				extraImages = append(extraImages, photo.Url)
			}
		}

		items[i] = model.Item{
			ID:          vItem.ID,
			MonitorID:   m.ID,
			Title:       vItem.Title,
			Brand:       vItem.BrandTitle,
			Price:       vItem.Price.Amount + " " + vItem.Price.Currency,
			TotalPrice:  totalPrice,
			Size:        size,
			Condition:   vItem.Condition,
			URL:         itemURL,
			ImageURL:    vItem.Photo.Url,
			ExtraImages: extraImages,
			SellerID:    vItem.User.ID,
			FoundAt:     time.Now(),
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
