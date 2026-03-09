package scraper

import (
	"io"
	"log"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"

	"vintrack-worker/internal/database"
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

func parseSellerInfoFromHTML(htmlBody []byte) SellerInfo {
	html := string(htmlBody)
	upperHTML := strings.ToUpper(html)

	var info SellerInfo

	for name, code := range countryMap {
		if strings.Contains(upperHTML, ", "+name) ||
			strings.Contains(upperHTML, ">"+name+"<") ||
			strings.Contains(upperHTML, "> "+name+"<") {
			info.Region = code
			break
		}
	}
	if matches := ariaLabelRatingRegex.FindStringSubmatch(html); len(matches) > 1 {
		rating := strings.Replace(matches[1], ",", ".", 1)
		info.Rating = "⭐ " + rating

		if m := ratingLabelRegex.FindStringSubmatch(html); len(m) > 1 {
			info.Rating += " (" + m[1] + ")"
		} else if m := reviewCountLabelRegex.FindStringSubmatch(html); len(m) > 1 {
			info.Rating += " (" + m[1] + ")"
		}
	}

	return info
}

type HTMLScraper struct {
	clients []*Client
	pm      *proxy.Manager
	db      *database.Store
	mu      sync.Mutex
	idx     int
}

func NewHTMLScraper(pm *proxy.Manager, db *database.Store) *HTMLScraper {
	poolSize := 3
	if pm.Count() < poolSize {
		poolSize = pm.Count()
	}
	if poolSize < 1 {
		poolSize = 1
	}
	s := &HTMLScraper{pm: pm, db: db, clients: make([]*Client, 0, poolSize)}
	for i := 0; i < poolSize; i++ {
		s.addClient()
	}
	return s
}

func (s *HTMLScraper) addClient() {
	client, err := NewClient(s.pm.Next())
	if err != nil {
		log.Printf("scraper client creation: %v", err)
		return
	}
	if err := client.WarmUp(); err != nil {
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
			go func(idx int) {
				nc, err := NewClient(s.pm.Next())
				if err != nil {
					return
				}
				_ = nc.WarmUp()
				s.mu.Lock()
				if idx < len(s.clients) {
					s.clients[idx] = nc
				}
				s.mu.Unlock()
			}(i)
			return
		}
	}
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

	info := s.scrapeWithRetry(itemURL)

	if userID > 0 && info.Region != "NaN" {
		sellerCache.Set(userID, info)
		s.db.SetUserRegion(userID, info.Region)
	}

	return info
}

func (s *HTMLScraper) scrapeWithRetry(itemURL string) SellerInfo {
	client := s.nextClient()
	if client == nil {
		return SellerInfo{Region: "NaN"}
	}

	info, status := s.doScrape(client, itemURL)
	if info.Region != "" {
		return info
	}

	if status != 200 {
		s.replaceClient(client)
		client2 := s.nextClient()
		if client2 != nil {
			info, _ = s.doScrape(client2, itemURL)
			if info.Region != "" {
				return info
			}
		}
	}

	return SellerInfo{Region: "NaN"}
}

func (s *HTMLScraper) doScrape(client *Client, itemURL string) (SellerInfo, int) {
	if client == nil {
		return SellerInfo{}, 0
	}

	body, status := s.fetchHTML(client, itemURL)
	if status != 200 || len(body) == 0 {
		return SellerInfo{}, status
	}

	return parseSellerInfoFromHTML(body), 200
}

func (s *HTMLScraper) fetchHTML(client *Client, targetURL string) ([]byte, int) {
	currentURL := targetURL

	// Extract domain from URL for headers
	domain := "www.vinted.de"
	if parsed, err := url.Parse(targetURL); err == nil && parsed.Host != "" {
		domain = parsed.Host
	}

	for redirects := 0; redirects < 3; redirects++ {
		req, err := http.NewRequest("GET", currentURL, nil)
		if err != nil {
			return nil, 0
		}

		req.Header = newPageHeaders(domain)

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

		body, _ := io.ReadAll(io.LimitReader(resp.Body, maxHTMLResponseBytes))
		resp.Body.Close()
		return body, 200
	}

	return nil, 0
}
