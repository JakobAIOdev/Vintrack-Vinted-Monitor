package vinted

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"log"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"vintrack-vinted/internal/session"

	http "github.com/bogdanfinn/fhttp"
	"github.com/bogdanfinn/fhttp/cookiejar"
	tls_client "github.com/bogdanfinn/tls-client"
	"github.com/bogdanfinn/tls-client/profiles"
)

const defaultUserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36"
const defaultSecChUA = `"Google Chrome";v="146", "Chromium";v="146", "Not_A Brand";v="99"`
const warmupReuseWindow = 10 * time.Minute
const maxWarmupResponseBytes = 2 * 1024 * 1024
const maxFilterSearchResponseBytes = 512 * 1024
const maxBrandPageInspectionBytes = 512 * 1024
const maxBrandPageRedirects = 3

type Client struct {
	httpClient      vintedHTTPClient
	session         *session.VintedSession
	csrfToken       string
	anonID          string
	warmedUp        bool
	catalogWarmedUp bool
}

type vintedHTTPClient interface {
	Do(req *http.Request) (*http.Response, error)
	GetCookies(u *url.URL) []*http.Cookie
	SetCookies(u *url.URL, cookies []*http.Cookie)
	GetFollowRedirect() bool
	SetFollowRedirect(followRedirect bool)
}

func NewClient(sess *session.VintedSession) (*Client, error) {
	jar, err := cookiejar.New(nil)
	if err != nil {
		return nil, fmt.Errorf("create cookie jar: %w", err)
	}

	options := []tls_client.HttpClientOption{
		tls_client.WithTimeoutSeconds(15),
		tls_client.WithClientProfile(profiles.Chrome_146),
		tls_client.WithCookieJar(jar),
	}

	httpClient, err := tls_client.NewHttpClient(tls_client.NewNoopLogger(), options...)
	if err != nil {
		return nil, fmt.Errorf("create tls client: %w", err)
	}

	sessCopy := *sess
	return &Client{httpClient: httpClient, session: &sessCopy}, nil
}

func (c *Client) userAgent() string {
	if strings.TrimSpace(c.session.UserAgent) != "" {
		return strings.TrimSpace(c.session.UserAgent)
	}
	return defaultUserAgent
}

func (c *Client) injectStoredCookies() {
	if strings.TrimSpace(c.session.CookieHeader) == "" {
		return
	}
	domainURL, _ := url.Parse(fmt.Sprintf("https://%s/", c.session.Domain))
	c.httpClient.SetCookies(domainURL, parseCookieHeader(c.session.CookieHeader))
}

func (c *Client) injectCachedSessionContext() {
	if strings.TrimSpace(c.session.CsrfToken) != "" {
		c.csrfToken = strings.TrimSpace(c.session.CsrfToken)
	}
	if strings.TrimSpace(c.session.AnonID) == "" {
		return
	}

	c.anonID = strings.TrimSpace(c.session.AnonID)
	domainURL, _ := url.Parse(fmt.Sprintf("https://%s/", c.session.Domain))
	c.httpClient.SetCookies(domainURL, []*http.Cookie{{
		Name:  "anon_id",
		Value: c.anonID,
		Path:  "/",
	}})
}

func (c *Client) injectAuthCookie() {
	if strings.TrimSpace(c.session.AccessToken) == "" && strings.TrimSpace(c.session.RefreshToken) == "" {
		return
	}

	authHost := authCookieHost(c.session.Domain)
	domainURL, _ := url.Parse(fmt.Sprintf("https://%s/", authHost))
	cookies := make([]*http.Cookie, 0, 6)
	for _, domain := range authCookieDomains(authHost) {
		cookies = append(cookies,
			authCookie("access_token_web", c.session.AccessToken, domain),
			authCookie("refresh_token_web", c.session.RefreshToken, domain),
		)
	}
	c.httpClient.SetCookies(domainURL, cookies)
}

func authCookieDomains(domain string) []string {
	host := authCookieHost(domain)
	if host == "" {
		return []string{""}
	}

	return []string{"", "." + host, "." + strings.TrimPrefix(host, "www.")}
}

func authCookieHost(domain string) string {
	host := strings.TrimPrefix(strings.ToLower(strings.TrimSpace(domain)), ".")
	if host == "" || strings.HasPrefix(host, "www.") {
		return host
	}
	return "www." + host
}

func authCookie(name, value, domain string) *http.Cookie {
	cookie := &http.Cookie{
		Name:     name,
		Value:    strings.TrimSpace(value),
		Path:     "/",
		Domain:   domain,
		Secure:   true,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
	}
	if cookie.Value == "" {
		cookie.Expires = time.Unix(1, 0).UTC()
		cookie.MaxAge = -1
	}
	return cookie
}

func (c *Client) apiHeaders() http.Header {
	now := time.Now().UnixMilli()
	h := http.Header{
		"User-Agent":         {c.userAgent()},
		"Accept":             {"application/json, text/plain, */*"},
		"Accept-Language":    {"de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7"},
		"Cache-Control":      {"no-cache"},
		"Pragma":             {"no-cache"},
		"Locale":             {c.locale()},
		"X-Platform":         {"web"},
		"X-Portal":           {c.portal()},
		"X-Debug-Info":       {"v4"},
		"X-Local-Time":       {strconv.FormatInt(now, 10)},
		"Origin":             {fmt.Sprintf("https://%s", c.session.Domain)},
		"Referer":            {fmt.Sprintf("https://%s/", c.session.Domain)},
		"Sec-Ch-Ua":          {defaultSecChUA},
		"Sec-Ch-Ua-Mobile":   {"?0"},
		"Sec-Ch-Ua-Platform": {`"macOS"`},
		"Sec-Fetch-Dest":     {"empty"},
		"Sec-Fetch-Mode":     {"cors"},
		"Sec-Fetch-Site":     {"same-origin"},
	}
	if c.csrfToken != "" {
		h.Set("X-Csrf-Token", c.csrfToken)
	}
	if c.anonID != "" {
		h.Set("X-Anon-Id", c.anonID)
	}
	return h
}

func (c *Client) portal() string {
	switch {
	case strings.Contains(c.session.Domain, "vinted.de"):
		return "de"
	case strings.Contains(c.session.Domain, "vinted.fr"):
		return "fr"
	case strings.Contains(c.session.Domain, "vinted.es"):
		return "es"
	case strings.Contains(c.session.Domain, "vinted.it"):
		return "it"
	case strings.Contains(c.session.Domain, "vinted.nl"):
		return "nl"
	case strings.Contains(c.session.Domain, "vinted.pl"):
		return "pl"
	case strings.Contains(c.session.Domain, "vinted.co.uk"):
		return "uk"
	case strings.Contains(c.session.Domain, "vinted.ie"):
		return "ie"
	case strings.Contains(c.session.Domain, "vinted.cz"):
		return "cz"
	case strings.Contains(c.session.Domain, "vinted.com"):
		return "com"
	default:
		return "de"
	}
}

func (c *Client) apiHeadersWithBody() http.Header {
	h := c.apiHeaders()
	h.Set("Content-Type", "application/json")
	return h
}

func (c *Client) locale() string {
	switch {
	case strings.Contains(c.session.Domain, "vinted.de"):
		return "de-DE"
	case strings.Contains(c.session.Domain, "vinted.fr"):
		return "fr-FR"
	case strings.Contains(c.session.Domain, "vinted.es"):
		return "es-ES"
	case strings.Contains(c.session.Domain, "vinted.it"):
		return "it-IT"
	case strings.Contains(c.session.Domain, "vinted.nl"):
		return "nl-NL"
	case strings.Contains(c.session.Domain, "vinted.pl"):
		return "pl-PL"
	case strings.Contains(c.session.Domain, "vinted.co.uk"):
		return "en-GB"
	case strings.Contains(c.session.Domain, "vinted.ie"):
		return "en-IE"
	case strings.Contains(c.session.Domain, "vinted.cz"):
		return "cs-CZ"
	case strings.Contains(c.session.Domain, "vinted.com"):
		return "en-US"
	default:
		return "de-DE"
	}
}

func (c *Client) WarmUp() error {
	return c.warmUpPage("/", false)
}

func (c *Client) ForceWarmUp() error {
	return c.warmUpPage("/", true)
}

func (c *Client) CatalogWarmUp() error {
	return c.warmUpPage("/catalog", false)
}

func (c *Client) ForceCatalogWarmUp() error {
	return c.warmUpPage("/catalog", true)
}

func (c *Client) warmUpPage(pagePath string, force bool) error {
	isCatalog := pagePath == "/catalog"
	if !force && ((!isCatalog && c.warmedUp) || (isCatalog && c.catalogWarmedUp)) {
		return nil
	}

	if force {
		c.warmedUp = false
		c.catalogWarmedUp = false
		c.csrfToken = ""
		c.anonID = ""
	}

	c.injectStoredCookies()
	c.injectAuthCookie()
	if !force {
		c.injectCachedSessionContext()
	}

	if !force && !isCatalog && c.canReuseWarmup() {
		c.warmedUp = true
		log.Printf("[vinted] reused cached warmup for %s, csrf=%v, anon_id=%v", c.session.Domain, c.csrfToken != "", c.anonID != "")
		return nil
	}

	u := fmt.Sprintf("https://%s%s", c.session.Domain, pagePath)
	req, _ := http.NewRequest("GET", u, nil)
	req.Header = http.Header{
		"User-Agent":      {c.userAgent()},
		"Accept":          {"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"},
		"Accept-Language": {c.locale() + ",en;q=0.8"},
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("warmup %s: %w", pagePath, err)
	}
	body, readErr := io.ReadAll(io.LimitReader(resp.Body, maxWarmupResponseBytes+1))
	resp.Body.Close()
	if readErr != nil {
		return fmt.Errorf("read warmup %s: %w", pagePath, readErr)
	}
	if len(body) > maxWarmupResponseBytes {
		return fmt.Errorf("warmup %s response exceeds %d bytes", pagePath, maxWarmupResponseBytes)
	}
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusBadRequest {
		return fmt.Errorf("warmup %s returned HTTP %d", pagePath, resp.StatusCode)
	}

	csrfPatterns := []*regexp.Regexp{
		regexp.MustCompile(`CSRF_TOKEN\\?":\s*\\?"([^"\\]+)`),
		regexp.MustCompile(`<meta\s+name="csrf-token"\s+content="([^"]+)"`),
		regexp.MustCompile(`<meta\s+content="([^"]+)"\s+name="csrf-token"`),
		regexp.MustCompile(`"csrfToken"\s*:\s*"([^"]+)"`),
		regexp.MustCompile(`"csrf_token"\s*:\s*"([^"]+)"`),
	}
	for _, re := range csrfPatterns {
		if m := re.FindSubmatch(body); len(m) > 1 {
			c.csrfToken = string(m[1])
			log.Printf("[vinted] extracted CSRF token: %s...", truncate(c.csrfToken, 20))
			break
		}
	}
	if c.csrfToken == "" {
		log.Printf("[vinted] WARNING: no CSRF token found in homepage HTML (body length: %d)", len(body))
	}

	domainURL, _ := url.Parse(fmt.Sprintf("https://%s/", c.session.Domain))
	for _, ck := range c.httpClient.GetCookies(domainURL) {
		if ck.Name == "anon_id" {
			c.anonID = ck.Value
			break
		}
	}

	c.injectAuthCookie()
	c.rememberWarmupState()

	c.warmedUp = true
	if isCatalog {
		c.catalogWarmedUp = true
	}
	log.Printf("[vinted] warmup done for %s path=%s csrf=%v anon_id=%v", c.session.Domain, pagePath, c.csrfToken != "", c.anonID != "")
	return nil
}

func (c *Client) canReuseWarmup() bool {
	warmedAt := strings.TrimSpace(c.session.WarmedAt)
	if warmedAt == "" {
		return false
	}

	parsed, err := time.Parse(time.RFC3339, warmedAt)
	if err != nil {
		return false
	}
	if time.Since(parsed) > warmupReuseWindow {
		return false
	}

	return c.csrfToken != "" || c.anonID != "" || strings.TrimSpace(c.session.CookieHeader) != ""
}

func (c *Client) rememberWarmupState() {
	if c.csrfToken != "" {
		c.session.CsrfToken = c.csrfToken
	}
	if c.anonID != "" {
		c.session.AnonID = c.anonID
	}
	c.session.WarmedAt = time.Now().UTC().Format(time.RFC3339)

	domainURL, _ := url.Parse(fmt.Sprintf("https://%s/", c.session.Domain))
	serialized := serializeCookies(c.httpClient.GetCookies(domainURL))
	if serialized != "" {
		c.session.CookieHeader = serialized
	}
}

func (c *Client) GetAccessToken() string {
	return c.session.AccessToken
}

type AccountInfo struct {
	ID          int64  `json:"id"`
	Login       string `json:"login"`
	PhotoURL    string `json:"photo_url"`
	ItemCount   int    `json:"item_count"`
	GivenRating string `json:"feedback_reputation"`
	CountryCode string `json:"country_title"`
}

type SellerInfo struct {
	Location string
	Rating   string
}

type sellerInfoCache struct {
	mu    sync.RWMutex
	cache map[int64]SellerInfo
}

var globalSellerCache = &sellerInfoCache{
	cache: make(map[int64]SellerInfo),
}

func (c *sellerInfoCache) Get(userID int64) (SellerInfo, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	info, ok := c.cache[userID]
	return info, ok
}

func (c *sellerInfoCache) Set(userID int64, info SellerInfo) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.cache[userID] = info
}

type VintedPrice struct {
	Amount   string `json:"amount"`
	Currency string `json:"currency_code"`
}

type VintedPhoto struct {
	ID             int64  `json:"id,omitempty"`
	Orientation    int    `json:"orientation,omitempty"`
	ImageNo        int    `json:"image_no,omitempty"`
	Width          int    `json:"width,omitempty"`
	Height         int    `json:"height,omitempty"`
	IsMain         bool   `json:"is_main,omitempty"`
	Url            string `json:"url"`
	FullSizeURL    string `json:"full_size_url,omitempty"`
	HighResolution struct {
		ID          string `json:"id,omitempty"`
		Timestamp   int64  `json:"timestamp,omitempty"`
		Orientation int    `json:"orientation,omitempty"`
	} `json:"high_resolution,omitempty"`
}

