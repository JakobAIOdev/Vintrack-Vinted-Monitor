package scraper

import (
	"context"
	"crypto/sha256"
	"fmt"
	"log"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"vintrack-worker/internal/database"
	"vintrack-worker/internal/discord"
	"vintrack-worker/internal/model"
	"vintrack-worker/internal/proxy"
	"vintrack-worker/internal/telegram"
)

const (
	maxAPIResponseBytes = 2 * 1024 * 1024 // 2 MB
	defaultQueryDelayMS = 1500
	minQueryDelayMS     = 500
	maxQueryDelayMS     = 3600000
)

type Engine struct {
	db             *database.Store
	serverProxy    *proxy.Manager
	freeProxy      *proxy.RegionPools
	fetcher        CatalogFetcher
	enrichSeller   bool
	poolSize       int
	pools          map[string]*ClientPool
	poolsMu        sync.RWMutex
	enrichers      map[string]*SellerEnricher
	enrichersMu    sync.RWMutex
	discoveryMode  string
	jobsCtx        context.Context
	jobsCancel     context.CancelFunc
	alertJobs      chan alertJob
	discordJobs    chan alertJob
	telegramJobs   chan alertJob
	enrichmentJobs chan enrichmentJob
	jobsWG         sync.WaitGroup
}

func NewEngine(db *database.Store, pm *proxy.Manager, freePM *proxy.RegionPools) *Engine {
	fetcher := NewCatalogFetcherFromEnv()
	enrich := os.Getenv("ENRICH_SELLER_INFO") != "false"
	if !fetcher.RequiresNetwork() {
		enrich = false
	}
	poolSize := getEnvInt("CLIENT_POOL_SIZE", 5)
	discoveryMode := resolveDiscoveryMode(os.Getenv("DISCOVERY_MODE"))
	if !fetcher.RequiresNetwork() {
		discoveryMode = "off"
	}
	jobsCtx, jobsCancel := context.WithCancel(context.Background())
	log.Printf("Catalog fetch mode: %s, seller enrichment (region/rating): %v, client pool size: %d, TLS profile: %s, discovery: %s", fetcher.Name(), enrich, poolSize, configuredClientFingerprint().name, discoveryMode)
	engine := &Engine{
		db:             db,
		serverProxy:    pm,
		freeProxy:      freePM,
		fetcher:        fetcher,
		enrichSeller:   enrich,
		poolSize:       poolSize,
		pools:          make(map[string]*ClientPool),
		enrichers:      make(map[string]*SellerEnricher),
		discoveryMode:  discoveryMode,
		jobsCtx:        jobsCtx,
		jobsCancel:     jobsCancel,
		alertJobs:      make(chan alertJob, 4096),
		discordJobs:    make(chan alertJob, 4096),
		telegramJobs:   make(chan alertJob, 4096),
		enrichmentJobs: make(chan enrichmentJob, 4096),
	}
	engine.startPipelines()
	return engine
}

func (e *Engine) ServerProxyVersion() uint64 {
	return e.serverProxy.Version()
}

func (e *Engine) FreeProxyVersion() uint64 {
	return e.freeProxy.Version("de")
}

func (e *Engine) FreeProxyRegionVersion(region string) uint64 {
	return e.freeProxy.Version(region)
}

func (e *Engine) GetOrCreateEnricher(pm *proxy.Manager, domain string, proxyKey string, trafficRecorder func(txBytes int64, rxBytes int64), proxyLabel string) *SellerEnricher {
	key := fmt.Sprintf("%s:%s", domain, proxyKey)

	e.enrichersMu.RLock()
	s, ok := e.enrichers[key]
	e.enrichersMu.RUnlock()

	if ok {
		return s
	}

	e.enrichersMu.Lock()
	defer e.enrichersMu.Unlock()

	if s, ok = e.enrichers[key]; ok {
		return s
	}

	log.Printf("Creating new seller enricher for %s (source: %s)", domain, proxyLabel)
	s = NewSellerEnricher(pm, e.db, domain, e.poolSize, trafficRecorder)
	e.enrichers[key] = s
	return s
}

