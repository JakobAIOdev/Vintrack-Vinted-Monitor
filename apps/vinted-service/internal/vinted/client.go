package vinted

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/url"
	"regexp"
	"strconv"
	"strings"

	"vintrack-vinted/internal/session"

	http "github.com/bogdanfinn/fhttp"
	tls_client "github.com/bogdanfinn/tls-client"
	"github.com/bogdanfinn/tls-client/profiles"
)

type Client struct {
	httpClient tls_client.HttpClient
	session    *session.VintedSession
	csrfToken  string
	anonID     string
	warmedUp   bool
}

func NewClient(sess *session.VintedSession) (*Client, error) {
	jar := tls_client.NewCookieJar()

	options := []tls_client.HttpClientOption{
		tls_client.WithTimeoutSeconds(15),
		tls_client.WithClientProfile(profiles.Chrome_120),
		tls_client.WithCookieJar(jar),
	}

	httpClient, err := tls_client.NewHttpClient(tls_client.NewNoopLogger(), options...)
	if err != nil {
		return nil, fmt.Errorf("create tls client: %w", err)
	}

	return &Client{httpClient: httpClient, session: sess}, nil
}

func (c *Client) injectAuthCookie() {
	domainURL, _ := url.Parse(fmt.Sprintf("https://%s/", c.session.Domain))
	c.httpClient.SetCookies(domainURL, []*http.Cookie{
		{
			Name:  "access_token_web",
			Value: c.session.AccessToken,
			Path:  "/",
		},
	})
}

func (c *Client) apiHeaders() http.Header {
	h := http.Header{
		"User-Agent":         {"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"},
		"Accept":             {"application/json, text/plain, */*"},
		"Accept-Language":    {"de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7"},
		"Cache-Control":      {"no-cache"},
		"Pragma":             {"no-cache"},
		"Locale":             {c.locale()},
		"Origin":             {fmt.Sprintf("https://%s", c.session.Domain)},
		"Referer":            {fmt.Sprintf("https://%s/", c.session.Domain)},
		"Sec-Ch-Ua":          {`"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"`},
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
	case strings.Contains(c.session.Domain, "vinted.com"):
		return "en-US"
	default:
		return "de-DE"
	}
}

func (c *Client) WarmUp() error {
	if c.warmedUp {
		return nil
	}

	u := fmt.Sprintf("https://%s/", c.session.Domain)
	req, _ := http.NewRequest("GET", u, nil)
	req.Header = http.Header{
		"User-Agent": {"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"},
		"Accept":     {"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"},
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("warmup: %w", err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()

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

	c.warmedUp = true
	log.Printf("[vinted] warmup done for %s, csrf=%v, anon_id=%v", c.session.Domain, c.csrfToken != "", c.anonID != "")
	return nil
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
	var userID int64
	if sub, ok := claims["sub"].(string); ok {
		userID, _ = strconv.ParseInt(sub, 10, 64)
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
					return nil, fmt.Errorf("authentication failed (HTTP %d)", resp.StatusCode)
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
	if err != nil && strings.Contains(err.Error(), "HTTP 401") && c.session.RefreshToken != "" {
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
	if err != nil && strings.Contains(err.Error(), "HTTP 401") && c.session.RefreshToken != "" {
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

	refreshURL := fmt.Sprintf("https://%s/web/api/auth/refresh", c.session.Domain)

	req, err := http.NewRequest("POST", refreshURL, strings.NewReader(""))
	if err != nil {
		return fmt.Errorf("create refresh request: %w", err)
	}
	req.Header = http.Header{
		"User-Agent":         {"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"},
		"Accept":             {"application/json, text/plain, */*"},
		"Accept-Language":    {c.locale()},
		"Cache-Control":      {"no-cache"},
		"Pragma":             {"no-cache"},
		"Origin":             {fmt.Sprintf("https://%s", c.session.Domain)},
		"Referer":            {fmt.Sprintf("https://%s/session-refresh?ref_url=%%2F", c.session.Domain)},
		"Sec-Ch-Ua":          {`"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"`},
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
		return fmt.Errorf("refresh request failed: %w", err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	log.Printf("[vinted] POST /web/api/auth/refresh -> %d (%.200s)", resp.StatusCode, string(body))

	if resp.StatusCode != 200 {
		return fmt.Errorf("refresh failed (HTTP %d): %s", resp.StatusCode, truncate(string(body), 200))
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
		for _, cookie := range resp.Cookies() {
			switch cookie.Name {
			case "access_token_web":
				newAccessToken = cookie.Value
			case "refresh_token_web":
				newRefreshToken = cookie.Value
			}
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
	c.warmedUp = false

	log.Printf("[vinted] token refresh successful, new access token: %s...", truncate(newAccessToken, 20))
	return nil
}