type VintedUser struct {
	ID    int64  `json:"id"`
	Login string `json:"login"`
}

type FavoritesPagination struct {
	CurrentPage   int         `json:"current_page"`
	TotalPages    int         `json:"total_pages"`
	TotalEntries  int         `json:"total_entries"`
	PerPage       int         `json:"per_page"`
	NextPageToken interface{} `json:"next_page_token,omitempty"`
}

type FavoritesItem struct {
	ID             int64         `json:"id"`
	Title          string        `json:"title"`
	Price          VintedPrice   `json:"price"`
	TotalItemPrice *VintedPrice  `json:"total_item_price,omitempty"`
	Url            string        `json:"url"`
	Photo          VintedPhoto   `json:"photo"`
	Photos         []VintedPhoto `json:"photos,omitempty"`
	SizeTitle      string        `json:"size_title"`
	BrandTitle     string        `json:"brand_title,omitempty"`
	Status         string        `json:"status"`
	User           VintedUser    `json:"user"`
	Location       string        `json:"location,omitempty"`
	Rating         string        `json:"rating,omitempty"`
}

type VintedItemDetailResponse struct {
	Item struct {
		ID                    int64           `json:"id"`
		Title                 string          `json:"title"`
		Description           string          `json:"description"`
		BrandID               int64           `json:"brand_id"`
		Brand                 string          `json:"brand"`
		SizeID                int64           `json:"size_id"`
		CatalogID             int64           `json:"catalog_id"`
		ISBN                  *string         `json:"isbn"`
		IsUnisex              bool            `json:"is_unisex"`
		PriceNumeric          *float64        `json:"price_numeric"`
		Price                 VintedPrice     `json:"price"`
		Currency              string          `json:"currency"`
		PackageSizeID         int64           `json:"package_size_id"`
		ShipmentPrices        interface{}     `json:"shipment_prices"`
		ColorIDs              []int64         `json:"color_ids"`
		ItemAttributes        []ItemAttribute `json:"item_attributes"`
		Photos                []VintedPhoto   `json:"photos"`
		TotalItemPrice        *VintedPrice    `json:"total_item_price"`
		MeasurementLength     interface{}     `json:"measurement_length"`
		MeasurementWidth      interface{}     `json:"measurement_width"`
		Manufacturer          interface{}     `json:"manufacturer"`
		ManufacturerLabelling interface{}     `json:"manufacturer_labelling"`
		User                  struct {
			ID                 int64   `json:"id"`
			Login              string  `json:"login"`
			CountryTitle       string  `json:"country_title"`
			CountryCode        string  `json:"country_iso_code"`
			FeedbackCount      int     `json:"feedback_count"`
			FeedbackReputation float64 `json:"feedback_reputation"`
		} `json:"user"`
	} `json:"item"`
}

type FavoritesResponse struct {
	Items      []FavoritesItem     `json:"items"`
	Pagination FavoritesPagination `json:"pagination"`
}

type ItemAttribute struct {
	Code string  `json:"code"`
	IDs  []int64 `json:"ids,omitempty"`
}

type WardrobePagination struct {
	CurrentPage  int `json:"current_page"`
	TotalPages   int `json:"total_pages"`
	TotalEntries int `json:"total_entries"`
	PerPage      int `json:"per_page"`
}

type WardrobePushUp struct {
	NextPushUpTime string `json:"next_push_up_time"`
}

type WardrobeItem struct {
	ID                int64           `json:"id"`
	Title             string          `json:"title"`
	Brand             string          `json:"brand,omitempty"`
	IsDraft           bool            `json:"is_draft"`
	IsClosed          bool            `json:"is_closed"`
	IsReserved        bool            `json:"is_reserved"`
	IsHidden          bool            `json:"is_hidden"`
	Promoted          bool            `json:"promoted"`
	CanPushUp         bool            `json:"can_push_up"`
	CanEdit           bool            `json:"can_edit"`
	StatsVisible      bool            `json:"stats_visible"`
	ViewCount         int             `json:"view_count"`
	FavouriteCount    int             `json:"favourite_count"`
	Status            string          `json:"status"`
	Size              string          `json:"size"`
	URL               string          `json:"url"`
	Path              string          `json:"path"`
	ItemClosingAction *string         `json:"item_closing_action"`
	Price             VintedPrice     `json:"price"`
	ServiceFee        *VintedPrice    `json:"service_fee"`
	TotalItemPrice    *VintedPrice    `json:"total_item_price"`
	PushUp            *WardrobePushUp `json:"push_up"`
	Photos            []VintedPhoto   `json:"photos"`
}

type WardrobeResponse struct {
	Items      []WardrobeItem      `json:"items"`
	Pagination *WardrobePagination `json:"pagination,omitempty"`
}

type InboxUserPhoto struct {
	URL string `json:"url"`
}

type InboxUser struct {
	ID    int64           `json:"id"`
	Login string          `json:"login"`
	Photo *InboxUserPhoto `json:"photo,omitempty"`
}

type InboxItemPhoto struct {
	ID  int64  `json:"id"`
	URL string `json:"url"`
}

type InboxConversation struct {
	ID                   int64            `json:"id"`
	ItemCount            int              `json:"item_count"`
	IsDeletionRestricted bool             `json:"is_deletion_restricted"`
	Description          string           `json:"description"`
	Unread               bool             `json:"unread"`
	UpdatedAt            string           `json:"updated_at"`
	OppositeUser         InboxUser        `json:"opposite_user"`
	ItemPhotos           []InboxItemPhoto `json:"item_photos"`
}

type InboxResponse struct {
	Code            int                 `json:"code,omitempty"`
	Conversations   []InboxConversation `json:"conversations"`
	Pagination      FavoritesPagination `json:"pagination"`
	WebsocketUserID string              `json:"websocket_user_id,omitempty"`
}

type NotificationPhoto struct {
	URL string `json:"url"`
}

type NotificationEntry struct {
	ID            string             `json:"id"`
	Body          string             `json:"body"`
	EntryType     int                `json:"entry_type"`
	IsRead        bool               `json:"is_read"`
	Link          string             `json:"link"`
	URL           string             `json:"url,omitempty"`
	Photo         *NotificationPhoto `json:"photo,omitempty"`
	SmallPhotoURL string             `json:"small_photo_url,omitempty"`
	SubjectID     int64              `json:"subject_id,omitempty"`
	UpdatedAt     string             `json:"updated_at,omitempty"`
	UserID        int64              `json:"user_id,omitempty"`
}

type NotificationsResponse struct {
	Code          int                 `json:"code,omitempty"`
	Notifications []NotificationEntry `json:"notifications"`
	Pagination    FavoritesPagination `json:"pagination"`
}

type FilterOption struct {
	ID    string `json:"id"`
	Label string `json:"label"`
}

type BrandPageResolution struct {
	ID           string `json:"id"`
	Label        string `json:"label"`
	CanonicalURL string `json:"canonical_url"`
}

type filterSearchError struct {
	Operation  string
	StatusCode int
	Err        error
}

func (e *filterSearchError) Error() string {
	if e.Err != nil {
		return fmt.Sprintf("%s failed: %v", e.Operation, e.Err)
	}
	if e.StatusCode > 0 {
		return fmt.Sprintf("%s failed with HTTP %d", e.Operation, e.StatusCode)
	}
	return fmt.Sprintf("%s failed", e.Operation)
}

func (e *filterSearchError) Unwrap() error {
	return e.Err
}

type filterOptionEntry struct {
	ID    interface{} `json:"id"`
	Value interface{} `json:"value"`
	Code  interface{} `json:"code"`
	Title string      `json:"title"`
	Label string      `json:"label"`
	Name  string      `json:"name"`
}

type filterOptionsPayload struct {
	Options []filterOptionEntry `json:"options"`
	Filters []filterOptionEntry `json:"filters"`
	Facets  []filterOptionEntry `json:"facets"`
}

var brandSearchDomains = map[string]string{
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
	"ie": "www.vinted.ie",
	"cz": "www.vinted.cz",
	"sk": "www.vinted.sk",
	"lt": "www.vinted.lt",
	"se": "www.vinted.se",
	"dk": "www.vinted.dk",
	"ro": "www.vinted.ro",
	"hu": "www.vinted.hu",
	"hr": "www.vinted.hr",
	"fi": "www.vinted.fi",
}

func DomainForRegion(region string) (string, bool) {
	domain, ok := brandSearchDomains[strings.ToLower(strings.TrimSpace(region))]
	return domain, ok
}

type userWrapper struct {
	User AccountInfo `json:"user"`
}

func parseUserIDFromJWT(token string) (int64, string) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return 0, ""
	}
	payload := parts[1]
	switch len(payload) % 4 {
	case 2:
		payload += "=="
	case 3:
		payload += "="
	}
	decoded, err := base64.URLEncoding.DecodeString(payload)
	if err != nil {
		return 0, ""
	}
	var claims map[string]interface{}
	if err := json.Unmarshal(decoded, &claims); err != nil {
		return 0, ""
	}
	parseClaim := func(value interface{}) int64 {
		switch typed := value.(type) {
		case string:
			parsed, _ := strconv.ParseInt(typed, 10, 64)
			return parsed
		case float64:
			if typed > 0 && typed == float64(int64(typed)) {
				return int64(typed)
			}
		}
		return 0
	}

	var userID int64
	if actor, ok := claims["act"].(map[string]interface{}); ok {
		userID = parseClaim(actor["sub"])
	}
	if userID == 0 {
		userID = parseClaim(claims["sub"])
	}
	if userID == 0 {
		userID = parseClaim(claims["account_id"])
	}
	return userID, fmt.Sprintf("%d", userID)
}

