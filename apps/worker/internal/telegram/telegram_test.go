package telegram

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"vintrack-worker/internal/model"
)

func TestSendAttemptReturnsTelegramRetryAfterWithoutSleeping(t *testing.T) {
	withTelegramServer(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte(`{"ok":false,"parameters":{"retry_after":17}}`))
	})
	result := sendAttempt(context.Background(), "sendMessage", map[string]interface{}{
		"chat_id": "1", "text": "test",
	})
	if !result.Retryable || result.ReasonCode != "rate_limited" || result.RetryAfter != 17*time.Second {
		t.Fatalf("unexpected result: %#v", result)
	}
}

func TestSendAttemptClassifiesTelegramProviderFailures(t *testing.T) {
	withTelegramServer(t, func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "unavailable") {
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		if strings.Contains(r.URL.Path, "not-found") {
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"ok":false,"description":"Not Found"}`))
			return
		}
		if strings.Contains(r.URL.Path, "missing-chat") {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"ok":false,"description":"Bad Request: chat not found"}`))
			return
		}
		w.WriteHeader(http.StatusForbidden)
	})
	transient := sendAttempt(context.Background(), "unavailable", map[string]interface{}{"chat_id": "1"})
	if !transient.Retryable || transient.ReasonCode != "provider_5xx" {
		t.Fatalf("transient result: %#v", transient)
	}
	terminal := sendAttempt(context.Background(), "forbidden", map[string]interface{}{"chat_id": "1"})
	if terminal.Retryable || terminal.ReasonCode != "invalid_destination" {
		t.Fatalf("terminal result: %#v", terminal)
	}
	authentication := sendAttempt(context.Background(), "not-found", map[string]interface{}{"chat_id": "1"})
	if !authentication.Retryable || authentication.ReasonCode != "provider_authentication" {
		t.Fatalf("authentication result: %#v", authentication)
	}
	missingChat := sendAttempt(context.Background(), "missing-chat", map[string]interface{}{"chat_id": "1"})
	if missingChat.Retryable || missingChat.ReasonCode != "invalid_destination" {
		t.Fatalf("missing chat result: %#v", missingChat)
	}
}

func withTelegramServer(t *testing.T, handler http.HandlerFunc) {
	t.Helper()

	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)

	oldBaseURL := apiBaseURL
	oldClient := httpClient
	oldRetryBackoff := retryBackoff
	oldToken, hadToken := os.LookupEnv("TELEGRAM_BOT_TOKEN")
	oldDashboardURL, hadDashboardURL := os.LookupEnv("DASHBOARD_URL")

	apiBaseURL = server.URL
	httpClient = server.Client()
	httpClient.Timeout = 2 * time.Second
	retryBackoff = 0
	os.Setenv("TELEGRAM_BOT_TOKEN", "test-token")
	os.Unsetenv("DASHBOARD_URL")

	t.Cleanup(func() {
		apiBaseURL = oldBaseURL
		httpClient = oldClient
		retryBackoff = oldRetryBackoff
		if hadToken {
			os.Setenv("TELEGRAM_BOT_TOKEN", oldToken)
		} else {
			os.Unsetenv("TELEGRAM_BOT_TOKEN")
		}
		if hadDashboardURL {
			os.Setenv("DASHBOARD_URL", oldDashboardURL)
		} else {
			os.Unsetenv("DASHBOARD_URL")
		}
	})
}

