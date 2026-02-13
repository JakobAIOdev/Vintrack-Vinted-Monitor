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

func SendWebhook(webhookUrl string, item model.Item, monitorQuery string) {
	if webhookUrl == "" {
		return
	}

	baseURL := os.Getenv("DASHBOARD_URL")
	if baseURL == "" {
		baseURL = "http://localhost:3000"
	}

	dashboardLink := fmt.Sprintf("%s/monitors/%d", baseURL, item.MonitorID)

	color := 0x007782
	payload := map[string]interface{}{
		"username":   "Vintrack Monitor",
		"avatar_url": "https://cdn-icons-png.flaticon.com/512/8266/8266540.png",
		"embeds": []map[string]interface{}{
			{
				"title":       item.Title,
				"url":         item.URL,
				"color":       color,
				"description": fmt.Sprintf("**%s** • \nFound for query: `%s`", item.Price, monitorQuery),
				"thumbnail": map[string]interface{}{
					"url": item.ImageURL,
				},
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
						"value":  fmt.Sprintf("`%s`", item.Condition),
						"inline": true,
					},
					{
						"name":   "Time",
						"value":  fmt.Sprintf("<t:%d:R>", time.Now().Unix()),
						"inline": true,
					},
				},
				"footer": map[string]interface{}{
					"text":     fmt.Sprintf("Vintrack • Monitor #%d", item.MonitorID),
					"icon_url": "https://cdn-icons-png.flaticon.com/512/8266/8266540.png",
				},
				"timestamp": time.Now().Format(time.RFC3339),
			},
		},
	}
	links := fmt.Sprintf(
		"[[🛒 BUY NOW]](%s) • [[📱 APP]](%s) • [[📊 DASHBOARD]](%s)",
		item.URL,
		item.URL,
		dashboardLink,
	)

	payload["embeds"].([]map[string]interface{})[0]["description"] = links + "\n\n" +
		payload["embeds"].([]map[string]interface{})[0]["description"].(string)

	jsonPayload, _ := json.Marshal(payload)
	go func() {
		client := &http.Client{Timeout: 5 * time.Second}
		resp, err := client.Post(webhookUrl, "application/json", bytes.NewBuffer(jsonPayload))
		if err != nil {
			fmt.Printf("Webhook Error: %v\n", err)
			return
		}
		defer resp.Body.Close()
	}()
}