func (c *Client) GetAccountInfo() (*AccountInfo, error) {
	if err := c.WarmUp(); err != nil {
		log.Printf("[vinted] warmup failed: %v", err)
	}

	jwtUserID, _ := parseUserIDFromJWT(c.session.AccessToken)

	if jwtUserID > 0 {
		userURL := fmt.Sprintf("https://%s/api/v2/users/%d", c.session.Domain, jwtUserID)
		req, err := http.NewRequest("GET", userURL, nil)
		if err == nil {
			req.Header = c.apiHeaders()
			resp, err := c.httpClient.Do(req)
			if err == nil {
				defer resp.Body.Close()
				body, _ := io.ReadAll(resp.Body)
				log.Printf("[vinted] GET /api/v2/users/%d -> %d (%.200s)", jwtUserID, resp.StatusCode, string(body))

				if resp.StatusCode == 200 {
					var wrapper userWrapper
					if err := json.Unmarshal(body, &wrapper); err == nil && wrapper.User.ID > 0 {
						return &wrapper.User, nil
					}
					var info AccountInfo
					if err := json.Unmarshal(body, &info); err == nil && info.ID > 0 {
						return &info, nil
					}
					var raw map[string]interface{}
					if err := json.Unmarshal(body, &raw); err == nil {
						if userMap, ok := raw["user"].(map[string]interface{}); ok {
							raw = userMap
						}
						login, _ := raw["login"].(string)
						photo, _ := raw["photo"].(map[string]interface{})
						photoURL := ""
						if photo != nil {
							photoURL, _ = photo["url"].(string)
						}
						return &AccountInfo{
							ID:       jwtUserID,
							Login:    login,
							PhotoURL: photoURL,
						}, nil
					}
				}

				if resp.StatusCode == 401 || resp.StatusCode == 403 {
					log.Printf("[vinted] /users/%d rejected with HTTP %d, trying /users/current", jwtUserID, resp.StatusCode)
				}
			}
		}
	}

	currentURL := fmt.Sprintf("https://%s/api/v2/users/current", c.session.Domain)
	req, err := http.NewRequest("GET", currentURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header = c.apiHeaders()

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetch current user: %w", err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	log.Printf("[vinted] GET /api/v2/users/current -> %d (%.300s)", resp.StatusCode, string(body))

	if resp.StatusCode == 401 || resp.StatusCode == 403 {
		return nil, fmt.Errorf("authentication failed (HTTP %d)", resp.StatusCode)
	}

	if resp.StatusCode != 200 {
		if jwtUserID > 0 {
			log.Printf("[vinted] /users/current failed but JWT has user ID %d, using that", jwtUserID)
			return &AccountInfo{ID: jwtUserID, Login: fmt.Sprintf("user_%d", jwtUserID)}, nil
		}
		return nil, fmt.Errorf("unexpected status %d: %.200s", resp.StatusCode, string(body))
	}

	var wrapper userWrapper
	if err := json.Unmarshal(body, &wrapper); err == nil && wrapper.User.ID > 0 {
		return &wrapper.User, nil
	}
	var info AccountInfo
	if err := json.Unmarshal(body, &info); err == nil && info.ID > 0 {
		return &info, nil
	}

	if jwtUserID > 0 {
		log.Printf("[vinted] could not parse user response, using JWT ID %d", jwtUserID)
		return &AccountInfo{ID: jwtUserID, Login: fmt.Sprintf("user_%d", jwtUserID)}, nil
	}

	return nil, fmt.Errorf("could not extract user info from response: %.200s", string(body))
}

func (c *Client) ValidateSession() bool {
	info, err := c.GetAccountInfo()
	if err != nil {
		log.Printf("[validate] session check failed: %v", err)
		return false
	}
	return info.ID > 0
}

func (c *Client) LikeItem(itemID int64) error {
	err := c.doLike(itemID)
	if err != nil && shouldAttemptTokenRefresh(err) && c.session.RefreshToken != "" {
		log.Printf("[vinted] like got 401, attempting token refresh...")
		if refreshErr := c.RefreshAccessToken(); refreshErr != nil {
			log.Printf("[vinted] token refresh failed: %v", refreshErr)
			return err
		}
		return c.doLike(itemID)
	}
	return err
}

func (c *Client) doLike(itemID int64) error {
	if err := c.WarmUp(); err != nil {
		log.Printf("[vinted] warmup failed before like: %v", err)
	}

	toggleURL := fmt.Sprintf("https://%s/api/v2/user_favourites/toggle", c.session.Domain)
	payload := map[string]interface{}{
		"type":            "item",
		"user_favourites": []int64{itemID},
	}
	body, _ := json.Marshal(payload)

	req, err := http.NewRequest("POST", toggleURL, strings.NewReader(string(body)))
	if err != nil {
		return fmt.Errorf("create like request: %w", err)
	}
	req.Header = c.apiHeadersWithBody()

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("like request failed: %w", err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	bodyStr := strings.TrimSpace(string(respBody))

	log.Printf("[vinted] POST user_favourites/toggle (like) -> %d (%.300s)", resp.StatusCode, bodyStr)

	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		log.Printf("[vinted] Liked item %d", itemID)
		return nil
	}

	return fmt.Errorf("like failed (HTTP %d): %s", resp.StatusCode, truncate(bodyStr, 300))
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func (c *Client) UnlikeItem(itemID int64) error {
	err := c.doUnlike(itemID)
	if err != nil && shouldAttemptTokenRefresh(err) && c.session.RefreshToken != "" {
		log.Printf("[vinted] unlike got 401, attempting token refresh...")
		if refreshErr := c.RefreshAccessToken(); refreshErr != nil {
			log.Printf("[vinted] token refresh failed: %v", refreshErr)
			return err
		}
		return c.doUnlike(itemID)
	}
	return err
}

func (c *Client) doUnlike(itemID int64) error {
	if err := c.WarmUp(); err != nil {
		log.Printf("[vinted] warmup failed before unlike: %v", err)
	}

	toggleURL := fmt.Sprintf("https://%s/api/v2/user_favourites/toggle", c.session.Domain)
	payload := map[string]interface{}{
		"type":            "item",
		"user_favourites": []int64{itemID},
	}
	body, _ := json.Marshal(payload)

	req, err := http.NewRequest("POST", toggleURL, strings.NewReader(string(body)))
	if err != nil {
		return fmt.Errorf("create unlike request: %w", err)
	}
	req.Header = c.apiHeadersWithBody()

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("unlike request failed: %w", err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	bodyStr := strings.TrimSpace(string(respBody))

	log.Printf("[vinted] POST user_favourites/toggle (unlike) -> %d (%.300s)", resp.StatusCode, bodyStr)

	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return nil
	}

	return fmt.Errorf("unlike failed (HTTP %d): %s", resp.StatusCode, truncate(bodyStr, 300))
}

type BuyResponse struct {
	TransactionID int64  `json:"id"`
	Status        string `json:"status"`
	CheckoutURL   string `json:"checkout_url"`
}

type BrowserInfo struct {
	Language       string `json:"language"`
	ColorDepth     int    `json:"color_depth"`
	JavaEnabled    bool   `json:"java_enabled"`
	ScreenHeight   int    `json:"screen_height"`
	ScreenWidth    int    `json:"screen_width"`
	TimezoneOffset int    `json:"timezone_offset"`
}

type OneClickBuyOptions struct {
	SellerID             int64
	IncogniaRequestToken string
	PickupType           int
	BrowserInfo          BrowserInfo
	PaymentMethod        map[string]interface{}
	PhoneNumber          string
}

type OneClickBuyResponse struct {
	Status          string `json:"status"`
	ItemID          int64  `json:"item_id"`
	SellerID        int64  `json:"seller_id"`
	TransactionID   int64  `json:"transaction_id"`
	PurchaseID      string `json:"purchase_id"`
	Checksum        string `json:"checksum,omitempty"`
	CheckoutURL     string `json:"checkout_url,omitempty"`
	ShippingOrderID int64  `json:"shipping_order_id,omitempty"`
	PaymentURL      string `json:"payment_url,omitempty"`
	PaymentRaw      string `json:"payment_raw,omitempty"`
}

func (c *Client) BuyItem(itemID int64) (*BuyResponse, error) {
	if err := c.WarmUp(); err != nil {
		log.Printf("[vinted] warmup failed before buy: %v", err)
	}

	buyURL := fmt.Sprintf("https://%s/api/v2/transactions", c.session.Domain)

	payload := map[string]interface{}{
		"item_id": itemID,
	}
	body, _ := json.Marshal(payload)

	req, err := http.NewRequest("POST", buyURL, strings.NewReader(string(body)))
	if err != nil {
		return nil, fmt.Errorf("create buy request: %w", err)
	}
	req.Header = c.apiHeadersWithBody()

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("buy request failed: %w", err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)

	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		var result BuyResponse
		json.Unmarshal(respBody, &result)
		return &result, nil
	}

	return nil, fmt.Errorf("buy failed (HTTP %d): %s", resp.StatusCode, truncate(string(respBody), 200))
}

func (c *Client) OneClickBuy(itemID int64, opts OneClickBuyOptions) (*OneClickBuyResponse, error) {
	result, err := c.doOneClickBuy(itemID, opts)
	if err != nil && shouldAttemptTokenRefresh(err) && c.session.RefreshToken != "" {
		log.Printf("[vinted] one-click buy got auth error, attempting token refresh...")
		if refreshErr := c.RefreshAccessToken(); refreshErr != nil {
			log.Printf("[vinted] token refresh failed: %v", refreshErr)
			return nil, fmt.Errorf("%w (auto-refresh failed: %v)", err, refreshErr)
		}
		return c.doOneClickBuy(itemID, opts)
	}
	return result, err
}

func (c *Client) doOneClickBuy(itemID int64, opts OneClickBuyOptions) (*OneClickBuyResponse, error) {
	if itemID == 0 {
		return nil, fmt.Errorf("item id is required")
	}
	if opts.SellerID == 0 {
		return nil, fmt.Errorf("seller id is required")
	}
	if opts.PickupType == 0 {
		opts.PickupType = 1
	}
	opts.BrowserInfo = defaultBrowserInfo(opts.BrowserInfo)
	opts.PaymentMethod = defaultPaymentMethod(opts.PaymentMethod)
	opts.PhoneNumber = strings.TrimSpace(opts.PhoneNumber)
	if opts.PhoneNumber == "" {
		opts.PhoneNumber = strings.TrimSpace(c.session.PhoneNumber)
	}

	if err := c.WarmUp(); err != nil {
		log.Printf("[vinted] warmup failed before one-click buy: %v", err)
	}

	transactionID, err := c.createBuyTransaction(itemID, opts.SellerID)
	if err != nil {
		return nil, err
	}

	build, err := c.buildPurchaseCheckout(itemID, transactionID, opts.IncogniaRequestToken)
	if err != nil {
		return nil, err
	}
	if build.PurchaseID == "" {
		return nil, fmt.Errorf("checkout build did not return a purchase id")
	}

	paymentUpdate, err := c.updatePurchaseCheckout(build.PurchaseID, transactionID, map[string]interface{}{
		"additional_service":      map[string]interface{}{},
		"payment_method":          opts.PaymentMethod,
		"shipping_address":        map[string]interface{}{},
		"shipping_pickup_options": map[string]interface{}{"pickup_type": opts.PickupType},
		"shipping_pickup_details": map[string]interface{}{},
	})
	if err != nil {
		return nil, err
	}
	mergeCheckoutBuildResult(build, paymentUpdate)

	if opts.PhoneNumber != "" {
		if build.ShippingOrderID == 0 {
			log.Printf("[vinted] checkout update returned no shipping_order_id for purchase %s, retrying shipping bootstrap", build.PurchaseID)
			shippingUpdate, err := c.updatePurchaseCheckout(build.PurchaseID, transactionID, map[string]interface{}{
				"additional_service":      map[string]interface{}{},
				"payment_method":          map[string]interface{}{},
				"shipping_address":        map[string]interface{}{},
				"shipping_pickup_options": map[string]interface{}{"pickup_type": opts.PickupType},
				"shipping_pickup_details": map[string]interface{}{},
			})
			if err != nil {
				return nil, err
			}
			mergeCheckoutBuildResult(build, shippingUpdate)
		}

		if build.ShippingOrderID > 0 {
			contactUpdate, err := c.updateShippingContact(build.PurchaseID, transactionID, build.ShippingOrderID, opts.PhoneNumber)
			if err != nil {
				return nil, err
			}
			mergeCheckoutBuildResult(build, contactUpdate)
		} else {
			log.Printf("[vinted] phone number provided but checkout state did not expose shipping_order_id for purchase %s", build.PurchaseID)
		}
	}

	payment, err := c.createPurchasePayment(build.PurchaseID, transactionID, build.Checksum, opts)
	if err != nil {
		return nil, err
	}

	checkoutURL := build.CheckoutURL
	if checkoutURL == "" {
		checkoutURL = fmt.Sprintf("https://%s/checkout?purchase_id=%s&order_id=%d&order_type=transaction", c.session.Domain, url.QueryEscape(build.PurchaseID), transactionID)
	}
	if payment.URL == "" {
		return nil, &PaymentURLMissingError{
			TransactionID: transactionID,
			PurchaseID:    build.PurchaseID,
			CheckoutURL:   checkoutURL,
			Raw:           payment.Raw,
		}
	}

	return &OneClickBuyResponse{
		Status:          "payment_url_created",
		ItemID:          itemID,
		SellerID:        opts.SellerID,
		TransactionID:   transactionID,
		PurchaseID:      build.PurchaseID,
		Checksum:        build.Checksum,
		CheckoutURL:     checkoutURL,
		ShippingOrderID: build.ShippingOrderID,
		PaymentURL:      payment.URL,
		PaymentRaw:      payment.Raw,
	}, nil
}

func defaultBrowserInfo(info BrowserInfo) BrowserInfo {
	if info.Language == "" {
		info.Language = "en-DE"
	}
	if info.ColorDepth == 0 {
		info.ColorDepth = 32
	}
	if info.ScreenHeight == 0 {
		info.ScreenHeight = 1080
	}
	if info.ScreenWidth == 0 {
		info.ScreenWidth = 1920
	}
	return info
}

func defaultPaymentMethod(paymentMethod map[string]interface{}) map[string]interface{} {
	if len(paymentMethod) > 0 {
		return paymentMethod
	}
	return map[string]interface{}{
		"card_id":          nil,
		"pay_in_method_id": "10",
	}
}

func (c *Client) createBuyTransaction(itemID, sellerID int64) (int64, error) {
	convoURL := fmt.Sprintf("https://%s/api/v2/conversations", c.session.Domain)
	payload := map[string]interface{}{
		"initiator":        "buy",
		"item_id":          fmt.Sprintf("%d", itemID),
		"opposite_user_id": fmt.Sprintf("%d", sellerID),
	}
	body, _ := json.Marshal(payload)

	req, err := http.NewRequest("POST", convoURL, strings.NewReader(string(body)))
	if err != nil {
		return 0, fmt.Errorf("create buy conversation request: %w", err)
	}
	req.Header = c.apiHeadersWithBody()
	req.Header.Set("Referer", fmt.Sprintf("https://%s/items/%d", c.session.Domain, itemID))

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return 0, fmt.Errorf("buy conversation request failed: %w", err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	bodyStr := strings.TrimSpace(string(respBody))
	log.Printf("[vinted] POST /api/v2/conversations (buy) -> %d (%.300s)", resp.StatusCode, bodyStr)

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return 0, vintedHTTPError("buy conversation", resp.StatusCode, bodyStr)
	}

	var convoResp struct {
		Conversation struct {
			Transaction struct {
				ID int64 `json:"id"`
			} `json:"transaction"`
		} `json:"conversation"`
	}
	if err := json.Unmarshal(respBody, &convoResp); err == nil && convoResp.Conversation.Transaction.ID > 0 {
		return convoResp.Conversation.Transaction.ID, nil
	}

	var raw map[string]interface{}
	if err := json.Unmarshal(respBody, &raw); err != nil {
		return 0, fmt.Errorf("parse buy conversation response: %w", err)
	}
	if txID, ok := int64AtPath(raw, "conversation", "transaction", "id"); ok {
		return txID, nil
	}
	if txID, ok := int64AtPath(raw, "transaction", "id"); ok {
		return txID, nil
	}

	return 0, fmt.Errorf("could not extract transaction ID from buy conversation response: %.200s", bodyStr)
}

type checkoutBuildResult struct {
	PurchaseID      string
	Checksum        string
	CheckoutURL     string
	ShippingOrderID int64
}

func (c *Client) buildPurchaseCheckout(itemID, transactionID int64, incogniaRequestToken string) (*checkoutBuildResult, error) {
	buildURL := fmt.Sprintf("https://%s/api/v2/purchases/checkout/build", c.session.Domain)
	payload := map[string]interface{}{
		"purchase_items": []map[string]interface{}{
			{"id": transactionID, "type": "transaction"},
		},
	}
	body, _ := json.Marshal(payload)

	req, err := http.NewRequest("POST", buildURL, strings.NewReader(string(body)))
	if err != nil {
		return nil, fmt.Errorf("create checkout build request: %w", err)
	}
	req.Header = c.apiHeadersWithBody()
	req.Header.Set("Referer", fmt.Sprintf("https://%s/items/%d", c.session.Domain, itemID))
	if incogniaRequestToken != "" {
		req.Header.Set("X-Incognia-Request-Token", incogniaRequestToken)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("checkout build request failed: %w", err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	bodyStr := strings.TrimSpace(string(respBody))
	log.Printf("[vinted] POST /api/v2/purchases/checkout/build -> %d (%.300s)", resp.StatusCode, bodyStr)

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, vintedHTTPError("checkout build", resp.StatusCode, bodyStr)
	}

	var raw map[string]interface{}
	if err := json.Unmarshal(respBody, &raw); err != nil {
		return nil, fmt.Errorf("parse checkout build response: %w", err)
	}

	result := &checkoutBuildResult{
		PurchaseID:      firstStringPath(raw, []string{"purchase", "id"}, []string{"purchase", "uid"}, []string{"checkout", "purchase_id"}, []string{"checkout", "id"}, []string{"purchase_id"}),
		Checksum:        firstStringPath(raw, []string{"checksum"}, []string{"checkout", "checksum"}, []string{"payment", "checksum"}),
		CheckoutURL:     firstStringPath(raw, []string{"checkout_url"}, []string{"checkout", "url"}),
		ShippingOrderID: firstInt64Path(raw, []string{"shipping_order_id"}, []string{"shippingOrderId"}, []string{"shipping_order", "id"}, []string{"shippingOrder", "id"}, []string{"checkout", "shipping_order_id"}, []string{"checkout", "shipping_order", "id"}),
	}
	if result.PurchaseID == "" {
		result.PurchaseID = findLikelyPurchaseID(raw)
	}
	if result.Checksum == "" {
		result.Checksum, _ = findStringByKey(raw, "checksum")
	}
	if result.CheckoutURL == "" {
		result.CheckoutURL, _ = findURLContaining(raw, "/checkout")
	}
	if result.ShippingOrderID == 0 {
		result.ShippingOrderID, _ = findInt64ByAnyKey(raw, "shipping_order_id", "shippingOrderId")
	}

	return result, nil
}

func (c *Client) updatePurchaseCheckout(purchaseID string, transactionID int64, components map[string]interface{}) (*checkoutBuildResult, error) {
	checkoutURL := fmt.Sprintf("https://%s/api/v2/purchases/%s/checkout", c.session.Domain, url.PathEscape(purchaseID))
	payload := map[string]interface{}{
		"components": components,
	}
	body, _ := json.Marshal(payload)

	req, err := http.NewRequest("PUT", checkoutURL, strings.NewReader(string(body)))
	if err != nil {
		return nil, fmt.Errorf("create checkout update request: %w", err)
	}
	req.Header = c.apiHeadersWithBody()
	req.Header.Set("Referer", fmt.Sprintf("https://%s/checkout?purchase_id=%s&order_id=%d&order_type=transaction", c.session.Domain, url.QueryEscape(purchaseID), transactionID))

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("checkout update request failed: %w", err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	bodyStr := strings.TrimSpace(string(respBody))
	log.Printf("[vinted] PUT /api/v2/purchases/%s/checkout -> %d (%.300s)", purchaseID, resp.StatusCode, bodyStr)

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, vintedHTTPError("checkout update", resp.StatusCode, bodyStr)
	}

	result := &checkoutBuildResult{}
	var raw map[string]interface{}
	if err := json.Unmarshal(respBody, &raw); err == nil {
		result.PurchaseID = firstStringPath(raw, []string{"purchase", "id"}, []string{"purchase_id"})
		result.Checksum = firstStringPath(raw, []string{"checksum"}, []string{"checkout", "checksum"}, []string{"payment", "checksum"})
		result.CheckoutURL = firstStringPath(raw, []string{"checkout_url"}, []string{"checkout", "url"})
		result.ShippingOrderID = firstInt64Path(raw, []string{"shipping_order_id"}, []string{"shippingOrderId"}, []string{"shipping_order", "id"}, []string{"shippingOrder", "id"}, []string{"checkout", "shipping_order_id"}, []string{"checkout", "shipping_order", "id"})
		if result.Checksum == "" {
			result.Checksum, _ = findStringByKey(raw, "checksum")
		}
		if result.CheckoutURL == "" {
			result.CheckoutURL, _ = findURLContaining(raw, "/checkout")
		}
		if result.ShippingOrderID == 0 {
			result.ShippingOrderID, _ = findInt64ByAnyKey(raw, "shipping_order_id", "shippingOrderId")
		}
	}
	return result, nil
}

func mergeCheckoutBuildResult(target, source *checkoutBuildResult) {
	if target == nil || source == nil {
		return
	}
	if source.PurchaseID != "" {
		target.PurchaseID = source.PurchaseID
	}
	if source.Checksum != "" {
		target.Checksum = source.Checksum
	}
	if source.CheckoutURL != "" {
		target.CheckoutURL = source.CheckoutURL
	}
	if source.ShippingOrderID > 0 {
		target.ShippingOrderID = source.ShippingOrderID
	}
}

func (c *Client) updateShippingContact(purchaseID string, transactionID, shippingOrderID int64, phoneNumber string) (*checkoutBuildResult, error) {
	contactURL := fmt.Sprintf("https://%s/api/v2/shipping_orders/%d/shipping_contact", c.session.Domain, shippingOrderID)
	payload := map[string]interface{}{
		"save_for_later":        true,
		"receiver_phone_number": strings.TrimSpace(phoneNumber),
	}
	body, _ := json.Marshal(payload)

	req, err := http.NewRequest("POST", contactURL, strings.NewReader(string(body)))
	if err != nil {
		return nil, fmt.Errorf("create shipping contact request: %w", err)
	}
	req.Header = c.apiHeadersWithBody()
	req.Header.Set("Referer", fmt.Sprintf("https://%s/checkout?purchase_id=%s&order_id=%d&order_type=transaction", c.session.Domain, url.QueryEscape(purchaseID), transactionID))

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("shipping contact request failed: %w", err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	bodyStr := strings.TrimSpace(string(respBody))
	log.Printf("[vinted] POST /api/v2/shipping_orders/%d/shipping_contact -> %d (%.300s)", shippingOrderID, resp.StatusCode, bodyStr)

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, vintedHTTPError("shipping contact", resp.StatusCode, bodyStr)
	}

	result := &checkoutBuildResult{ShippingOrderID: shippingOrderID}
	var raw map[string]interface{}
	if err := json.Unmarshal(respBody, &raw); err == nil {
		result.PurchaseID = firstStringPath(raw, []string{"purchase", "id"}, []string{"purchase_id"})
		result.Checksum = firstStringPath(raw, []string{"checksum"}, []string{"checkout", "checksum"}, []string{"payment", "checksum"})
		result.CheckoutURL = firstStringPath(raw, []string{"checkout_url"}, []string{"checkout", "url"})
		if result.Checksum == "" {
			result.Checksum, _ = findStringByKey(raw, "checksum")
		}
		if result.CheckoutURL == "" {
			result.CheckoutURL, _ = findURLContaining(raw, "/checkout")
		}
		if parsedShippingOrderID, ok := findInt64ByAnyKey(raw, "shipping_order_id", "shippingOrderId"); ok && parsedShippingOrderID > 0 {
			result.ShippingOrderID = parsedShippingOrderID
		}
	}
	return result, nil
}

type paymentResult struct {
	URL string
	Raw string
}

func (c *Client) createPurchasePayment(purchaseID string, transactionID int64, checksum string, opts OneClickBuyOptions) (*paymentResult, error) {
	if checksum == "" {
		return nil, fmt.Errorf("checkout build response did not include checksum")
	}

	paymentURL := fmt.Sprintf("https://%s/api/v2/purchases/%s/checkout/payment", c.session.Domain, url.PathEscape(purchaseID))
	payload := map[string]interface{}{
		"checksum": checksum,
		"payment_options": map[string]interface{}{
			"browser_info": opts.BrowserInfo,
		},
	}
	body, _ := json.Marshal(payload)

	req, err := http.NewRequest("POST", paymentURL, strings.NewReader(string(body)))
	if err != nil {
		return nil, fmt.Errorf("create checkout payment request: %w", err)
	}
	req.Header = c.apiHeadersWithBody()
	req.Header.Set("Referer", fmt.Sprintf("https://%s/checkout?purchase_id=%s&order_id=%d&order_type=transaction", c.session.Domain, url.QueryEscape(purchaseID), transactionID))
	if opts.IncogniaRequestToken != "" {
		req.Header.Set("X-Incognia-Request-Token", opts.IncogniaRequestToken)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("checkout payment request failed: %w", err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	bodyStr := strings.TrimSpace(string(respBody))
	log.Printf("[vinted] POST /api/v2/purchases/%s/checkout/payment -> %d (%.300s)", purchaseID, resp.StatusCode, bodyStr)

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, vintedHTTPError("checkout payment", resp.StatusCode, bodyStr)
	}

	var raw map[string]interface{}
	if err := json.Unmarshal(respBody, &raw); err != nil {
		return nil, fmt.Errorf("parse checkout payment response: %w", err)
	}
	result := &paymentResult{Raw: truncate(bodyStr, 2000)}
	if u, ok := findURLContaining(raw, "paypal"); ok {
		result.URL = u
		return result, nil
	}
	if u := firstStringPath(
		raw,
		[]string{"payment_url"},
		[]string{"redirect_url"},
		[]string{"url"},
		[]string{"payment", "url"},
		[]string{"payment", "redirect_url"},
		[]string{"action", "parameters", "url"},
	); u != "" {
		result.URL = u
		return result, nil
	}
	return result, nil
}

func int64AtPath(raw map[string]interface{}, path ...string) (int64, bool) {
	var current interface{} = raw
	for _, part := range path {
		obj, ok := current.(map[string]interface{})
		if !ok {
			return 0, false
		}
		current, ok = obj[part]
		if !ok {
			return 0, false
		}
	}
	return interfaceToInt64(current)
}

func firstStringPath(raw map[string]interface{}, paths ...[]string) string {
	for _, path := range paths {
		if val, ok := stringAtPath(raw, path...); ok && val != "" {
			return val
		}
	}
	return ""
}

func firstInt64Path(raw map[string]interface{}, paths ...[]string) int64 {
	for _, path := range paths {
		if val, ok := int64AtPath(raw, path...); ok && val > 0 {
			return val
		}
	}
	return 0
}

func stringAtPath(raw map[string]interface{}, path ...string) (string, bool) {
	var current interface{} = raw
	for _, part := range path {
		obj, ok := current.(map[string]interface{})
		if !ok {
			return "", false
		}
		current, ok = obj[part]
		if !ok {
			return "", false
		}
	}
	val, ok := current.(string)
	return val, ok
}

func findLikelyPurchaseID(v interface{}) string {
	if s, ok := v.(string); ok {
		if strings.Contains(s, "purchase_id=") {
			if parsed, err := url.Parse(s); err == nil {
				return parsed.Query().Get("purchase_id")
			}
		}
		return ""
	}
	switch typed := v.(type) {
	case map[string]interface{}:
		for key, child := range typed {
			if val, ok := child.(string); ok && strings.Contains(val, "purchase_id=") {
				if parsed, err := url.Parse(val); err == nil {
					if purchaseID := parsed.Query().Get("purchase_id"); purchaseID != "" {
						return purchaseID
					}
				}
			}
			lowerKey := strings.ToLower(key)
			if strings.Contains(lowerKey, "purchase") {
				if val, ok := child.(string); ok && len(val) >= 12 && !isDigitsOnly(val) && !strings.Contains(val, "http") && !strings.Contains(val, "|") {
					return val
				}
			}
		}
		for _, key := range []string{"purchase_id", "purchaseId"} {
			if val, ok := typed[key].(string); ok && val != "" {
				return val
			}
		}
		for _, child := range typed {
			if found := findLikelyPurchaseID(child); found != "" {
				return found
			}
		}
	case []interface{}:
		for _, child := range typed {
			if found := findLikelyPurchaseID(child); found != "" {
				return found
			}
		}
	}
	return ""
}

func findInt64ByAnyKey(v interface{}, keys ...string) (int64, bool) {
	keySet := make(map[string]struct{}, len(keys))
	for _, key := range keys {
		keySet[strings.ToLower(key)] = struct{}{}
	}
	return findInt64ByKeySet(v, keySet)
}

func findInt64ByKeySet(v interface{}, keys map[string]struct{}) (int64, bool) {
	switch typed := v.(type) {
	case map[string]interface{}:
		for key, child := range typed {
			if _, ok := keys[strings.ToLower(key)]; ok {
				if val, converted := interfaceToInt64(child); converted && val > 0 {
					return val, true
				}
			}
		}
		for _, child := range typed {
			if val, ok := findInt64ByKeySet(child, keys); ok {
				return val, true
			}
		}
	case []interface{}:
		for _, child := range typed {
			if val, ok := findInt64ByKeySet(child, keys); ok {
				return val, true
			}
		}
	}
	return 0, false
}

func findStringByKey(v interface{}, key string) (string, bool) {
	switch typed := v.(type) {
	case map[string]interface{}:
		if val, ok := typed[key].(string); ok {
			return val, true
		}
		for _, child := range typed {
			if val, ok := findStringByKey(child, key); ok {
				return val, true
			}
		}
	case []interface{}:
		for _, child := range typed {
			if val, ok := findStringByKey(child, key); ok {
				return val, true
			}
		}
	}
	return "", false
}

func findURLContaining(v interface{}, needle string) (string, bool) {
	switch typed := v.(type) {
	case string:
		lower := strings.ToLower(typed)
		if (strings.HasPrefix(lower, "http://") || strings.HasPrefix(lower, "https://")) && strings.Contains(lower, strings.ToLower(needle)) {
			return typed, true
		}
	case map[string]interface{}:
		for _, child := range typed {
			if val, ok := findURLContaining(child, needle); ok {
				return val, true
			}
		}
	case []interface{}:
		for _, child := range typed {
			if val, ok := findURLContaining(child, needle); ok {
				return val, true
			}
		}
	}
	return "", false
}

func interfaceToInt64(v interface{}) (int64, bool) {
	switch typed := v.(type) {
	case float64:
		return int64(typed), true
	case int64:
		return typed, true
	case int:
		return int64(typed), true
	case json.Number:
		parsed, err := typed.Int64()
		return parsed, err == nil
	case string:
		parsed, err := strconv.ParseInt(typed, 10, 64)
		return parsed, err == nil
	default:
		return 0, false
	}
}

func isDigitsOnly(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

type DataDomeChallengeError struct {
	Step       string
	StatusCode int
	CaptchaURL string
}

func (e *DataDomeChallengeError) Error() string {
	if e.CaptchaURL != "" {
		return fmt.Sprintf("datadome challenge at %s (HTTP %d): captcha_url=%s", e.Step, e.StatusCode, e.CaptchaURL)
	}
	return fmt.Sprintf("datadome challenge at %s (HTTP %d)", e.Step, e.StatusCode)
}

type PaymentURLMissingError struct {
	TransactionID int64
	PurchaseID    string
	CheckoutURL   string
	Raw           string
}

func (e *PaymentURLMissingError) Error() string {
	return fmt.Sprintf("checkout payment did not return a PayPal/payment URL for purchase %s", e.PurchaseID)
}

type AuthError struct {
	Step       string
	StatusCode int
	VintedCode int
	Message    string
}

func (e *AuthError) Error() string {
	if e.Message != "" {
		return fmt.Sprintf("invalid authentication token at %s (HTTP %d): %s", e.Step, e.StatusCode, e.Message)
	}
	return fmt.Sprintf("invalid authentication token at %s (HTTP %d)", e.Step, e.StatusCode)
}

type PaymentStateError struct {
	Step       string
	StatusCode int
	Code       string
	VintedCode int
	Message    string
	Raw        string
}

func (e *PaymentStateError) Error() string {
	if e.Message != "" {
		return fmt.Sprintf("%s at %s (HTTP %d): %s", e.Code, e.Step, e.StatusCode, e.Message)
	}
	return fmt.Sprintf("%s at %s (HTTP %d)", e.Code, e.Step, e.StatusCode)
}

func vintedHTTPError(step string, statusCode int, body string) error {
	if isInvalidAuthToken(body) {
		authErr := &AuthError{Step: step, StatusCode: statusCode}
		var raw struct {
			Code        int    `json:"code"`
			Message     string `json:"message"`
			MessageCode string `json:"message_code"`
		}
		if err := json.Unmarshal([]byte(body), &raw); err == nil {
			authErr.VintedCode = raw.Code
			authErr.Message = raw.Message
			if authErr.Message == "" {
				authErr.Message = raw.MessageCode
			}
		}
		return authErr
	}
	if isPaymentAlreadyProcessing(body) {
		return paymentStateError(step, statusCode, "payment_already_processing", body)
	}
	if isPaymentMethodInvalid(body) {
		return paymentStateError(step, statusCode, "payment_method_invalid", body)
	}
	if isPhoneRequired(body) {
		return paymentStateError(step, statusCode, "phone_required", body)
	}
	if isDataDomeChallenge(body) {
		return &DataDomeChallengeError{
			Step:       step,
			StatusCode: statusCode,
			CaptchaURL: extractCaptchaURL(body),
		}
	}
	return fmt.Errorf("%s failed (HTTP %d): %s", step, statusCode, truncate(body, 300))
}

func paymentStateError(step string, statusCode int, code string, body string) *PaymentStateError {
	err := &PaymentStateError{
		Step:       step,
		StatusCode: statusCode,
		Code:       code,
		Raw:        truncate(body, 2000),
	}
	var raw struct {
		Code        int    `json:"code"`
		Message     string `json:"message"`
		MessageCode string `json:"message_code"`
		Errors      []struct {
			Field string `json:"field"`
			Value string `json:"value"`
		} `json:"errors"`
	}
	if jsonErr := json.Unmarshal([]byte(body), &raw); jsonErr == nil {
		err.VintedCode = raw.Code
		err.Message = raw.Message
		for _, fieldErr := range raw.Errors {
			if fieldErr.Value != "" {
				err.Message = fieldErr.Value
				break
			}
		}
		if err.Message == "" {
			err.Message = raw.MessageCode
		}
	}
	return err
}

func isInvalidAuthToken(body string) bool {
	lower := strings.ToLower(body)
	return strings.Contains(lower, "invalid_authentication_token") || strings.Contains(lower, "jeton d'authentification invalide")
}

func isPaymentAlreadyProcessing(body string) bool {
	lower := strings.ToLower(body)
	return strings.Contains(lower, "bezahlungsvorgang") &&
		(strings.Contains(lower, "abgeschlossen") || strings.Contains(lower, "bearbeitet"))
}

func isPaymentMethodInvalid(body string) bool {
	lower := strings.ToLower(body)
	return strings.Contains(lower, "checkout_error") &&
		(strings.Contains(lower, "purchase card is not valid") || strings.Contains(lower, "andere zahlungsmethode"))
}

func isPhoneRequired(body string) bool {
	lower := strings.ToLower(body)
	return strings.Contains(lower, "telefonnummer") && strings.Contains(lower, "erforderlich")
}

func isDataDomeChallenge(body string) bool {
	lower := strings.ToLower(body)
	return strings.Contains(lower, "captcha-delivery.com") || strings.Contains(lower, "datadome")
}

func extractCaptchaURL(body string) string {
	var raw map[string]interface{}
	if err := json.Unmarshal([]byte(body), &raw); err == nil {
		if u, ok := raw["url"].(string); ok && strings.Contains(strings.ToLower(u), "captcha-delivery.com") {
			return u
		}
	}
	re := regexp.MustCompile(`https://[^"'\s]+captcha-delivery\.com[^"'\s]+`)
	if match := re.FindString(body); match != "" {
		return match
	}
	return ""
}

func parseCookieHeader(header string) []*http.Cookie {
	parts := strings.Split(header, ";")
	cookies := make([]*http.Cookie, 0, len(parts))
	for _, part := range parts {
		name, value, ok := strings.Cut(strings.TrimSpace(part), "=")
		if !ok || strings.TrimSpace(name) == "" {
			continue
		}
		cookies = append(cookies, &http.Cookie{
			Name:  strings.TrimSpace(name),
			Value: strings.TrimSpace(value),
			Path:  "/",
		})
	}
	return cookies
}

func serializeCookies(cookies []*http.Cookie) string {
	if len(cookies) == 0 {
		return ""
	}

	order := make([]string, 0, len(cookies))
	values := make(map[string]string, len(cookies))
	for _, cookie := range cookies {
		if cookie == nil {
			continue
		}

		name := strings.TrimSpace(cookie.Name)
		value := strings.TrimSpace(cookie.Value)
		if name == "" || value == "" {
			continue
		}
		if name == "access_token_web" || name == "refresh_token_web" {
			continue
		}
		if _, exists := values[name]; !exists {
			order = append(order, name)
		}
		values[name] = value
	}

	parts := make([]string, 0, len(order))
	for _, name := range order {
		if value := values[name]; value != "" {
			parts = append(parts, fmt.Sprintf("%s=%s", name, value))
		}
	}
	return strings.Join(parts, "; ")
}

func truncate(s string, maxLen int) string {
	if len(s) > maxLen {
		return s[:maxLen] + "..."
	}
	return s
}

func (c *Client) GetDomain() string {
	return c.session.Domain
}

func (c *Client) GetSession() *session.VintedSession {
	return c.session
}

func (c *Client) RefreshAccessToken() error {
	if c.session.RefreshToken == "" {
		return fmt.Errorf("no refresh token available")
	}

	domainURL, _ := url.Parse(fmt.Sprintf("https://%s/", c.session.Domain))

	c.httpClient.SetCookies(domainURL, []*http.Cookie{
		{Name: "access_token_web", Value: c.session.AccessToken, Path: "/"},
		{Name: "refresh_token_web", Value: c.session.RefreshToken, Path: "/"},
	})

	c.warmedUp = false
	if err := c.WarmUp(); err != nil {
		log.Printf("[vinted] warmup before refresh failed: %v (continuing anyway)", err)
	}

	c.httpClient.SetCookies(domainURL, []*http.Cookie{
		{Name: "refresh_token_web", Value: c.session.RefreshToken, Path: "/"},
	})

	_, err := c.executeRefreshRequest()
	if err != nil {
		log.Printf("[vinted] refresh attempt failed, forcing fresh warmup and retrying once: %v", err)
		if warmErr := c.ForceWarmUp(); warmErr != nil {
			return fmt.Errorf("%v; force warmup failed: %w", err, warmErr)
		}
		_, err = c.executeRefreshRequest()
		if err != nil {
			return err
		}
	}

	var newAccessToken, newRefreshToken string
	for _, cookie := range c.httpClient.GetCookies(domainURL) {
		switch cookie.Name {
		case "access_token_web":
			newAccessToken = cookie.Value
		case "refresh_token_web":
			newRefreshToken = cookie.Value
		}
	}

	if newAccessToken == "" {
		return fmt.Errorf("refresh response did not contain new access token")
	}

	c.session.AccessToken = newAccessToken
	if newRefreshToken != "" {
		c.session.RefreshToken = newRefreshToken
	}

	c.injectAuthCookie()
	c.rememberWarmupState()
	c.warmedUp = false

	log.Printf("[vinted] token refresh successful, new access token: %s...", truncate(newAccessToken, 20))
	return nil
}

func (c *Client) executeRefreshRequest() ([]byte, error) {
	refreshURL := fmt.Sprintf("https://%s/web/api/auth/refresh", c.session.Domain)

	req, err := http.NewRequest("POST", refreshURL, strings.NewReader(""))
	if err != nil {
		return nil, fmt.Errorf("create refresh request: %w", err)
	}
	req.Header = http.Header{
		"User-Agent":         {c.userAgent()},
		"Accept":             {"application/json, text/plain, */*"},
		"Accept-Language":    {c.locale()},
		"Cache-Control":      {"no-cache"},
		"Pragma":             {"no-cache"},
		"Origin":             {fmt.Sprintf("https://%s", c.session.Domain)},
		"Referer":            {fmt.Sprintf("https://%s/session-refresh?ref_url=%%2F", c.session.Domain)},
		"Sec-Ch-Ua":          {defaultSecChUA},
		"Sec-Ch-Ua-Mobile":   {"?0"},
		"Sec-Ch-Ua-Platform": {`"macOS"`},
		"Sec-Fetch-Dest":     {"empty"},
		"Sec-Fetch-Mode":     {"cors"},
		"Sec-Fetch-Site":     {"same-origin"},
	}
	if c.csrfToken != "" {
		req.Header.Set("X-Csrf-Token", c.csrfToken)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("refresh request failed: %w", err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	log.Printf("[vinted] POST /web/api/auth/refresh -> %d (%.200s)", resp.StatusCode, string(body))

	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("refresh failed (HTTP %d): %s", resp.StatusCode, truncate(string(body), 200))
	}

	return body, nil
}

func shouldAttemptTokenRefresh(err error) bool {
	if err == nil {
		return false
	}

	var authErr *AuthError
	if errors.As(err, &authErr) {
		return true
	}

	msg := err.Error()
	return strings.Contains(msg, "HTTP 401") || strings.Contains(msg, "HTTP 403")
}

func (c *Client) GetFavourites(vintedUserID int64, page string) (*FavoritesResponse, error) {
	favs, err := c.doGetFavourites(vintedUserID, page)
	if err != nil && shouldAttemptTokenRefresh(err) && c.session.RefreshToken != "" {
		log.Printf("[vinted] get favorites got %v, attempting token refresh...", err)
		if refreshErr := c.RefreshAccessToken(); refreshErr != nil {
			log.Printf("[vinted] token refresh failed: %v", refreshErr)
			return nil, err
		}
		return c.doGetFavourites(vintedUserID, page)
	}
	return favs, err
}

func (c *Client) GetWardrobe(vintedUserID int64, page, perPage int, order string) (*WardrobeResponse, error) {
	wardrobe, err := c.doGetWardrobe(vintedUserID, page, perPage, order)
	if err != nil && shouldAttemptTokenRefresh(err) && c.session.RefreshToken != "" {
		log.Printf("[vinted] get wardrobe got %v, attempting token refresh...", err)
		if refreshErr := c.RefreshAccessToken(); refreshErr != nil {
			log.Printf("[vinted] token refresh failed: %v", refreshErr)
			return nil, err
		}
		return c.doGetWardrobe(vintedUserID, page, perPage, order)
	}
	return wardrobe, err
}

func (c *Client) doGetFavourites(vintedUserID int64, page string) (*FavoritesResponse, error) {
	if err := c.WarmUp(); err != nil {
		log.Printf("[vinted] warmup failed: %v", err)
	}

	u := fmt.Sprintf("https://%s/api/v2/users/%d/items/favourites", c.session.Domain, vintedUserID)
	if page != "" {
		u += "?page=" + page
	}

	req, err := http.NewRequest("GET", u, nil)
	if err != nil {
		return nil, fmt.Errorf("create favorites request: %w", err)
	}

	req.Header = c.apiHeaders()
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("do favorites request: %w", err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	log.Printf("[vinted] GET /api/v2/users/%d/items/favourites -> %d (%.200s)", vintedUserID, resp.StatusCode, string(body))

	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("vinted error: %d %s", resp.StatusCode, string(body))
	}

	var favs FavoritesResponse
	if err := json.Unmarshal(body, &favs); err != nil {
		return nil, fmt.Errorf("unmarshal favorites: %w", err)
	}

	return &favs, nil
}

func (c *Client) doGetWardrobe(vintedUserID int64, page, perPage int, order string) (*WardrobeResponse, error) {
	if err := c.WarmUp(); err != nil {
		log.Printf("[vinted] warmup failed before get wardrobe: %v", err)
	}

	if page <= 0 {
		page = 1
	}
	if perPage <= 0 {
		perPage = 20
	}
	if order == "" {
		order = "relevance"
	}

	u := fmt.Sprintf(
		"https://%s/api/v2/wardrobe/%d/items?page=%d&per_page=%d&order=%s",
		c.session.Domain,
		vintedUserID,
		page,
		perPage,
		url.QueryEscape(order),
	)

	req, err := http.NewRequest("GET", u, nil)
	if err != nil {
		return nil, fmt.Errorf("create wardrobe request: %w", err)
	}

	req.Header = c.apiHeaders()
	req.Header.Set("Referer", fmt.Sprintf("https://%s/member/%d", c.session.Domain, vintedUserID))

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("wardrobe request failed: %w", err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	log.Printf("[vinted] GET /api/v2/wardrobe/%d/items?page=%d&per_page=%d&order=%s -> %d (%.300s)", vintedUserID, page, perPage, order, resp.StatusCode, string(body))

	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, truncate(string(body), 300))
	}

	var wardrobe WardrobeResponse
	if err := json.Unmarshal(body, &wardrobe); err != nil {
		return nil, fmt.Errorf("unmarshal wardrobe: %w", err)
	}

	return &wardrobe, nil
}

func (c *Client) SearchBrands(catalogIDs []string, query string) ([]FilterOption, error) {
	normalizedCatalogIDs := normalizeCatalogIDs(catalogIDs)
	options, err := c.searchCatalogFilterOptions(
		normalizedCatalogIDs,
		query,
		"brand",
	)
	if err == nil {
		return options, nil
	}

	if filterSearchStatus(err) == http.StatusUnauthorized || filterSearchStatus(err) == http.StatusForbidden {
		if warmErr := c.ForceCatalogWarmUp(); warmErr != nil {
			log.Printf("[vinted] catalog warmup retry failed for domain=%s: %v", c.session.Domain, warmErr)
		} else {
			options, err = c.searchCatalogFilterOptions(normalizedCatalogIDs, query, "brand")
			if err == nil {
				return options, nil
			}
		}
	}

	log.Printf("[vinted] catalog brand search unavailable for domain=%s, using gateway fallback: %v", c.session.Domain, err)
	fallbackOptions, fallbackErr := c.searchGatewayFilterOptions(normalizedCatalogIDs, query, "brand")
	if fallbackErr != nil {
		return nil, fmt.Errorf("catalog brand search failed: %v; gateway fallback failed: %w", err, fallbackErr)
	}
	return fallbackOptions, nil
}

func filterSearchStatus(err error) int {
	var searchErr *filterSearchError
	if errors.As(err, &searchErr) {
		return searchErr.StatusCode
	}
	return 0
}

func (c *Client) SearchPlatforms(catalogIDs []string, query string) ([]FilterOption, error) {
	if err := c.WarmUp(); err != nil {
		log.Printf("[vinted] warmup failed before platform facets request: %v", err)
	}

	normalizedQuery := strings.TrimSpace(query)
	if normalizedQuery == "" {
		return nil, errors.New("query is required")
	}

	normalizedCatalogIDs := normalizeCatalogIDs(catalogIDs)
	if len(normalizedCatalogIDs) == 0 {
		normalizedCatalogIDs = []string{"3002"}
	}

	params := url.Values{
		"filter_code":            {"video_game_platform"},
		"attribute_ids[catalog]": {strings.Join(normalizedCatalogIDs, ",")},
	}
	u := fmt.Sprintf(
		"https://%s/web/gateway/svc-filters/filters/facets?%s",
		c.session.Domain,
		params.Encode(),
	)
	req, err := http.NewRequest("GET", u, nil)
	if err != nil {
		return nil, fmt.Errorf("create platform facets request: %w", err)
	}

	req.Header = c.apiHeaders()
	req.Header.Set("Platform", "web")
	req.Header.Set("X-Next-App", "marketplace-web")
	req.Header.Set(
		"Referer",
		fmt.Sprintf(
			"https://%s/catalog/%s",
			c.session.Domain,
			url.PathEscape(normalizedCatalogIDs[0]),
		),
	)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("platform facets request failed: %w", err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, truncate(string(body), 300))
	}

	var payload filterOptionsPayload
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, fmt.Errorf("unmarshal platform facets: %w", err)
	}

	options := normalizeFilterOptionsPayload(payload)
	matches := make([]FilterOption, 0, len(options))
	for _, option := range options {
		if platformOptionMatches(option.Label, normalizedQuery) {
			matches = append(matches, option)
		}
	}
	return matches, nil
}

var (
	nonAlphaNumeric      = regexp.MustCompile(`[^a-z0-9]+`)
	platformSearchTokens = regexp.MustCompile(`[A-Za-z0-9]+`)
)

func normalizePlatformSearch(value string) string {
	return nonAlphaNumeric.ReplaceAllString(strings.ToLower(strings.TrimSpace(value)), "")
}

func platformOptionMatches(label, query string) bool {
	normalizedQuery := normalizePlatformSearch(query)
	if normalizedQuery == "" {
		return false
	}

	normalizedLabel := normalizePlatformSearch(label)
	if strings.Contains(normalizedLabel, normalizedQuery) {
		return true
	}

	aliases := []string{
		strings.ReplaceAll(normalizedLabel, "playstation", "ps"),
		strings.ReplaceAll(normalizedLabel, "nintendo", "n"),
	}
	words := platformSearchTokens.FindAllString(label, -1)
	if len(words) > 1 {
		var initials strings.Builder
		for _, word := range words {
			initials.WriteByte(strings.ToLower(word)[0])
		}
		aliases = append(aliases, initials.String())
	}

	for _, alias := range aliases {
		if strings.Contains(alias, normalizedQuery) {
			return true
		}
	}
	return false
}

func (c *Client) searchCatalogFilterOptions(catalogIDs []string, query string, filterCode string) ([]FilterOption, error) {
	if err := c.CatalogWarmUp(); err != nil {
		log.Printf("[vinted] warmup failed before %s catalog search: %v", filterCode, err)
	}

	normalizedQuery := strings.TrimSpace(query)
	if normalizedQuery == "" {
		return nil, errors.New("query is required")
	}

	normalizedCatalogIDs := normalizeCatalogIDs(catalogIDs)
	u := buildCatalogFilterSearchURL(c.session.Domain, normalizedCatalogIDs, normalizedQuery, filterCode)
	req, err := http.NewRequest("GET", u, nil)
	if err != nil {
		return nil, &filterSearchError{Operation: "create catalog filter search request", Err: err}
	}

	req.Header = c.apiHeaders()
	req.Header.Set("Accept", "application/json,text/plain,*/*,image/webp")
	req.Header.Set("Referer", fmt.Sprintf("https://%s/catalog", c.session.Domain))

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, &filterSearchError{Operation: "catalog filter search request", Err: err}
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, maxFilterSearchResponseBytes+1))
	if err != nil {
		return nil, &filterSearchError{Operation: "read catalog filter search response", Err: err}
	}
	if len(body) > maxFilterSearchResponseBytes {
		return nil, &filterSearchError{Operation: "catalog filter search response", Err: fmt.Errorf("response exceeds %d bytes", maxFilterSearchResponseBytes)}
	}
	log.Printf("[vinted] GET /api/v2/catalog/filters/search code=%s query=%q catalogs=%s -> %d", filterCode, normalizedQuery, strings.Join(normalizedCatalogIDs, ","), resp.StatusCode)

	if resp.StatusCode != http.StatusOK {
		return nil, &filterSearchError{Operation: "catalog filter search", StatusCode: resp.StatusCode}
	}

	var payload filterOptionsPayload
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, &filterSearchError{Operation: "decode catalog filter search", StatusCode: resp.StatusCode, Err: err}
	}
	var envelope map[string]json.RawMessage
	if err := json.Unmarshal(body, &envelope); err != nil {
		return nil, &filterSearchError{Operation: "decode catalog filter search schema", StatusCode: resp.StatusCode, Err: err}
	}
	if _, hasOptions := envelope["options"]; !hasOptions {
		if _, hasFilters := envelope["filters"]; !hasFilters {
			if _, hasFacets := envelope["facets"]; !hasFacets {
				return nil, &filterSearchError{Operation: "decode catalog filter search schema", StatusCode: resp.StatusCode, Err: errors.New("missing filter options")}
			}
		}
	}

	return normalizeFilterOptionsPayload(payload), nil
}

