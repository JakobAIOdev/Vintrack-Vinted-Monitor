package scraper

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strconv"
	"time"
	"vintrack-worker/internal/database"
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

func (e *Engine) MonitorTask(m model.Monitor) {
	currentProxy := e.proxy.Next()
	client, err := NewClient(currentProxy)
	if err != nil {
		fmt.Printf("ERROR: [%d] Init Error: %v\n", m.ID, err)
		return
	}

	fmt.Printf("[%d] Warming up cookies...\n", m.ID)
	reqWarmup, _ := http.NewRequest("GET", "https://www.vinted.de/", nil)
	reqWarmup.Header = http.Header{
		"User-Agent": {"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"},
		"Accept":     {"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"},
	}
	respWarmup, err := client.HttpClient.Do(reqWarmup)
	if err == nil {
		respWarmup.Body.Close()
	} else {
		fmt.Printf("WARNING: [%d] Warmup failed (Proxy might be dead): %v\n", m.ID, err)
	}

	apiURL := BuildVintedURL(m)
	fmt.Printf("Starting Monitor [%d]: %s\n URL: %s\n", m.ID, m.Query, apiURL)

	consecutiveErrors := 0
	checks := 0

	for {
		checks++
		req, err := http.NewRequest("GET", apiURL, nil)
		if err != nil {
			fmt.Printf("ERROR: [%d] Req Build Error: %v\n", m.ID, err)
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
			fmt.Printf("ERROR: [%d] Net Error: %v\n", m.ID, err)
			consecutiveErrors++
			if consecutiveErrors > 3 {
				fmt.Printf("ERROR: [%d] Too many errors. Rotating Proxy.\n", m.ID)
				client, _ = NewClient(e.proxy.Next())
				consecutiveErrors = 0
			}
			time.Sleep(2 * time.Second)
			continue
		}

		if resp.StatusCode == 401 || resp.StatusCode == 403 {
			fmt.Printf("ERROR: [%d] Blocked (%d). Rotating...\n", m.ID, resp.StatusCode)
			client, _ = NewClient(e.proxy.Next())
			resp.Body.Close()
			time.Sleep(2 * time.Second)
			continue
		}

		if resp.StatusCode != 200 {
			fmt.Printf("WARNING: [%d] Status %d\n", m.ID, resp.StatusCode)
			resp.Body.Close()
			time.Sleep(5 * time.Second)
			continue
		}

		consecutiveErrors = 0

		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()

		var data model.VintedResponse
		if err := json.Unmarshal(body, &data); err != nil {
			preview := string(body)
			if len(preview) > 100 {
				preview = preview[:100]
			}
			fmt.Printf("WARNING: [%d] JSON Parse Error: %v | Body: %s...\n", m.ID, err, preview)

			time.Sleep(2 * time.Second)
			continue
		}

		fmt.Printf("\r [%d] Check #%d | Items: %d | Parsing...", m.ID, checks, len(data.Items))
		newCount := 0
		for _, vItem := range data.Items {
			if e.db.IsNew(vItem.ID) {
				price := vItem.Price.Amount + " " + vItem.Price.Currency

				item := model.Item{
					ID:        vItem.ID,
					MonitorID: m.ID,
					Title:     vItem.Title,
					Price:     price,
					Size:      vItem.SizeTitle,
					Condition: vItem.Status,
					URL:       vItem.Url,
					ImageURL:  vItem.Photo.Url,
				}

				if err := e.db.SaveItem(item); err == nil {
					fmt.Printf("NEW [%d]: %s (%s)\n", m.ID, item.Title, item.Price)
					newCount++
				}
			}
		}

		intervalStr := os.Getenv("CHECK_INTERVAL_MS")
		interval := 1500
		if val, err := strconv.Atoi(intervalStr); err == nil {
			interval = val
		}
		time.Sleep(time.Duration(interval) * time.Millisecond)
	}
}
