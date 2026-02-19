package discord

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"time"

	"vintrack-worker/internal/model"
)

var httpClient = &http.Client{Timeout: 5 * time.Second}

func SendWebhook(webhookURL string, item model.Item, query string) {
	if webhookURL == "" {
		return
	}

	baseURL := os.Getenv("DASHBOARD_URL")
	if baseURL == "" {
		baseURL = "http://localhost:3000"
	}

	dashLink := fmt.Sprintf("%s/monitors/%d", baseURL, item.MonitorID)
	links := fmt.Sprintf("[[🛒 BUY NOW]](%s) • [[📱 APP]](%s) • [[📊 DASHBOARD]](%s)", item.URL, item.URL, dashLink)

	payload := map[string]interface{}{
		"username":   "Vintrack Monitor",
		"avatar_url": "https://cdn-icons-png.flaticon.com/512/8266/8266540.png",
		"embeds": []map[string]interface{}{
			{
				"title":       item.Title,
				"url":         item.URL,
				"color":       0x007782,
				"description": fmt.Sprintf("%s\n\n**%s** • \nFound for query: `%s`", links, item.Price, query),
				"thumbnail":   map[string]string{"url": item.ImageURL},
				"fields":      buildFields(item),
				"footer": map[string]string{
					"text":     fmt.Sprintf("Vintrack • Monitor #%d", item.MonitorID),
					"icon_url": "https://cdn-icons-png.flaticon.com/512/8266/8266540.png",
				},
				"timestamp": time.Now().Format(time.RFC3339),
			},
		},
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
}

func buildFields(item model.Item) []map[string]interface{} {
	fields := []map[string]interface{}{
		{"name": "Region", "value": fmt.Sprintf("**%s**", item.Location), "inline": true},
		{"name": "Price", "value": fmt.Sprintf("`%s`", item.Price), "inline": true},
		{"name": "Size", "value": fmt.Sprintf("**%s**", item.Size), "inline": true},
		{"name": "Condition", "value": fmt.Sprintf("`%s`", item.Condition), "inline": true},
	}

	if item.Rating != "" {
		fields = append(fields, map[string]interface{}{
			"name": "Rating", "value": fmt.Sprintf("**%s**", item.Rating), "inline": true,
		})
	}

	fields = append(fields, map[string]interface{}{
		"name": "Time", "value": fmt.Sprintf("<t:%d:R>", time.Now().Unix()), "inline": true,
	})

	return fields
}