func (e *Engine) GetOrCreatePool(pm *proxy.Manager, domain string, proxyKey string, trafficRecorder func(txBytes int64, rxBytes int64), proxyLabel string) *ClientPool {
	return e.GetOrCreatePoolSized(pm, domain, proxyKey, trafficRecorder, proxyLabel, e.poolSize)
}

func (e *Engine) GetOrCreatePoolSized(pm *proxy.Manager, domain string, proxyKey string, trafficRecorder func(txBytes int64, rxBytes int64), proxyLabel string, poolSize int) *ClientPool {
	key := fmt.Sprintf("%s:%s", domain, proxyKey)

	e.poolsMu.RLock()
	pool, ok := e.pools[key]
	e.poolsMu.RUnlock()

	if ok {
		return pool
	}

	e.poolsMu.Lock()
	defer e.poolsMu.Unlock()

	// Double check
	if pool, ok = e.pools[key]; ok {
		return pool
	}

	log.Printf("Creating new client pool for %s (source: %s)", domain, proxyLabel)
	pool = NewClientPool(pm, domain, poolSize, trafficRecorder)
	e.pools[key] = pool
	return pool
}

func (e *Engine) getProxyManager(m model.Monitor) *proxy.Manager {
	if m.Proxies.Valid && m.Proxies.String != "" {
		return proxy.FromString(m.Proxies.String)
	}
	if m.ProxySource == "free" {
		return e.freeProxy.Manager(m.Region)
	}
	return e.serverProxy
}

func (e *Engine) proxyContext(m model.Monitor) (*proxy.Manager, string, string, func(txBytes int64, rxBytes int64)) {
	pm := e.getProxyManager(m)
	proxySource := "server"
	proxyKey := fmt.Sprintf("server:%d", e.ServerProxyVersion())
	var trafficRecorder func(txBytes int64, rxBytes int64)

	if m.ProxyGroupName.Valid && m.ProxyGroupName.String != "" {
		proxySource = fmt.Sprintf("group:%s", m.ProxyGroupName.String)
	}
	if m.ProxyGroupID != nil {
		groupID := *m.ProxyGroupID
		proxyKey = fmt.Sprintf("group:%d:%s", groupID, shortProxyHash(m.Proxies.String))
		trafficRecorder = func(txBytes int64, rxBytes int64) {
			e.db.RecordProxyGroupBandwidth(groupID, txBytes, rxBytes)
		}
	} else if m.ProxySource == "free" {
		proxySource = "free"
		proxyKey = fmt.Sprintf("free:%s:%d", m.Region, e.FreeProxyRegionVersion(m.Region))
	}

	return pm, proxySource, proxyKey, trafficRecorder
}

func shortProxyHash(raw string) string {
	sum := sha256.Sum256([]byte(raw))
	return fmt.Sprintf("%x", sum[:6])
}

