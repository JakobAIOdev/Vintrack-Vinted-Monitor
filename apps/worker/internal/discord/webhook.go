package discord

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"time"
	"vintrack-worker/internal/model"
)

func SendWebhook(webhookUrl string, item model.Item, monitorQuery string, region string) {
	if webhookUrl == "" {
		return
	}

	baseURL := os.Getenv("DASHBOARD_URL")
	if baseURL == "" {
		baseURL = "http://localhost:3000"
	}

	dashboardLink := fmt.Sprintf("%s/monitors/%d", baseURL, item.MonitorID)

	payload := map[string]interface{}{
		"username":   "Vintrack",
		"avatar_url": "https://cdn-icons-png.flaticon.com/512/8266/8266540.png",
		"embeds": []map[string]interface{}{
			{
				"title": item.Title,
				"url":   item.URL,

				"color": 5763719,

				"thumbnail": map[string]interface{}{
					"url": item.ImageURL,
				},

				"description": fmt.Sprintf(">>> [**Open in Dashboard**](%s)", dashboardLink),

				"fields": []map[string]interface{}{
					{
						"name":   "Price",
						"value":  fmt.Sprintf("`%s`", item.Price),
						"inline": true,
					},
					{
						"name":   "Size",
						"value":  fmt.Sprintf("**%s**", item.Size),
						"inline": true,
					},
					{
						"name":   "Condition",
						"value":  item.Condition,
						"inline": true,
					},
					{
						"name":   "Monitor",
						"value":  fmt.Sprintf("`%s`", monitorQuery),
						"inline": true,
					},
				},
				"footer": map[string]interface{}{
					"text":     "Vintrack • Instant Notification",
					"icon_url": "https://cdn-icons-png.flaticon.com/512/8266/8266540.png",
				},
				"timestamp": time.Now().Format(time.RFC3339),
			},
		},
	}

	jsonPayload, _ := json.Marshal(payload)
	client := &http.Client{Timeout: 5 * time.Second}
	client.Post(webhookUrl, "application/json", bytes.NewBuffer(jsonPayload))
}
