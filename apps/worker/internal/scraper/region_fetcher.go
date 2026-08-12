package scraper

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"vintrack-worker/internal/cache"
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
	info      SellerInfo
	counter   uint64
	fetchedAt time.Time
}

type sellerInfoCache struct {
	mu      sync.RWMutex
	cache   map[string]sellerCacheEntry
	counter uint64
}

var sellerCache = &sellerInfoCache{
	cache: make(map[string]sellerCacheEntry, 4096),
}

func sellerCacheKey(domain string, userID int64) string {
	return fmt.Sprintf("%s:%d", strings.ToLower(strings.TrimSpace(domain)), userID)
}

func (c *sellerInfoCache) Get(domain string, userID int64, ttl time.Duration) (SellerInfo, bool) {
	key := sellerCacheKey(domain, userID)
	c.mu.RLock()
	entry, ok := c.cache[key]
	c.mu.RUnlock()
	if ok && ttl > 0 && time.Since(entry.fetchedAt) > ttl {
		c.mu.Lock()
		delete(c.cache, key)
		c.mu.Unlock()
		return SellerInfo{}, false
	}
	if ok {
		n := atomic.AddUint64(&c.counter, 1)
		c.mu.Lock()
		if e, exists := c.cache[key]; exists {
			e.counter = n
			c.cache[key] = e
		}
		c.mu.Unlock()
	}
	return entry.info, ok
}

func (c *sellerInfoCache) Set(domain string, userID int64, info SellerInfo, fetchedAt time.Time) {
	key := sellerCacheKey(domain, userID)
	if fetchedAt.IsZero() {
		fetchedAt = time.Now()
	}
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
	c.cache[key] = sellerCacheEntry{info: info, counter: n, fetchedAt: fetchedAt}
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
	pool            *ClientPool
	pm              *proxy.Manager
	db              *database.Store
	domain          string
	trafficRecorder func(txBytes int64, rxBytes int64)
	flightMu        sync.Mutex
	inflight        map[int64]*sellerFetchFlight
	cacheTTL        time.Duration
	hedgeDelay      time.Duration
	remoteFetch     func(context.Context, int64) (SellerInfo, error)
}

type sellerFetchFlight struct {
	done chan struct{}
	info SellerInfo
	err  error
}

func NewSellerEnricher(pm *proxy.Manager, db *database.Store, domain string, poolSize int, trafficRecorder func(txBytes int64, rxBytes int64)) *SellerEnricher {
	if poolSize < 1 {
		poolSize = 1
	}
	requestTimeout := sellerEnrichmentTimeout()
	cacheTTL := time.Duration(getEnvInt("SELLER_CACHE_TTL_MINUTES", 30)) * time.Minute
	if cacheTTL <= 0 {
		cacheTTL = 30 * time.Minute
	}
	hedgeDelay := time.Duration(getEnvInt("SELLER_HEDGE_DELAY_MS", 350)) * time.Millisecond
	if hedgeDelay < 0 {
		hedgeDelay = 350 * time.Millisecond
	}
	pool := NewClientPoolWithTimeout(pm, domain, poolSize, trafficRecorder, requestTimeout)
	pool.SetMaxInFlightPerClient(1)
	s := &SellerEnricher{
		pool: pool, pm: pm, db: db, domain: domain, trafficRecorder: trafficRecorder,
		inflight:   make(map[int64]*sellerFetchFlight),
		cacheTTL:   cacheTTL,
		hedgeDelay: hedgeDelay,
	}
	return s
}

func sellerEnrichmentTimeout() time.Duration {
	timeout := time.Duration(getEnvInt("SELLER_ENRICHMENT_TIMEOUT_MS", 2000)) * time.Millisecond
	if timeout <= 0 {
		return 2 * time.Second
	}
	return timeout
}

