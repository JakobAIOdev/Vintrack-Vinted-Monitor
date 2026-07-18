package main

import (
	"context"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"vintrack-worker/internal/cache"
	"vintrack-worker/internal/database"
	"vintrack-worker/internal/proxy"
	"vintrack-worker/internal/scraper"

	"github.com/joho/godotenv"
)

var freeProxyCheckRunning atomic.Bool

const proxyScrapeFallbackURL = "https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&proxy_format=protocolipport&format=text"

type freeProxyImportCandidate struct {
	ProxyURL string
	Protocol string
	Host     string
	Port     int
	Source   string
}

func main() {
	log.SetFlags(log.Ltime)
	log.Println("Vintrack Worker starting...")
	_ = godotenv.Load()

	store := initStore()
	defer store.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(sigChan)

	role := strings.ToLower(strings.TrimSpace(getEnv("WORKER_ROLE", "monitor")))
	if role == "proxy-maintainer" {
		log.Println("Worker role: proxy-maintainer")
		runProxyMaintainer(ctx, cancel, sigChan, store)
		return
	}
	if role == "id-scanner" {
		log.Println("Worker role: id-scanner (shadow only)")
		freeProxyPools := initFreeProxyPools(store)
		runIDScannerWorker(ctx, cancel, sigChan, store, freeProxyPools)
		return
	}
	if role != "monitor" {
		log.Fatalf("Unknown WORKER_ROLE %q (expected monitor, proxy-maintainer, or id-scanner)", role)
	}

	log.Println("Worker role: monitor")
	proxyManager := initServerProxyManager(store)
	freeProxyPools := initFreeProxyPools(store)
	engine := scraper.NewEngine(store, proxyManager, freeProxyPools)
	defer engine.Close()
	mgr := scraper.NewManager(store, engine)
	runMonitorWorker(ctx, cancel, sigChan, store, proxyManager, freeProxyPools, mgr)
}

func runIDScannerWorker(ctx context.Context, cancel context.CancelFunc, sigChan <-chan os.Signal, store *database.Store, freeProxyPools *proxy.RegionPools) {
	scanner := scraper.NewPreindexScanner(store, freeProxyPools)
	done := make(chan struct{})
	go func() {
		defer close(done)
		scanner.Run(ctx)
	}()

	freeProxyRefreshTicker := time.NewTicker(30 * time.Second)
	defer freeProxyRefreshTicker.Stop()

	for {
		select {
		case <-sigChan:
			log.Println("Shutdown signal received, stopping pre-index shadow scanner...")
			cancel()
			<-done
			return
		case <-freeProxyRefreshTicker.C:
			refreshFreeProxies(store, freeProxyPools)
		case <-done:
			return
		}
	}
}

func runMonitorWorker(ctx context.Context, cancel context.CancelFunc, sigChan <-chan os.Signal, store *database.Store, proxyManager *proxy.Manager, freeProxyPools *proxy.RegionPools, mgr *scraper.Manager) {
	mgr.Sync(ctx)

	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	freeProxyRefreshTicker := time.NewTicker(30 * time.Second)
	defer freeProxyRefreshTicker.Stop()

	log.Println("Worker running. Polling for monitor changes every 5s...")

	for {
		select {
		case <-sigChan:
			log.Println("Shutdown signal received, stopping all monitors...")
			cancel()
			mgr.StopAll()
			time.Sleep(time.Second)
			return
		case <-ticker.C:
			refreshServerProxies(store, proxyManager)
			mgr.Sync(ctx)
		case <-freeProxyRefreshTicker.C:
			refreshFreeProxies(store, freeProxyPools)
		}
	}
}

