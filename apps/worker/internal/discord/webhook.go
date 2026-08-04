package discord

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"vintrack-worker/internal/model"
)

var httpClient = &http.Client{Timeout: 5 * time.Second}

func SendWebhook(webhookURL string, item model.Item, monitorName string, proxySource string, style model.NotificationMessageStyle) error {
	if webhookURL == "" {
		return nil
	}

	payload := buildItemWebhookPayload(item, monitorName, proxySource, style)
	body, err := json.Marshal(payload)
	if err != nil {
		log.Printf("webhook marshal error: %v", err)
		return err
	}

	resp, err := httpClient.Post(webhookURL, "application/json", bytes.NewReader(body))
	if err != nil {
		log.Printf("webhook error: %v", err)
		return err
	}
	resp.Body.Close()

	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return nil
	}

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
					if resp2.StatusCode >= 200 && resp2.StatusCode < 300 {
						return nil
					}
					return fmt.Errorf("discord webhook returned %d after retry", resp2.StatusCode)
				}
				return err
			}
		} else {
			time.Sleep(2 * time.Second)
		}
	}
	return fmt.Errorf("discord webhook returned %d", resp.StatusCode)
}

func buildItemWebhookPayload(item model.Item, monitorName string, proxySource string, style model.NotificationMessageStyle) map[string]interface{} {
	if model.NormalizeNotificationMessageStyle(style) == model.NotificationMessageStyleCompact {
		return buildCompactItemWebhookPayload(item, monitorName)
	}
	return buildRichItemWebhookPayload(item, monitorName, proxySource)
}

func buildCompactItemWebhookPayload(item model.Item, monitorName string) map[string]interface{} {
	embed := map[string]interface{}{
		"title":       fallbackText(item.Title, "New Vinted listing"),
		"color":       0x007782,
		"description": itemPriceValue(item),
	}
	if monitorName != "" {
		embed["author"] = map[string]string{
			"name": fmt.Sprintf("New match • %s", monitorName),
		}
	}
	if fields := buildCompactFields(item); len(fields) > 0 {
		embed["fields"] = fields
	}
	if imageURL := absoluteDashboardURL(item.ImageURL); imageURL != "" {
		embed["thumbnail"] = map[string]string{"url": imageURL}
	}
	if isHTTPURL(item.URL) {
		embed["url"] = item.URL
	}

	return map[string]interface{}{
		"username":   "Vintrack",
		"avatar_url": "https://cdn-icons-png.flaticon.com/512/8266/8266540.png",
		"embeds":     []map[string]interface{}{embed},
	}
}

func buildCompactFields(item model.Item) []map[string]interface{} {
	values := []struct {
		name  string
		value string
	}{
		{name: "Brand", value: item.Brand},
		{name: "Size", value: item.Size},
		{name: "Condition", value: item.Condition},
		{name: "Region", value: item.Location},
		{name: "Seller rating", value: item.Rating},
	}

	fields := make([]map[string]interface{}, 0, len(values))
	for _, value := range values {
		if strings.TrimSpace(value.value) == "" {
			continue
		}
		fields = append(fields, map[string]interface{}{
			"name": value.name, "value": value.value, "inline": true,
		})
	}
	return fields
}

func buildRichItemWebhookPayload(item model.Item, monitorName string, proxySource string) map[string]interface{} {
	baseURL := os.Getenv("DASHBOARD_URL")
	if baseURL == "" {
		baseURL = "http://localhost:3000"
	}
	dashLink := fmt.Sprintf("%s/monitors/%d", baseURL, item.MonitorID)

	links := fmt.Sprintf("**[View item](%s)**  •  [Dashboard](%s)", item.URL, dashLink)
	if item.SellerURL != "" {
		links = fmt.Sprintf("%s  •  [Seller](%s)", links, item.SellerURL)
	}

	detectedAt := item.FoundAt
	if detectedAt.IsZero() {
		detectedAt = time.Now()
	}

	embed := map[string]interface{}{
		"author": map[string]string{
			"name": fmt.Sprintf("New match • %s", monitorName),
		},
		"title":       fallbackText(item.Title, "New Vinted listing"),
		"url":         item.URL,
		"color":       0x007782,
		"description": links,
		"fields":      buildFields(item),
		"footer": map[string]string{
			"text":     fmt.Sprintf("Vintrack • %s", fallbackText(proxySource, "monitor")),
			"icon_url": "https://cdn-icons-png.flaticon.com/512/8266/8266540.png",
		},
		"timestamp": detectedAt.Format(time.RFC3339),
	}
	if imageURL := absoluteDashboardURL(item.ImageURL); imageURL != "" {
		embed["image"] = map[string]string{"url": imageURL}
	}
	embeds := []map[string]interface{}{embed}
	seenImages := map[string]bool{item.ImageURL: item.ImageURL != ""}
	for _, rawImageURL := range item.ExtraImages {
		if len(embeds) >= 3 || rawImageURL == "" || seenImages[rawImageURL] {
			continue
		}
		seenImages[rawImageURL] = true
		embeds = append(embeds, map[string]interface{}{
			"url":   item.URL,
			"image": map[string]string{"url": absoluteDashboardURL(rawImageURL)},
		})
	}

	return map[string]interface{}{
		"username":   "Vintrack",
		"avatar_url": "https://cdn-icons-png.flaticon.com/512/8266/8266540.png",
		"embeds":     embeds,
	}
}