func LookupCachedSellerInfo(ctx context.Context, db *database.Store, domain string, userID int64, ttl time.Duration) (SellerInfo, bool) {
	if userID <= 0 {
		return SellerInfo{}, false
	}
	if info, ok := sellerCache.Get(domain, userID, ttl); ok {
		// An in-process cache hit is the expected path and happens for every
		// detected item. Logging it put one line per item through Go's global
		// log mutex and into the container log driver for no diagnostic value;
		// only the incomplete case is worth reporting.
		if !isSellerInfoComplete(info) {
			log.Printf("[seller-enrich] user=%d source=memory-cache partial region=%q rating=%q", userID, info.Region, info.Rating)
		}
		return info, true
	}
	cacheCtx, cancel := context.WithTimeout(ctx, 40*time.Millisecond)
	cached, ok := db.GetSellerInfoCache(cacheCtx, domain, userID)
	cancel()
	if ok && (cached.FetchedAt.IsZero() || time.Since(cached.FetchedAt) <= ttl) {
		info := sellerInfoFromCache(cached)
		sellerCache.Set(domain, userID, info, cached.FetchedAt)
		logSellerEnrichmentSuccess("redis-cache", userID, info)
		return info, true
	}
	// The old region-only cache remains readable during rollout. It is partial
	// data, so callers may use it as their best effort while a remote fetch runs.
	regionCtx, cancel := context.WithTimeout(ctx, 40*time.Millisecond)
	region, ok := db.GetUserRegionContext(regionCtx, userID)
	cancel()
	if ok && region != "" {
		info := SellerInfo{Region: region}
		log.Printf("[seller-enrich] user=%d source=db-cache partial region=%q rating=%q", userID, info.Region, info.Rating)
		return info, true
	}
	return SellerInfo{}, false
}

func (s *SellerEnricher) FetchSellerInfo(ctx context.Context, userID int64) (SellerInfo, error) {
	if userID <= 0 {
		return SellerInfo{}, errors.New("invalid seller id")
	}
	if info, ok := sellerCache.Get(s.domain, userID, s.cacheTTL); ok && isSellerInfoComplete(info) {
		return info, nil
	}
	if s.db != nil {
		if info, ok := LookupCachedSellerInfo(ctx, s.db, s.domain, userID, s.cacheTTL); ok && isSellerInfoComplete(info) {
			return info, nil
		}
	}

	s.flightMu.Lock()
	if s.inflight == nil {
		s.inflight = make(map[int64]*sellerFetchFlight)
	}
	if flight, ok := s.inflight[userID]; ok {
		s.flightMu.Unlock()
		select {
		case <-flight.done:
			return flight.info, flight.err
		case <-ctx.Done():
			return SellerInfo{}, ctx.Err()
		}
	}
	flight := &sellerFetchFlight{done: make(chan struct{})}
	s.inflight[userID] = flight
	s.flightMu.Unlock()

	var info SellerInfo
	var err error
	if s.remoteFetch != nil {
		info, err = s.remoteFetch(ctx, userID)
	} else {
		info, err = s.fetchHedged(ctx, userID)
	}
	if info.Region != "" && info.Region != "NaN" {
		fetchedAt := time.Now()
		sellerCache.Set(s.domain, userID, info, fetchedAt)
		if s.db != nil {
			s.db.SetUserRegion(userID, info.Region)
			cacheCtx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
			cacheErr := s.db.SetSellerInfoCache(cacheCtx, s.domain, userID, sellerInfoToCache(info, fetchedAt), s.cacheTTL)
			cancel()
			if cacheErr != nil {
				log.Printf("[seller-enrich] user=%d full cache write failed: %v", userID, cacheErr)
			}
		}
	}

	s.flightMu.Lock()
	flight.info, flight.err = info, err
	delete(s.inflight, userID)
	close(flight.done)
	s.flightMu.Unlock()
	return info, err
}

func sellerInfoFromCache(info cache.SellerInfo) SellerInfo {
	return SellerInfo{Region: info.Region, Rating: info.Rating, RatingStars: info.RatingStars, RatingCount: info.RatingCount, RatingAvailable: info.RatingAvailable}
}

func sellerInfoToCache(info SellerInfo, fetchedAt time.Time) cache.SellerInfo {
	return cache.SellerInfo{Region: info.Region, Rating: info.Rating, RatingStars: info.RatingStars, RatingCount: info.RatingCount, RatingAvailable: info.RatingAvailable, FetchedAt: fetchedAt}
}

type sellerFetchResult struct {
	info   SellerInfo
	status int
	err    error
}

func (s *SellerEnricher) acquireSellerClient(ctx context.Context, excluded map[*Client]bool, wait bool) *Client {
	for {
		if client := s.pool.AcquireExcluding(excluded); client != nil {
			return client
		}
		if !wait {
			return nil
		}
		timer := time.NewTimer(5 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil
		case <-timer.C:
		}
	}
}

