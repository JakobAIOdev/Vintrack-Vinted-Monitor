package telegram

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"vintrack-worker/internal/model"
)

var httpClient = &http.Client{Timeout: 20 * time.Second}
var apiBaseURL = "https://api.telegram.org"
var retryBackoff = 750 * time.Millisecond

type retryResponse struct {
	Description string `json:"description"`
	Parameters  struct {
		RetryAfter int `json:"retry_after"`
	} `json:"parameters"`
}

type telegramRequestError struct {
	cause   error
	message string
}

func (e *telegramRequestError) Error() string { return e.message }
func (e *telegramRequestError) Unwrap() error { return e.cause }

func safeTelegramRequestError(err error) error {
	message := "telegram request failed"
	var netErr net.Error
	if errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &netErr) && netErr.Timeout()) {
		message = "telegram request timed out"
	}
	return &telegramRequestError{cause: err, message: message}
}

func SendItem(chatID string, item model.Item, monitorName string, proxySource string, style model.NotificationMessageStyle) error {
	if chatID == "" {
		return nil
	}
	style = model.NormalizeNotificationMessageStyle(style)

	if style == model.NotificationMessageStyleCompact {
		payload := map[string]interface{}{
			"chat_id":    chatID,
			"text":       compactItemText(item, monitorName),
			"parse_mode": "HTML",
		}
		previewURL := absoluteDashboardURL(item.ImageURL)
		if isTelegramButtonURL(previewURL) {
			payload["link_preview_options"] = map[string]interface{}{
				"url":                previewURL,
				"prefer_small_media": true,
				"show_above_text":    false,
			}
		} else {
			payload["disable_web_page_preview"] = true
		}
		if keyboard := compactItemKeyboard(item); keyboard != nil {
			payload["reply_markup"] = keyboard
		}

		if err := send("sendMessage", payload); err != nil {
			log.Printf("telegram send compact item error: %v", err)
			return err
		}
		return nil
	}

	if item.ImageURL != "" {
		payload := map[string]interface{}{
			"chat_id":    chatID,
			"photo":      absoluteDashboardURL(item.ImageURL),
			"caption":    itemCaption(item, monitorName, proxySource),
			"parse_mode": "HTML",
		}
		if keyboard := itemKeyboard(item); keyboard != nil {
			payload["reply_markup"] = keyboard
		}

		if err := send("sendPhoto", payload); err == nil {
			return nil
		} else {
			log.Printf("telegram send photo error: %v", err)
		}
	}

	payload := map[string]interface{}{
		"chat_id":                  chatID,
		"text":                     itemCaption(item, monitorName, proxySource),
		"parse_mode":               "HTML",
		"disable_web_page_preview": false,
	}
	if keyboard := itemKeyboard(item); keyboard != nil {
		payload["reply_markup"] = keyboard
	}

	if err := send("sendMessage", payload); err != nil {
		log.Printf("telegram send item error: %v", err)
		return err
	}
	return nil
}

func SendItemAttempt(
	ctx context.Context,
	chatID string,
	item model.Item,
	monitorName string,
	proxySource string,
	style model.NotificationMessageStyle,
) model.AlertDeliveryResult {
	if strings.TrimSpace(chatID) == "" {
		return model.AlertDeliveryResult{ReasonCode: "invalid_destination", Detail: "telegram chat is not configured"}
	}
	style = model.NormalizeNotificationMessageStyle(style)
	if style == model.NotificationMessageStyleCompact {
		payload := map[string]interface{}{
			"chat_id": chatID, "text": compactItemText(item, monitorName), "parse_mode": "HTML",
		}
		previewURL := absoluteDashboardURL(item.ImageURL)
		if isTelegramButtonURL(previewURL) {
			payload["link_preview_options"] = map[string]interface{}{
				"url": previewURL, "prefer_small_media": true, "show_above_text": false,
			}
		} else {
			payload["disable_web_page_preview"] = true
		}
		if keyboard := compactItemKeyboard(item); keyboard != nil {
			payload["reply_markup"] = keyboard
		}
		return sendAttempt(ctx, "sendMessage", payload)
	}

	if item.ImageURL != "" {
		photoPayload := map[string]interface{}{
			"chat_id": chatID, "photo": absoluteDashboardURL(item.ImageURL),
			"caption": itemCaption(item, monitorName, proxySource), "parse_mode": "HTML",
		}
		if keyboard := itemKeyboard(item); keyboard != nil {
			photoPayload["reply_markup"] = keyboard
		}
		result := sendAttempt(ctx, "sendPhoto", photoPayload)
		if result.Success || result.Retryable || result.ReasonCode == "invalid_destination" {
			return result
		}
	}

	messagePayload := map[string]interface{}{
		"chat_id": chatID, "text": itemCaption(item, monitorName, proxySource),
		"parse_mode": "HTML", "disable_web_page_preview": false,
	}
	if keyboard := itemKeyboard(item); keyboard != nil {
		messagePayload["reply_markup"] = keyboard
	}
	return sendAttempt(ctx, "sendMessage", messagePayload)
}

