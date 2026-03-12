package scraper

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"

	"vintrack-worker/internal/database"
	"vintrack-worker/internal/model"
	"vintrack-worker/internal/proxy"

	http "github.com/bogdanfinn/fhttp"
)

const maxHTMLResponseBytes = 1 * 1024 * 1024 // 1 MB

type SellerInfo struct {
	Region string
	Rating string
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

type sellerCacheEntry struct {
	info    SellerInfo
	counter uint64
}

type sellerInfoCache struct {
	mu      sync.RWMutex
	cache   map[int64]sellerCacheEntry
	counter uint64
}

var sellerCache = &sellerInfoCache{
	cache: make(map[int64]sellerCacheEntry, 4096),
}

func (c *sellerInfoCache) Get(userID int64) (SellerInfo, bool) {
	c.mu.RLock()
	entry, ok := c.cache[userID]
	c.mu.RUnlock()
	if ok {
		n := atomic.AddUint64(&c.counter, 1)
		c.mu.Lock()
		if e, exists := c.cache[userID]; exists {
			e.counter = n
			c.cache[userID] = e
		}
		c.mu.Unlock()
	}
	return entry.info, ok
}

func (c *sellerInfoCache) Set(userID int64, info SellerInfo) {
	n := atomic.AddUint64(&c.counter, 1)
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.cache) > 50000 {
		minCounter := n
		for _, e := range c.cache {
			if e.counter < minCounter {
				minCounter = e.counter
			}
		}
		mid := minCounter + (n-minCounter)/2
		for k, e := range c.cache {
			if e.counter < mid {
				delete(c.cache, k)
			}
		}
	}
	c.cache[userID] = sellerCacheEntry{info: info, counter: n}
}

var ariaLabelRatingRegex = regexp.MustCompile(`(?i)aria-label="[^"]*?(\d+(?:[.,]\d+)?)\s*(?:von|out of|sur|di|van)\s*5[^"]*?(?:Stern|star|étoi|stell)[^"]*?"`)
var ratingLabelRegex = regexp.MustCompile(`(?i)Rating__label[^>]*>\s*<[^>]*>\s*(\d{1,5})\s*<`)
var reviewCountLabelRegex = regexp.MustCompile(`(?i)(\d{1,5})\s*(?:Bewertung|review|avis|recens)`)

var jsonCountryTitleRegex = regexp.MustCompile(`"country_title"\s*:\s*"([^"]{2,50})"`)
var jsonAddressCountryRegex = regexp.MustCompile(`"addressCountry"\s*:\s*"([A-Z]{2})"`)
var jsonCityRegex = regexp.MustCompile(`"city"\s*:\s*"[^"]+"[^}]{0,200}?"country_title"\s*:\s*"([^"]{2,50})"`)
var jsonReputationRegex = regexp.MustCompile(`"feedback_reputation"\s*:\s*([\d.]+)`)
var jsonFeedbackCountRegex = regexp.MustCompile(`"feedback_count"\s*:\s*(\d+)`)

var isoCountryMap = map[string]string{
	"DE": "🇩🇪 DE", "FR": "🇫🇷 FR", "IT": "🇮🇹 IT", "ES": "🇪🇸 ES",
	"NL": "🇳🇱 NL", "PL": "🇵🇱 PL", "AT": "🇦🇹 AT", "BE": "🇧🇪 BE",
	"GB": "🇬🇧 UK", "UK": "🇬🇧 UK", "LU": "🇱🇺 LU", "PT": "🇵🇹 PT",
	"CZ": "🇨🇿 CZ", "SK": "🇸🇰 SK", "LT": "🇱🇹 LT", "SE": "🇸🇪 SE",
	"DK": "🇩🇰 DK", "RO": "🇷🇴 RO", "HU": "🇭🇺 HU", "HR": "🇭🇷 HR",
	"FI": "🇫🇮 FI", "IE": "🇮🇪 IE", "SI": "🇸🇮 SI", "EE": "🇪🇪 EE",
	"LV": "🇱🇻 LV", "GR": "🇬🇷 GR",
}