func (e *Engine) MonitorTask(ctx context.Context, m model.Monitor) {
	pm, proxySource, proxyKey, trafficRecorder := e.proxyContext(m)
	domain := model.RegionDomain(m.Region)

	if e.fetcher.RequiresNetwork() && pm.Count() == 0 {
		log.Printf("[%d] ❌ ERROR: no valid proxies available (source: %s)", m.ID, proxySource)
		e.db.UpdateMonitorHealth(model.MonitorHealth{
			MonitorID:       m.ID,
			ConsecutiveErrs: -1,
			LastError:       "no valid proxies available",
			UpdatedAt:       time.Now().UTC().Format(time.RFC3339),
		})
		e.db.RecordMonitorRun(model.MonitorRun{
			MonitorID:    m.ID,
			Status:       "failed",
			ErrorMessage: "no valid proxies available",
			ProxySource:  proxySource,
			Region:       m.Region,
		})
		e.db.RecordMonitorEvent(model.MonitorEvent{
			MonitorID: m.ID,
			EventType: "proxy_unavailable",
			Severity:  "error",
			Message:   "No valid proxies available for monitor",
		})
		if proxySource == "free" {
			e.db.RecordMonitorEvent(model.MonitorEvent{
				MonitorID: m.ID,
				EventType: "free_proxy_pool_degraded",
				Severity:  "warning",
				Message:   fmt.Sprintf("Free proxy pool for region %s is empty; monitor is waiting for recovery", m.Region),
			})
			if !waitForProxyManager(ctx, pm, 15*time.Second) {
				return
			}
			proxyKey = fmt.Sprintf("free:%s:%d", m.Region, e.FreeProxyRegionVersion(m.Region))
			log.Printf("[%d] free proxy pool recovered with %d proxies", m.ID, pm.Count())
		} else {
			if m.WebhookActive && m.DiscordWebhook.String != "" {
				discord.SendAutoStopWebhook(m.DiscordWebhook.String, m.Name, -1)
			}
			if m.TelegramActive && m.TelegramChatID.String != "" {
				telegram.SendAutoStop(m.TelegramChatID.String, m.Name, -1)
			}
			return
		}
	}

	var pool *ClientPool
	if e.fetcher.RequiresNetwork() {
		log.Printf("[%d] proxy source: %s (%d proxies)", m.ID, proxySource, pm.Count())
		pool = e.GetOrCreatePool(pm, domain, proxyKey, trafficRecorder, proxySource)
		log.Printf("[%d] using client pool: %d clients", m.ID, pool.Size())
	} else {
		proxySource = "mock"
		log.Printf("[%d] using mock catalog fetcher: %s", m.ID, e.fetcher.Name())
		m.AllowedCountries = nil
		if strings.TrimSpace(m.DiscordWebhook.String) == "" {
			m.DiscordWebhook.String = strings.TrimSpace(os.Getenv("VINTED_MOCK_DISCORD_WEBHOOK_URL"))
			m.DiscordWebhook.Valid = m.DiscordWebhook.String != ""
			m.WebhookActive = m.DiscordWebhook.Valid
		}
	}

	var enricher *SellerEnricher
	if e.enrichSeller {
		enricher = e.GetOrCreateEnricher(pm, domain, proxyKey, trafficRecorder, proxySource)
	}

	monitorQueries := parseMonitorQueries(m.Query)
	if len(monitorQueries) == 0 {
		monitorQueries = []string{""}
	}
	queryURLs := make([]string, len(monitorQueries))
	for index, query := range monitorQueries {
		queryURLs[index] = BuildVintedURLForQuery(m, query)
	}
	interval := monitorQueryInterval(m, time.Now())
	maxConsecutiveErrors := getEnvInt("MAX_CONSECUTIVE_ERRORS", 20)
	timeoutDuration := time.Duration(getEnvInt("CATALOG_TIMEOUT_MS", 2000)) * time.Millisecond
	if timeoutDuration < 500*time.Millisecond {
		timeoutDuration = 500 * time.Millisecond
	}
	consecutiveErrors := 0
	checks := 0
	initializedQueries := make([]bool, len(monitorQueries))
	var totalErrors int64
	localSeen := make(map[int64]time.Time, 128)

	log.Printf("[%d] started | name=%q | queries=%d | delay=%s | hedge=%dms | url=%s", m.ID, m.Name, len(monitorQueries), interval, getEnvInt("CATALOG_HEDGE_DELAY_MS", 250), queryURLs[0])
	if !m.SuppressStartupNotice && m.WebhookActive && m.DiscordWebhook.Valid && m.DiscordWebhook.String != "" {
		go discord.SendStartupWebhook(m.DiscordWebhook.String, m.Name)
	}
	if !m.SuppressStartupNotice && m.TelegramActive && m.TelegramChatID.Valid && m.TelegramChatID.String != "" {
		go telegram.SendStartup(m.TelegramChatID.String, m.Name)
	}

	reportHealth := func(lastErr string) {
		h := model.MonitorHealth{
			MonitorID:       m.ID,
			TotalChecks:     int64(checks),
			TotalErrors:     totalErrors,
			ConsecutiveErrs: consecutiveErrors,
			UpdatedAt:       time.Now().UTC().Format(time.RFC3339),
		}
		if lastErr != "" {
			h.LastError = lastErr
		}
		e.db.UpdateMonitorHealth(h)
	}

	defer func() {
		e.db.ClearMonitorHealth(m.ID)
	}()

	for {
		cycleStart := time.Now()

		select {
		case <-ctx.Done():
			log.Printf("[%d] stopped gracefully", m.ID)
			return
		default:
		}
		if proxySource == "free" && pm.Count() == 0 {
			log.Printf("[%d] free proxy pool became empty; waiting for recovery", m.ID)
			reportHealth("free proxy pool is waiting for recovery")
			e.db.RecordMonitorEvent(model.MonitorEvent{
				MonitorID: m.ID,
				EventType: "free_proxy_pool_degraded",
				Severity:  "warning",
				Message:   fmt.Sprintf("Free proxy pool for region %s became empty; monitor is waiting for recovery", m.Region),
			})
			if !waitForProxyManager(ctx, pm, 15*time.Second) {
				return
			}
			proxyKey = fmt.Sprintf("free:%s:%d", m.Region, e.FreeProxyRegionVersion(m.Region))
			pool = e.GetOrCreatePool(pm, domain, proxyKey, trafficRecorder, proxySource)
			consecutiveErrors = 0
			log.Printf("[%d] free proxy pool recovered with %d proxies", m.ID, pm.Count())
		}

		checks++

		if e.isProxyGroupBandwidthLimitReached(m) {
			log.Printf("[%d] proxy group limit reached for %s, pausing monitor", m.ID, proxySource)
			e.db.UpdateMonitorHealth(model.MonitorHealth{
				MonitorID:       m.ID,
				TotalChecks:     int64(checks),
				TotalErrors:     totalErrors,
				ConsecutiveErrs: consecutiveErrors,
				LastError:       "proxy group bandwidth limit reached",
				UpdatedAt:       time.Now().UTC().Format(time.RFC3339),
			})
			e.db.RecordMonitorEvent(model.MonitorEvent{
				MonitorID: m.ID,
				EventType: "bandwidth_limit_reached",
				Severity:  "warning",
				Message:   "Proxy group bandwidth limit reached; monitor was paused",
			})
			e.db.SetMonitorStatus(m.ID, "paused")
			return
		}

		if checks%20 == 0 {
			if updated, err := e.db.GetMonitorByID(m.ID); err == nil {
				if updated.Status != "active" {
					log.Printf("[%d] paused via dashboard", m.ID)
					return
				}
				if updated.ProxySource != "free" && updated.ProxyGroupID == nil {
					updated.ServerProxyVersion = e.ServerProxyVersion()
				}
				if monitorConfigFingerprint(updated) != monitorConfigFingerprint(m) {
					log.Printf("[%d] config changed, will be restarted by sync loop", m.ID)
					return
				}
				m.DiscordWebhook = updated.DiscordWebhook
				m.WebhookActive = updated.WebhookActive
				m.TelegramChatID = updated.TelegramChatID
				m.TelegramActive = updated.TelegramActive
				m.DedupeMonitorAlerts = updated.DedupeMonitorAlerts
				m.AllowedCountries = updated.AllowedCountries
				m.Status = updated.Status
				m.ProxyGroupLimitBytes = updated.ProxyGroupLimitBytes
				m.ProxyGroupRxBytes = updated.ProxyGroupRxBytes
				m.ProxyGroupTxBytes = updated.ProxyGroupTxBytes
				m.ProxyGroupResetAt = updated.ProxyGroupResetAt
			}
		}

		queryIndex, _ := monitorQueryForCheck(monitorQueries, checks)
		apiURL := queryURLs[queryIndex]
		fetchCtx, cancelFetch := context.WithTimeout(ctx, timeoutDuration)
		result := e.fetchCatalogHedged(fetchCtx, pool, apiURL, domain)
		cancelFetch()
		gotSuccess := result.err == nil && result.status == 200
		if gotSuccess {
			e.recordFreeProxySuccess(proxySource, result.client, m.Region, int(result.duration.Milliseconds()))
		} else if result.client != nil {
			message := fmt.Sprintf("status %d", result.status)
			if result.err != nil {
				message = result.err.Error()
			}
			e.recordFreeProxyFailure(proxySource, result.client, m.Region, result.status, message)
		}

		if !gotSuccess {
			e.db.RecordMonitorRun(model.MonitorRun{
				MonitorID:    m.ID,
				Status:       "failed",
				StatusCode:   result.status,
				DurationMS:   int(time.Since(cycleStart).Milliseconds()),
				ErrorMessage: "all fetchers failed",
				ProxySource:  proxySource,
				FetchSource:  "canonical",
				Region:       m.Region,
			})
			consecutiveErrors++
			totalErrors++
			if consecutiveErrors%5 == 0 {
				reportHealth("all fetchers failed")
				log.Printf("[%d] %d consecutive failures, backing off...", m.ID, consecutiveErrors)
				if consecutiveErrors == 15 || consecutiveErrors == 30 {
					if m.WebhookActive && m.DiscordWebhook.String != "" {
						discord.SendProxyWarningWebhook(m.DiscordWebhook.String, m.Name, consecutiveErrors)
					}
					if m.TelegramActive && m.TelegramChatID.String != "" {
						telegram.SendProxyWarning(m.TelegramChatID.String, m.Name, consecutiveErrors)
					}
				}
			}
			if consecutiveErrors >= maxConsecutiveErrors {
				log.Printf("[%d] ❌ auto-stopping: %d consecutive errors", m.ID, consecutiveErrors)
				e.db.SetMonitorStatus(m.ID, "error")
				e.db.RecordMonitorEvent(model.MonitorEvent{
					MonitorID: m.ID,
					EventType: "auto_stopped",
					Severity:  "error",
					Message:   fmt.Sprintf("Monitor auto-stopped after %d consecutive fetch errors", consecutiveErrors),
				})
				if m.WebhookActive && m.DiscordWebhook.String != "" {
					discord.SendAutoStopWebhook(m.DiscordWebhook.String, m.Name, consecutiveErrors)
				}
				if m.TelegramActive && m.TelegramChatID.String != "" {
					telegram.SendAutoStop(m.TelegramChatID.String, m.Name, consecutiveErrors)
				}
				return
			}
			var rateLimitBackoff time.Duration
			if result.status == 403 || result.status == 429 {
				rateLimitBackoff = time.Duration(250*(1<<min(consecutiveErrors, 4))) * time.Millisecond
				if rateLimitBackoff > 3*time.Second {
					rateLimitBackoff = 3 * time.Second
				}
			}
			sleepMonitorCycle(ctx, cycleStart, monitorQueryInterval(m, time.Now())+rateLimitBackoff)
			continue
		}

		consecutiveErrors = 0
		if checks%5 == 0 || checks <= 3 {
			reportHealth("")
		}

		items := result.items
		if len(items) == 0 {
			if !initializedQueries[queryIndex] {
				initializedQueries[queryIndex] = true
				log.Printf("[%d] initial scan completed with no items", m.ID)
			}
			if checks%10 == 0 {
				log.Printf("[%d] #%d | 0 items returned by Vinted", m.ID, checks)
			}
			e.db.RecordMonitorRun(model.MonitorRun{
				MonitorID: m.ID, Status: "success", StatusCode: 200,
				DurationMS: int(time.Since(cycleStart).Milliseconds()), ProxySource: proxySource,
				FetchSource: "canonical", Region: m.Region,
			})
			sleepMonitorCycle(ctx, cycleStart, monitorQueryInterval(m, time.Now()))
			continue
		}

		now := time.Now()
		if !initializedQueries[queryIndex] {
			seedIDs := make([]int64, len(items))
			for i, item := range items {
				seedIDs[i] = item.ID
				localSeen[item.ID] = now
			}
			e.db.MarkItemsSeen(m.ID, seedIDs)
			filteredSeeds, _ := filterAntiKeywordItems(items, m.AntiKeywords)
			filteredSeeds, _ = filterBannedSellerItems(filteredSeeds, m.BannedSellerIDs)
			for _, seed := range filteredSeeds {
				built := e.buildItems(m, []model.VintedItem{seed})[0]
				e.enqueueItem(enrichmentJob{
					ctx: ctx, item: built, vintedItem: seed, monitor: m, proxySource: proxySource,
					enricher: enricher, publishUpdate: false,
					requireCountryMatch: hasCountryFilter(m.AllowedCountries),
				}, false)
			}
			log.Printf("[%d] initial scan seeded %d items without notifications", m.ID, len(items))
			initializedQueries[queryIndex] = true
			e.db.RecordMonitorRun(model.MonitorRun{
				MonitorID: m.ID, Status: "success", StatusCode: 200,
				DurationMS: int(time.Since(cycleStart).Milliseconds()), ItemCount: len(items),
				ProxySource: proxySource, FetchSource: "canonical", Region: m.Region,
			})
			sleepMonitorCycle(ctx, cycleStart, monitorQueryInterval(m, time.Now()))
			continue
		}

		newItems := make([]model.VintedItem, 0)
		for _, item := range items {
			if _, exists := localSeen[item.ID]; !exists {
				newItems = append(newItems, item)
			}
			localSeen[item.ID] = now
		}
		if checks%100 == 0 {
			cutoff := now.Add(-10 * time.Minute)
			for id, seenAt := range localSeen {
				if seenAt.Before(cutoff) {
					delete(localSeen, id)
				}
			}
		}

		alertItems, antiBlockedCount := filterAntiKeywordItems(newItems, m.AntiKeywords)
		alertItems, sellerBlockedCount := filterBannedSellerItems(alertItems, m.BannedSellerIDs)
		if antiBlockedCount > 0 {
			log.Printf("[%d] skipped %d new items due to anti keywords", m.ID, antiBlockedCount)
		}
		if sellerBlockedCount > 0 {
			log.Printf("[%d] skipped %d new items due to seller bans", m.ID, sellerBlockedCount)
		}

		delivered := 0
		for _, item := range alertItems {
			seenAt := time.Now()
			e.db.RecordItemDetection(model.MonitorItemDetection{
				MonitorID: m.ID, ItemID: item.ID, Source: "canonical", SeenAt: seenAt,
			})
			if e.handleDetectedItem(ctx, m, item, "canonical", proxySource, enricher) {
				delivered++
			}
		}
		if delivered > 0 {
			log.Printf("[%d] #%d | %d items | %d claimed | %dms", m.ID, checks, len(items), delivered, time.Since(cycleStart).Milliseconds())
		}
		e.db.RecordMonitorRun(model.MonitorRun{
			MonitorID: m.ID, Status: "success", StatusCode: 200,
			DurationMS: int(time.Since(cycleStart).Milliseconds()), ItemCount: len(items),
			NewItemCount: delivered, ProxySource: proxySource, FetchSource: "canonical", Region: m.Region,
		})
		sleepMonitorCycle(ctx, cycleStart, monitorQueryInterval(m, time.Now()))
	}
}