func SendStatusAttempt(ctx context.Context, chatID string, title string, message string) model.AlertDeliveryResult {
	text := fmt.Sprintf("<b>%s</b>\n%s", escape(title), escape(message))
	return sendAttempt(ctx, "sendMessage", map[string]interface{}{
		"chat_id": chatID, "text": text, "parse_mode": "HTML", "disable_web_page_preview": true,
	})
}

func sendAttempt(ctx context.Context, method string, payload map[string]interface{}) model.AlertDeliveryResult {
	token := os.Getenv("TELEGRAM_BOT_TOKEN")
	if token == "" {
		return model.AlertDeliveryResult{ReasonCode: "provider_rejected", Detail: "telegram bot token is not configured"}
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return model.AlertDeliveryResult{ReasonCode: "provider_rejected", Detail: "telegram payload could not be encoded"}
	}
	endpoint := fmt.Sprintf("%s/bot%s/%s", strings.TrimRight(apiBaseURL, "/"), token, method)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return model.AlertDeliveryResult{ReasonCode: "provider_rejected", Detail: "telegram request could not be created"}
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := httpClient.Do(req)
	if err != nil {
		reason := "network_error"
		var netErr net.Error
		if ctx.Err() != nil || (errors.As(err, &netErr) && netErr.Timeout()) {
			reason = "network_timeout"
		}
		return model.AlertDeliveryResult{Retryable: true, ReasonCode: reason, Detail: "telegram request failed"}
	}
	defer resp.Body.Close()
	responseBody, _ := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	result := model.AlertDeliveryResult{HTTPStatus: resp.StatusCode}
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		result.Success = true
		return result
	}
	if resp.StatusCode == http.StatusTooManyRequests {
		var retry retryResponse
		_ = json.Unmarshal(responseBody, &retry)
		result.Retryable = true
		result.ReasonCode = "rate_limited"
		result.Detail = "telegram rate limit reached"
		if retry.Parameters.RetryAfter > 0 {
			result.RetryAfter = time.Duration(retry.Parameters.RetryAfter) * time.Second
		} else {
			result.RetryAfter = 2 * time.Second
		}
		return result
	}
	if resp.StatusCode >= 500 {
		result.Retryable = true
		result.ReasonCode = "provider_5xx"
		result.Detail = fmt.Sprintf("telegram returned %d", resp.StatusCode)
		return result
	}
	var apiError retryResponse
	_ = json.Unmarshal(responseBody, &apiError)
	description := strings.ToLower(apiError.Description)
	result.ReasonCode = "provider_rejected"
	result.Detail = fmt.Sprintf("telegram returned %d", resp.StatusCode)
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusNotFound {
		result.Retryable = true
		result.ReasonCode = "provider_authentication"
		result.Detail = "telegram bot authentication failed"
		return result
	}
	if resp.StatusCode == http.StatusForbidden ||
		(resp.StatusCode == http.StatusBadRequest &&
			(strings.Contains(description, "chat not found") ||
				strings.Contains(description, "bot was blocked") ||
				strings.Contains(description, "user is deactivated"))) {
		result.ReasonCode = "invalid_destination"
		result.Detail = "telegram chat is no longer reachable"
	}
	return result
}

func SendStartup(chatID string, monitorName string) {
	sendStatus(chatID, fmt.Sprintf("Vintrack: Monitor <b>%s</b> is starting. Initial scan is muted.", escape(monitorName)))
}

