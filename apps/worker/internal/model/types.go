package model

import (
	"database/sql"
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
	Rating    string    `json:"rating,omitempty"`
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
	User      VintedUser  `json:"user"`
}

type VintedUser struct {
	ID    int64  `json:"id"`
	Login string `json:"login"`
}

type VintedPrice struct {
	Amount   string `json:"amount"`
	Currency string `json:"currency_code"`
}

type VintedPhoto struct {
	Url string `json:"url"`
}

type VintedItemDetail struct {
	ID   int64                `json:"id"`
	User VintedItemDetailUser `json:"user"`
}

type VintedItemDetailUser struct {
	ID           int64  `json:"id"`
	City         string `json:"city"`
	CountryTitle string `json:"country_title"`
}

func (v VintedItem) GetPriceString() string {
	return v.Price.Amount + " " + v.Price.Currency
}