func waitForProxyManager(ctx context.Context, manager *proxy.Manager, interval time.Duration) bool {
	if manager.Count() > 0 {
		return true
	}
	if interval <= 0 {
		interval = 15 * time.Second
	}

	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return false
		case <-ticker.C:
			if manager.Count() > 0 {
				return true
			}
		}
	}
}

func (e *Engine) handleDetectedItem(ctx context.Context, monitor model.Monitor, vintedItem model.VintedItem, source string, proxySource string, enricher *SellerEnricher) bool {
	if !e.db.ClaimMonitorItem(monitor.ID, vintedItem.ID, source) {
		return false
	}
	item := e.buildItems(monitor, []model.VintedItem{vintedItem})[0]
	log.Printf("[%d] NEW via %s: %s (%s) [%s]", monitor.ID, source, item.Title, item.Price, item.Size)
	strictCountryGate := hasCountryFilter(monitor.AllowedCountries)
	publishNow, alertAfterEnrich := detectedItemAlertPlan(monitor, strictCountryGate)
	e.enqueueItem(enrichmentJob{
		ctx: ctx, item: item, vintedItem: vintedItem, monitor: monitor, proxySource: proxySource,
		enricher: enricher, publishUpdate: !strictCountryGate,
		requireCountryMatch: strictCountryGate, alertAfterEnrich: alertAfterEnrich,
	}, publishNow)
	return true
}