func TestSendItemUsesPhotoAndEscapesCaption(t *testing.T) {
	var payload map[string]interface{}
	withTelegramServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/bottest-token/sendPhoto" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Fatalf("decode payload: %v", err)
		}
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"ok":true}`))
	})

	SendItem("-1001", model.Item{
		ID:        10,
		MonitorID: 7,
		Title:     "Nike <Dunk>",
		Brand:     "A&B",
		Price:     "12 EUR",
		Size:      "42",
		Condition: "New",
		URL:       "https://example.test/item?x=1&y=2",
		ImageURL:  "https://example.test/image.jpg",
	}, "monitor <one>", "server", model.NotificationMessageStyleRich)

	if payload["chat_id"] != "-1001" {
		t.Fatalf("unexpected chat_id: %v", payload["chat_id"])
	}
	if payload["photo"] != "https://example.test/image.jpg" {
		t.Fatalf("unexpected photo: %v", payload["photo"])
	}
	caption, _ := payload["caption"].(string)
	if !strings.Contains(caption, "Nike &lt;Dunk&gt;") {
		t.Fatalf("caption did not escape title: %q", caption)
	}
	if strings.Contains(caption, "A&B") {
		t.Fatalf("caption did not escape brand: %q", caption)
	}
}

func TestSendItemCompactUsesSmallPreviewKeyDetailsAndVintedButton(t *testing.T) {
	var payload map[string]interface{}
	withTelegramServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/bottest-token/sendMessage" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Fatalf("decode payload: %v", err)
		}
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"ok":true}`))
	})

	SendItem("-1001", model.Item{
		MonitorID:   7,
		Title:       "Nike <Dunk>",
		Brand:       "Nike",
		Price:       "12 EUR",
		TotalPrice:  "14 EUR",
		Size:        "42",
		Condition:   "New",
		URL:         "https://example.test/item",
		ImageURL:    "https://example.test/image.jpg",
		Location:    "Berlin",
		Rating:      "⭐ 4.9 (120)",
		SellerLogin: "seller",
		SellerURL:   "https://example.test/seller",
	}, "monitor", "server", model.NotificationMessageStyleCompact)

	if _, ok := payload["disable_web_page_preview"]; ok {
		t.Fatalf("compact payload disabled its small image preview: %#v", payload)
	}
	preview := payload["link_preview_options"].(map[string]interface{})
	if preview["url"] != "https://example.test/image.jpg" || preview["prefer_small_media"] != true || preview["show_above_text"] != false {
		t.Fatalf("unexpected compact preview options: %#v", preview)
	}
	text, _ := payload["text"].(string)
	if text != "<b>Nike &lt;Dunk&gt;</b>\n💰 <b>12 EUR (14 EUR)</b>\n🏷️ Nike • 📏 42\n✨ New\n📍 Berlin • ⭐ 4.9 (120)\n📡 <i>monitor</i>" {
		t.Fatalf("unexpected compact text: %q", text)
	}
	for _, excluded := range []string{"seller", "server"} {
		if strings.Contains(text, excluded) {
			t.Fatalf("compact text contained %q: %q", excluded, text)
		}
	}
	keyboard := payload["reply_markup"].(map[string]interface{})
	rows := keyboard["inline_keyboard"].([]interface{})
	buttons := rows[0].([]interface{})
	if len(buttons) != 1 {
		t.Fatalf("expected one compact button, got %d", len(buttons))
	}
	button := buttons[0].(map[string]interface{})
	if button["text"] != "View on Vinted" || button["url"] != "https://example.test/item" {
		t.Fatalf("unexpected compact button: %#v", button)
	}
}

func TestRatingLabelAddsExactlyOneStar(t *testing.T) {
	tests := map[string]string{
		"4.9 (120)":     "⭐ 4.9 (120)",
		"⭐ 4.9 (120)":   "⭐ 4.9 (120)",
		"⭐ ⭐ 4.9 (120)": "⭐ 4.9 (120)",
		"":              "",
	}

	for input, expected := range tests {
		if actual := ratingLabel(input); actual != expected {
			t.Errorf("ratingLabel(%q) = %q, want %q", input, actual, expected)
		}
	}
}

func TestSendItemCompactSendsTextWithoutInvalidURLButton(t *testing.T) {
	var payload map[string]interface{}
	withTelegramServer(t, func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Fatalf("decode payload: %v", err)
		}
		w.WriteHeader(http.StatusOK)
	})

	SendItem("-1001", model.Item{Title: "Item", Price: "12 EUR", URL: "not-a-url"}, "monitor", "server", model.NotificationMessageStyleCompact)

	if _, ok := payload["reply_markup"]; ok {
		t.Fatalf("compact payload included keyboard for invalid URL: %#v", payload)
	}
	if payload["disable_web_page_preview"] != true {
		t.Fatalf("compact payload without a public image did not disable previews: %#v", payload)
	}
}

func TestSendItemUnknownStyleFallsBackToRich(t *testing.T) {
	withTelegramServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/bottest-token/sendPhoto" {
			t.Fatalf("unknown style did not use rich photo payload: %s", r.URL.Path)
		}
		w.WriteHeader(http.StatusOK)
	})

	SendItem("-1001", model.Item{
		Title:    "Item",
		Price:    "12 EUR",
		URL:      "https://example.test/item",
		ImageURL: "https://example.test/image.jpg",
	}, "monitor", "server", model.NotificationMessageStyle("unknown"))
}

