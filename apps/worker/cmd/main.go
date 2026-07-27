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
	"sort"
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

var (
	freeProxyCheckRunning   atomic.Bool
	freeProxyImportRunning  atomic.Bool
	telemetryCleanupRunning atomic.Bool
)

const (
	proxyScrapeFallbackURL = "https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&proxy_format=protocolipport&format=text"
	proxiflyHTTPListURL    = "https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/protocols/http/data.txt"
	proxiflyHTTPSListURL   = "https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/protocols/https/data.txt"
	proxiflySOCKS4ListURL  = "https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/protocols/socks4/data.txt"
	proxiflySOCKS5ListURL  = "https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/protocols/socks5/data.txt"
	databayHTTPListURL     = "https://raw.githubusercontent.com/databay-labs/free-proxy-list/master/http.txt"
	databaySOCKS4ListURL   = "https://raw.githubusercontent.com/databay-labs/free-proxy-list/master/socks4.txt"
	databaySOCKS5ListURL   = "https://raw.githubusercontent.com/databay-labs/free-proxy-list/master/socks5.txt"
	monosansProxyListURL   = "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/all.txt"
)

const (
	freeProxyCheckCycleTimeout = 5 * time.Minute
	freeProxyImportTimeout     = 2 * time.Minute
	freeProxySourceTimeout     = 15 * time.Second
	freeProxyWriteTimeout      = 5 * time.Second
)