func buildCatalogFilterSearchURL(domain string, catalogIDs []string, query string, filterCode string) string {
	params := url.Values{
		"catalog_ids":        {strings.Join(normalizeCatalogIDs(catalogIDs), ",")},
		"size_ids":           {""},
		"brand_ids":          {""},
		"status_ids":         {""},
		"color_ids":          {""},
		"material_ids":       {""},
		"filter_search_code": {filterCode},
		"filter_search_text": {strings.TrimSpace(query)},
	}
	return fmt.Sprintf("https://%s/api/v2/catalog/filters/search?%s", domain, params.Encode())
}

func (c *Client) searchGatewayFilterOptions(catalogIDs []string, query string, filterCode string) ([]FilterOption, error) {
	if err := c.WarmUp(); err != nil {
		log.Printf("[vinted] warmup failed before %s gateway search: %v", filterCode, err)
	}

	normalizedQuery := strings.TrimSpace(query)
	if normalizedQuery == "" {
		return nil, errors.New("query is required")
	}

	normalizedCatalogIDs := normalizeCatalogIDs(catalogIDs)
	u := buildGatewayFilterSearchURL(
		c.session.Domain,
		normalizedCatalogIDs,
		normalizedQuery,
		filterCode,
	)
	req, err := http.NewRequest("GET", u, nil)
	if err != nil {
		return nil, fmt.Errorf("create %s gateway search request: %w", filterCode, err)
	}

	req.Header = c.apiHeaders()
	req.Header.Set("Platform", "web")
	req.Header.Set("X-Next-App", "marketplace-web")
	req.Header.Set("Referer", fmt.Sprintf("https://%s/catalog?search_text=%s", c.session.Domain, url.QueryEscape(normalizedQuery)))

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("%s gateway search request failed: %w", filterCode, err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, maxFilterSearchResponseBytes+1))
	if err != nil {
		return nil, fmt.Errorf("read %s gateway search response: %w", filterCode, err)
	}
	if len(body) > maxFilterSearchResponseBytes {
		return nil, fmt.Errorf("%s gateway search response exceeds %d bytes", filterCode, maxFilterSearchResponseBytes)
	}
	log.Printf("[vinted] GET /web/gateway/svc-filters/filters/search code=%s query=%q catalogs=%s -> %d", filterCode, normalizedQuery, strings.Join(normalizedCatalogIDs, ","), resp.StatusCode)

	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, truncate(string(body), 300))
	}

	var payload filterOptionsPayload
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, fmt.Errorf("unmarshal %s gateway search: %w", filterCode, err)
	}

	return normalizeFilterOptionsPayload(payload), nil
}

