package scraper

import (
	"io"
	"log"
	"net/url"
	"regexp"
	"strings"
	"sync"

	"vintrack-worker/internal/database"
	"vintrack-worker/internal/proxy"

	http "github.com/bogdanfinn/fhttp"
)

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

type sellerInfoCache struct {
	mu    sync.RWMutex
	cache map[int64]SellerInfo
}

var sellerCache = &sellerInfoCache{
	cache: make(map[int64]SellerInfo, 4096),
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
	if len(c.cache) > 50000 {
		newCache := make(map[int64]SellerInfo, 25000)
		i := 0
		for k, v := range c.cache {
			if i >= 25000 {
				break
			}
			newCache[k] = v
			i++
		}
		c.cache = newCache
	}
	c.cache[userID] = info
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
	client *Client
	pm     *proxy.Manager
	db     *database.Store
	mu     sync.Mutex
}

func NewHTMLScraper(pm *proxy.Manager, db *database.Store) *HTMLScraper {
	s := &HTMLScraper{pm: pm, db: db}
	s.warmUp()
	return s
}

func (s *HTMLScraper) warmUp() {
	client, err := NewClient(s.pm.Next())
	if err != nil {
		log.Printf("scraper warmup: %v", err)
		return
	}
	if err := client.WarmUp(); err != nil {
		log.Printf("scraper warmup request: %v", err)
	}
	s.client = client
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
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.client == nil {
		s.warmUp()
	}

	info, status := s.doScrape(itemURL)
	if info.Region != "" {
		return info
	}

	if status != 200 {
		s.warmUp()
		info, _ = s.doScrape(itemURL)
		if info.Region != "" {
			return info
		}
	}

	return SellerInfo{Region: "NaN"}
}

func (s *HTMLScraper) doScrape(itemURL string) (SellerInfo, int) {
	if s.client == nil {
		return SellerInfo{}, 0
	}

	body, status := s.fetchHTML(itemURL)
	if status != 200 || len(body) == 0 {
		return SellerInfo{}, status
	}

	return parseSellerInfoFromHTML(body), 200
}

func (s *HTMLScraper) fetchHTML(targetURL string) ([]byte, int) {
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

		resp, err := s.client.HttpClient.Do(req)
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

		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		return body, 200
	}

	return nil, 0
}