func parseSellerInfoFromHTML(htmlBody []byte) SellerInfo {
	html := string(htmlBody)
	var info SellerInfo

	if m := jsonCountryTitleRegex.FindStringSubmatch(html); len(m) > 1 {
		country := strings.ToUpper(strings.TrimSpace(m[1]))
		if code, ok := countryMap[country]; ok {
			info.Region = code
		}
	}

	if info.Region == "" {
		if m := jsonAddressCountryRegex.FindStringSubmatch(html); len(m) > 1 {
			if code, ok := isoCountryMap[m[1]]; ok {
				info.Region = code
			}
		}
	}

	if info.Region == "" {
		upperHTML := strings.ToUpper(html)
		for name, code := range countryMap {
			if strings.Contains(upperHTML, ", "+name) ||
				strings.Contains(upperHTML, ">"+name+"<") ||
				strings.Contains(upperHTML, "> "+name+"<") {
				info.Region = code
				break
			}
		}
	}

	if m := jsonReputationRegex.FindStringSubmatch(html); len(m) > 1 {
		info.Rating = "⭐ " + m[1]
		if mc := jsonFeedbackCountRegex.FindStringSubmatch(html); len(mc) > 1 {
			info.Rating += " (" + mc[1] + ")"
		}
	}

	if info.Rating == "" {
		if matches := ariaLabelRatingRegex.FindStringSubmatch(html); len(matches) > 1 {
			rating := strings.Replace(matches[1], ",", ".", 1)
			info.Rating = "⭐ " + rating

			if m := ratingLabelRegex.FindStringSubmatch(html); len(m) > 1 {
				info.Rating += " (" + m[1] + ")"
			} else if m := reviewCountLabelRegex.FindStringSubmatch(html); len(m) > 1 {
				info.Rating += " (" + m[1] + ")"
			}
		}
	}

	return info
}

type HTMLScraper struct {
	clients []*Client
	pm      *proxy.Manager
	db      *database.Store
	domain  string
	mu      sync.Mutex
	idx     int
}

func NewHTMLScraper(pm *proxy.Manager, db *database.Store, domain string, poolSize int) *HTMLScraper {
	if pm.Count() < poolSize {
		poolSize = pm.Count()
	}
	if poolSize < 1 {
		poolSize = 1
	}
	s := &HTMLScraper{pm: pm, db: db, domain: domain, clients: make([]*Client, 0, poolSize)}
	for i := 0; i < poolSize; i++ {
		s.addClient()
	}
	return s
}

func (s *HTMLScraper) addClient() {
	client, err := NewHTMLClient(s.pm.Next())
	if err != nil {
		log.Printf("scraper client creation: %v", err)
		return
	}
	if err := client.WarmUpRegion(s.domain); err != nil {
		log.Printf("scraper warmup: %v", err)
	}
	s.clients = append(s.clients, client)
}

func (s *HTMLScraper) nextClient() *Client {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.clients) == 0 {
		return nil
	}
	c := s.clients[s.idx%len(s.clients)]
	s.idx++
	return c
}

func (s *HTMLScraper) replaceClient(bad *Client) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, c := range s.clients {
		if c == bad {
			go func(idx int, domain string) {
				nc, err := NewHTMLClient(s.pm.Next())
				if err != nil {
					return
				}
				_ = nc.WarmUpRegion(domain)
				s.mu.Lock()
				if idx < len(s.clients) {
					s.clients[idx] = nc
				}
				s.mu.Unlock()
			}(i, s.domain)
			return
		}
	}
}

func LookupCachedSellerInfo(db *database.Store, userID int64) (SellerInfo, bool) {
	if userID <= 0 {
		return SellerInfo{}, false
	}
	if info, ok := sellerCache.Get(userID); ok {
		return info, true
	}
	if region, ok := db.GetUserRegion(userID); ok && region != "" {
		info := SellerInfo{Region: region}
		sellerCache.Set(userID, info)
		return info, true
	}
	return SellerInfo{}, false
}