func buildGatewayFilterSearchURL(
	domain string,
	catalogIDs []string,
	query string,
	filterCode string,
) string {
	params := url.Values{
		"filter_search_code": {filterCode},
		"filter_search_text": {query},
	}
	if len(catalogIDs) > 0 {
		params.Set("attribute_ids[catalog]", strings.Join(catalogIDs, ","))
	}
	return fmt.Sprintf(
		"https://%s/web/gateway/svc-filters/filters/search?%s",
		domain,
		params.Encode(),
	)
}

func normalizeCatalogIDs(catalogIDs []string) []string {
	seen := make(map[string]struct{}, len(catalogIDs))
	normalized := make([]string, 0, len(catalogIDs))
	for _, raw := range catalogIDs {
		for _, part := range strings.Split(raw, ",") {
			value := strings.TrimSpace(part)
			if value == "" {
				continue
			}
			if _, ok := seen[value]; ok {
				continue
			}
			seen[value] = struct{}{}
			normalized = append(normalized, value)
		}
	}
	return normalized
}

func normalizeFilterOptionsPayload(payload filterOptionsPayload) []FilterOption {
	entries := payload.Options
	if len(entries) == 0 {
		entries = payload.Filters
	}
	if len(entries) == 0 {
		entries = payload.Facets
	}

	options := make([]FilterOption, 0, len(entries))
	seen := make(map[string]struct{}, len(entries))
	for _, entry := range entries {
		id := optionIDString(firstNonNil(entry.ID, entry.Value, entry.Code))
		label := strings.TrimSpace(firstNonEmptyString(entry.Title, entry.Label, entry.Name))
		if id == "" || label == "" {
			continue
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		options = append(options, FilterOption{ID: id, Label: label})
	}
	return options
}

func firstNonNil(values ...interface{}) interface{} {
	for _, value := range values {
		if value != nil {
			return value
		}
	}
	return nil
}

func firstNonEmptyString(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func optionIDString(value interface{}) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		return strings.TrimSpace(typed)
	case float64:
		if typed == float64(int64(typed)) {
			return strconv.FormatInt(int64(typed), 10)
		}
		return strconv.FormatFloat(typed, 'f', -1, 64)
	case int:
		return strconv.Itoa(typed)
	case int64:
		return strconv.FormatInt(typed, 10)
	case json.Number:
		return typed.String()
	default:
		return strings.TrimSpace(fmt.Sprint(typed))
	}
}