func sleepMonitorCycle(ctx context.Context, cycleStart time.Time, interval time.Duration) {
	remaining := interval - time.Since(cycleStart)
	if remaining <= 0 {
		return
	}
	timer := time.NewTimer(remaining)
	defer timer.Stop()
	select {
	case <-timer.C:
	case <-ctx.Done():
	}
}

func (e *Engine) isProxyGroupBandwidthLimitReached(m model.Monitor) bool {
	if m.ProxyGroupID == nil || m.ProxyGroupLimitBytes == nil || *m.ProxyGroupLimitBytes <= 0 {
		return false
	}

	txBytes, rxBytes, ok := e.db.GetProxyGroupBandwidthUsage(*m.ProxyGroupID)
	if !ok {
		txBytes = m.ProxyGroupTxBytes
		rxBytes = m.ProxyGroupRxBytes
	}

	return txBytes+rxBytes >= *m.ProxyGroupLimitBytes
}

func (e *Engine) recordFreeProxySuccess(proxySource string, client *Client, region string, latencyMs int) {
	if proxySource != "free" || client == nil {
		return
	}
	e.db.RecordFreeProxySuccess(client.ProxyURL, region, latencyMs)
}

func (e *Engine) recordFreeProxyFailure(proxySource string, client *Client, region string, statusCode int, message string) {
	if proxySource != "free" || client == nil {
		return
	}
	e.db.RecordFreeProxyFailure(
		client.ProxyURL,
		region,
		statusCode,
		message,
		e.freeProxyFailureThreshold(),
		e.freeProxyQuarantineMinutes(),
	)
}

