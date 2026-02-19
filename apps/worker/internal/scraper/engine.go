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
	db    *database.Store
	proxy *proxy.Manager
}

func NewEngine(db *database.Store, pm *proxy.Manager) *Engine {
	return &Engine{db: db, proxy: pm}
}

func (e *Engine) newWarmClient(monitorID int) (*Client, error) {
	client, err := NewClient(e.proxy.Next())
	if err != nil {
		return nil, fmt.Errorf("client creation failed: %w", err)
	}

	if err := client.WarmUp(); err != nil {
		log.Printf("[%d] warmup warning: %v", monitorID, err)
	}

	return client, nil
}

func (e *Engine) MonitorTask(ctx context.Context, m model.Monitor) {
	client, err := e.newWarmClient(m.ID)
	if err != nil {
		log.Printf("[%d] init error: %v", m.ID, err)
		return
	}

	scraper := NewHTMLScraper(e.proxy, e.db)
	apiURL := BuildVintedURL(m)

	interval := getEnvInt("CHECK_INTERVAL_MS", 1500)
	consecutiveErrors := 0
	checks := 0

	log.Printf("[%d] started | query=%q | url=%s", m.ID, m.Query, apiURL)

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

		items, err := e.fetchCatalog(client, apiURL)
		if err != nil {
			consecutiveErrors++
			if consecutiveErrors > 2 {
				if newClient, err := e.newWarmClient(m.ID); err == nil {
					client = newClient
					consecutiveErrors = 0
				}
			}
			time.Sleep(2 * time.Second)
			continue
		}

		if items == nil { // 401/403 — re-warm
			if newClient, err := e.newWarmClient(m.ID); err == nil {
				client = newClient
			}
			time.Sleep(5 * time.Second)
			continue
		}

		consecutiveErrors = 0

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

		for _, vItem := range newItems {
			e.processNewItem(m, vItem, scraper)
		}
		fmt.Println()

		time.Sleep(300 * time.Millisecond)
	}
}

func (e *Engine) fetchCatalog(client *Client, apiURL string) ([]model.VintedItem, error) {
	req, err := http.NewRequest("GET", apiURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header = apiHeaders

	resp, err := client.HttpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode == 401 || resp.StatusCode == 403 {
		return nil, nil // signal to re-warm
	}

	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("catalog returned %d", resp.StatusCode)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	var data model.VintedResponse
	if err := json.Unmarshal(body, &data); err != nil {
		return nil, fmt.Errorf("json decode: %w", err)
	}

	return data.Items, nil
}

func (e *Engine) processNewItem(m model.Monitor, vItem model.VintedItem, scraper *HTMLScraper) {
	itemURL := vItem.Url
	if !strings.HasPrefix(itemURL, "http") {
		itemURL = "https://www.vinted.de" + itemURL
	}

	sellerInfo := scraper.FetchSellerInfo(itemURL, vItem.User.ID)

	size := vItem.SizeTitle
	if size == "" {
		size = vItem.Size
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
		Location:  sellerInfo.Region,
		Rating:    sellerInfo.Rating,
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
		go discord.SendWebhook(m.DiscordWebhook.String, item, m.Query)
	}
}

func getEnvInt(key string, fallback int) int {
	if val, err := strconv.Atoi(os.Getenv(key)); err == nil {
		return val
	}
	return fallback
}
