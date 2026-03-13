package model

import (
	"database/sql"
	"time"
)

// Monitor represents a user-configured search monitor.
type Monitor struct {
	ID             int
	Query          string
	PriceMin       *int
	PriceMax       *int
	SizeID         *string
	CatalogIDs     *string
	BrandIDs       *string
	ColorIDs       *string
	Region         string
	Status         string
	DiscordWebhook sql.NullString
	WebhookActive  bool
	ProxyGroupID   *int
	ProxyGroupName sql.NullString
	Proxies        sql.NullString
	CreatedAt      time.Time
}

var regionDomains = map[string]string{
	"de": "www.vinted.de",
	"fr": "www.vinted.fr",
	"it": "www.vinted.it",
	"es": "www.vinted.es",
	"nl": "www.vinted.nl",
	"pl": "www.vinted.pl",
	"pt": "www.vinted.pt",
	"be": "www.vinted.be",
	"at": "www.vinted.at",
	"lu": "www.vinted.lu",
	"uk": "www.vinted.co.uk",
	"cz": "www.vinted.cz",
	"sk": "www.vinted.sk",
	"lt": "www.vinted.lt",
	"se": "www.vinted.se",
	"dk": "www.vinted.dk",
	"ro": "www.vinted.ro",
	"hu": "www.vinted.hu",
	"hr": "www.vinted.hr",
	"fi": "www.vinted.fi",
	"ie": "www.vinted.ie",
	"si": "www.vinted.si",
	"ee": "www.vinted.ee",
	"lv": "www.vinted.lv",
	"gr": "www.vinted.gr",
}

func RegionDomain(region string) string {
	if d, ok := regionDomains[region]; ok {
		return d
	}
	return "www.vinted.de"
}

// Item represents a found Vinted listing stored in the database.
type Item struct {
	ID          int64     `json:"id"`
	MonitorID   int       `json:"monitor_id"`
	Title       string    `json:"title"`
	Brand       string    `json:"brand,omitempty"`
	Price       string    `json:"price"`
	TotalPrice  string    `json:"total_price,omitempty"`
	Size        string    `json:"size"`
	Condition   string    `json:"condition"`
	URL         string    `json:"url"`
	ImageURL    string    `json:"image_url"`
	ExtraImages []string  `json:"extra_images,omitempty"`
	Location    string    `json:"location"`
	Rating      string    `json:"rating,omitempty"`
	SellerID    int64     `json:"seller_id,omitempty"`
	FoundAt     time.Time `json:"found_at"`
}

type MonitorHealth struct {
	MonitorID       int    `json:"monitor_id"`
	TotalChecks     int64  `json:"total_checks"`
	TotalErrors     int64  `json:"total_errors"`
	ConsecutiveErrs int    `json:"consecutive_errors"`
	LastError       string `json:"last_error,omitempty"`
	UpdatedAt       string `json:"updated_at"`
}

// --- Vinted API response types ---

type VintedResponse struct {
	Items []VintedItem `json:"items"`
}

type VintedItem struct {
	ID             int64         `json:"id"`
	Title          string        `json:"title"`
	Price          VintedPrice   `json:"price"`
	TotalItemPrice *VintedPrice  `json:"total_item_price,omitempty"`
	Url            string        `json:"url"`
	Photo          VintedPhoto   `json:"photo"`
	Photos         []VintedPhoto `json:"photos,omitempty"`
	SizeTitle      string        `json:"size_title"`
	Size           string        `json:"size"`
	BrandTitle     string        `json:"brand_title,omitempty"`
	Condition      string        `json:"status"`
	User           VintedUser    `json:"user"`
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

type VintedUserDetailResponse struct {
	User VintedUserDetail `json:"user"`
}

type VintedUserDetail struct {
	ID                 int64   `json:"id"`
	Login              string  `json:"login"`
	CountryTitle       string  `json:"country_title"`
	CountryCode        string  `json:"country_iso_code"`
	FeedbackCount      int     `json:"feedback_count"`
	FeedbackReputation float64 `json:"feedback_reputation"`
}
