package discord

import (
	"strings"
	"testing"
	"time"

	"vintrack-worker/internal/model"
)

func TestBuildItemWebhookPayloadUsesStructuredEmbedAndGallery(t *testing.T) {
	foundAt := time.Unix(1_720_000_000, 0).UTC()
	item := model.Item{
		ID:          42,
		MonitorID:   7,
		Title:       "Nike Dunk Low",
		Brand:       "Nike",
		Price:       "85.00 EUR",
		TotalPrice:  "90.20 EUR",
		Size:        "42",
		Condition:   "Very good",
		URL:         "https://www.vinted.de/items/42",
		ImageURL:    "https://images.example/item.jpg",
		ExtraImages: []string{"https://images.example/extra.jpg"},
		Location:    "Germany",
		Rating:      "4.9 (120)",
		SellerLogin: "seller",
		SellerURL:   "https://www.vinted.de/member/5-seller",
		FoundAt:     foundAt,
	}

	payload := buildItemWebhookPayload(item, "Dunks", "free", model.NotificationMessageStyleRich)
	embeds, ok := payload["embeds"].([]map[string]interface{})
	if !ok || len(embeds) != 2 {
		t.Fatalf("expected item embed and one gallery embed, got %#v", payload["embeds"])
	}

	embed := embeds[0]
	if embed["title"] != item.Title {
		t.Fatalf("expected title %q, got %#v", item.Title, embed["title"])
	}
	if embed["timestamp"] != foundAt.Format(time.RFC3339) {
		t.Fatalf("expected detection timestamp, got %#v", embed["timestamp"])
	}
	description, _ := embed["description"].(string)
	for _, expectedLink := range []string{item.URL, item.SellerURL, "/monitors/7"} {
		if !strings.Contains(description, expectedLink) {
			t.Fatalf("expected description to contain %q: %q", expectedLink, description)
		}
	}
	if _, ok := embed["image"]; !ok {
		t.Fatal("expected primary image in item embed")
	}
	fields, ok := embed["fields"].([]map[string]interface{})
	if !ok {
		t.Fatalf("expected structured item fields, got %#v", embed["fields"])
	}
	fieldsByName := make(map[string]interface{}, len(fields))
	for _, field := range fields {
		name, _ := field["name"].(string)
		fieldsByName[name] = field["value"]
	}
	if fieldsByName["Location"] != item.Location {
		t.Fatalf("expected location %q, got %#v", item.Location, fieldsByName["Location"])
	}
	if fieldsByName["Seller rating"] != item.Rating {
		t.Fatalf("expected rating %q, got %#v", item.Rating, fieldsByName["Seller rating"])
	}
	if _, ok := embeds[1]["fields"]; ok {
		t.Fatal("gallery embed must not duplicate item fields")
	}
	if _, ok := embeds[1]["image"]; !ok {
		t.Fatal("expected image in gallery embed")
	}
}

func TestBuildItemWebhookPayloadLimitsGalleryToThreeImages(t *testing.T) {
	payload := buildItemWebhookPayload(model.Item{
		URL:      "https://www.vinted.de/items/42",
		ImageURL: "https://images.example/main.jpg",
		ExtraImages: []string{
			"https://images.example/one.jpg",
			"https://images.example/two.jpg",
			"https://images.example/three.jpg",
		},
	}, "Monitor", "server", model.NotificationMessageStyleRich)

	embeds := payload["embeds"].([]map[string]interface{})
	if len(embeds) != 3 {
		t.Fatalf("expected a maximum of three image embeds, got %d", len(embeds))
	}
}

func TestBuildItemWebhookPayloadCompactUsesMinimalEmbed(t *testing.T) {
	item := model.Item{
		MonitorID:   7,
		Title:       "Nike Dunk Low",
		Brand:       "Nike",
		Price:       "85.00 EUR",
		TotalPrice:  "90.20 EUR",
		Size:        "42",
		Condition:   "Very good",
		URL:         "https://www.vinted.de/items/42",
		ImageURL:    "https://images.example/item.jpg",
		ExtraImages: []string{"https://images.example/extra.jpg"},
		Location:    "Germany",
		Rating:      "4.9 (120)",
		SellerLogin: "seller",
		SellerURL:   "https://www.vinted.de/member/5-seller",
		FoundAt:     time.Unix(1_720_000_000, 0).UTC(),
	}

	payload := buildItemWebhookPayload(item, "Dunks", "free", model.NotificationMessageStyleCompact)
	embeds := payload["embeds"].([]map[string]interface{})
	if len(embeds) != 1 {
		t.Fatalf("expected one compact embed, got %d", len(embeds))
	}
	embed := embeds[0]
	if embed["title"] != item.Title || embed["url"] != item.URL {
		t.Fatalf("unexpected compact title or URL: %#v", embed)
	}
	if embed["description"] != "**85.00 EUR**\n90.20 EUR total" {
		t.Fatalf("unexpected compact price: %#v", embed["description"])
	}
	thumbnail := embed["thumbnail"].(map[string]string)
	if thumbnail["url"] != item.ImageURL {
		t.Fatalf("unexpected compact thumbnail: %#v", thumbnail)
	}
	author := embed["author"].(map[string]string)
	if author["name"] != "New match • Dunks" {
		t.Fatalf("unexpected compact author: %#v", author)
	}
	fields := embed["fields"].([]map[string]interface{})
	fieldsByName := make(map[string]interface{}, len(fields))
	for _, field := range fields {
		name, _ := field["name"].(string)
		fieldsByName[name] = field["value"]
	}
	for name, expected := range map[string]string{
		"Brand": item.Brand, "Size": item.Size, "Condition": item.Condition,
		"Region": item.Location, "Seller rating": item.Rating,
	} {
		if fieldsByName[name] != expected {
			t.Fatalf("compact field %q = %#v, want %q", name, fieldsByName[name], expected)
		}
	}
	for _, excluded := range []string{"image", "footer", "timestamp"} {
		if _, ok := embed[excluded]; ok {
			t.Fatalf("compact embed included %q: %#v", excluded, embed)
		}
	}
}

func TestBuildItemWebhookPayloadCompactOmitsInvalidURL(t *testing.T) {
	payload := buildItemWebhookPayload(model.Item{
		Title: "Item",
		Price: "10.00 EUR",
		URL:   "not-a-url",
	}, "Monitor", "server", model.NotificationMessageStyleCompact)

	embed := payload["embeds"].([]map[string]interface{})[0]
	if _, ok := embed["url"]; ok {
		t.Fatalf("compact embed included invalid URL: %#v", embed)
	}
}

func TestBuildItemWebhookPayloadUnknownStyleFallsBackToRich(t *testing.T) {
	payload := buildItemWebhookPayload(model.Item{
		Title:    "Item",
		Price:    "10.00 EUR",
		URL:      "https://www.vinted.de/items/42",
		ImageURL: "https://images.example/item.jpg",
	}, "Monitor", "server", model.NotificationMessageStyle("unknown"))

	embed := payload["embeds"].([]map[string]interface{})[0]
	if _, ok := embed["image"]; !ok {
		t.Fatalf("unknown style did not fall back to rich: %#v", embed)
	}
}

func TestBuildFieldsProvidesStableCoreFields(t *testing.T) {
	fields := buildFields(model.Item{Price: "10.00 EUR"})
	if len(fields) != 3 {
		t.Fatalf("expected three core fields, got %d", len(fields))
	}
	if fields[1]["value"] != "Not specified" || fields[2]["value"] != "Not specified" {
		t.Fatalf("expected empty size and condition fallbacks, got %#v", fields)
	}
}
