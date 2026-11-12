package telegram

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

// The notice sent when a watch ends is plain title-and-text. Its listing
// title comes from Vinted, so markup in it must arrive escaped.
func TestPriceWatchStoppedNoticeIsSentAsEscapedText(t *testing.T) {
	var method string
	var body struct {
		ChatID    string `json:"chat_id"`
		Text      string `json:"text"`
		ParseMode string `json:"parse_mode"`
	}
	withTelegramServer(t, func(w http.ResponseWriter, r *http.Request) {
		method = r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:]
		raw, _ := io.ReadAll(io.LimitReader(r.Body, 64*1024))
		if err := json.Unmarshal(raw, &body); err != nil {
			t.Errorf("decode telegram body: %v", err)
		}
		_, _ = w.Write([]byte(`{"ok":true,"result":{}}`))
	})

	message := "“Coat <b>new</b>” was sold or is no longer for sale, so Vintrack stopped watching it.\n" +
		"Last price: 15.00 EUR\nhttps://www.vinted.de/items/300-coat"
	result := SendStatusAttempt(context.Background(), "12345", "Price Watch ended: listing sold", message)
	if !result.Success {
		t.Fatalf("delivery failed: %+v", result)
	}
	if method != "sendMessage" || body.ChatID != "12345" || body.ParseMode != "HTML" {
		t.Fatalf("unexpected request: method=%q body=%+v", method, body)
	}
	want := "<b>Price Watch ended: listing sold</b>\n" +
		"“Coat &lt;b&gt;new&lt;/b&gt;” was sold or is no longer for sale, so Vintrack stopped watching it.\n" +
		"Last price: 15.00 EUR\nhttps://www.vinted.de/items/300-coat"
	if body.Text != want {
		t.Fatalf("text = %q, want %q", body.Text, want)
	}
}
