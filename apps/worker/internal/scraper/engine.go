package scraper

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strconv"
	"sync"
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

func (e *Engine) createWarmClient(monitorID int) (*Client, error) {
	currentProxy := e.proxy.Next()
	client, err := NewClient(currentProxy)
	if err != nil {
		return nil, err
	}

	req, _ := http.NewRequest("GET", "https://www.vinted.de/", nil)
	req.Header = http.Header{
		"User-Agent": {"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"},
		"Accept":     {"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"},
	}

	resp, err := client.HttpClient.Do(req)
	if err == nil {
		resp.Body.Close()
	} else {
		fmt.Printf("WARNING: [%d] Warmup Warning: %v\n", monitorID, err)
	}

	return client, nil
}

func (e *Engine) MonitorTask(ctx context.Context, m model.Monitor) {
	client, err := e.createWarmClient(m.ID)
	if err != nil {
		fmt.Printf("ERROR: [%d] Init Error: %v\n", m.ID, err)
		return
	}

	apiURL := BuildVintedURL(m)
	fmt.Printf("Starting Monitor [%d]: %s\n URL: %s\n", m.ID, m.Query, apiURL)

	consecutiveErrors := 0
	checks := 0

	intervalStr := os.Getenv("CHECK_INTERVAL_MS")
	interval := 1500
	if val, err := strconv.Atoi(intervalStr); err == nil {
		interval = val
	}

	for {
		select {
		case <-ctx.Done():
			fmt.Printf("\nERROR: Monitor [%d] stopped gracefully.\n", m.ID)
			return
		default:
		}

		checks++
		if checks%10 == 0 {
			updatedMonitor, err := e.db.GetMonitorByID(m.ID)
			if err == nil {
				m.DiscordWebhook = updatedMonitor.DiscordWebhook
				m.WebhookActive = updatedMonitor.WebhookActive
				m.Status = updatedMonitor.Status
				if m.Status != "active" {
					fmt.Printf("Monitor [%d] paused via Dashboard.\n", m.ID)
					return
				}
			}
		}

		req, err := http.NewRequest("GET", apiURL, nil)
		if err != nil {
			time.Sleep(5 * time.Second)
			continue
		}

		req.Header = http.Header{
			"User-Agent":       {"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"},
			"Accept":           {"application/json, text/plain, */*"},
			"X-Requested-With": {"XMLHttpRequest"},
			"Referer":          {"https://www.vinted.de/"},
		}

		resp, err := client.HttpClient.Do(req)
		if err != nil {
			consecutiveErrors++
			if consecutiveErrors > 2 {
				if newClient, err := e.createWarmClient(m.ID); err == nil {
					client = newClient
					consecutiveErrors = 0
				}
			}
			time.Sleep(2 * time.Second)
			continue
		}

		if resp.StatusCode == 401 || resp.StatusCode == 403 {
			resp.Body.Close()
			if newClient, err := e.createWarmClient(m.ID); err == nil {
				client = newClient
			}
			time.Sleep(5 * time.Second)
			continue
		}

		if resp.StatusCode != 200 {
			resp.Body.Close()
			time.Sleep(5 * time.Second)
			continue
		}

		consecutiveErrors = 0
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()

		var data model.VintedResponse
		if err := json.Unmarshal(body, &data); err != nil {
			time.Sleep(2 * time.Second)
			continue
		}

		fmt.Printf("\r[%d] Check #%d | Items: %d | Processing...", m.ID, checks, len(data.Items))

		var wg sync.WaitGroup
		newItemsCount := 0
		var mu sync.Mutex
		sem := make(chan struct{}, 10)

		for _, vItem := range data.Items {
			wg.Add(1)
			sem <- struct{}{}

			go func(item model.VintedItem) {
				defer wg.Done()
				defer func() { <-sem }()

				if e.processItem(m, item) {
					mu.Lock()
					newItemsCount++
					mu.Unlock()
				}
			}(vItem)
		}

		wg.Wait()

		if newItemsCount > 0 {
			fmt.Println()
		}

		if newItemsCount > 0 {
			time.Sleep(500 * time.Millisecond)
		} else {
			time.Sleep(time.Duration(interval) * time.Millisecond)
		}
	}
}

func (e *Engine) processItem(m model.Monitor, vItem model.VintedItem) bool {
	if !e.db.IsNew(vItem.ID) {
		return false
	}

	size := vItem.SizeTitle
	if size == "" {
		size = vItem.Size
	}
	condition := vItem.Condition
	region := model.GetRegion(vItem.Url)

	item := model.Item{
		ID:        vItem.ID,
		MonitorID: m.ID,
		Title:     vItem.Title,
		Price:     vItem.Price.Amount + " " + vItem.Price.Currency,
		Size:      size,
		Condition: condition,
		URL:       vItem.Url,
		ImageURL:  vItem.Photo.Url,
		Location:  region,
	}

	if err := e.db.SaveItem(item); err != nil {
		fmt.Printf("ERROR saving item %d: %v\n", item.ID, err)
		return false
	}

	if err := e.db.PublishItem(item); err != nil {
		fmt.Printf("Pub/Sub Error: %v\n", err)
	}

	fmt.Printf("\nNEW [%d]: %s (%s) [%s]", m.ID, item.Title, item.Price, item.Size)

	if m.DiscordWebhook.Valid && m.DiscordWebhook.String != "" {
		if m.WebhookActive {
			go discord.SendWebhook(
				m.DiscordWebhook.String,
				item,
				m.Query,
			)
		}
	}

	return true
}
