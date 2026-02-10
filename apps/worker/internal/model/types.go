package model

import (
	"database/sql"
	"strings"
	"time"
)

type Monitor struct {
	ID             int
	Query          string
	PriceMin       *int
	PriceMax       *int
	SizeID         *string
	Status         string
	DiscordWebhook sql.NullString
	WebhookActive  bool
	CreatedAt      time.Time
}

type Item struct {
	ID        int64     `json:"id"`
	MonitorID int       `json:"monitor_id"`
	Title     string    `json:"title"`
	Price     string    `json:"price"`
	Size      string    `json:"size"`
	Condition string    `json:"condition"`
	URL       string    `json:"url"`
	ImageURL  string    `json:"image_url"`
	Location  string    `json:"location"`
	FoundAt   time.Time `json:"found_at"`
}

type VintedResponse struct {
	Items []VintedItem `json:"items"`
}

type VintedItem struct {
	ID        int64       `json:"id"`
	Title     string      `json:"title"`
	Price     VintedPrice `json:"price"`
	Url       string      `json:"url"`
	Photo     VintedPhoto `json:"photo"`
	SizeTitle string      `json:"size_title"`
	Size      string      `json:"size"`
	Condition string      `json:"status"`
}

type VintedPrice struct {
	Amount   string `json:"amount"`
	Currency string `json:"currency_code"`
}

type VintedPhoto struct {
	Url string `json:"url"`
}

func GetRegion(url string) string {
	url = strings.ToLower(url)
	if strings.Contains(url, ".de/") {
		return "🇩🇪 DE"
	}
	if strings.Contains(url, ".fr/") {
		return "🇫🇷 FR"
	}
	if strings.Contains(url, ".it/") {
		return "🇮🇹 IT"
	}
	if strings.Contains(url, ".es/") {
		return "🇪🇸 ES"
	}
	if strings.Contains(url, ".pl/") {
		return "🇵🇱 PL"
	}
	if strings.Contains(url, ".nl/") {
		return "🇳🇱 NL"
	}
	if strings.Contains(url, ".co.uk/") {
		return "🇬🇧 UK"
	}
	if strings.Contains(url, ".at/") {
		return "🇦🇹 AT"
	}
	if strings.Contains(url, ".be/") {
		return "🇧🇪 BE"
	}
	return "🇪🇺 EU"
}

func (v VintedItem) GetPriceString() string {
	return v.Price.Amount + " " + v.Price.Currency
}
