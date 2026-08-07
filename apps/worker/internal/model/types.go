package model

import (
	"database/sql"
	"time"
)

type NotificationMessageStyle string

const (
	NotificationMessageStyleRich    NotificationMessageStyle = "rich"
	NotificationMessageStyleCompact NotificationMessageStyle = "compact"
)

func NormalizeNotificationMessageStyle(style NotificationMessageStyle) NotificationMessageStyle {
	if style == NotificationMessageStyleCompact {
		return style
	}
	return NotificationMessageStyleRich
}

// Monitor represents a user-configured search monitor.
type Monitor struct {
	ID                    int
	UserID                string
	Name                  string
	Query                 string
	TitleOnly             bool
	AntiKeywords          *string
	QueryDelayMs          int
	QuietHoursEnabled     bool
	QuietHoursStartMinute int
	QuietHoursEndMinute   int
	QuietHoursMode        string
	QuietHoursDelayMs     int
	QuietHoursTimezone    string
	PriceMin              *int
	PriceMax              *int
	SizeID                *string
	CatalogIDs            *string
	BrandIDs              *string
	ColorIDs              *string
	StatusIDs             *string
	VideoGamePlatformIDs  *string
	Region                string
	AllowedCountries      *string
	MinSellerRating       *float64
	MinSellerRatingCount  *int
	Status                string
	DiscordWebhook        sql.NullString
	WebhookActive         bool
	TelegramChatID        sql.NullString
	TelegramActive        bool
	NotificationsEnabled  bool
	DedupeMonitorAlerts   bool
	TelegramMessageStyle  NotificationMessageStyle
	DiscordMessageStyle   NotificationMessageStyle
	BannedSellerIDs       []int64
	ProxyGroupID          *int
	ProxySource           string
	ProxyGroupName        sql.NullString
	ProxyGroupLimitBytes  *int64
	ProxyGroupRxBytes     int64
	ProxyGroupTxBytes     int64
	ProxyGroupResetAt     sql.NullTime
	Proxies               sql.NullString
	ServerProxyVersion    uint64
	FreeProxyVersion      uint64
	SuppressStartupNotice bool
	CreatedAt             time.Time
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
	ID                    int64     `json:"id"`
	MonitorID             int       `json:"monitor_id"`
	Title                 string    `json:"title"`
	Brand                 string    `json:"brand,omitempty"`
	Price                 string    `json:"price"`
	TotalPrice            string    `json:"total_price,omitempty"`
	Size                  string    `json:"size"`
	Condition             string    `json:"condition"`
	URL                   string    `json:"url"`
	ImageURL              string    `json:"image_url"`
	ExtraImages           []string  `json:"extra_images,omitempty"`
	Location              string    `json:"location"`
	Rating                string    `json:"rating,omitempty"`
	SellerRating          float64   `json:"-"`
	SellerRatingCount     int       `json:"-"`
	SellerRatingAvailable bool      `json:"-"`
	SellerID              int64     `json:"seller_id,omitempty"`
	SellerLogin           string    `json:"seller_login,omitempty"`
	SellerURL             string    `json:"seller_profile_url,omitempty"`
	FoundAt               time.Time `json:"found_at"`
}

type MonitorHealth struct {
	MonitorID       int    `json:"monitor_id"`
	TotalChecks     int64  `json:"total_checks"`
	TotalErrors     int64  `json:"total_errors"`
	ConsecutiveErrs int    `json:"consecutive_errors"`
	LastError       string `json:"last_error,omitempty"`
	LastErrorCode   string `json:"last_error_code,omitempty"`
	ProxyState      string `json:"proxy_state,omitempty"`
	RetryAt         string `json:"retry_at,omitempty"`
	ProxyLabel      string `json:"proxy_label,omitempty"`
	UpdatedAt       string `json:"updated_at"`
}

type MonitorRun struct {
	MonitorID    int
	Status       string
	StatusCode   int
	DurationMS   int
	ItemCount    int
	NewItemCount int
	ErrorMessage string
	ProxySource  string
	FetchSource  string
	Region       string
}

type MonitorItemDetection struct {
	MonitorID int
	ItemID    int64
	Source    string
	SeenAt    time.Time
}

type MonitorEvent struct {
	MonitorID int
	EventType string
	Severity  string
	Message   string
	Metadata  string
}

type AlertEvent struct {
	UserID        string
	MonitorID     int
	ItemID        int64
	Channel       string
	Status        string
	FailureReason string
	Metadata      string
}

// --- Vinted API response types ---

type VintedResponse struct {
	Items []VintedItem `json:"items"`
}

type VintedItem struct {
	ID             int64         `json:"id"`
	Title          string        `json:"title"`
	Description    string        `json:"description,omitempty"`
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