type freeProxyImportCandidate struct {
	ProxyURL string
	Protocol string
	Host     string
	Port     int
	Source   string
	Sources  []string
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
	pruneTelemetry := func() {
		if !telemetryCleanupRunning.CompareAndSwap(false, true) {
			log.Println("Telemetry cleanup is still running; skipping overlapping cycle")
			return
		}
		defer telemetryCleanupRunning.Store(false)

		store.PruneMonitorRuns(settingInt(store, "MONITOR_RUN_RETENTION_HOURS", 24))
		store.PruneMonitorRunStats(settingInt(store, "MONITOR_RUN_STATS_RETENTION_DAYS", 90))
		store.PruneDetectionTelemetry(settingInt(store, "DETECTION_RETENTION_DAYS", 14))
		store.PrunePreindexTelemetry(
			settingInt(store, "PREINDEX_PROBE_RETENTION_HOURS", 48),
			settingInt(store, "PREINDEX_SAMPLE_RETENTION_DAYS", 14),
		)
	}

	go func() {
		pruneTelemetry()
		importFreeProxies(ctx, store)
		checkFreeProxies(ctx, store)
	}()

	healthTicker := time.NewTicker(15 * time.Second)
	defer healthTicker.Stop()
	importTicker := time.NewTicker(5 * time.Minute)
	defer importTicker.Stop()
	cleanupTicker := time.NewTicker(time.Hour)
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
			go pruneTelemetry()
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
	refreshCtx, cancelRefresh := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancelRefresh()

	regions, err := freeProxyRegionsContext(refreshCtx, store)
	if err != nil {
		log.Printf("free proxy region refresh failed: %v", err)
		return
	}
	freeProxyPools.Retain(regions)
	enabled, err := settingBoolContext(refreshCtx, store, "free_proxy_enabled", false)
	if err != nil {
		log.Printf("free proxy enabled setting refresh failed: %v", err)
		return
	}
	if !enabled {
		freeProxyPools.Retain(nil)
		return
	}
	maxPoolSize, err := settingIntContext(refreshCtx, store, "free_proxy_max_pool_size", 500)
	if err != nil {
		log.Printf("free proxy max pool setting refresh failed: %v", err)
		return
	}
	for _, region := range regions {
		activeCount, err := store.CountActiveFreeProxiesContext(refreshCtx, region)
		if err != nil {
			log.Printf("free proxy active count failed for %s: %v", region, err)
			continue
		}
		if activeCount == 0 {
			freeProxyPools.Replace(region, "")
			continue
		}
		proxies, err := store.GetActiveFreeProxiesContext(refreshCtx, region, maxPoolSize)
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

	cycleCtx, cancelCycle := context.WithTimeout(ctx, freeProxyCheckCycleTimeout)
	defer cancelCycle()

	enabled, err := settingBoolContext(cycleCtx, store, "free_proxy_enabled", false)
	if err != nil {
		log.Printf("free proxy enabled setting load failed: %v", err)
		return
	}
	if !enabled {
		return
	}
	regions, err := freeProxyRegionsContext(cycleCtx, store)
	if err != nil {
		log.Printf("free proxy health region load failed: %v", err)
		return
	}
	maxPoolSize, err := settingIntContext(cycleCtx, store, "free_proxy_max_pool_size", 500)
	if err != nil {
		log.Printf("free proxy max pool setting load failed: %v", err)
		return
	}
	if err := store.EnsureFreeProxyHealthRowsContext(cycleCtx, regions, maxPoolSize); err != nil {
		log.Printf("free proxy health row sync failed: %v", err)
		return
	}
	regionBatches := make([][]database.FreeProxyCandidate, 0, len(regions))
	perRegionBatch, err := settingIntContext(cycleCtx, store, "FREE_PROXY_HEALTH_BATCH_PER_REGION", 40)
	if err != nil {
		log.Printf("free proxy health batch setting load failed: %v", err)
		return
	}
	bootstrapBatch, err := settingIntContext(cycleCtx, store, "FREE_PROXY_BOOTSTRAP_BATCH_PER_REGION", 120)
	if err != nil {
		log.Printf("free proxy bootstrap batch setting load failed: %v", err)
		return
	}
	minActive, err := settingIntContext(cycleCtx, store, "free_proxy_min_active_per_region", 25)
	if err != nil {
		log.Printf("free proxy min active setting load failed: %v", err)
		return
	}
	targetActive, err := settingIntContext(cycleCtx, store, "free_proxy_target_active_per_region", max(50, minActive*2))
	if err != nil {
		log.Printf("free proxy target active setting load failed: %v", err)
		return
	}
	if targetActive < minActive {
		targetActive = minActive
	}
	if targetActive > maxPoolSize {
		targetActive = maxPoolSize
	}
	threshold, err := settingIntContext(cycleCtx, store, "free_proxy_failure_threshold", 3)
	if err != nil {
		log.Printf("free proxy failure threshold setting load failed: %v", err)
		return
	}
	quarantineMinutes, err := settingIntContext(cycleCtx, store, "free_proxy_quarantine_minutes", 30)
	if err != nil {
		log.Printf("free proxy quarantine setting load failed: %v", err)
		return
	}
	maxLatencyMs, err := settingIntContext(cycleCtx, store, "free_proxy_max_latency_ms", 2500)
	if err != nil {
		log.Printf("free proxy max latency setting load failed: %v", err)
		return
	}
	validationTimeout := freeProxyValidationTimeout(maxLatencyMs)
	concurrency, err := settingIntContext(cycleCtx, store, "FREE_PROXY_HEALTH_CONCURRENCY", 48)
	if err != nil {
		log.Printf("free proxy health concurrency setting load failed: %v", err)
		return
	}
	if concurrency < 1 {
		concurrency = 1
	}

	for _, region := range regions {
		batchSize := perRegionBatch
		bootstrap := false
		activeCount, err := store.CountActiveFreeProxiesContext(cycleCtx, region)
		if err != nil {
			log.Printf("free proxy active count failed for %s: %v", region, err)
		} else if activeCount < targetActive {
			batchSize = bootstrapBatch
			bootstrap = true
		}
		regionProxies, err := store.ClaimFreeProxiesDueForCheck(cycleCtx, []string{region}, batchSize, bootstrap)
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
	protocolCounts := make(map[string]int)
	sourceCounts := make(map[string]int)
	for _, candidate := range proxies {
		protocolCounts[candidate.Protocol]++
		sourceCounts[candidate.Source]++
	}
	log.Printf(
		"free proxy check started: %d candidates across %d regions (concurrency %d, timeout %s, protocols %v, sources %v)",
		len(proxies),
		len(regionBatches),
		concurrency,
		validationTimeout,
		protocolCounts,
		sourceCounts,
	)
	sem := make(chan struct{}, concurrency)
	var wg sync.WaitGroup
	var passed atomic.Int64
	var failed atomic.Int64
	var canceled atomic.Int64
	var persistenceFailed atomic.Int64
	var launched atomic.Int64
	errorCounts := make(map[string]int)
	var errorCountsMu sync.Mutex
	startedAt := time.Now()
launchCandidates:
	for _, candidate := range proxies {
		candidate := candidate
		select {
		case sem <- struct{}{}:
		case <-cycleCtx.Done():
			break launchCandidates
		}
		wg.Add(1)
		launched.Add(1)
		go func() {
			defer wg.Done()
			defer func() { <-sem }()
			validationCtx, cancelValidation := context.WithTimeout(cycleCtx, validationTimeout)
			result, err := scraper.ValidateFreeProxy(validationCtx, candidate.ProxyURL, candidate.Region, maxLatencyMs)
			cancelValidation()
			if cycleCtx.Err() != nil {
				canceled.Add(1)
				return
			}

			writeCtx, cancelWrite := context.WithTimeout(cycleCtx, freeProxyWriteTimeout)
			defer cancelWrite()
			if err != nil {
				failed.Add(1)
				errorCountsMu.Lock()
				errorCounts[result.ErrorCode]++
				errorCountsMu.Unlock()
				if writeErr := store.RecordFreeProxyFailureClassContext(
					writeCtx,
					candidate.ProxyURL,
					candidate.Region,
					result.StatusCode,
					err.Error(),
					result.ErrorCode,
					threshold,
					quarantineMinutes,
				); writeErr != nil {
					persistenceFailed.Add(1)
				}
				return
			}
			passed.Add(1)
			if writeErr := store.RecordFreeProxySuccessContext(
				writeCtx,
				candidate.ProxyURL,
				candidate.Region,
				result.LatencyMs,
			); writeErr != nil {
				persistenceFailed.Add(1)
			}
		}()
	}
	if !waitForFreeProxyBatch(cycleCtx, &wg) {
		log.Printf(
			"free proxy check timed out after %s: %d/%d launched, %d passed, %d failed, %d canceled, %d persistence failures",
			time.Since(startedAt).Round(time.Second),
			launched.Load(),
			len(proxies),
			passed.Load(),
			failed.Load(),
			canceled.Load(),
			persistenceFailed.Load(),
		)
		return
	}

	log.Printf(
		"free proxy check completed: %d checked, %d passed, %d failed, %d canceled, %d persistence failures in %s (errors %v)",
		passed.Load()+failed.Load(),
		passed.Load(),
		failed.Load(),
		canceled.Load(),
		persistenceFailed.Load(),
		time.Since(startedAt).Round(time.Second),
		errorCounts,
	)
}

func waitForFreeProxyBatch(ctx context.Context, wg *sync.WaitGroup) bool {
	done := make(chan struct{})
	go func() {
		wg.Wait()
		close(done)
	}()

	select {
	case <-done:
		return true
	case <-ctx.Done():
		return false
	}
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
	if !freeProxyImportRunning.CompareAndSwap(false, true) {
		return
	}
	defer freeProxyImportRunning.Store(false)

	importCtx, cancelImport := context.WithTimeout(ctx, freeProxyImportTimeout)
	defer cancelImport()

	enabled, err := settingBoolContext(importCtx, store, "free_proxy_enabled", false)
	if err != nil {
		log.Printf("free proxy import enabled setting failed: %v", err)
		return
	}
	autoImportEnabled, err := settingBoolContext(importCtx, store, "free_proxy_auto_import_enabled", false)
	if err != nil {
		log.Printf("free proxy auto import setting failed: %v", err)
		return
	}
	if !enabled || !autoImportEnabled {
		return
	}
	importURL, ok, err := store.GetSettingValueContext(importCtx, "free_proxy_import_url")
	if err != nil {
		log.Printf("free proxy import setting failed: %v", err)
		return
	}
	if !ok || strings.TrimSpace(importURL) == "" {
		importURL = "https://raw.githubusercontent.com/iplocate/free-proxy-list/main/all-proxies.txt"
	}

	maxImport, err := settingIntContext(importCtx, store, "free_proxy_max_pool_size", 5000)
	if err != nil {
		log.Printf("free proxy max import setting failed: %v", err)
		return
	}
	importURLs := freeProxyImportURLsContext(importCtx, store, importURL)
	if len(importURLs) == 0 {
		return
	}
	type sourceDownload struct {
		index int
		url   string
		body  []byte
		err   error
	}
	downloadJobs := make(chan sourceDownload)
	downloadResults := make(chan sourceDownload, len(importURLs))
	var downloadWG sync.WaitGroup
	for workerIndex := 0; workerIndex < min(4, len(importURLs)); workerIndex++ {
		downloadWG.Add(1)
		go func() {
			defer downloadWG.Done()
			for job := range downloadJobs {
				sourceCtx, cancelSource := context.WithTimeout(importCtx, freeProxySourceTimeout)
				job.body, job.err = fetchFreeProxyList(sourceCtx, job.url)
				cancelSource()
				downloadResults <- job
			}
		}()
	}
	go func() {
		defer close(downloadJobs)
		for index, sourceURL := range importURLs {
			select {
			case downloadJobs <- sourceDownload{index: index, url: sourceURL}:
			case <-importCtx.Done():
				return
			}
		}
	}()
	go func() {
		downloadWG.Wait()
		close(downloadResults)
	}()

	downloads := make([]sourceDownload, len(importURLs))
	downloaded := make([]bool, len(importURLs))
	for result := range downloadResults {
		downloads[result.index] = result
		downloaded[result.index] = true
	}

	sourceCandidates := make([][]freeProxyImportCandidate, 0, len(importURLs))
	allSeenProxyURLs := make(map[string]bool)
	for index, sourceURL := range importURLs {
		if !downloaded[index] {
			continue
		}
		download := downloads[index]
		if download.err != nil {
			log.Printf("free proxy import skipped %s: %v", sourceURL, download.err)
			continue
		}
		source := freeProxySourceContext(importCtx, store, sourceURL)
		defaultScheme := defaultSchemeForImportURL(sourceURL)
		candidates := make([]freeProxyImportCandidate, 0)
		seenSourceProxies := make(map[string]bool)
		for _, line := range strings.Split(string(download.body), "\n") {
			proxyURL, protocol, host, port, ok := normalizeFreeProxyLine(line, defaultScheme)
			if !ok || seenSourceProxies[proxyURL] {
				continue
			}
			seenSourceProxies[proxyURL] = true
			allSeenProxyURLs[proxyURL] = true
			candidates = append(candidates, freeProxyImportCandidate{
				ProxyURL: proxyURL,
				Protocol: protocol,
				Host:     host,
				Port:     port,
				Source:   source,
				Sources:  []string{source},
			})
		}
		log.Printf("free proxy import source %s yielded %d candidates", source, len(candidates))
		sourceCandidates = append(sourceCandidates, candidates)
	}

	inventory, err := store.GetFreeProxyImportInventoryContext(importCtx)
	if err != nil {
		log.Printf("free proxy import existing pool load failed: %v", err)
		return
	}
	canonicalInventory := make(map[string]database.FreeProxyInventoryRecord, len(inventory))
	touchedProxyURLs := make([]string, 0, len(inventory))
	for storedProxyURL, record := range inventory {
		canonicalProxyURL := canonicalFreeProxyURL(storedProxyURL)
		current, exists := canonicalInventory[canonicalProxyURL]
		if !exists || (storedProxyURL == canonicalProxyURL && current.ProxyURL != canonicalProxyURL) {
			canonicalInventory[canonicalProxyURL] = record
		}
		if allSeenProxyURLs[canonicalProxyURL] {
			touchedProxyURLs = append(touchedProxyURLs, record.ProxyURL)
		}
	}
	if err := store.TouchFreeProxiesSeenContext(importCtx, touchedProxyURLs); err != nil {
		log.Printf("free proxy last-seen refresh failed: %v", err)
	}
	selectedCandidates, newCandidates := selectFreeProxyImportCandidates(
		sourceCandidates,
		canonicalInventory,
		maxImport,
	)

	processed, err := store.UpsertFreeProxiesContext(importCtx, selectedCandidates)
	if err != nil {
		log.Printf("free proxy batch import failed after %d candidates: %v", processed, err)
		return
	}
	selectedProxyURLs := make([]string, 0, len(selectedCandidates))
	for _, candidate := range selectedCandidates {
		selectedProxyURLs = append(selectedProxyURLs, candidate.ProxyURL)
	}
	pruned, err := store.PruneUnselectedFreeProxiesContext(importCtx, selectedProxyURLs)
	if err != nil {
		log.Printf("free proxy stale candidate prune failed: %v", err)
	}
	if processed > 0 {
		log.Printf(
			"free proxy import refreshed %d candidates (%d new, %d retained, %d stale removed) from %d available sources",
			processed,
			newCandidates,
			processed-newCandidates,
			pruned,
			len(sourceCandidates),
		)
	}
}

func selectFreeProxyImportCandidates(
	sources [][]freeProxyImportCandidate,
	inventory map[string]database.FreeProxyInventoryRecord,
	maxPoolSize int,
) ([]database.FreeProxyRecord, int) {
	if maxPoolSize <= 0 {
		return nil, 0
	}

	allSourcesByProxy := make(map[string][]string)
	prioritizedSources := make([][]freeProxyImportCandidate, len(sources))
	for sourceIndex, source := range sources {
		prioritizedSources[sourceIndex] = append([]freeProxyImportCandidate(nil), source...)
		for _, candidate := range source {
			for _, sourceName := range append(candidate.Sources, candidate.Source) {
				if sourceName == "" || containsString(allSourcesByProxy[candidate.ProxyURL], sourceName) {
					continue
				}
				allSourcesByProxy[candidate.ProxyURL] = append(allSourcesByProxy[candidate.ProxyURL], sourceName)
			}
		}
		sort.SliceStable(prioritizedSources[sourceIndex], func(left int, right int) bool {
			leftPriority := freeProxyImportPriority(
				prioritizedSources[sourceIndex][left].ProxyURL,
				inventory,
			)
			rightPriority := freeProxyImportPriority(
				prioritizedSources[sourceIndex][right].ProxyURL,
				inventory,
			)
			if leftPriority != rightPriority {
				return leftPriority < rightPriority
			}
			return prioritizedSources[sourceIndex][left].ProxyURL <
				prioritizedSources[sourceIndex][right].ProxyURL
		})
	}

	orderedCandidates := interleaveFreeProxyImportCandidates(prioritizedSources, maxPoolSize)
	selectedCandidates := make([]database.FreeProxyRecord, 0, maxPoolSize)
	newCandidates := 0

	for _, candidate := range orderedCandidates {
		stored, exists := inventory[candidate.ProxyURL]
		proxyURL := candidate.ProxyURL
		if exists {
			proxyURL = stored.ProxyURL
		} else {
			newCandidates++
			inventory[candidate.ProxyURL] = database.FreeProxyInventoryRecord{ProxyURL: candidate.ProxyURL}
		}

		selectedCandidates = append(selectedCandidates, database.FreeProxyRecord{
			ProxyURL: proxyURL,
			Protocol: candidate.Protocol,
			Host:     candidate.Host,
			Port:     candidate.Port,
			Source:   candidate.Source,
			Sources:  allSourcesByProxy[candidate.ProxyURL],
		})
	}

	return selectedCandidates, newCandidates
}

func interleaveFreeProxyImportCandidates(sources [][]freeProxyImportCandidate, limit int) []freeProxyImportCandidate {
	if limit <= 0 || len(sources) == 0 {
		return nil
	}

	groupSources := map[string][][]freeProxyImportCandidate{
		"web":    make([][]freeProxyImportCandidate, len(sources)),
		"socks5": make([][]freeProxyImportCandidate, len(sources)),
		"socks4": make([][]freeProxyImportCandidate, len(sources)),
		"other":  make([][]freeProxyImportCandidate, len(sources)),
	}
	for sourceIndex, source := range sources {
		for _, candidate := range source {
			group := "other"
			switch candidate.Protocol {
			case "http", "https":
				group = "web"
			case "socks5":
				group = "socks5"
			case "socks4":
				group = "socks4"
			}
			groupSources[group][sourceIndex] = append(groupSources[group][sourceIndex], candidate)
		}
	}

	groupOrder := []string{"web", "socks5", "socks4", "other"}
	groupCandidates := make(map[string][]freeProxyImportCandidate, len(groupOrder))
	for _, group := range groupOrder {
		groupCandidates[group] = interleaveFreeProxySources(groupSources[group])
	}

	webQuota, socks5Quota, socks4Quota := freeProxyImportProtocolQuotas(limit)
	quotas := map[string]int{
		"web":    webQuota,
		"socks5": socks5Quota,
		"socks4": socks4Quota,
		"other":  0,
	}
	positions := make(map[string]int, len(groupOrder))
	seen := make(map[string]bool, limit)
	candidates := make([]freeProxyImportCandidate, 0, limit)
	appendFromGroup := func(group string, count int) {
		for count > 0 && positions[group] < len(groupCandidates[group]) && len(candidates) < limit {
			candidate := groupCandidates[group][positions[group]]
			positions[group]++
			if seen[candidate.ProxyURL] {
				continue
			}
			seen[candidate.ProxyURL] = true
			candidates = append(candidates, candidate)
			count--
		}
	}
	for _, group := range groupOrder {
		appendFromGroup(group, quotas[group])
	}
	for len(candidates) < limit {
		before := len(candidates)
		for _, group := range groupOrder {
			appendFromGroup(group, 1)
			if len(candidates) >= limit {
				break
			}
		}
		if len(candidates) == before {
			break
		}
	}
	return candidates
}

func interleaveFreeProxySources(sources [][]freeProxyImportCandidate) []freeProxyImportCandidate {
	indices := make([]int, len(sources))
	seen := make(map[string]bool)
	candidates := make([]freeProxyImportCandidate, 0)
	for {
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
		}
		if !progressed {
			break
		}
	}
	return candidates
}

func freeProxyImportPriority(proxyURL string, inventory map[string]database.FreeProxyInventoryRecord) int {
	record, exists := inventory[proxyURL]
	if !exists {
		return 2
	}
	if record.SuccessCount > 0 {
		return 0
	}
	if record.LastChecked == nil {
		return 1
	}
	return 3
}

func freeProxyImportProtocolQuotas(limit int) (web int, socks5 int, socks4 int) {
	if limit <= 0 {
		return 0, 0, 0
	}
	web = limit * 60 / 100
	socks5 = limit * 25 / 100
	if limit >= 3 {
		web = max(1, web)
		socks5 = max(1, socks5)
		socks4 = max(1, limit-web-socks5)
	} else {
		socks4 = limit - web - socks5
	}
	for web+socks5+socks4 > limit {
		if web > socks5 && web > 1 {
			web--
		} else if socks5 > 1 {
			socks5--
		} else {
			socks4--
		}
	}
	if remaining := limit - web - socks5 - socks4; remaining > 0 {
		web += remaining
	}
	return web, socks5, socks4
}

func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
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
	return freeProxyRegionsContext(context.Background(), store)
}