func runProxyMaintainer(ctx context.Context, cancel context.CancelFunc, sigChan <-chan os.Signal, store *database.Store) {
	go func() {
		importFreeProxies(ctx, store)
		checkFreeProxies(ctx, store)
		store.PruneDetectionTelemetry(settingInt(store, "DETECTION_RETENTION_DAYS", 14))
		store.PrunePreindexTelemetry(
			settingInt(store, "PREINDEX_PROBE_RETENTION_HOURS", 48),
			settingInt(store, "PREINDEX_SAMPLE_RETENTION_DAYS", 14),
		)
	}()

	healthTicker := time.NewTicker(15 * time.Second)
	defer healthTicker.Stop()
	importTicker := time.NewTicker(5 * time.Minute)
	defer importTicker.Stop()
	cleanupTicker := time.NewTicker(24 * time.Hour)
	defer cleanupTicker.Stop()

	for {
		select {
		case <-sigChan:
			log.Println("Shutdown signal received, stopping proxy maintainer...")
			cancel()
			return
		case <-healthTicker.C:
			go checkFreeProxies(ctx, store)
		case <-importTicker.C:
			go importFreeProxies(ctx, store)
		case <-cleanupTicker.C:
			go func() {
				store.PruneDetectionTelemetry(settingInt(store, "DETECTION_RETENTION_DAYS", 14))
				store.PrunePreindexTelemetry(
					settingInt(store, "PREINDEX_PROBE_RETENTION_HOURS", 48),
					settingInt(store, "PREINDEX_SAMPLE_RETENTION_DAYS", 14),
				)
			}()
		}
	}
}

func initStore() *database.Store {
	dbURL := mustEnv("DATABASE_URL")
	redisAddr := getEnv("REDIS_ADDR", "localhost:6379")

	redisCache, err := cache.NewRedisCache(redisAddr, os.Getenv("REDIS_PASSWORD"), 0)
	if err != nil {
		log.Fatalf("Redis: %v", err)
	}

	store, err := database.NewStore(dbURL, redisCache)
	if err != nil {
		log.Fatalf("PostgreSQL: %v", err)
	}
	return store
}

func initServerProxyManager(store *database.Store) *proxy.Manager {
	proxyFile := getEnv("PROXY_FILE", "proxies.txt")
	proxyManager, err := proxy.Load(proxyFile)
	if err != nil {
		log.Printf("Proxies: %v (continuing without)", err)
		proxyManager = &proxy.Manager{}
	}
	refreshServerProxies(store, proxyManager)
	return proxyManager
}

func initFreeProxyPools(store *database.Store) *proxy.RegionPools {
	freeProxyPools := proxy.NewRegionPools()
	refreshFreeProxies(store, freeProxyPools)
	return freeProxyPools
}

func refreshServerProxies(store *database.Store, proxyManager *proxy.Manager) {
	value, ok, err := store.GetSettingValue("server_proxies")
	if err != nil {
		log.Printf("server proxy setting refresh failed: %v", err)
		return
	}
	if ok {
		proxyManager.ReplaceFromString(value)
	}
}

func refreshFreeProxies(store *database.Store, freeProxyPools *proxy.RegionPools) {
	regions, err := freeProxyRegions(store)
	if err != nil {
		log.Printf("free proxy region refresh failed: %v", err)
		return
	}
	freeProxyPools.Retain(regions)
	if !settingBool(store, "free_proxy_enabled", false) {
		freeProxyPools.Retain(nil)
		return
	}
	for _, region := range regions {
		activeCount, err := store.CountActiveFreeProxies(region)
		if err != nil {
			log.Printf("free proxy active count failed for %s: %v", region, err)
			continue
		}
		if activeCount == 0 {
			freeProxyPools.Replace(region, "")
			continue
		}
		proxies, err := store.GetActiveFreeProxies(region, settingInt(store, "free_proxy_max_pool_size", 500))
		if err != nil {
			log.Printf("free proxy refresh failed for %s: %v", region, err)
			continue
		}
		freeProxyPools.Replace(region, strings.Join(proxies, "\n"))
	}
}

