package discord

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"strconv"
	"time"

	"vintrack-worker/internal/model"
)

var httpClient = &http.Client{Timeout: 5 * time.Second}

func SendWebhook(webhookURL string, item model.Item, query string, proxySource string) {
	if webhookURL == "" {
		return
	}

	baseURL := os.Getenv("DASHBOARD_URL")
	if baseURL == "" {
		baseURL = "http://localhost:3000"
	}

	dashLink := fmt.Sprintf("%s/monitors/%d", baseURL, item.MonitorID)

	description := fmt.Sprintf("%s\n\n**[🛒 View on Vinted](%s)** | **[📊 View on Dashboard](%s)**", item.Title, item.URL, dashLink)

	embeds := []map[string]interface{}{
		{
			"title":       fmt.Sprintf("🇫🇷 %s | %s", item.Title, item.Price),
			"url":         item.URL,
			"color":       0x007782,
			"description": description,
			"image":       map[string]string{"url": item.ImageURL},
			"fields":      buildFields(item),
			"footer": map[string]string{
				"text":     fmt.Sprintf("Vintrack • Monitor #%d • %s", item.MonitorID, proxySource),
				"icon_url": "https://cdn-icons-png.flaticon.com/512/8266/8266540.png",
			},
			"timestamp": time.Now().Format(time.RFC3339),
		},
	}

	for i, imgURL := range item.ExtraImages {
		if i >= 2 {
			break
		}
		embeds = append(embeds, map[string]interface{}{
			"url":   item.URL,
			"image": map[string]string{"url": imgURL},
		})
	}

	payload := map[string]interface{}{
		"username":   "Vintrack Monitor",
		"avatar_url": "https://cdn-icons-png.flaticon.com/512/8266/8266540.png",
		"embeds":     embeds,
	}

	body, err := json.Marshal(payload)
	if err != nil {
		log.Printf("webhook marshal error: %v", err)
		return
	}

	resp, err := httpClient.Post(webhookURL, "application/json", bytes.NewReader(body))
	if err != nil {
		log.Printf("webhook error: %v", err)
		return
	}
	resp.Body.Close()

	if resp.StatusCode == 429 {
		if retryAfter := resp.Header.Get("Retry-After"); retryAfter != "" {
			if secs, err := strconv.ParseFloat(retryAfter, 64); err == nil {
				wait := time.Duration(secs*1000+500) * time.Millisecond
				if wait > 10*time.Second {
					wait = 10 * time.Second
				}
				time.Sleep(wait)
				resp2, err := httpClient.Post(webhookURL, "application/json", bytes.NewReader(body))
				if err == nil {
					resp2.Body.Close()
				}
			}
		} else {
			time.Sleep(2 * time.Second)
		}
	}
}

func buildFields(item model.Item) []map[string]interface{} {
	priceValue := fmt.Sprintf("**%s**", item.Price)
	if item.TotalPrice != "" {
		priceValue = fmt.Sprintf("**%s** (+ fee)", item.Price)
		priceValue = fmt.Sprintf("**%s** (%s)", item.Price, item.TotalPrice)
	}

	fields := []map[string]interface{}{
		{"name": "💰 Price", "value": priceValue, "inline": true},
		{"name": "🏷️ Brand", "value": fmt.Sprintf("**%s**", item.Brand), "inline": true},
		{"name": "📏 Size", "value": fmt.Sprintf("**%s**", item.Size), "inline": true},
		{"name": "✨ Condition", "value": fmt.Sprintf("**%s**", item.Condition), "inline": true},
		{"name": "⌚ Published", "value": fmt.Sprintf("<t:%d:R>", item.FoundAt.Unix()), "inline": true},
	}

	if item.Rating != "" {
		fields = append(fields, map[string]interface{}{
			"name": "🌟 Reviews", "value": fmt.Sprintf("**%s**", item.Rating), "inline": true,
		})
	} else {
		fields = append(fields, map[string]interface{}{
			"name": "🌟 Reviews", "value": "**No ratings**", "inline": true,
		})
	}

	return fields
}
