package scraper

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"

	"vintrack-worker/internal/database"
	"vintrack-worker/internal/model"
	"vintrack-worker/internal/proxy"

	http "github.com/bogdanfinn/fhttp"
)

type SellerInfo struct {
	Region          string
	Rating          string
	RatingStars     float64
	RatingCount     int
	RatingAvailable bool
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

var isoCountryMap = map[string]string{
	"DE": "🇩🇪 DE", "FR": "🇫🇷 FR", "IT": "🇮🇹 IT", "ES": "🇪🇸 ES",
	"NL": "🇳🇱 NL", "PL": "🇵🇱 PL", "AT": "🇦🇹 AT", "BE": "🇧🇪 BE",
	"GB": "🇬🇧 UK", "UK": "🇬🇧 UK", "LU": "🇱🇺 LU", "PT": "🇵🇹 PT",
	"CZ": "🇨🇿 CZ", "SK": "🇸🇰 SK", "LT": "🇱🇹 LT", "SE": "🇸🇪 SE",
	"DK": "🇩🇰 DK", "RO": "🇷🇴 RO", "HU": "🇭🇺 HU", "HR": "🇭🇷 HR",
	"FI": "🇫🇮 FI", "IE": "🇮🇪 IE", "SI": "🇸🇮 SI", "EE": "🇪🇪 EE",
	"LV": "🇱🇻 LV", "GR": "🇬🇷 GR",
}

func logSellerEnrichmentSuccess(source string, userID int64, info SellerInfo) {
	log.Printf("[seller-enrich] user=%d source=%s success region=%q rating=%q rating_available=%v", userID, source, info.Region, info.Rating, info.RatingAvailable)
}

func logSellerEnrichmentFailure(source string, userID int64, format string, args ...interface{}) {
	msg := fmt.Sprintf(format, args...)
	log.Printf("[seller-enrich] user=%d source=%s failed %s", userID, source, msg)
}

func isSellerInfoComplete(info SellerInfo) bool {
	return info.Region != "" && info.RatingAvailable
}

func normalizeSellerRating(feedbackCount int, feedbackReputation float64) (string, float64, int, bool) {
	if feedbackCount > 0 &&
		!math.IsNaN(feedbackReputation) &&
		!math.IsInf(feedbackReputation, 0) &&
		feedbackReputation >= 0 &&
		feedbackReputation <= 1 {
		rating := math.Round(feedbackReputation*50.0) / 10.0
		return fmt.Sprintf("⭐ %.1f (%d)", rating, feedbackCount), rating, feedbackCount, true
	}
	if feedbackCount == 0 && feedbackReputation == 0 {
		return "No rating", 0, 0, true
	}
	return "", 0, 0, false
}

type SellerEnricher struct {
	clients         []*Client
	pm              *proxy.Manager
	db              *database.Store
	domain          string
	trafficRecorder func(txBytes int64, rxBytes int64)
	mu              sync.Mutex
	idx             int
}

func NewSellerEnricher(pm *proxy.Manager, db *database.Store, domain string, poolSize int, trafficRecorder func(txBytes int64, rxBytes int64)) *SellerEnricher {
	if pm.Count() < poolSize {
		poolSize = pm.Count()
	}
	if poolSize < 1 {
		poolSize = 1
	}
	s := &SellerEnricher{pm: pm, db: db, domain: domain, trafficRecorder: trafficRecorder, clients: make([]*Client, 0, poolSize)}
	for i := 0; i < poolSize; i++ {
		s.addClient()
	}
	return s
}

func (s *SellerEnricher) addClient() {
	client, err := NewSellerClient(s.pm.Next(), s.trafficRecorder)
	if err != nil {
		log.Printf("seller enricher client creation: %v", err)
		return
	}
	s.clients = append(s.clients, client)
}

func (s *SellerEnricher) nextClient() *Client {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.clients) == 0 {
		return nil
	}
	c := s.clients[s.idx%len(s.clients)]
	s.idx++
	return c
}