func checkFreeProxies(ctx context.Context, store *database.Store) {
	if !freeProxyCheckRunning.CompareAndSwap(false, true) {
		return
	}
	defer freeProxyCheckRunning.Store(false)

	if !settingBool(store, "free_proxy_enabled", false) {
		return
	}
	regions, err := freeProxyRegions(store)
	if err != nil {
		log.Printf("free proxy health region load failed: %v", err)
		return
	}
	maxPoolSize := settingInt(store, "free_proxy_max_pool_size", 500)
	if err := store.EnsureFreeProxyHealthRows(regions, maxPoolSize); err != nil {
		log.Printf("free proxy health row sync failed: %v", err)
		return
	}
	regionBatches := make([][]database.FreeProxyCandidate, 0, len(regions))
	perRegionBatch := settingInt(store, "FREE_PROXY_HEALTH_BATCH_PER_REGION", 40)
	bootstrapBatch := settingInt(store, "FREE_PROXY_BOOTSTRAP_BATCH_PER_REGION", 120)
	minActive := settingInt(store, "free_proxy_min_active_per_region", 25)
	targetActive := settingInt(store, "free_proxy_target_active_per_region", max(50, minActive*2))
	if targetActive < minActive {
		targetActive = minActive
	}
	if targetActive > maxPoolSize {
		targetActive = maxPoolSize
	}
	for _, region := range regions {
		batchSize := perRegionBatch
		bootstrap := false
		activeCount, err := store.CountActiveFreeProxies(region)
		if err != nil {
			log.Printf("free proxy active count failed for %s: %v", region, err)
		} else if activeCount < targetActive {
			batchSize = bootstrapBatch
			bootstrap = true
		}
		regionProxies, err := store.GetFreeProxiesDueForCheck([]string{region}, batchSize, bootstrap)
		if err != nil {
			log.Printf("free proxy health load failed for %s: %v", region, err)
			continue
		}
		regionBatches = append(regionBatches, regionProxies)
	}
	proxies := interleaveFreeProxyCandidates(regionBatches)
	if len(proxies) == 0 {
		return
	}
	threshold := settingInt(store, "free_proxy_failure_threshold", 3)
	quarantineMinutes := settingInt(store, "free_proxy_quarantine_minutes", 30)
	maxLatencyMs := settingInt(store, "free_proxy_max_latency_ms", 2500)
	validationTimeout := freeProxyValidationTimeout(maxLatencyMs)
	concurrency := settingInt(store, "FREE_PROXY_HEALTH_CONCURRENCY", 100)
	if concurrency < 1 {
		concurrency = 1
	}
	log.Printf(
		"free proxy check started: %d candidates across %d regions (concurrency %d, timeout %s)",
		len(proxies),
		len(regionBatches),
		concurrency,
		validationTimeout,
	)
	sem := make(chan struct{}, concurrency)
	var wg sync.WaitGroup
	var passed atomic.Int64
	var failed atomic.Int64
	startedAt := time.Now()
	for _, candidate := range proxies {
		candidate := candidate
		wg.Add(1)
		sem <- struct{}{}
		go func() {
			defer wg.Done()
			defer func() { <-sem }()
			select {
			case <-ctx.Done():
				return
			default:
			}
			validationCtx, cancelValidation := context.WithTimeout(ctx, validationTimeout)
			result, err := scraper.ValidateFreeProxy(validationCtx, candidate.ProxyURL, candidate.Region, maxLatencyMs)
			cancelValidation()
			if err != nil {
				failed.Add(1)
				store.RecordFreeProxyFailure(candidate.ProxyURL, candidate.Region, result.StatusCode, err.Error(), threshold, quarantineMinutes)
				return
			}
			passed.Add(1)
			store.RecordFreeProxySuccess(candidate.ProxyURL, candidate.Region, result.LatencyMs)
		}()
	}
	wg.Wait()
	store.DisableGloballyDeadFreeProxies()
	log.Printf(
		"free proxy check completed: %d checked, %d passed, %d failed in %s",
		passed.Load()+failed.Load(),
		passed.Load(),
		failed.Load(),
		time.Since(startedAt).Round(time.Second),
	)
}

func freeProxyValidationTimeout(maxLatencyMs int) time.Duration {
	if maxLatencyMs <= 0 {
		maxLatencyMs = 2500
	}
	timeout := time.Duration(maxLatencyMs+1500) * time.Millisecond
	if timeout < 4*time.Second {
		return 4 * time.Second
	}
	if timeout > 8*time.Second {
		return 8 * time.Second
	}
	return timeout
}

func interleaveFreeProxyCandidates(batches [][]database.FreeProxyCandidate) []database.FreeProxyCandidate {
	total := 0
	maxBatchSize := 0
	for _, batch := range batches {
		total += len(batch)
		if len(batch) > maxBatchSize {
			maxBatchSize = len(batch)
		}
	}

	candidates := make([]database.FreeProxyCandidate, 0, total)
	for index := 0; index < maxBatchSize; index++ {
		for _, batch := range batches {
			if index < len(batch) {
				candidates = append(candidates, batch[index])
			}
		}
	}
	return candidates
}