func (s *SellerEnricher) startSellerFetch(ctx context.Context, userID int64, excluded map[*Client]bool, results chan<- sellerFetchResult, waitForLease bool) (*Client, bool) {
	client := s.acquireSellerClient(ctx, excluded, waitForLease)
	if client == nil {
		return nil, false
	}
	go func() {
		started := time.Now()
		info, status, err := s.fetchFromAPI(ctx, client, userID)
		s.pool.Report(client, status, time.Since(started), err)
		results <- sellerFetchResult{info: info, status: status, err: err}
	}()
	return client, true
}

func (s *SellerEnricher) fetchHedged(ctx context.Context, userID int64) (SellerInfo, error) {
	results := make(chan sellerFetchResult, 2)
	primary, ok := s.startSellerFetch(ctx, userID, nil, results, true)
	if !ok {
		if err := ctx.Err(); err != nil {
			return SellerInfo{Region: "NaN"}, err
		}
		return SellerInfo{Region: "NaN"}, errors.New("no healthy seller client available")
	}
	timer := time.NewTimer(s.hedgeDelay)
	defer timer.Stop()
	requests := 1
	completed := 0
	hedged := false
	var lastErr error
	for completed < requests || (!hedged && requests == 1) {
		select {
		case result := <-results:
			completed++
			if result.info.Region != "" {
				return result.info, nil
			}
			lastErr = result.err
			if !hedged {
				_, started := s.startSellerFetch(ctx, userID, map[*Client]bool{primary: true}, results, false)
				hedged = true
				if started {
					requests++
				}
			}
		case <-timer.C:
			if !hedged {
				_, started := s.startSellerFetch(ctx, userID, map[*Client]bool{primary: true}, results, false)
				hedged = true
				if started {
					requests++
				}
			}
		case <-ctx.Done():
			return SellerInfo{Region: "NaN"}, ctx.Err()
		}
	}
	if lastErr == nil {
		lastErr = errors.New("seller info unavailable")
	}
	return SellerInfo{Region: "NaN"}, lastErr
}

func (s *SellerEnricher) fetchFromAPI(ctx context.Context, client *Client, userID int64) (SellerInfo, int, error) {
	if client == nil || userID <= 0 {
		return SellerInfo{}, 0, errors.New("invalid seller request")
	}

	apiURL := fmt.Sprintf("https://%s/api/v2/users/%d", s.domain, userID)
	body, status, fetchErr := s.fetchAPIBody(ctx, client, apiURL, userID)
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
				return info, 200, nil
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

	if fetchErr == nil {
		fetchErr = fmt.Errorf("seller api status %d", status)
	}
	return SellerInfo{}, status, fetchErr
}

func (s *SellerEnricher) fetchAPIBody(ctx context.Context, client *Client, targetURL string, userID int64) ([]byte, int, error) {
	currentURL := targetURL
	domain := s.domain
	if parsed, err := url.Parse(targetURL); err == nil && parsed.Host != "" {
		domain = parsed.Host
	}

	if err := client.EnsureWarmContext(ctx, domain); err != nil {
		logSellerEnrichmentFailure("warmup", userID, "domain=%s via=%s error=%v", domain, client.ProxyLabel(), err)
		return nil, 0, err
	}

	for redirects := 0; redirects < 3; redirects++ {
		req, err := http.NewRequestWithContext(ctx, "GET", currentURL, nil)
		if err != nil {
			return nil, 0, err
		}
		req.Header = newAPIHeaders(domain)

		resp, err := client.HttpClient.Do(req)
		if err != nil {
			client.FlushTrackedTraffic()
			return nil, 0, err
		}

		if resp.StatusCode >= 300 && resp.StatusCode < 400 {
			location := resp.Header.Get("Location")
			_, _ = io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
			client.FlushTrackedTraffic()
			if location == "" {
				return nil, resp.StatusCode, errors.New("redirect without location")
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
			return nil, resp.StatusCode, fmt.Errorf("seller api status %d", resp.StatusCode)
		}

		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512*1024))
		resp.Body.Close()
		client.FlushTrackedTraffic()
		return body, 200, nil
	}

	return nil, 0, errors.New("too many seller api redirects")
}