func SendProxyWarning(chatID string, monitorName string, consecutiveErrors int) {
	sendStatus(chatID, fmt.Sprintf("Vintrack: Monitor <b>%s</b> has <b>%d</b> consecutive proxy errors.", escape(monitorName), consecutiveErrors))
}

func SendAutoStop(chatID string, monitorName string, consecutiveErrors int) {
	sendStatus(chatID, fmt.Sprintf("Vintrack: Monitor <b>%s</b> was auto-stopped after <b>%d</b> consecutive proxy errors.", escape(monitorName), consecutiveErrors))
}

func sendStatus(chatID string, text string) {
	if chatID == "" {
		return
	}

	if err := send("sendMessage", map[string]interface{}{
		"chat_id":                  chatID,
		"text":                     text,
		"parse_mode":               "HTML",
		"disable_web_page_preview": true,
	}); err != nil {
		log.Printf("telegram status error: %v", err)
	}
}

func send(method string, payload map[string]interface{}) error {
	token := os.Getenv("TELEGRAM_BOT_TOKEN")
	if token == "" {
		return fmt.Errorf("TELEGRAM_BOT_TOKEN is not configured")
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}

	return postWithRetry(fmt.Sprintf("%s/bot%s/%s", strings.TrimRight(apiBaseURL, "/"), token, method), body)
}

func postWithRetry(endpoint string, body []byte) error {
	retryAfter, err := post(endpoint, body)
	if err != nil {
		if !isTransientPostError(err) {
			return err
		}

		time.Sleep(retryBackoff)
		retryAfter, err = post(endpoint, body)
		if err != nil {
			return err
		}
	}
	if retryAfter == nil {
		return nil
	}

	wait := time.Duration(*retryAfter) * time.Second
	if wait > 10*time.Second {
		wait = 10 * time.Second
	}
	time.Sleep(wait)

	retryAfter, err = post(endpoint, body)
	if err != nil {
		return err
	}
	if retryAfter != nil {
		return fmt.Errorf("telegram API rate limited after retry")
	}
	return nil
}

func isTransientPostError(err error) bool {
	if errors.Is(err, context.DeadlineExceeded) {
		return true
	}

	var netErr net.Error
	return errors.As(err, &netErr) && netErr.Timeout()
}