func (e *Engine) freeProxyFailureThreshold() int {
	if value, ok, err := e.db.GetSettingValue("free_proxy_failure_threshold"); err == nil && ok {
		if parsed, parseErr := strconv.Atoi(strings.TrimSpace(value)); parseErr == nil && parsed > 0 {
			return parsed
		}
	}
	return 3
}

func (e *Engine) freeProxyQuarantineMinutes() int {
	if value, ok, err := e.db.GetSettingValue("free_proxy_quarantine_minutes"); err == nil && ok {
		if parsed, parseErr := strconv.Atoi(strings.TrimSpace(value)); parseErr == nil && parsed > 0 {
			return parsed
		}
	}
	return 30
}

func clientProxyLabel(client *Client, fallback string) string {
	if client == nil {
		return fallback
	}
	return client.ProxyLabel()
}

func resolveRedirectURL(currentURL string, location string) (string, error) {
	base, err := url.Parse(currentURL)
	if err != nil {
		return "", err
	}

	next, err := url.Parse(location)
	if err != nil {
		return "", err
	}

	return base.ResolveReference(next).String(), nil
}

func splitIncomingItems(items []model.VintedItem, newMap map[int64]bool, initialized bool) ([]model.VintedItem, []model.VintedItem) {
	if !initialized {
		return nil, items
	}

	newItems := make([]model.VintedItem, 0, len(items))
	for _, item := range items {
		if newMap[item.ID] {
			newItems = append(newItems, item)
		}
	}

	return newItems, nil
}

