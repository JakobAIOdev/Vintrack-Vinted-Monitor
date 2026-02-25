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
	"time"

	"vintrack-worker/internal/database"
	"vintrack-worker/internal/discord"
	"vintrack-worker/internal/model"
	"vintrack-worker/internal/proxy"

	http "github.com/bogdanfinn/fhttp"
)

type Engine struct {
	db           *database.Store
	serverProxy  *proxy.Manager
	enrichSeller bool
}

func NewEngine(db *database.Store, pm *proxy.Manager) *Engine {
	enrich := os.Getenv("ENRICH_SELLER_INFO") != "false"
	log.Printf("Seller enrichment (region/rating): %v", enrich)
	return &Engine{db: db, serverProxy: pm, enrichSeller: enrich}
}

func (e *Engine) getProxyManager(m model.Monitor) *proxy.Manager {
	if m.Proxies.Valid && m.Proxies.String != "" {
		return proxy.FromString(m.Proxies.String)
	}
	return e.serverProxy
}

func (e *Engine) newWarmClient(monitorID int, pm *proxy.Manager, domain string) (*Client, error) {
	client, err := NewClient(pm.Next())
	if err != nil {
		return nil, fmt.Errorf("client creation failed: %w", err)
	}

	if err := client.WarmUpRegion(domain); err != nil {
		log.Printf("[%d] warmup warning: %v", monitorID, err)
	}

	return client, nil
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

	client, err := e.newWarmClient(m.ID, pm, domain)
	if err != nil {
		log.Printf("[%d] init error: %v", m.ID, err)
		return
	}

	var scraper *HTMLScraper
	if e.enrichSeller {
		scraper = NewHTMLScraper(pm, e.db)
	}

	apiURL := BuildVintedURL(m)

	interval := getEnvInt("CHECK_INTERVAL_MS", 1500)
	maxConsecutiveErrors := getEnvInt("MAX_CONSECUTIVE_ERRORS", 50)
	consecutiveErrors := 0
	checks := 0
	var totalErrors int64
	firstRun := true

	log.Printf("[%d] started | query=%q | url=%s", m.ID, m.Query, apiURL)

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

	for {
		select {
		case <-ctx.Done():
			log.Printf("[%d] stopped gracefully", m.ID)
			return
		default:
		}

		checks++

		if checks%10 == 0 {
			if updated, err := e.db.GetMonitorByID(m.ID); err == nil {
				m.DiscordWebhook = updated.DiscordWebhook
				m.WebhookActive = updated.WebhookActive
				m.Status = updated.Status
				if m.Status != "active" {
					log.Printf("[%d] paused via dashboard", m.ID)
					return
				}
			}
		}

		items, status, err := e.fetchCatalog(client, apiURL, domain)

		if err != nil {
			consecutiveErrors++
			totalErrors++
			errMsg := err.Error()
			if len(errMsg) > 200 {
				errMsg = errMsg[:200]
			}
			log.Printf("[%d] #%d network error (%d consecutive): %v", m.ID, checks, consecutiveErrors, err)
			reportHealth(errMsg)
			if consecutiveErrors >= maxConsecutiveErrors {
				log.Printf("[%d] ❌ auto-stopping: %d consecutive errors", m.ID, consecutiveErrors)
				e.db.SetMonitorStatus(m.ID, "error")
				return
			}
			if consecutiveErrors > 2 {
				if newClient, err := e.newWarmClient(m.ID, pm, domain); err == nil {
					client = newClient
					consecutiveErrors = 0
					reportHealth("")
				} else {
					log.Printf("[%d] client rotation failed: %v", m.ID, err)
				}
			}
			time.Sleep(2 * time.Second)
			continue
		}

		if status == 401 || status == 403 {
			consecutiveErrors++
			totalErrors++
			reportHealth(fmt.Sprintf("HTTP %d", status))
			log.Printf("[%d] #%d got %d, re-warming...", m.ID, checks, status)
			if consecutiveErrors >= maxConsecutiveErrors {
				log.Printf("[%d] ❌ auto-stopping: %d consecutive errors", m.ID, consecutiveErrors)
				e.db.SetMonitorStatus(m.ID, "error")
				return
			}
			if newClient, err := e.newWarmClient(m.ID, pm, domain); err == nil {
				client = newClient
			} else {
				log.Printf("[%d] re-warm failed: %v", m.ID, err)
			}
			time.Sleep(5 * time.Second)
			continue
		}

		if status != 200 {
			consecutiveErrors++
			totalErrors++
			reportHealth(fmt.Sprintf("HTTP %d", status))
			log.Printf("[%d] #%d catalog returned %d, waiting...", m.ID, checks, status)
			if consecutiveErrors >= maxConsecutiveErrors {
				log.Printf("[%d] ❌ auto-stopping: %d consecutive errors", m.ID, consecutiveErrors)
				e.db.SetMonitorStatus(m.ID, "error")
				return
			}
			time.Sleep(5 * time.Second)
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

		fmt.Printf("\r[%d] #%d | %d items | %d new", m.ID, checks, len(items), len(newItems))

		if len(newItems) == 0 {
			time.Sleep(time.Duration(interval) * time.Millisecond)
			continue
		}

		skipEnrich := firstRun && len(newItems) > 5
		if skipEnrich {
			log.Printf("[%d] bulk import: %d items, skipping seller enrichment", m.ID, len(newItems))
		}

		for _, vItem := range newItems {
			e.processNewItem(m, vItem, scraper, skipEnrich, proxySource)
		}
		fmt.Println()

		firstRun = false
		time.Sleep(time.Duration(interval) * time.Millisecond)
	}
}

func (e *Engine) fetchCatalog(client *Client, apiURL string, domain string) ([]model.VintedItem, int, error) {
	req, err := http.NewRequest("GET", apiURL, nil)
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
		return nil, resp.StatusCode, nil
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, 0, err
	}

	var data model.VintedResponse
	if err := json.Unmarshal(body, &data); err != nil {
		return nil, 0, fmt.Errorf("json decode: %w", err)
	}

	return data.Items, 200, nil
}