func TestSendItemFallsBackToMessageWhenPhotoFails(t *testing.T) {
	var calls []string
	withTelegramServer(t, func(w http.ResponseWriter, r *http.Request) {
		calls = append(calls, r.URL.Path)
		if r.URL.Path == "/bottest-token/sendPhoto" {
			http.Error(w, "bad photo", http.StatusBadRequest)
			return
		}
		if r.URL.Path != "/bottest-token/sendMessage" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"ok":true}`))
	})

	SendItem("-1001", model.Item{
		MonitorID: 7,
		Title:     "Item",
		Price:     "12 EUR",
		URL:       "https://example.test/item",
		ImageURL:  "https://example.test/image.jpg",
	}, "monitor", "server", model.NotificationMessageStyleRich)

	if len(calls) != 2 {
		t.Fatalf("expected photo plus fallback message, got %v", calls)
	}
}

func TestSendItemRetriesPhotoTimeout(t *testing.T) {
	var calls int32
	var paths []string
	var pathsMu sync.Mutex
	withTelegramServer(t, func(w http.ResponseWriter, r *http.Request) {
		pathsMu.Lock()
		paths = append(paths, r.URL.Path)
		pathsMu.Unlock()
		if r.URL.Path != "/bottest-token/sendPhoto" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		if atomic.AddInt32(&calls, 1) == 1 {
			time.Sleep(50 * time.Millisecond)
			return
		}
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"ok":true}`))
	})
	httpClient.Timeout = 10 * time.Millisecond

	SendItem("-1001", model.Item{
		MonitorID: 7,
		Title:     "Item",
		Price:     "12 EUR",
		URL:       "https://example.test/item",
		ImageURL:  "https://example.test/image.jpg",
	}, "monitor", "server", model.NotificationMessageStyleRich)

	pathsMu.Lock()
	gotPaths := append([]string(nil), paths...)
	pathsMu.Unlock()
	if gotCalls := atomic.LoadInt32(&calls); gotCalls != 2 {
		t.Fatalf("expected timeout retry, got %d calls: %v", gotCalls, gotPaths)
	}
}

func TestSafeTelegramRequestErrorRedactsEndpoint(t *testing.T) {
	cause := fmt.Errorf("Post https://api.telegram.org/botsecret-token/sendPhoto: %w", errors.New("unexpected EOF"))
	err := safeTelegramRequestError(cause)
	if strings.Contains(err.Error(), "secret-token") {
		t.Fatalf("safe error exposed token: %q", err.Error())
	}
	if err.Error() != "telegram request failed" {
		t.Fatalf("safe error = %q", err.Error())
	}
}

func TestSendItemSkipsInvalidDashboardButton(t *testing.T) {
	var payload map[string]interface{}
	withTelegramServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/bottest-token/sendMessage" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Fatalf("decode payload: %v", err)
		}
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"ok":true}`))
	})

	SendItem("-1001", model.Item{
		MonitorID: 7,
		Title:     "Item",
		Price:     "12 EUR",
		URL:       "https://example.test/item",
	}, "monitor", "server", model.NotificationMessageStyleRich)

	keyboard := payload["reply_markup"].(map[string]interface{})
	rows := keyboard["inline_keyboard"].([]interface{})
	buttons := rows[0].([]interface{})
	if len(buttons) != 1 {
		t.Fatalf("expected only vinted button when dashboard URL is local, got %d", len(buttons))
	}
	button := buttons[0].(map[string]interface{})
	if button["text"] != "View on Vinted" {
		t.Fatalf("unexpected button: %v", button)
	}
}

func TestSendItemIncludesPublicDashboardButton(t *testing.T) {
	var payload map[string]interface{}
	withTelegramServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/bottest-token/sendMessage" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Fatalf("decode payload: %v", err)
		}
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"ok":true}`))
	})
	os.Setenv("DASHBOARD_URL", "https://dashboard.example.test")

	SendItem("-1001", model.Item{
		MonitorID: 7,
		Title:     "Item",
		Price:     "12 EUR",
		URL:       "https://example.test/item",
	}, "monitor", "server", model.NotificationMessageStyleRich)

	keyboard := payload["reply_markup"].(map[string]interface{})
	rows := keyboard["inline_keyboard"].([]interface{})
	buttons := rows[0].([]interface{})
	if len(buttons) != 2 {
		t.Fatalf("expected vinted and dashboard buttons, got %d", len(buttons))
	}
	button := buttons[1].(map[string]interface{})
	if button["url"] != "https://dashboard.example.test/monitors/7" {
		t.Fatalf("unexpected dashboard url: %v", button)
	}
}

func TestSendRetriesTelegramRateLimit(t *testing.T) {
	var calls int32
	withTelegramServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/bottest-token/sendMessage" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		if atomic.AddInt32(&calls, 1) == 1 {
			w.WriteHeader(http.StatusTooManyRequests)
			w.Write([]byte(`{"ok":false,"parameters":{"retry_after":0}}`))
			return
		}
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"ok":true}`))
	})

	SendStartup("-1001", "monitor")

	if calls != 2 {
		t.Fatalf("expected retry after 429, got %d calls", calls)
	}
}