func importFreeProxies(ctx context.Context, store *database.Store) {
	if !settingBool(store, "free_proxy_enabled", false) || !settingBool(store, "free_proxy_auto_import_enabled", false) {
		return
	}
	importURL, ok, err := store.GetSettingValue("free_proxy_import_url")
	if err != nil {
		log.Printf("free proxy import setting failed: %v", err)
		return
	}
	if !ok || strings.TrimSpace(importURL) == "" {
		importURL = "https://raw.githubusercontent.com/iplocate/free-proxy-list/main/all-proxies.txt"
	}

	maxImport := settingInt(store, "free_proxy_max_pool_size", 5000)
	importURLs := freeProxyImportURLs(store, importURL)
	if len(importURLs) == 0 {
		return
	}
	sourceCandidates := make([][]freeProxyImportCandidate, 0, len(importURLs))
	for _, sourceURL := range importURLs {
		body, err := fetchFreeProxyList(ctx, sourceURL)
		if err != nil {
			log.Printf("free proxy import skipped %s: %v", sourceURL, err)
			continue
		}
		source := freeProxySource(store, sourceURL)
		defaultScheme := defaultSchemeForImportURL(sourceURL)
		candidates := make([]freeProxyImportCandidate, 0)
		seenSourceProxies := make(map[string]bool)
		for _, line := range strings.Split(string(body), "\n") {
			proxyURL, protocol, host, port, ok := normalizeFreeProxyLine(line, defaultScheme)
			if !ok || seenSourceProxies[proxyURL] {
				continue
			}
			seenSourceProxies[proxyURL] = true
			candidates = append(candidates, freeProxyImportCandidate{
				ProxyURL: proxyURL,
				Protocol: protocol,
				Host:     host,
				Port:     port,
				Source:   source,
			})
		}
		sourceCandidates = append(sourceCandidates, candidates)
	}

	storedProxyURLs, err := store.GetFreeProxyURLSet()
	if err != nil {
		log.Printf("free proxy import existing pool load failed: %v", err)
		return
	}
	existingProxyURLs := make(map[string]string, len(storedProxyURLs))
	for storedProxyURL := range storedProxyURLs {
		canonicalProxyURL := canonicalFreeProxyURL(storedProxyURL)
		currentStoredURL, exists := existingProxyURLs[canonicalProxyURL]
		if !exists || (storedProxyURL == canonicalProxyURL && currentStoredURL != canonicalProxyURL) {
			existingProxyURLs[canonicalProxyURL] = storedProxyURL
		}
	}
	selectedCandidates, newCandidates := selectFreeProxyImportCandidates(
		sourceCandidates,
		existingProxyURLs,
		maxImport,
	)

	processed, err := store.UpsertFreeProxies(selectedCandidates)
	if err != nil {
		log.Printf("free proxy batch import failed after %d candidates: %v", processed, err)
		return
	}
	if processed > 0 {
		log.Printf(
			"free proxy import refreshed %d candidates (%d new) from %d available sources",
			processed,
			newCandidates,
			len(sourceCandidates),
		)
	}
}

func selectFreeProxyImportCandidates(
	sources [][]freeProxyImportCandidate,
	existingProxyURLs map[string]string,
	maxPoolSize int,
) ([]database.FreeProxyRecord, int) {
	if maxPoolSize <= 0 {
		return nil, 0
	}

	remainingCapacity := max(0, maxPoolSize-len(existingProxyURLs))
	scanLimit := maxPoolSize + min(len(existingProxyURLs), maxPoolSize)
	orderedCandidates := interleaveFreeProxyImportCandidates(sources, scanLimit)
	selectedCandidates := make([]database.FreeProxyRecord, 0, maxPoolSize)
	refreshedExisting := 0
	newCandidates := 0

	for _, candidate := range orderedCandidates {
		storedProxyURL, exists := existingProxyURLs[candidate.ProxyURL]
		proxyURL := candidate.ProxyURL
		if exists {
			if refreshedExisting >= maxPoolSize {
				continue
			}
			refreshedExisting++
			proxyURL = storedProxyURL
		} else {
			if newCandidates >= remainingCapacity {
				continue
			}
			newCandidates++
			existingProxyURLs[candidate.ProxyURL] = candidate.ProxyURL
		}

		selectedCandidates = append(selectedCandidates, database.FreeProxyRecord{
			ProxyURL: proxyURL,
			Protocol: candidate.Protocol,
			Host:     candidate.Host,
			Port:     candidate.Port,
			Source:   candidate.Source,
		})
	}

	return selectedCandidates, newCandidates
}