var brandPathPattern = regexp.MustCompile(`(?:^|/)brand/(\d+)-([a-z0-9][a-z0-9-]*)/?$`)
var htmlTitlePattern = regexp.MustCompile(`(?is)<title[^>]*>(.*?)</title>`)
var htmlH1Pattern = regexp.MustCompile(`(?is)<h1[^>]*>(.*?)</h1>`)
var htmlLinkPattern = regexp.MustCompile(`(?is)<link\b[^>]*>`)
var htmlAttributePattern = regexp.MustCompile(`(?is)([a-zA-Z][a-zA-Z0-9:_-]*)\s*=\s*["']([^"']*)["']`)
var htmlTagPattern = regexp.MustCompile(`(?is)<[^>]+>`)

func ParseVintedBrandURL(rawURL string) (int64, string, error) {
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil {
		return 0, "", errors.New("invalid Vinted brand URL")
	}
	if parsed.Scheme != "https" || parsed.User != nil || parsed.Port() != "" {
		return 0, "", errors.New("brand URL must be an HTTPS Vinted URL")
	}
	host := strings.ToLower(parsed.Hostname())
	if !isSupportedBrandHost(host) {
		return 0, "", errors.New("unsupported Vinted brand domain")
	}

	matches := brandPathPattern.FindStringSubmatch(strings.TrimSuffix(parsed.EscapedPath(), "/"))
	if len(matches) != 3 {
		return 0, "", errors.New("URL must point to a Vinted brand page")
	}
	path := strings.TrimSuffix(parsed.Path, "/")
	if !strings.HasPrefix(path, "/brand/") && !strings.HasPrefix(path, "/catalog/") {
		return 0, "", errors.New("URL must point to a Vinted brand page")
	}

	brandID, err := strconv.ParseInt(matches[1], 10, 64)
	if err != nil || brandID <= 0 {
		return 0, "", errors.New("invalid Vinted brand ID")
	}
	return brandID, matches[2], nil
}

func isSupportedBrandHost(host string) bool {
	for _, domain := range brandSearchDomains {
		if host == domain || host == strings.TrimPrefix(domain, "www.") {
			return true
		}
	}
	return false
}

func (c *Client) ResolveBrandPage(rawURL string) (*BrandPageResolution, error) {
	brandID, slug, err := ParseVintedBrandURL(rawURL)
	if err != nil {
		return nil, err
	}
	if !isSupportedBrandHost(strings.ToLower(c.session.Domain)) {
		return nil, errors.New("unsupported regional Vinted domain")
	}

	if err := c.ForceCatalogWarmUp(); err != nil {
		log.Printf("[vinted] catalog warmup failed before brand page validation for domain=%s: %v", c.session.Domain, err)
	}

	currentURL := fmt.Sprintf("https://%s/brand/%d-%s", c.session.Domain, brandID, slug)
	wasFollowingRedirects := c.httpClient.GetFollowRedirect()
	c.httpClient.SetFollowRedirect(false)
	defer c.httpClient.SetFollowRedirect(wasFollowingRedirects)

	for redirectCount := 0; redirectCount <= maxBrandPageRedirects; redirectCount++ {
		req, err := http.NewRequest("GET", currentURL, nil)
		if err != nil {
			return nil, fmt.Errorf("create brand page request: %w", err)
		}
		req.Header = http.Header{
			"User-Agent":      {c.userAgent()},
			"Accept":          {"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"},
			"Accept-Language": {c.locale() + ",en;q=0.8"},
			"Referer":         {fmt.Sprintf("https://%s/catalog", c.session.Domain)},
		}

		resp, err := c.httpClient.Do(req)
		if err != nil {
			return nil, fmt.Errorf("brand page request failed: %w", err)
		}

		if resp.StatusCode >= 300 && resp.StatusCode < 400 {
			resp.Body.Close()
			location := strings.TrimSpace(resp.Header.Get("Location"))
			if location == "" || redirectCount == maxBrandPageRedirects {
				return nil, errors.New("invalid Vinted brand page redirect")
			}
			nextURL, err := req.URL.Parse(location)
			if err != nil || nextURL.Scheme != "https" || !strings.EqualFold(nextURL.Hostname(), c.session.Domain) || nextURL.Port() != "" {
				return nil, errors.New("Vinted brand page redirected outside the selected region")
			}
			currentURL = nextURL.String()
			continue
		}

		body, readErr := io.ReadAll(io.LimitReader(resp.Body, maxBrandPageInspectionBytes))
		resp.Body.Close()
		if readErr != nil {
			return nil, fmt.Errorf("read brand page response: %w", readErr)
		}
		if resp.StatusCode != http.StatusOK {
			return nil, fmt.Errorf("brand page returned HTTP %d", resp.StatusCode)
		}
		if contentType := strings.ToLower(resp.Header.Get("Content-Type")); contentType != "" && !strings.Contains(contentType, "text/html") {
			return nil, errors.New("brand page did not return HTML")
		}

		resolution, err := validateBrandPageHTML(body, c.session.Domain, brandID)
		if err != nil {
			return nil, err
		}
		return resolution, nil
	}

	return nil, errors.New("too many Vinted brand page redirects")
}