func filterAntiKeywordItems(items []model.VintedItem, rawKeywords *string) ([]model.VintedItem, int) {
	keywords := parseAntiKeywords(rawKeywords)
	if len(keywords) == 0 || len(items) == 0 {
		return items, 0
	}

	filtered := make([]model.VintedItem, 0, len(items))
	blocked := 0
	for _, item := range items {
		haystack := strings.ToLower(item.Title + "\n" + item.Description)
		matched := false
		for _, keyword := range keywords {
			if strings.Contains(haystack, keyword) {
				matched = true
				break
			}
		}
		if matched {
			blocked++
			continue
		}
		filtered = append(filtered, item)
	}

	return filtered, blocked
}

func filterBannedSellerItems(items []model.VintedItem, bannedSellerIDs []int64) ([]model.VintedItem, int) {
	if len(items) == 0 || len(bannedSellerIDs) == 0 {
		return items, 0
	}

	banned := make(map[int64]bool, len(bannedSellerIDs))
	for _, sellerID := range bannedSellerIDs {
		if sellerID != 0 {
			banned[sellerID] = true
		}
	}
	if len(banned) == 0 {
		return items, 0
	}

	filtered := make([]model.VintedItem, 0, len(items))
	blocked := 0
	for _, item := range items {
		if item.User.ID != 0 && banned[item.User.ID] {
			blocked++
			continue
		}
		filtered = append(filtered, item)
	}

	return filtered, blocked
}