func interleaveFreeProxyImportCandidates(sources [][]freeProxyImportCandidate, limit int) []freeProxyImportCandidate {
	if limit <= 0 || len(sources) == 0 {
		return nil
	}

	indices := make([]int, len(sources))
	seen := make(map[string]bool, limit)
	candidates := make([]freeProxyImportCandidate, 0, limit)
	for len(candidates) < limit {
		progressed := false
		for sourceIndex, source := range sources {
			for indices[sourceIndex] < len(source) {
				candidate := source[indices[sourceIndex]]
				indices[sourceIndex]++
				if seen[candidate.ProxyURL] {
					continue
				}
				seen[candidate.ProxyURL] = true
				candidates = append(candidates, candidate)
				progressed = true
				break
			}
			if len(candidates) >= limit {
				break
			}
		}
		if !progressed {
			break
		}
	}
	return candidates
}

func fetchFreeProxyList(ctx context.Context, importURL string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, importURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "text/plain,*/*")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("status %d", resp.StatusCode)
	}
	return io.ReadAll(io.LimitReader(resp.Body, 2*1024*1024))
}

func normalizeFreeProxyLine(line string, defaultScheme string) (string, string, string, int, bool) {
	line = strings.TrimSpace(line)
	if line == "" {
		return "", "", "", 0, false
	}
	if defaultScheme == "" {
		defaultScheme = "http"
	}
	if !strings.HasPrefix(line, "http://") && !strings.HasPrefix(line, "https://") && !strings.HasPrefix(line, "socks4://") && !strings.HasPrefix(line, "socks5://") {
		line = defaultScheme + "://" + line
	}
	parsed, err := url.Parse(line)
	if err != nil {
		return "", "", "", 0, false
	}
	port, err := strconv.Atoi(parsed.Port())
	if err != nil || port < 1 || port > 65535 || parsed.Hostname() == "" {
		return "", "", "", 0, false
	}
	scheme := parsed.Scheme
	if scheme != "http" && scheme != "https" && scheme != "socks4" && scheme != "socks5" {
		return "", "", "", 0, false
	}
	return canonicalFreeProxyURL(parsed.String()), scheme, parsed.Hostname(), port, true
}

func canonicalFreeProxyURL(rawURL string) string {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return rawURL
	}
	if parsed.Path == "/" && parsed.RawQuery == "" && parsed.Fragment == "" {
		parsed.Path = ""
	}
	return parsed.String()
}

func freeProxyRegions(store *database.Store) ([]string, error) {
	activeRegions, err := store.GetActiveFreeProxyRegions()
	if err != nil {
		return nil, err
	}
	starterRegionValue := "de,fr,it,es,nl,be,at"
	if value, ok, settingErr := store.GetSettingValue("free_proxy_starter_regions"); settingErr != nil {
		return nil, settingErr
	} else if ok {
		starterRegionValue = value
	}
	starterRegions := strings.Split(starterRegionValue, ",")
	seen := make(map[string]bool)
	regions := make([]string, 0, len(activeRegions)+len(starterRegions))
	for _, region := range append(starterRegions, activeRegions...) {
		region = strings.TrimSpace(strings.ToLower(region))
		if region == "" || seen[region] {
			continue
		}
		seen[region] = true
		regions = append(regions, region)
	}
	return regions, nil
}