func (e *Engine) processNewItem(m model.Monitor, vItem model.VintedItem, scraper *HTMLScraper, skipEnrich bool, proxySource string) {
	domain := model.RegionDomain(m.Region)
	itemURL := vItem.Url
	if !strings.HasPrefix(itemURL, "http") {
		itemURL = fmt.Sprintf("https://%s%s", domain, itemURL)
	}

	size := vItem.SizeTitle
	if size == "" {
		size = vItem.Size
	}

	var region, rating string

	if e.enrichSeller && !skipEnrich && scraper != nil {
		sellerInfo := scraper.FetchSellerInfo(itemURL, vItem.User.ID)
		if sellerInfo.Region != "" && sellerInfo.Region != "NaN" {
			region = sellerInfo.Region
			rating = sellerInfo.Rating
		}
	}

	item := model.Item{
		ID:        vItem.ID,
		MonitorID: m.ID,
		Title:     vItem.Title,
		Price:     vItem.Price.Amount + " " + vItem.Price.Currency,
		Size:      size,
		Condition: vItem.Condition,
		URL:       itemURL,
		ImageURL:  vItem.Photo.Url,
		Location:  region,
		Rating:    rating,
		FoundAt:   time.Now(),
	}

	if err := e.db.SaveItem(item); err != nil {
		log.Printf("[%d] save error for item %d: %v", m.ID, item.ID, err)
		return
	}

	if err := e.db.PublishItem(item); err != nil {
		log.Printf("[%d] publish error: %v", m.ID, err)
	}

	ratingStr := ""
	if item.Rating != "" {
		ratingStr = " " + item.Rating
	}
	fmt.Printf("\n  NEW [%d]: %s (%s) [%s] %s%s", m.ID, item.Title, item.Price, item.Size, item.Location, ratingStr)

	if m.DiscordWebhook.Valid && m.DiscordWebhook.String != "" && m.WebhookActive {
		go discord.SendWebhook(m.DiscordWebhook.String, item, m.Query, proxySource)
	}
}

func getEnvInt(key string, fallback int) int {
	if val, err := strconv.Atoi(os.Getenv(key)); err == nil {
		return val
	}
	return fallback
}
