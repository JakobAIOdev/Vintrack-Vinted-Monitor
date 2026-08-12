package discord

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"vintrack-worker/internal/httpclient"
	"vintrack-worker/internal/model"
)

var httpClient = httpclient.New(5 * time.Second)

func SendWebhook(webhookURL string, item model.Item, monitorName string, proxySource string, style model.NotificationMessageStyle) error {
	payload := buildItemWebhookPayload(item, monitorName, proxySource, style)
	result := SendPayloadAttempt(context.Background(), webhookURL, payload)
	if result.Success {
		return nil
	}
	return fmt.Errorf("%s", result.Detail)
}

func SendWebhookAttempt(
	ctx context.Context,
	webhookURL string,
	item model.Item,
	monitorName string,
	proxySource string,
	style model.NotificationMessageStyle,
) model.AlertDeliveryResult {
	return SendPayloadAttempt(ctx, webhookURL, buildItemWebhookPayload(item, monitorName, proxySource, style))
}

func SendStatusAttempt(ctx context.Context, webhookURL string, title string, message string) model.AlertDeliveryResult {
	payload := map[string]interface{}{
		"username": "Vintrack Monitor",
		"embeds": []map[string]interface{}{{
			"title": title, "description": message, "color": 3447003,
			"timestamp": time.Now().UTC().Format(time.RFC3339),
		}},
	}
	return SendPayloadAttempt(ctx, webhookURL, payload)
}

func SendPayloadAttempt(ctx context.Context, webhookURL string, payload interface{}) model.AlertDeliveryResult {
	if strings.TrimSpace(webhookURL) == "" {
		return model.AlertDeliveryResult{ReasonCode: "invalid_destination", Detail: "discord webhook is not configured"}
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return model.AlertDeliveryResult{ReasonCode: "provider_rejected", Detail: "discord payload could not be encoded"}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, webhookURL, bytes.NewReader(body))
	if err != nil {
		return model.AlertDeliveryResult{ReasonCode: "invalid_destination", Detail: "discord webhook URL is invalid"}
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := httpClient.Do(req)
	if err != nil {
		reason := "network_error"
		var netErr net.Error
		if ctx.Err() != nil || (errors.As(err, &netErr) && netErr.Timeout()) {
			reason = "network_timeout"
		}
		return model.AlertDeliveryResult{Retryable: true, ReasonCode: reason, Detail: "discord request failed"}
	}
	defer resp.Body.Close()
	responseBody, _ := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	result := model.AlertDeliveryResult{
		HTTPStatus:      resp.StatusCode,
		RateLimitBucket: resp.Header.Get("X-RateLimit-Bucket"),
	}
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		result.Success = true
		if resp.Header.Get("X-RateLimit-Remaining") == "0" {
			result.RetryAfter = parseDiscordDuration(resp.Header.Get("X-RateLimit-Reset-After"))
		}
		return result
	}
	if resp.StatusCode == http.StatusTooManyRequests {
		result.Retryable = true
		result.ReasonCode = "rate_limited"
		result.Detail = "discord rate limit reached"
		result.GlobalRateLimit = strings.EqualFold(resp.Header.Get("X-RateLimit-Global"), "true") ||
			strings.EqualFold(resp.Header.Get("X-RateLimit-Scope"), "global")
		result.RetryAfter = parseDiscordDuration(resp.Header.Get("Retry-After"))
		if result.RetryAfter <= 0 {
			result.RetryAfter = parseDiscordDuration(resp.Header.Get("X-RateLimit-Reset-After"))
		}
		if result.RetryAfter <= 0 {
			var rateLimit struct {
				RetryAfter float64 `json:"retry_after"`
			}
			if json.Unmarshal(responseBody, &rateLimit) == nil && rateLimit.RetryAfter > 0 {
				result.RetryAfter = time.Duration(rateLimit.RetryAfter * float64(time.Second))
			}
		}
		if result.RetryAfter <= 0 {
			result.RetryAfter = 2 * time.Second
		}
		return result
	}
	if resp.StatusCode >= 500 {
		result.Retryable = true
		result.ReasonCode = "provider_5xx"
		result.Detail = fmt.Sprintf("discord returned %d", resp.StatusCode)
		return result
	}
	result.ReasonCode = "provider_rejected"
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden || resp.StatusCode == http.StatusNotFound {
		result.ReasonCode = "invalid_destination"
	}
	result.Detail = fmt.Sprintf("discord returned %d", resp.StatusCode)
	return result
}

func parseDiscordDuration(value string) time.Duration {
	seconds, err := strconv.ParseFloat(strings.TrimSpace(value), 64)
	if err != nil || seconds <= 0 {
		return 0
	}
	return time.Duration(seconds * float64(time.Second))
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
		httpclient.DrainAndClose(resp.Body)
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
		httpclient.DrainAndClose(resp.Body)
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
		httpclient.DrainAndClose(resp.Body)
	}
}
