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

// RegionDomain returns the Vinted domain for a given region code.
func RegionDomain(region string) string {
	domains := map[string]string{
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
	if d, ok := domains[region]; ok {
		return d
	}
	return "www.vinted.de"
}

// Item represents a found Vinted listing stored in the database.
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