func validateBrandPageHTML(body []byte, domain string, expectedBrandID int64) (*BrandPageResolution, error) {
	titleMatch := htmlTitlePattern.FindSubmatch(body)
	h1Match := htmlH1Pattern.FindSubmatch(body)
	if len(titleMatch) != 2 || len(h1Match) != 2 {
		return nil, errors.New("Vinted brand page is missing its official title")
	}

	title := normalizeHTMLText(string(titleMatch[1]))
	h1 := normalizeHTMLText(string(h1Match[1]))
	label := strings.TrimSpace(strings.TrimSuffix(title, "| Vinted"))
	if label == "" || h1 == "" || !strings.EqualFold(label, h1) {
		return nil, errors.New("Vinted brand page title does not match its brand name")
	}

	canonical := ""
	for _, linkTag := range htmlLinkPattern.FindAll(body, -1) {
		attributes := make(map[string]string)
		for _, match := range htmlAttributePattern.FindAllSubmatch(linkTag, -1) {
			attributes[strings.ToLower(string(match[1]))] = html.UnescapeString(string(match[2]))
		}
		if strings.EqualFold(attributes["rel"], "canonical") {
			canonical = strings.TrimSpace(attributes["href"])
			break
		}
	}
	if canonical == "" {
		return nil, errors.New("Vinted brand page is missing its canonical URL")
	}

	canonicalURL, err := url.Parse(canonical)
	if err != nil || canonicalURL.Scheme != "https" || !strings.EqualFold(canonicalURL.Hostname(), domain) || canonicalURL.Port() != "" {
		return nil, errors.New("Vinted brand page has an invalid canonical URL")
	}
	canonicalMatches := brandPathPattern.FindStringSubmatch(strings.TrimSuffix(canonicalURL.EscapedPath(), "/"))
	if len(canonicalMatches) != 3 || canonicalMatches[1] != strconv.FormatInt(expectedBrandID, 10) {
		return nil, errors.New("Vinted brand page canonical ID does not match")
	}

	return &BrandPageResolution{
		ID:           strconv.FormatInt(expectedBrandID, 10),
		Label:        label,
		CanonicalURL: canonicalURL.String(),
	}, nil
}

func normalizeHTMLText(value string) string {
	withoutTags := htmlTagPattern.ReplaceAllString(value, " ")
	return strings.Join(strings.Fields(html.UnescapeString(withoutTags)), " ")
}

var isoCountryMap = map[string]string{
	"DE": "🇩🇪 DE", "FR": "🇫🇷 FR", "IT": "🇮🇹 IT", "ES": "🇪🇸 ES",
	"NL": "🇳🇱 NL", "PL": "🇵🇱 PL", "AT": "🇦🇹 AT", "BE": "🇧🇪 BE",
	"GB": "🇬🇧 UK", "UK": "🇬🇧 UK", "LU": "🇱🇺 LU", "PT": "🇵🇹 PT",
	"CZ": "🇨🇿 CZ", "SK": "🇸🇰 SK", "LT": "🇱🇹 LT", "SE": "🇸🇪 SE",
	"DK": "🇩🇰 DK", "RO": "🇷🇴 RO", "HU": "🇭🇺 HU", "HR": "🇭🇷 HR",
	"FI": "🇫🇮 FI", "IE": "🇮🇪 IE", "SI": "🇸🇮 SI", "EE": "🇪🇪 EE",
	"LV": "🇱🇻 LV", "GR": "🇬🇷 GR",
}

var countryMap = map[string]string{
	"DEUTSCHLAND": "🇩🇪 DE", "GERMANY": "🇩🇪 DE",
	"FRANCE": "🇫🇷 FR", "FRANKREICH": "🇫🇷 FR",
	"ITALIA": "🇮🇹 IT", "ITALY": "🇮🇹 IT", "ITALIEN": "🇮🇹 IT",
	"ESPAÑA": "🇪🇸 ES", "SPAIN": "🇪🇸 ES", "SPANIEN": "🇪🇸 ES",
	"NEDERLAND": "🇳🇱 NL", "NETHERLANDS": "🇳🇱 NL", "NIEDERLANDE": "🇳🇱 NL",
	"POLSKA": "🇵🇱 PL", "POLAND": "🇵🇱 PL", "POLEN": "🇵🇱 PL",
	"ÖSTERREICH": "🇦🇹 AT", "AUSTRIA": "🇦🇹 AT",
	"BELGIË": "🇧🇪 BE", "BELGIUM": "🇧🇪 BE", "BELGIEN": "🇧🇪 BE",
	"UNITED KINGDOM": "🇬🇧 UK", "GROSSBRITANNIEN": "🇬🇧 UK",
	"LUXEMBOURG": "🇱🇺 LU", "LUXEMBURG": "🇱🇺 LU",
	"PORTUGAL":        "🇵🇹 PT",
	"ČESKÁ REPUBLIKA": "🇨🇿 CZ", "TSCHECHIEN": "🇨🇿 CZ",
	"SLOVENSKO": "🇸🇰 SK", "SLOWAKEI": "🇸🇰 SK",
	"LIETUVA": "🇱🇹 LT", "LITAUEN": "🇱🇹 LT",
	"SVERIGE": "🇸🇪 SE", "SCHWEDEN": "🇸🇪 SE",
	"DANMARK": "🇩🇰 DK", "DÄNEMARK": "🇩🇰 DK",
	"ROMÂNIA": "🇷🇴 RO", "RUMÄNIEN": "🇷🇴 RO",
	"MAGYARORSZÁG": "🇭🇺 HU", "UNGARN": "🇭🇺 HU",
	"HRVATSKA": "🇭🇷 HR", "KROATIEN": "🇭🇷 HR",
	"SUOMI": "🇫🇮 FI", "FINLAND": "🇫🇮 FI", "FINNLAND": "🇫🇮 FI",
	"IRELAND": "🇮🇪 IE", "IRLAND": "🇮🇪 IE",
	"SLOVENIJA": "🇸🇮 SI", "SLOWENIEN": "🇸🇮 SI",
	"EESTI": "🇪🇪 EE", "ESTLAND": "🇪🇪 EE",
	"LATVIJA": "🇱🇻 LV", "LETTLAND": "🇱🇻 LV",
	"ΕΛΛΆΔΑ": "🇬🇷 GR", "GREECE": "🇬🇷 GR", "GRIECHENLAND": "🇬🇷 GR",
}

func (c *Client) GetItem(itemID int64) (*VintedItemDetailResponse, error) {
	u := fmt.Sprintf("https://%s/api/v2/items/%d?localization=%s", c.session.Domain, itemID, c.locale())
	req, err := http.NewRequest("GET", u, nil)
	if err != nil {
		return nil, err
	}

	req.Header = c.apiHeaders()
	req.Header.Set("Referer", fmt.Sprintf("https://%s/items/%d", c.session.Domain, itemID))

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("item detail error: %d (%.100s)", resp.StatusCode, string(body))
	}

	var detail VintedItemDetailResponse
	if err := json.Unmarshal(body, &detail); err != nil {
		var alt struct {
			ID     int64         `json:"id"`
			Photos []VintedPhoto `json:"photos"`
			User   struct {
				ID                 int64   `json:"id"`
				CountryCode        string  `json:"country_iso_code"`
				FeedbackCount      int     `json:"feedback_count"`
				FeedbackReputation float64 `json:"feedback_reputation"`
			} `json:"user"`
		}
		if err2 := json.Unmarshal(body, &alt); err2 == nil && alt.ID != 0 {
			detail.Item.ID = alt.ID
			detail.Item.Photos = alt.Photos
			detail.Item.User.ID = alt.User.ID
			detail.Item.User.CountryCode = alt.User.CountryCode
			detail.Item.User.FeedbackCount = alt.User.FeedbackCount
			detail.Item.User.FeedbackReputation = alt.User.FeedbackReputation
			return &detail, nil
		}
		return nil, fmt.Errorf("unmarshal item detail: %w", err)
	}

	if detail.Item.ID == 0 {
		detail.Item.ID = itemID
	}

	return &detail, nil
}