func freeProxyRegionsContext(ctx context.Context, store *database.Store) ([]string, error) {
	activeRegions, err := store.GetActiveFreeProxyRegionsContext(ctx)
	if err != nil {
		return nil, err
	}
	starterRegionValue := "de,fr,it,es,nl,be,at"
	if value, ok, settingErr := store.GetSettingValueContext(ctx, "free_proxy_starter_regions"); settingErr != nil {
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
	return freeProxyImportURLsContext(context.Background(), store, importURL)
}

func freeProxyImportURLsContext(ctx context.Context, store *database.Store, importURL string) []string {
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
	regions, err := freeProxyRegionsContext(ctx, store)
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
	for _, sourceURL := range []string{
		proxiflyHTTPListURL,
		proxiflyHTTPSListURL,
		proxiflySOCKS4ListURL,
		proxiflySOCKS5ListURL,
		databayHTTPListURL,
		databaySOCKS5ListURL,
		databaySOCKS4ListURL,
		monosansProxyListURL,
	} {
		if seen[sourceURL] {
			continue
		}
		seen[sourceURL] = true
		urls = append(urls, sourceURL)
	}
	return urls
}

func freeProxySource(store *database.Store, importURL string) string {
	return freeProxySourceContext(context.Background(), store, importURL)
}

func freeProxySourceContext(ctx context.Context, store *database.Store, importURL string) string {
	if region := iplocateCountryFromURL(importURL); region != "" {
		return "iplocate:" + region
	}
	if strings.Contains(importURL, "iplocate/free-proxy-list") {
		return "iplocate"
	}
	if strings.Contains(importURL, "proxyscrape") {
		return "proxyscrape"
	}
	if strings.Contains(importURL, "proxifly/free-proxy-list") {
		return "proxifly"
	}
	if strings.Contains(importURL, "databay-labs/free-proxy-list") {
		switch {
		case strings.Contains(importURL, "/http.txt"):
			return "databay:http"
		case strings.Contains(importURL, "/socks5.txt"):
			return "databay:socks5"
		case strings.Contains(importURL, "/socks4.txt"):
			return "databay:socks4"
		default:
			return "databay"
		}
	}
	if strings.Contains(importURL, "monosans/proxy-list") {
		return "monosans"
	}
	if source, err := settingStringContext(ctx, store, "free_proxy_import_source", ""); err == nil && source != "" {
		if strings.HasPrefix(source, "iplocate") {
			return "iplocate"
		}
		if strings.HasPrefix(source, "proxyscrape") {
			return "proxyscrape"
		}
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
	case strings.Contains(importURL, "/protocols/https") || strings.Contains(importURL, "/https.txt"):
		return "https"
	case strings.Contains(importURL, "/protocols/socks4") || strings.Contains(importURL, "/socks4.txt"):
		return "socks4"
	case strings.Contains(importURL, "/protocols/socks5") || strings.Contains(importURL, "/socks5.txt"):
		return "socks5"
	default:
		return "http"
	}
}

func settingBool(store *database.Store, key string, fallback bool) bool {
	value, err := settingBoolContext(context.Background(), store, key, fallback)
	if err != nil {
		return fallback
	}
	return value
}

func settingBoolContext(ctx context.Context, store *database.Store, key string, fallback bool) (bool, error) {
	value, ok, err := store.GetSettingValueContext(ctx, key)
	if err != nil || !ok {
		return fallback, err
	}
	return strings.TrimSpace(value) == "true", nil
}

func settingString(store *database.Store, key string, fallback string) string {
	value, err := settingStringContext(context.Background(), store, key, fallback)
	if err != nil {
		return fallback
	}
	return value
}

func settingStringContext(ctx context.Context, store *database.Store, key string, fallback string) (string, error) {
	value, ok, err := store.GetSettingValueContext(ctx, key)
	if err != nil || !ok {
		return fallback, err
	}
	value = strings.TrimSpace(value)
	if value == "" {
		return fallback, nil
	}
	return value, nil
}

func settingInt(store *database.Store, key string, fallback int) int {
	value, err := settingIntContext(context.Background(), store, key, fallback)
	if err != nil {
		return fallback
	}
	return value
}

func settingIntContext(ctx context.Context, store *database.Store, key string, fallback int) (int, error) {
	if strings.ToUpper(key) == key {
		if value := strings.TrimSpace(os.Getenv(key)); value != "" {
			parsed, err := strconv.Atoi(value)
			if err == nil && parsed > 0 {
				return parsed, nil
			}
		}
	}
	value, ok, err := store.GetSettingValueContext(ctx, key)
	if err != nil || !ok {
		return fallback, err
	}
	parsed, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil || parsed <= 0 {
		return fallback, nil
	}
	return parsed, nil
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