func freeProxyImportURLs(store *database.Store, importURL string) []string {
	urls := make([]string, 0)
	if !strings.Contains(importURL, "raw.githubusercontent.com/iplocate/free-proxy-list/main") {
		return []string{importURL}
	}
	seen := make(map[string]bool)
	supportedCountries := map[string]bool{
		"ar": true, "bd": true, "br": true, "ca": true, "ch": true, "cn": true,
		"co": true, "cz": true, "de": true, "ec": true, "ee": true, "fi": true,
		"fr": true, "gb": true, "gh": true, "hk": true, "hu": true, "id": true,
		"in": true, "iq": true, "jp": true, "ke": true, "kh": true, "kr": true,
		"lv": true, "md": true, "me": true, "my": true, "nl": true, "pk": true,
		"ps": true, "ru": true, "se": true, "sg": true, "sy": true, "tr": true,
		"ua": true, "us": true, "uz": true, "ve": true, "vn": true, "za": true,
		"zw": true,
	}
	regions, err := freeProxyRegions(store)
	if err != nil {
		return []string{importURL}
	}
	for _, region := range regions {
		region = strings.ToLower(strings.TrimSpace(region))
		country := region
		if region == "uk" {
			country = "gb"
		}
		if !supportedCountries[country] {
			continue
		}
		countryURL := "https://raw.githubusercontent.com/iplocate/free-proxy-list/main/countries/" + strings.ToUpper(country) + "/proxies.txt"
		if seen[countryURL] {
			continue
		}
		seen[countryURL] = true
		urls = append(urls, countryURL)
	}
	if !seen[importURL] {
		urls = append(urls, importURL)
	}
	if !seen[proxyScrapeFallbackURL] {
		urls = append(urls, proxyScrapeFallbackURL)
	}
	return urls
}

func freeProxySource(store *database.Store, importURL string) string {
	if region := iplocateCountryFromURL(importURL); region != "" {
		return "iplocate:" + region
	}
	if source := settingString(store, "free_proxy_import_source", ""); source != "" {
		if strings.HasPrefix(source, "iplocate") {
			return "iplocate"
		}
		if strings.HasPrefix(source, "proxyscrape") {
			return "proxyscrape"
		}
	}
	if strings.Contains(importURL, "iplocate/free-proxy-list") {
		return "iplocate"
	}
	if strings.Contains(importURL, "proxyscrape") {
		return "proxyscrape"
	}
	return "manual"
}

func iplocateCountryFromURL(importURL string) string {
	const marker = "/countries/"
	markerIndex := strings.Index(importURL, marker)
	if markerIndex < 0 {
		return ""
	}
	remainder := importURL[markerIndex+len(marker):]
	separatorIndex := strings.IndexByte(remainder, '/')
	if separatorIndex <= 0 {
		return ""
	}
	country := strings.ToLower(strings.TrimSpace(remainder[:separatorIndex]))
	if len(country) != 2 {
		return ""
	}
	if country == "gb" {
		return "uk"
	}
	return country
}

func defaultSchemeForImportURL(importURL string) string {
	switch {
	case strings.Contains(importURL, "/protocols/https"):
		return "https"
	case strings.Contains(importURL, "/protocols/socks4"):
		return "socks4"
	case strings.Contains(importURL, "/protocols/socks5"):
		return "socks5"
	default:
		return "http"
	}
}

func settingBool(store *database.Store, key string, fallback bool) bool {
	value, ok, err := store.GetSettingValue(key)
	if err != nil || !ok {
		return fallback
	}
	return strings.TrimSpace(value) == "true"
}

func settingString(store *database.Store, key string, fallback string) string {
	value, ok, err := store.GetSettingValue(key)
	if err != nil || !ok {
		return fallback
	}
	value = strings.TrimSpace(value)
	if value == "" {
		return fallback
	}
	return value
}

func settingInt(store *database.Store, key string, fallback int) int {
	if strings.ToUpper(key) == key {
		if value := strings.TrimSpace(os.Getenv(key)); value != "" {
			parsed, err := strconv.Atoi(value)
			if err == nil && parsed > 0 {
				return parsed
			}
		}
	}
	value, ok, err := store.GetSettingValue(key)
	if err != nil || !ok {
		return fallback
	}
	parsed, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil || parsed <= 0 {
		return fallback
	}
	return parsed
}

func mustEnv(key string) string {
	val := os.Getenv(key)
	if val == "" {
		log.Fatalf("Required env var %s not set", key)
	}
	return val
}

func getEnv(key, fallback string) string {
	if val := os.Getenv(key); val != "" {
		return val
	}
	return fallback
}