func (c *Client) GetSellerInfo(userID int64) (*SellerInfo, error) {
	if info, ok := globalSellerCache.Get(userID); ok {
		return &info, nil
	}

	u := fmt.Sprintf("https://%s/api/v2/users/%d?localization=%s", c.session.Domain, userID, c.locale())
	req, err := http.NewRequest("GET", u, nil)
	if err != nil {
		return nil, err
	}

	req.Header = c.apiHeaders()
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("user detail error: %d", resp.StatusCode)
	}

	var wrapper struct {
		User struct {
			CountryCode        string  `json:"country_iso_code"`
			CountryTitle       string  `json:"country_title"`
			FeedbackReputation float64 `json:"feedback_reputation"`
			FeedbackCount      int     `json:"feedback_count"`
		} `json:"user"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&wrapper); err != nil {
		return nil, err
	}

	info := SellerInfo{
		Location: "Unknown",
		Rating:   "No rating",
	}

	code := strings.ToUpper(wrapper.User.CountryCode)
	if flag, ok := isoCountryMap[code]; ok {
		info.Location = flag
	} else if wrapper.User.CountryTitle != "" {
		if flag, ok := countryMap[strings.ToUpper(wrapper.User.CountryTitle)]; ok {
			info.Location = flag
		}
	}

	if wrapper.User.FeedbackCount > 0 {
		r := wrapper.User.FeedbackReputation * 5.0
		info.Rating = fmt.Sprintf("⭐ %.1f (%d)", r, wrapper.User.FeedbackCount)
	}

	globalSellerCache.Set(userID, info)
	return &info, nil
}

func (c *Client) EnrichFavorites(favs *FavoritesResponse) {
	if favs == nil || len(favs.Items) == 0 {
		return
	}

	var wg sync.WaitGroup
	sem := make(chan struct{}, 5)

	log.Printf("[vinted] enriching %d favorites with seller info for user %d...", len(favs.Items), c.session.VintedUserID)

	for i := range favs.Items {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			item := &favs.Items[idx]

			sInfo, err := c.GetSellerInfo(item.User.ID)
			if err == nil {
				item.Location = sInfo.Location
				item.Rating = sInfo.Rating
			}
		}(i)
	}

	wg.Wait()
}

func (c *Client) SendMessage(itemID, sellerID int64, message string) error {
	err := c.doSendMessage(itemID, sellerID, message)
	if err != nil && strings.Contains(err.Error(), "HTTP 401") && c.session.RefreshToken != "" {
		log.Printf("[vinted] send message got 401, attempting token refresh...")
		if refreshErr := c.RefreshAccessToken(); refreshErr != nil {
			log.Printf("[vinted] token refresh failed: %v", refreshErr)
			return err
		}
		return c.doSendMessage(itemID, sellerID, message)
	}
	return err
}

func (c *Client) GetInbox(page, perPage int) (*InboxResponse, error) {
	inbox, err := c.doGetInbox(page, perPage)
	if err != nil && (strings.Contains(err.Error(), "401") || strings.Contains(err.Error(), "403")) && c.session.RefreshToken != "" {
		log.Printf("[vinted] get inbox got %v, attempting token refresh...", err)
		if refreshErr := c.RefreshAccessToken(); refreshErr != nil {
			log.Printf("[vinted] token refresh failed: %v", refreshErr)
			return nil, err
		}
		return c.doGetInbox(page, perPage)
	}
	return inbox, err
}

func (c *Client) GetNotifications(page, perPage int) (*NotificationsResponse, error) {
	notifications, err := c.doGetNotifications(page, perPage)
	if err != nil && (strings.Contains(err.Error(), "401") || strings.Contains(err.Error(), "403")) && c.session.RefreshToken != "" {
		log.Printf("[vinted] get notifications got %v, attempting token refresh...", err)
		if refreshErr := c.RefreshAccessToken(); refreshErr != nil {
			log.Printf("[vinted] token refresh failed: %v", refreshErr)
			return nil, err
		}
		return c.doGetNotifications(page, perPage)
	}
	return notifications, err
}

func (c *Client) doGetInbox(page, perPage int) (*InboxResponse, error) {
	if err := c.WarmUp(); err != nil {
		log.Printf("[vinted] warmup failed before get inbox: %v", err)
	}

	if page <= 0 {
		page = 1
	}
	if perPage <= 0 {
		perPage = 20
	}

	u := fmt.Sprintf("https://%s/api/v2/inbox?page=%d&per_page=%d", c.session.Domain, page, perPage)
	req, err := http.NewRequest("GET", u, nil)
	if err != nil {
		return nil, fmt.Errorf("create inbox request: %w", err)
	}
	req.Header = c.apiHeaders()
	req.Header.Set("Referer", fmt.Sprintf("https://%s/inbox", c.session.Domain))

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("inbox request failed: %w", err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	log.Printf("[vinted] GET /api/v2/inbox?page=%d&per_page=%d -> %d (%.300s)", page, perPage, resp.StatusCode, string(body))

	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, truncate(string(body), 300))
	}

	var inbox InboxResponse
	if err := json.Unmarshal(body, &inbox); err != nil {
		return nil, fmt.Errorf("parse inbox response: %w", err)
	}

	return &inbox, nil
}

func (c *Client) doGetNotifications(page, perPage int) (*NotificationsResponse, error) {
	if err := c.WarmUp(); err != nil {
		log.Printf("[vinted] warmup failed before get notifications: %v", err)
	}

	if page <= 0 {
		page = 1
	}
	if perPage <= 0 {
		perPage = 5
	}

	apiDomain := strings.TrimPrefix(c.session.Domain, "www.")
	u := fmt.Sprintf("https://api.%s/inbox-notifications/v1/notifications?page=%d&per_page=%d", apiDomain, page, perPage)
	req, err := http.NewRequest("GET", u, nil)
	if err != nil {
		return nil, fmt.Errorf("create notifications request: %w", err)
	}
	req.Header = c.apiHeaders()
	req.Header.Set("Referer", fmt.Sprintf("https://%s/", c.session.Domain))
	req.Header.Set("X-Next-App", "marketplace-web")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("notifications request failed: %w", err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	log.Printf("[vinted] GET /inbox-notifications/v1/notifications?page=%d&per_page=%d -> %d (%.300s)", page, perPage, resp.StatusCode, string(body))

	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, truncate(string(body), 300))
	}

	var notifications NotificationsResponse
	if err := json.Unmarshal(body, &notifications); err != nil {
		return nil, fmt.Errorf("parse notifications response: %w", err)
	}

	for i := range notifications.Notifications {
		notifications.Notifications[i].URL = c.notificationWebURL(notifications.Notifications[i].Link)
	}

	return &notifications, nil
}

func (c *Client) notificationWebURL(rawLink string) string {
	if rawLink == "" {
		return ""
	}
	if strings.HasPrefix(rawLink, "/") {
		return fmt.Sprintf("https://%s%s", c.session.Domain, rawLink)
	}
	if strings.HasPrefix(rawLink, "http://") || strings.HasPrefix(rawLink, "https://") {
		return rawLink
	}
	if !strings.Contains(rawLink, "://") {
		return rawLink
	}

	parsed, err := url.Parse(rawLink)
	if err != nil {
		return rawLink
	}

	portalDomain := c.session.Domain
	if portal := strings.TrimSpace(parsed.Query().Get("portal")); portal != "" {
		portalDomain = domainForPortal(portal)
	}

	switch parsed.Host {
	case "messaging":
		itemID := strings.TrimSpace(parsed.Query().Get("item_id"))
		if itemID != "" {
			return fmt.Sprintf("https://%s/items/%s", portalDomain, itemID)
		}
		return fmt.Sprintf("https://%s/inbox", portalDomain)
	case "item":
		itemID := strings.TrimSpace(parsed.Query().Get("item_id"))
		if itemID != "" {
			return fmt.Sprintf("https://%s/items/%s", portalDomain, itemID)
		}
	}

	return fmt.Sprintf("https://%s/", portalDomain)
}

func domainForPortal(portal string) string {
	switch strings.ToLower(strings.TrimSpace(portal)) {
	case "de":
		return "www.vinted.de"
	case "fr":
		return "www.vinted.fr"
	case "es":
		return "www.vinted.es"
	case "it":
		return "www.vinted.it"
	case "nl":
		return "www.vinted.nl"
	case "pl":
		return "www.vinted.pl"
	case "uk":
		return "www.vinted.co.uk"
	case "ie":
		return "www.vinted.ie"
	case "com":
		return "www.vinted.com"
	default:
		return "www.vinted.de"
	}
}

func (c *Client) GetConversationReplies(conversationID int64, page, perPage int) (map[string]interface{}, error) {
	data, err := c.doGetConversationReplies(conversationID, page, perPage)
	if err != nil && (strings.Contains(err.Error(), "401") || strings.Contains(err.Error(), "403")) && c.session.RefreshToken != "" {
		log.Printf("[vinted] get conversation replies got %v, attempting token refresh...", err)
		if refreshErr := c.RefreshAccessToken(); refreshErr != nil {
			log.Printf("[vinted] token refresh failed: %v", refreshErr)
			return nil, err
		}
		return c.doGetConversationReplies(conversationID, page, perPage)
	}
	return data, err
}

func (c *Client) doGetConversationReplies(conversationID int64, page, perPage int) (map[string]interface{}, error) {
	if err := c.WarmUp(); err != nil {
		log.Printf("[vinted] warmup failed before get conversation replies: %v", err)
	}
	return c.getConversationDetail(conversationID)
}

func (c *Client) getConversationDetail(conversationID int64) (map[string]interface{}, error) {
	u := fmt.Sprintf("https://%s/api/v2/conversations/%d", c.session.Domain, conversationID)
	req, err := http.NewRequest("GET", u, nil)
	if err != nil {
		return nil, fmt.Errorf("create conversation detail request: %w", err)
	}
	req.Header = c.apiHeaders()
	req.Header.Set("Referer", fmt.Sprintf("https://%s/inbox/%d", c.session.Domain, conversationID))

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("conversation detail request failed: %w", err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	log.Printf("[vinted] GET /api/v2/conversations/%d -> %d (%.300s)", conversationID, resp.StatusCode, string(body))

	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, truncate(string(body), 300))
	}

	var payload map[string]interface{}
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, fmt.Errorf("parse conversation detail response: %w", err)
	}

	return payload, nil
}

func (c *Client) ReplyToConversation(conversationID int64, message string) error {
	err := c.doReplyToConversation(conversationID, message)
	if err != nil && strings.Contains(err.Error(), "HTTP 401") && c.session.RefreshToken != "" {
		log.Printf("[vinted] reply to conversation got 401, attempting token refresh...")
		if refreshErr := c.RefreshAccessToken(); refreshErr != nil {
			log.Printf("[vinted] token refresh failed: %v", refreshErr)
			return err
		}
		return c.doReplyToConversation(conversationID, message)
	}
	return err
}

func (c *Client) doReplyToConversation(conversationID int64, message string) error {
	if err := c.WarmUp(); err != nil {
		log.Printf("[vinted] warmup failed before reply to conversation: %v", err)
	}

	replyURL := fmt.Sprintf("https://%s/api/v2/conversations/%d/replies", c.session.Domain, conversationID)
	replyPayload := map[string]interface{}{
		"reply": map[string]interface{}{
			"body":                                   message,
			"photo_temp_uuids":                       nil,
			"is_personal_data_sharing_check_skipped": false,
		},
	}
	replyBody, _ := json.Marshal(replyPayload)

	req, err := http.NewRequest("POST", replyURL, strings.NewReader(string(replyBody)))
	if err != nil {
		return fmt.Errorf("create conversation reply request: %w", err)
	}
	req.Header = c.apiHeadersWithBody()
	req.Header.Set("Referer", fmt.Sprintf("https://%s/inbox/%d", c.session.Domain, conversationID))

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("conversation reply request failed: %w", err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	bodyStr := strings.TrimSpace(string(respBody))

	log.Printf("[vinted] POST /api/v2/conversations/%d/replies -> %d (%.300s)", conversationID, resp.StatusCode, bodyStr)

	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return nil
	}

	return fmt.Errorf("send reply failed (HTTP %d): %s", resp.StatusCode, truncate(bodyStr, 300))
}

func (c *Client) doSendMessage(itemID, sellerID int64, message string) error {
	if err := c.WarmUp(); err != nil {
		log.Printf("[vinted] warmup failed before send message: %v", err)
	}

	convoURL := fmt.Sprintf("https://%s/api/v2/conversations", c.session.Domain)
	convoPayload := map[string]interface{}{
		"initiator":        "ask_seller",
		"item_id":          fmt.Sprintf("%d", itemID),
		"opposite_user_id": fmt.Sprintf("%d", sellerID),
	}
	convoBody, _ := json.Marshal(convoPayload)

	req, err := http.NewRequest("POST", convoURL, strings.NewReader(string(convoBody)))
	if err != nil {
		return fmt.Errorf("create conversation request: %w", err)
	}
	req.Header = c.apiHeadersWithBody()

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("conversation request failed: %w", err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	bodyStr := strings.TrimSpace(string(respBody))

	log.Printf("[vinted] POST /api/v2/conversations -> %d (%.300s)", resp.StatusCode, bodyStr)

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("create conversation failed (HTTP %d): %s", resp.StatusCode, truncate(bodyStr, 300))
	}

	var convoResp struct {
		Conversation struct {
			ID int64 `json:"id"`
		} `json:"conversation"`
	}
	if err := json.Unmarshal(respBody, &convoResp); err != nil {
		return fmt.Errorf("parse conversation response: %w", err)
	}
	convoID := convoResp.Conversation.ID
	if convoID == 0 {
		var alt struct {
			ID int64 `json:"id"`
		}
		if err := json.Unmarshal(respBody, &alt); err == nil && alt.ID > 0 {
			convoID = alt.ID
		}
	}
	if convoID == 0 {
		return fmt.Errorf("could not extract conversation ID from response: %.200s", bodyStr)
	}

	log.Printf("[vinted] created conversation %d for item %d", convoID, itemID)

	replyURL := fmt.Sprintf("https://%s/api/v2/conversations/%d/replies", c.session.Domain, convoID)
	replyPayload := map[string]interface{}{
		"reply": map[string]interface{}{
			"body":                                   message,
			"photo_temp_uuids":                       nil,
			"is_personal_data_sharing_check_skipped": false,
		},
	}
	replyBody, _ := json.Marshal(replyPayload)

	req2, err := http.NewRequest("POST", replyURL, strings.NewReader(string(replyBody)))
	if err != nil {
		return fmt.Errorf("create reply request: %w", err)
	}
	req2.Header = c.apiHeadersWithBody()

	resp2, err := c.httpClient.Do(req2)
	if err != nil {
		return fmt.Errorf("reply request failed: %w", err)
	}
	defer resp2.Body.Close()

	respBody2, _ := io.ReadAll(resp2.Body)
	bodyStr2 := strings.TrimSpace(string(respBody2))

	log.Printf("[vinted] POST /api/v2/conversations/%d/replies -> %d (%.300s)", convoID, resp2.StatusCode, bodyStr2)

	if resp2.StatusCode >= 200 && resp2.StatusCode < 300 {
		log.Printf("[vinted] message sent to seller %d for item %d", sellerID, itemID)
		return nil
	}

	return fmt.Errorf("send reply failed (HTTP %d): %s", resp2.StatusCode, truncate(bodyStr2, 300))
}

func (c *Client) SendOffer(itemID, sellerID int64, price string, currency string) error {
	err := c.doSendOffer(itemID, sellerID, price, currency)
	if err != nil && strings.Contains(err.Error(), "HTTP 401") && c.session.RefreshToken != "" {
		log.Printf("[vinted] send offer got 401, attempting token refresh...")
		if refreshErr := c.RefreshAccessToken(); refreshErr != nil {
			log.Printf("[vinted] token refresh failed: %v", refreshErr)
			return err
		}
		return c.doSendOffer(itemID, sellerID, price, currency)
	}
	return err
}

func (c *Client) doSendOffer(itemID, sellerID int64, price string, currency string) error {
	if err := c.WarmUp(); err != nil {
		log.Printf("[vinted] warmup failed before send offer: %v", err)
	}

	convoURL := fmt.Sprintf("https://%s/api/v2/conversations", c.session.Domain)
	convoPayload := map[string]interface{}{
		"initiator":        "ask_seller",
		"item_id":          fmt.Sprintf("%d", itemID),
		"opposite_user_id": fmt.Sprintf("%d", sellerID),
	}
	body, _ := json.Marshal(convoPayload)

	req, err := http.NewRequest("POST", convoURL, strings.NewReader(string(body)))
	if err != nil {
		return fmt.Errorf("create conversation request: %w", err)
	}
	req.Header = c.apiHeadersWithBody()

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("conversation request failed: %w", err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	bodyStr := strings.TrimSpace(string(respBody))

	log.Printf("[vinted] POST /api/v2/conversations (for offer context) -> %d (%.300s)", resp.StatusCode, bodyStr)

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("failed to get transaction/conversation context (HTTP %d): %s", resp.StatusCode, truncate(bodyStr, 300))
	}

	var convoResp struct {
		Conversation struct {
			Transaction struct {
				ID int64 `json:"id"`
			} `json:"transaction"`
		} `json:"conversation"`
	}

	if err := json.Unmarshal(respBody, &convoResp); err != nil {
		return fmt.Errorf("parse conversation response for tx id: %w", err)
	}

	txID := convoResp.Conversation.Transaction.ID
	if txID == 0 {
		return fmt.Errorf("could not extract transaction ID from conversation response: %.200s", bodyStr)
	}

	log.Printf("[vinted] found transaction ID %d for offer", txID)

	offerURL := fmt.Sprintf("https://%s/api/v2/transactions/%d/offer_requests", c.session.Domain, txID)
	offerPayload := map[string]interface{}{
		"offer_request": map[string]string{
			"price":    price,
			"currency": currency,
		},
	}
	offerBody, _ := json.Marshal(offerPayload)

	req2, err := http.NewRequest("POST", offerURL, strings.NewReader(string(offerBody)))
	if err != nil {
		return fmt.Errorf("create offer request: %w", err)
	}
	req2.Header = c.apiHeadersWithBody()

	resp2, err := c.httpClient.Do(req2)
	if err != nil {
		return fmt.Errorf("offer request failed: %w", err)
	}
	defer resp2.Body.Close()

	respBody2, _ := io.ReadAll(resp2.Body)
	bodyStr2 := strings.TrimSpace(string(respBody2))

	log.Printf("[vinted] POST /api/v2/transactions/%d/offer_requests -> %d (%.300s)", txID, resp2.StatusCode, bodyStr2)

	if resp2.StatusCode >= 200 && resp2.StatusCode < 300 {
		log.Printf("[vinted] offer sent for item %d (price: %s %s)", itemID, price, currency)
		return nil
	}

	var errResp struct {
		Message string `json:"message"`
		Code    int    `json:"code"`
	}
	if err := json.Unmarshal(respBody2, &errResp); err == nil && errResp.Message != "" {
		return fmt.Errorf("offer failed: %s", errResp.Message)
	}

	return fmt.Errorf("send offer failed (HTTP %d): %s", resp2.StatusCode, truncate(bodyStr2, 300))
}