func absoluteDashboardURL(rawURL string) string {
	if rawURL == "" {
		return ""
	}
	if strings.HasPrefix(rawURL, "http://") || strings.HasPrefix(rawURL, "https://") {
		return rawURL
	}
	baseURL := os.Getenv("DASHBOARD_URL")
	if baseURL == "" {
		baseURL = "http://localhost:3000"
	}
	if strings.HasPrefix(rawURL, "/") {
		return strings.TrimRight(baseURL, "/") + rawURL
	}
	return strings.TrimRight(baseURL, "/") + "/" + rawURL
}

func SendStartupWebhook(webhookURL string, monitorName string) {
	if webhookURL == "" {
		return
	}

	payload := map[string]interface{}{
		"username":   "Vintrack Monitor",
		"avatar_url": "https://cdn-icons-png.flaticon.com/512/8266/8266540.png",
		"embeds": []map[string]interface{}{
			{
				"title":       "⏳ Monitor Starting Up",
				"description": fmt.Sprintf("The monitor **%s** is initializing in the backend. The initial scan is muted to avoid startup spam.", monitorName),
				"color":       3447003,
				"footer": map[string]string{
					"text":     "Vintrack • Startup",
					"icon_url": "https://cdn-icons-png.flaticon.com/512/8266/8266540.png",
				},
				"timestamp": time.Now().Format(time.RFC3339),
			},
		},
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return
	}

	resp, err := httpClient.Post(webhookURL, "application/json", bytes.NewReader(body))
	if err == nil {
		resp.Body.Close()
	}
}

func buildFields(item model.Item) []map[string]interface{} {
	fields := []map[string]interface{}{
		{"name": "Price", "value": itemPriceValue(item), "inline": true},
		{"name": "Size", "value": fallbackText(item.Size, "Not specified"), "inline": true},
		{"name": "Condition", "value": fallbackText(item.Condition, "Not specified"), "inline": true},
	}

	if item.Brand != "" {
		fields = append(fields, map[string]interface{}{
			"name": "Brand", "value": item.Brand, "inline": true,
		})
	}
	if item.Location != "" {
		fields = append(fields, map[string]interface{}{
			"name": "Location", "value": item.Location, "inline": true,
		})
	}
	if item.Rating != "" {
		fields = append(fields, map[string]interface{}{
			"name": "Seller rating", "value": item.Rating, "inline": true,
		})
	}
	if item.SellerLogin != "" {
		fields = append(fields, map[string]interface{}{
			"name": "Seller", "value": "@" + item.SellerLogin, "inline": true,
		})
	}
	if !item.FoundAt.IsZero() {
		fields = append(fields, map[string]interface{}{
			"name": "Detected", "value": fmt.Sprintf("<t:%d:R>", item.FoundAt.Unix()), "inline": true,
		})
	}

	return fields
}

func itemPriceValue(item model.Item) string {
	priceValue := fmt.Sprintf("**%s**", fallbackText(item.Price, "Unknown"))
	if item.TotalPrice != "" && item.TotalPrice != item.Price {
		priceValue = fmt.Sprintf("**%s**\n%s total", fallbackText(item.Price, "Unknown"), item.TotalPrice)
	}
	return priceValue
}

func isHTTPURL(rawURL string) bool {
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	return err == nil && (parsed.Scheme == "http" || parsed.Scheme == "https") && parsed.Host != ""
}

func fallbackText(value string, fallback string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return fallback
	}
	return value
}

func SendProxyWarningWebhook(webhookURL string, monitorName string, consecutiveErrors int) {
	if webhookURL == "" {
		return
	}

	payload := map[string]interface{}{
		"username":   "Vintrack Monitor",
		"avatar_url": "https://cdn-icons-png.flaticon.com/512/8266/8266540.png",
		"embeds": []map[string]interface{}{
			{
				"title":       "⚠️ Proxy Warning",
				"description": fmt.Sprintf("The monitor **%s** is experiencing repeated proxy errors. Currently at **%d consecutive errors**.", monitorName, consecutiveErrors),
				"color":       16753920, // Orange
				"footer": map[string]string{
					"text":     "Vintrack • Health Warning",
					"icon_url": "https://cdn-icons-png.flaticon.com/512/8266/8266540.png",
				},
				"timestamp": time.Now().Format(time.RFC3339),
			},
		},
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return
	}

	resp, err := httpClient.Post(webhookURL, "application/json", bytes.NewReader(body))
	if err == nil {
		resp.Body.Close()
	}
}

func SendAutoStopWebhook(webhookURL string, monitorName string, consecutiveErrors int) {
	if webhookURL == "" {
		return
	}

	payload := map[string]interface{}{
		"username":   "Vintrack Monitor",
		"avatar_url": "https://cdn-icons-png.flaticon.com/512/8266/8266540.png",
		"embeds": []map[string]interface{}{
			{
				"title":       "🛑 Monitor Auto-Stopped",
				"description": fmt.Sprintf("The monitor **%s** was automatically stopped due to reaching the maximum limit of **%d consecutive errors**.\nPlease check your proxy group.", monitorName, consecutiveErrors),
				"color":       15548997, // Red
				"footer": map[string]string{
					"text":     "Vintrack • System Alert",
					"icon_url": "https://cdn-icons-png.flaticon.com/512/8266/8266540.png",
				},
				"timestamp": time.Now().Format(time.RFC3339),
			},
		},
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return
	}

	resp, err := httpClient.Post(webhookURL, "application/json", bytes.NewReader(body))
	if err == nil {
		resp.Body.Close()
	}
}