func (s *SellerEnricher) replaceClient(bad *Client) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, c := range s.clients {
		if c == bad {
			go func(idx int) {
				nc, err := NewSellerClient(s.pm.Next(), s.trafficRecorder)
				if err != nil {
					return
				}
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

func LookupCachedSellerInfo(db *database.Store, userID int64) (SellerInfo, bool) {
	if userID <= 0 {
		return SellerInfo{}, false
	}
	if info, ok := sellerCache.Get(userID); ok {
		if isSellerInfoComplete(info) {
			logSellerEnrichmentSuccess("memory-cache", userID, info)
		} else {
			log.Printf("[seller-enrich] user=%d source=memory-cache partial region=%q rating=%q", userID, info.Region, info.Rating)
		}
		return info, true
	}
	if region, ok := db.GetUserRegion(userID); ok && region != "" {
		info := SellerInfo{Region: region}
		log.Printf("[seller-enrich] user=%d source=db-cache partial region=%q rating=%q", userID, info.Region, info.Rating)
		return info, true
	}
	return SellerInfo{}, false
}

func (s *SellerEnricher) FetchSellerInfo(userID int64) SellerInfo {
	if userID > 0 {
		if info, ok := sellerCache.Get(userID); ok {
			if isSellerInfoComplete(info) {
				logSellerEnrichmentSuccess("memory-cache", userID, info)
				return info
			}
			log.Printf("[seller-enrich] user=%d source=memory-cache partial region=%q rating=%q continuing remote fetch", userID, info.Region, info.Rating)
		}
	}

	if userID > 0 {
		if region, ok := s.db.GetUserRegion(userID); ok && region != "" {
			log.Printf("[seller-enrich] user=%d source=db-cache partial region=%q rating=%q continuing remote fetch", userID, region, "")
		}
	}

	info := s.fetchWithRetry(userID)
	if userID > 0 && info.Region != "" && info.Region != "NaN" {
		sellerCache.Set(userID, info)
		s.db.SetUserRegion(userID, info.Region)
	}

	return info
}

func (s *SellerEnricher) fetchWithRetry(userID int64) SellerInfo {
	client := s.nextClient()
	if client == nil {
		logSellerEnrichmentFailure("seller-client", userID, "no client available")
		return SellerInfo{Region: "NaN"}
	}

	info, status := s.fetchFromAPI(client, userID)
	if info.Region != "" {
		return info
	}

	if status != 200 {
		s.replaceClient(client)
	}

	client2 := s.nextClient()
	if client2 != nil && client2 != client {
		logSellerEnrichmentFailure("retry", userID, "retrying with a replacement client after status=%d", status)
		info, status2 := s.fetchFromAPI(client2, userID)
		if info.Region != "" {
			return info
		}
		if status2 != 200 {
			s.replaceClient(client2)
		}
	}

	logSellerEnrichmentFailure("seller-api", userID, "no region resolved after retries")
	return SellerInfo{Region: "NaN"}
}

func (s *SellerEnricher) fetchFromAPI(client *Client, userID int64) (SellerInfo, int) {
	if client == nil || userID <= 0 {
		return SellerInfo{}, 0
	}

	apiURL := fmt.Sprintf("https://%s/api/v2/users/%d", s.domain, userID)
	body, status := s.fetchAPIBody(client, apiURL, userID)
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

			info.Rating, info.RatingStars, info.RatingCount, info.RatingAvailable =
				normalizeSellerRating(resp.User.FeedbackCount, resp.User.FeedbackReputation)

			if info.Region != "" {
				logSellerEnrichmentSuccess("seller-api", userID, info)
				return info, 200
			}

			logSellerEnrichmentFailure(
				"seller-api",
				userID,
				"response had no usable region (country_code=%q country_title=%q feedback_count=%d)",
				resp.User.CountryCode,
				resp.User.CountryTitle,
				resp.User.FeedbackCount,
			)
		} else if err != nil {
			logSellerEnrichmentFailure("seller-api", userID, "json decode error: %v", err)
		} else {
			logSellerEnrichmentFailure("seller-api", userID, "response did not contain a valid user")
		}
	} else if status == 200 {
		logSellerEnrichmentFailure("seller-api", userID, "empty response body")
	} else {
		logSellerEnrichmentFailure("seller-api", userID, "http status=%d", status)
	}

	return SellerInfo{}, status
}

func (s *SellerEnricher) fetchAPIBody(client *Client, targetURL string, userID int64) ([]byte, int) {
	currentURL := targetURL
	domain := s.domain
	if parsed, err := url.Parse(targetURL); err == nil && parsed.Host != "" {
		domain = parsed.Host
	}

	if err := client.EnsureWarm(domain); err != nil {
		logSellerEnrichmentFailure("warmup", userID, "domain=%s via=%s error=%v", domain, client.ProxyLabel(), err)
		return nil, 0
	}

	for redirects := 0; redirects < 3; redirects++ {
		req, err := http.NewRequest("GET", currentURL, nil)
		if err != nil {
			return nil, 0
		}
		req.Header = newAPIHeaders(domain)

		resp, err := client.HttpClient.Do(req)
		if err != nil {
			client.FlushTrackedTraffic()
			return nil, 0
		}

		if resp.StatusCode >= 300 && resp.StatusCode < 400 {
			location := resp.Header.Get("Location")
			_, _ = io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
			client.FlushTrackedTraffic()
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
			_, _ = io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
			client.FlushTrackedTraffic()
			return nil, resp.StatusCode
		}

		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512*1024))
		resp.Body.Close()
		client.FlushTrackedTraffic()
		return body, 200
	}

	return nil, 0
}