func parseAntiKeywords(rawKeywords *string) []string {
	if rawKeywords == nil || strings.TrimSpace(*rawKeywords) == "" {
		return nil
	}

	split := strings.FieldsFunc(*rawKeywords, func(r rune) bool {
		return r == ',' || r == '\n' || r == '\r'
	})

	keywords := make([]string, 0, len(split))
	seen := make(map[string]bool, len(split))
	for _, part := range split {
		keyword := strings.ToLower(strings.TrimSpace(part))
		if keyword == "" || seen[keyword] {
			continue
		}
		seen[keyword] = true
		keywords = append(keywords, keyword)
	}
	return keywords
}

func (e *Engine) buildItems(m model.Monitor, vItems []model.VintedItem) []model.Item {
	domain := model.RegionDomain(m.Region)
	items := make([]model.Item, len(vItems))

	for i, vItem := range vItems {
		itemURL := vItem.Url
		if !strings.HasPrefix(itemURL, "http") {
			itemURL = fmt.Sprintf("https://%s%s", domain, itemURL)
		}
		size := vItem.SizeTitle
		if size == "" {
			size = vItem.Size
		}
		totalPrice := ""
		if vItem.TotalItemPrice != nil {
			totalPrice = vItem.TotalItemPrice.Amount + " " + vItem.TotalItemPrice.Currency
		}

		var extraImages []string
		for idx, photo := range vItem.Photos {
			if idx == 0 {
				continue
			}
			if photo.Url != "" {
				extraImages = append(extraImages, photo.Url)
			}
		}

		items[i] = model.Item{
			ID:          vItem.ID,
			MonitorID:   m.ID,
			Title:       vItem.Title,
			Brand:       vItem.BrandTitle,
			Price:       vItem.Price.Amount + " " + vItem.Price.Currency,
			TotalPrice:  totalPrice,
			Size:        size,
			Condition:   vItem.Condition,
			URL:         itemURL,
			ImageURL:    vItem.Photo.Url,
			ExtraImages: extraImages,
			SellerID:    vItem.User.ID,
			SellerLogin: vItem.User.Login,
			SellerURL:   buildSellerProfileURL(domain, vItem.User.ID, vItem.User.Login),
			FoundAt:     time.Now(),
		}

		if e != nil && e.fetcher != nil && !e.fetcher.RequiresNetwork() {
			location, rating := mockSellerMetadata(vItem.User.ID, vItem.ID)
			items[i].Location = location
			items[i].Rating = rating
		}
	}

	return items
}

func buildSellerProfileURL(domain string, sellerID int64, sellerLogin string) string {
	if sellerID == 0 {
		return ""
	}
	sellerPath := fmt.Sprintf("%d", sellerID)
	if strings.TrimSpace(sellerLogin) != "" {
		sellerPath = fmt.Sprintf("%d-%s", sellerID, strings.TrimSpace(sellerLogin))
	}
	return fmt.Sprintf("https://%s/member/%s", domain, sellerPath)
}

func mockSellerMetadata(userID int64, itemID int64) (string, string) {
	locations := []string{
		"🇩🇪 DE",
		"🇫🇷 FR",
		"🇮🇹 IT",
		"🇳🇱 NL",
		"🇪🇸 ES",
		"🇦🇹 AT",
	}
	ratings := []string{
		"⭐ 5.0 (124)",
		"⭐ 4.9 (58)",
		"⭐ 4.8 (203)",
		"⭐ 4.7 (31)",
		"No rating",
	}

	location := locations[int((userID+itemID)%int64(len(locations)))]
	rating := ratings[int((userID+itemID)%int64(len(ratings)))]
	return location, rating
}

func getEnvInt(key string, fallback int) int {
	if val, err := strconv.Atoi(os.Getenv(key)); err == nil {
		return val
	}
	return fallback
}

func resolveQueryDelayMs(value int) int {
	if value == 0 {
		return clampQueryDelayMs(getEnvInt("CHECK_INTERVAL_MS", defaultQueryDelayMS))
	}

	return clampQueryDelayMs(value)
}

func clampQueryDelayMs(value int) int {
	if value < minQueryDelayMS {
		return minQueryDelayMS
	}
	if value > maxQueryDelayMS {
		return maxQueryDelayMS
	}
	return value
}