func post(endpoint string, body []byte) (*int, error) {
	resp, err := httpClient.Post(endpoint, "application/json", bytes.NewReader(body))
	if err != nil {
		return nil, safeTelegramRequestError(err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	if resp.StatusCode == http.StatusTooManyRequests {
		var retry retryResponse
		if err := json.Unmarshal(respBody, &retry); err == nil {
			return &retry.Parameters.RetryAfter, nil
		}
		fallback := 2
		return &fallback, nil
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("telegram API returned %d: %s", resp.StatusCode, string(respBody))
	}

	return nil, nil
}

func itemCaption(item model.Item, monitorName string, proxySource string) string {
	lines := []string{
		"🔔 <b>New Vintrack Match</b>",
		fmt.Sprintf("<b>%s</b>", escape(item.Title)),
		"",
		fmt.Sprintf("💰 <b>%s</b>", escape(itemPrice(item))),
		fmt.Sprintf("🏷️ %s", escape(defaultValue(item.Brand, "No brand"))),
		fmt.Sprintf("📏 %s", escape(defaultValue(item.Size, "No size"))),
		fmt.Sprintf("✨ %s", escape(defaultValue(item.Condition, "No condition"))),
	}

	if item.Location != "" {
		lines = append(lines, fmt.Sprintf("📍 %s", escape(item.Location)))
	}
	if item.Rating != "" {
		lines = append(lines, escape(ratingLabel(item.Rating)))
	}
	if item.SellerURL != "" {
		label := "Seller"
		if item.SellerLogin != "" {
			label = "@" + item.SellerLogin
		}
		lines = append(lines, fmt.Sprintf("👤 <a href=\"%s\">%s</a>", escapeAttr(item.SellerURL), escape(label)))
	}

	lines = append(lines,
		"",
		fmt.Sprintf("📡 <b>%s</b>", escape(monitorName)),
		fmt.Sprintf("Vintrack • %s", escape(proxySource)),
	)

	return strings.Join(lines, "\n")
}

func compactItemText(item model.Item, monitorName string) string {
	lines := []string{
		fmt.Sprintf("<b>%s</b>", escape(defaultValue(item.Title, "New Vinted listing"))),
		fmt.Sprintf("💰 <b>%s</b>", escape(defaultValue(itemPrice(item), "Unknown"))),
	}

	itemDetails := make([]string, 0, 2)
	if item.Brand != "" {
		itemDetails = append(itemDetails, fmt.Sprintf("🏷️ %s", escape(item.Brand)))
	}
	if item.Size != "" {
		itemDetails = append(itemDetails, fmt.Sprintf("📏 %s", escape(item.Size)))
	}
	if len(itemDetails) > 0 {
		lines = append(lines, strings.Join(itemDetails, " • "))
	}
	if item.Condition != "" {
		lines = append(lines, fmt.Sprintf("✨ %s", escape(item.Condition)))
	}

	sellerDetails := make([]string, 0, 2)
	if item.Location != "" {
		sellerDetails = append(sellerDetails, fmt.Sprintf("📍 %s", escape(item.Location)))
	}
	if item.Rating != "" {
		sellerDetails = append(sellerDetails, escape(ratingLabel(item.Rating)))
	}
	if len(sellerDetails) > 0 {
		lines = append(lines, strings.Join(sellerDetails, " • "))
	}
	if monitorName != "" {
		lines = append(lines, fmt.Sprintf("📡 <i>%s</i>", escape(monitorName)))
	}

	return strings.Join(lines, "\n")
}

func itemPrice(item model.Item) string {
	price := item.Price
	if item.TotalPrice != "" {
		price = fmt.Sprintf("%s (%s)", item.Price, item.TotalPrice)
	}
	return price
}

func ratingLabel(rating string) string {
	rating = strings.TrimSpace(rating)
	for strings.HasPrefix(rating, "⭐") {
		rating = strings.TrimSpace(strings.TrimPrefix(rating, "⭐"))
	}
	if rating == "" {
		return ""
	}
	return "⭐ " + rating
}

func compactItemKeyboard(item model.Item) map[string]interface{} {
	if !isTelegramButtonURL(item.URL) {
		return nil
	}
	return map[string]interface{}{
		"inline_keyboard": [][]map[string]string{{
			{"text": "View on Vinted", "url": item.URL},
		}},
	}
}

func itemKeyboard(item model.Item) map[string]interface{} {
	buttons := make([]map[string]string, 0, 3)
	if isTelegramButtonURL(item.URL) {
		buttons = append(buttons, map[string]string{"text": "View on Vinted", "url": item.URL})
	}
	if isTelegramButtonURL(item.SellerURL) {
		buttons = append(buttons, map[string]string{"text": "Seller", "url": item.SellerURL})
	}
	if dashboardURL := dashboardItemURL(item); isTelegramButtonURL(dashboardURL) {
		buttons = append(buttons, map[string]string{"text": "Dashboard", "url": dashboardURL})
	}
	if len(buttons) == 0 {
		return nil
	}

	return map[string]interface{}{
		"inline_keyboard": [][]map[string]string{buttons},
	}
}

func dashboardItemURL(item model.Item) string {
	baseURL := os.Getenv("DASHBOARD_URL")
	if strings.TrimSpace(baseURL) == "" {
		baseURL = "http://localhost:3000"
	}
	return fmt.Sprintf("%s/monitors/%d", strings.TrimRight(baseURL, "/"), item.MonitorID)
}

func absoluteDashboardURL(rawURL string) string {
	if rawURL == "" {
		return ""
	}
	if strings.HasPrefix(rawURL, "http://") || strings.HasPrefix(rawURL, "https://") {
		return rawURL
	}
	baseURL := os.Getenv("DASHBOARD_URL")
	if strings.TrimSpace(baseURL) == "" {
		baseURL = "http://localhost:3000"
	}
	if strings.HasPrefix(rawURL, "/") {
		return strings.TrimRight(baseURL, "/") + rawURL
	}
	return strings.TrimRight(baseURL, "/") + "/" + rawURL
}

func isTelegramButtonURL(rawURL string) bool {
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return false
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return false
	}

	host := strings.ToLower(parsed.Hostname())
	return host != "localhost" && host != "127.0.0.1" && host != "::1"
}

func defaultValue(value string, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}

func escape(value string) string {
	return html.EscapeString(value)
}

func escapeAttr(value string) string {
	return html.EscapeString(value)
}