func (s *HTMLScraper) FetchSellerInfo(itemURL string, userID int64) SellerInfo {
	if userID > 0 {
		if info, ok := sellerCache.Get(userID); ok {
			return info
		}
	}

	if userID > 0 {
		if region, ok := s.db.GetUserRegion(userID); ok && region != "" {
			info := SellerInfo{Region: region}
			sellerCache.Set(userID, info)
			return info
		}
	}

	scrapeURL := itemURL
	if userID > 0 {
		scrapeURL = fmt.Sprintf("https://%s/member/%d", s.domain, userID)
	}
	info := s.scrapeWithRetry(scrapeURL, userID)

	if userID > 0 && info.Region != "" && info.Region != "NaN" {
		sellerCache.Set(userID, info)
		s.db.SetUserRegion(userID, info.Region)
	}

	return info
}

func (s *HTMLScraper) scrapeWithRetry(itemURL string, userID int64) SellerInfo {
	client := s.nextClient()
	if client == nil {
		return SellerInfo{Region: "NaN"}
	}

	info, status := s.doScrape(client, itemURL, userID)
	if info.Region != "" {
		return info
	}

	if status != 200 {
		s.replaceClient(client)
	}

	client2 := s.nextClient()
	if client2 != nil && client2 != client {
		info, status2 := s.doScrape(client2, itemURL, userID)
		if info.Region != "" {
			return info
		}
		if status2 != 200 {
			s.replaceClient(client2)
		}
	}

	return SellerInfo{Region: "NaN"}
}

func (s *HTMLScraper) doScrape(client *Client, scrapeURL string, userID int64) (SellerInfo, int) {
	if client == nil {
		return SellerInfo{}, 0
	}

	if userID > 0 {
		apiURL := fmt.Sprintf("https://%s/api/v2/users/%d", s.domain, userID)
		body, status := s.fetchBody(client, apiURL, true)
		if status == 200 && len(body) > 0 {
			var resp model.VintedUserDetailResponse
			if err := json.Unmarshal(body, &resp); err == nil && resp.User.ID > 0 {
				info := SellerInfo{}
				if code, ok := isoCountryMap[resp.User.CountryCode]; ok {
					info.Region = code
				} else if resp.User.CountryTitle != "" {
					if code, ok := countryMap[strings.ToUpper(resp.User.CountryTitle)]; ok {
						info.Region = code
					}
				}

				if resp.User.FeedbackCount > 0 {
					rating := resp.User.FeedbackReputation * 5.0
					info.Rating = fmt.Sprintf("⭐ %.1f (%d)", rating, resp.User.FeedbackCount)
				} else {
					info.Rating = "Keine Bewertungen"
				}

				if info.Region != "" {
					return info, 200
				}
			}
		}
		if status == 403 || status == 429 {
			return SellerInfo{}, status
		}
	}

	body, status := s.fetchBody(client, scrapeURL, false)
	if status != 200 || len(body) == 0 {
		return SellerInfo{}, status
	}

	info := parseSellerInfoFromHTML(body)
	return info, 200
}

func (s *HTMLScraper) fetchBody(client *Client, targetURL string, isAPI bool) ([]byte, int) {
	currentURL := targetURL

	domain := s.domain
	if parsed, err := url.Parse(targetURL); err == nil && parsed.Host != "" {
		domain = parsed.Host
	}

	for redirects := 0; redirects < 3; redirects++ {
		req, err := http.NewRequest("GET", currentURL, nil)
		if err != nil {
			return nil, 0
		}

		if isAPI {
			req.Header = newAPIHeaders(domain)
		} else {
			req.Header = newPageHeaders(domain)
		}

		resp, err := client.HttpClient.Do(req)
		if err != nil {
			return nil, 0
		}

		if resp.StatusCode >= 300 && resp.StatusCode < 400 {
			location := resp.Header.Get("Location")
			resp.Body.Close()
			if location == "" {
				return nil, resp.StatusCode
			}
			if strings.HasPrefix(location, "/") {
				location = "https://" + domain + location
			}
			currentURL = location
			continue
		}

		if resp.StatusCode != 200 {
			resp.Body.Close()
			return nil, resp.StatusCode
		}

		limit := maxHTMLResponseBytes
		if isAPI {
			limit = 512 * 1024
		}
		body, _ := io.ReadAll(io.LimitReader(resp.Body, int64(limit)))
		resp.Body.Close()
		return body, 200
	}

	return nil, 0
}
