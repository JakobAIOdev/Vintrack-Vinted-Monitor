package scraper

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"log"
	"math/rand"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"vintrack-worker/internal/database"
	"vintrack-worker/internal/model"
	"vintrack-worker/internal/proxy"
)

const (
	maxAPIResponseBytes             = 2 * 1024 * 1024 // 2 MB
	defaultQueryDelayMS             = 1500
	minQueryDelayMS                 = 500
	maxQueryDelayMS                 = 3600000
	defaultFreeProxyClientPoolSize  = 50
	maximumFreeProxyClientPoolSize  = 100
	freeProxyMaxInFlightPerClient   = 2
	defaultFreeProxyHedgeDelayMilli = 900
	freeProxyRuntimeSuccessInterval = 5 * time.Minute
)

type Engine struct {
	db                     *database.Store
	serverProxy            *proxy.Manager
	freeProxy              *proxy.RegionPools
	fetcher                CatalogFetcher
	enrichSeller           bool
	poolSize               int
	freePoolSize           int
	pools                  map[string]*ClientPool
	poolsMu                sync.RWMutex
	enrichers              map[string]*SellerEnricher
	enrichersMu            sync.RWMutex
	sellerFlightsMu        sync.Mutex
	sellerFlights          map[string]*sellerFetchFlight
	notificationPolicies   map[int]notificationPolicy
	notificationPoliciesMu sync.RWMutex
	freeProxySuccessSeen   map[string]time.Time
	freeProxySuccessSeenMu sync.Mutex
	discoveryMode          string
	jobsCtx                context.Context
	jobsCancel             context.CancelFunc
	alertJobs              chan alertJob
	enrichmentScheduler    *SellerEnrichmentScheduler
	enrichmentFastJobs     chan enrichmentJob
	alertDeliveryWake      chan struct{}
	claimedAlertDeliveries chan model.AlertDelivery
	alertDeliveryInFlight  atomic.Int64
	alertDeliveryMaxFlight int
	priceWatchJobs         chan model.PriceWatchTarget
	priceWatchInFlight     atomic.Int64
	priceWatchWorkers      int
	priceWatchEnabled      atomic.Bool
	priceWatchSharedMaxRPM atomic.Int64
	priceWatchPersonalRPM  atomic.Int64
	priceWatchRateMu       sync.Mutex
	priceWatchRateWindows  map[string]*priceWatchRateWindow
	enrichmentMetrics      *sellerEnrichmentMetrics
	catalogLatency         *catalogLatencyMetrics
	jobsWG                 sync.WaitGroup
}

type notificationPolicy struct {
	enabled       bool
	telegramStyle model.NotificationMessageStyle
	discordStyle  model.NotificationMessageStyle
}

func NewEngine(db *database.Store, pm *proxy.Manager, freePM *proxy.RegionPools) *Engine {
	fetcher := NewCatalogFetcherFromEnv()
	enrich := os.Getenv("ENRICH_SELLER_INFO") != "false"
	if !fetcher.RequiresNetwork() {
		enrich = false
	}
	poolSize := getEnvInt("CLIENT_POOL_SIZE", 5)
	freePoolSize := configuredFreeProxyClientPoolSize()
	discoveryMode := resolveDiscoveryMode(os.Getenv("DISCOVERY_MODE"))
	if !fetcher.RequiresNetwork() {
		discoveryMode = "off"
	}
	jobsCtx, jobsCancel := context.WithCancel(context.Background())
	enrichmentWorkers := getEnvInt("ENRICHMENT_WORKERS", 24)
	if enrichmentWorkers < 1 {
		enrichmentWorkers = 1
	}
	priceWatchWorkers := getEnvInt("PRICE_WATCH_WORKERS", 4)
	if priceWatchWorkers < 1 {
		priceWatchWorkers = 1
	}
	if priceWatchWorkers > 16 {
		priceWatchWorkers = 16
	}
	log.Printf("Catalog fetch mode: %s, seller enrichment (region/rating): %v, client pool size: %d, free proxy pool size: %d, TLS profile: %s, discovery: %s", fetcher.Name(), enrich, poolSize, freePoolSize, configuredClientFingerprint().name, discoveryMode)
	engine := &Engine{
		db:                     db,
		serverProxy:            pm,
		freeProxy:              freePM,
		fetcher:                fetcher,
		enrichSeller:           enrich,
		poolSize:               poolSize,
		freePoolSize:           freePoolSize,
		pools:                  make(map[string]*ClientPool),
		enrichers:              make(map[string]*SellerEnricher),
		sellerFlights:          make(map[string]*sellerFetchFlight),
		notificationPolicies:   make(map[int]notificationPolicy),
		freeProxySuccessSeen:   make(map[string]time.Time),
		discoveryMode:          discoveryMode,
		jobsCtx:                jobsCtx,
		jobsCancel:             jobsCancel,
		alertJobs:              make(chan alertJob, 4096),
		enrichmentScheduler:    NewSellerEnrichmentScheduler(4096, enrichmentWorkers),
		enrichmentFastJobs:     make(chan enrichmentJob, 4096),
		alertDeliveryWake:      make(chan struct{}, 64),
		claimedAlertDeliveries: make(chan model.AlertDelivery, alertDeliveryWorkerCount()),
		priceWatchJobs:         make(chan model.PriceWatchTarget, priceWatchWorkers),
		priceWatchWorkers:      priceWatchWorkers,
		priceWatchRateWindows:  make(map[string]*priceWatchRateWindow),
		// attempt_count and the delivery lease both start when a row is claimed,
		// so claiming far more than the workers can start means the surplus ages
		// out of its lease while queued, gets recovered, and is delivered twice.
		alertDeliveryMaxFlight: alertDeliveryWorkerCount() + alertDeliveryWorkerCount()/2,
		enrichmentMetrics:      &sellerEnrichmentMetrics{},
	}
	engine.priceWatchEnabled.Store(true)
	engine.priceWatchSharedMaxRPM.Store(30)
	engine.priceWatchPersonalRPM.Store(2)
	// The catalog latency aggregate is opt-out rather than opt-in: it is a single
	// bounded ring plus one app_settings row every 10s, and without it the worker
	// has no view of fetch versus post-fetch cost at all.
	if catalogLatencyMetricsEnabled() {
		engine.catalogLatency = newCatalogLatencyMetrics()
	}
	engine.startPipelines()
	if engine.catalogLatency != nil {
		engine.jobsWG.Add(1)
		go engine.catalogLatencyHeartbeat()
	}
	return engine
}

func (e *Engine) SyncNotificationPolicies(monitors []model.Monitor) {
	policies := make(map[int]notificationPolicy, len(monitors))
	for _, monitor := range monitors {
		policies[monitor.ID] = notificationPolicy{
			enabled:       monitor.NotificationsEnabled,
			telegramStyle: model.NormalizeNotificationMessageStyle(monitor.TelegramMessageStyle),
			discordStyle:  model.NormalizeNotificationMessageStyle(monitor.DiscordMessageStyle),
		}
	}

	e.notificationPoliciesMu.Lock()
	e.notificationPolicies = policies
	e.notificationPoliciesMu.Unlock()
}

func (e *Engine) monitorNotificationsEnabled(monitor model.Monitor) bool {
	e.notificationPoliciesMu.RLock()
	policy, ok := e.notificationPolicies[monitor.ID]
	e.notificationPoliciesMu.RUnlock()
	if ok {
		return policy.enabled
	}
	return monitor.NotificationsEnabled
}

func (e *Engine) monitorNotificationMessageStyles(monitor model.Monitor) (model.NotificationMessageStyle, model.NotificationMessageStyle) {
	e.notificationPoliciesMu.RLock()
	policy, ok := e.notificationPolicies[monitor.ID]
	e.notificationPoliciesMu.RUnlock()
	if ok {
		return policy.telegramStyle, policy.discordStyle
	}
	return model.NormalizeNotificationMessageStyle(monitor.TelegramMessageStyle), model.NormalizeNotificationMessageStyle(monitor.DiscordMessageStyle)
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
	sellerPoolSize := getEnvInt("SELLER_CLIENT_POOL_SIZE", 16)
	if sellerPoolSize < 1 {
		sellerPoolSize = 1
	}
	s = NewSellerEnricher(pm, e.db, domain, sellerPoolSize, trafficRecorder)
	e.enrichers[key] = s
	return s
}

func (e *Engine) GetOrCreatePool(pm *proxy.Manager, domain string, proxyKey string, trafficRecorder func(txBytes int64, rxBytes int64), proxyLabel string) *ClientPool {
	poolSize := e.poolSize
	if proxyLabel == "free" {
		poolSize = e.freePoolSize
	}
	return e.GetOrCreatePoolSized(pm, domain, proxyKey, trafficRecorder, proxyLabel, poolSize)
}

func (e *Engine) GetOrCreatePoolSized(pm *proxy.Manager, domain string, proxyKey string, trafficRecorder func(txBytes int64, rxBytes int64), proxyLabel string, poolSize int) *ClientPool {
	return e.GetOrCreatePoolSizedWithTimeout(pm, domain, proxyKey, trafficRecorder, proxyLabel, poolSize, 3*time.Second)
}

func (e *Engine) GetOrCreatePoolSizedWithTimeout(pm *proxy.Manager, domain string, proxyKey string, trafficRecorder func(txBytes int64, rxBytes int64), proxyLabel string, poolSize int, requestTimeout time.Duration) *ClientPool {
	key := fmt.Sprintf("%s:%s", domain, proxyKey)

	e.poolsMu.RLock()
	pool, ok := e.pools[key]
	e.poolsMu.RUnlock()

	if ok {
		if strings.HasPrefix(proxyLabel, "free") {
			pool.Reconcile(poolSize)
		} else {
			pool.EnsureSize(poolSize)
		}
		return pool
	}

	e.poolsMu.Lock()
	defer e.poolsMu.Unlock()

	// Double check
	if pool, ok = e.pools[key]; ok {
		if strings.HasPrefix(proxyLabel, "free") {
			pool.Reconcile(poolSize)
		} else {
			pool.EnsureSize(poolSize)
		}
		return pool
	}

	log.Printf("Creating new client pool for %s (source: %s)", domain, proxyLabel)
	pool = NewClientPoolWithTimeout(pm, domain, poolSize, trafficRecorder, requestTimeout)
	if strings.HasPrefix(proxyLabel, "free") {
		pool.SetMaxInFlightPerClient(freeProxyMaxInFlightPerClient)
		pool.SetQuarantineFailureThreshold(3)
	}
	e.pools[key] = pool
	return pool
}

func (e *Engine) existingPool(domain string, proxyKey string) *ClientPool {
	key := fmt.Sprintf("%s:%s", domain, proxyKey)
	e.poolsMu.RLock()
	pool := e.pools[key]
	e.poolsMu.RUnlock()
	return pool
}

func configuredFreeProxyClientPoolSize() int {
	size := getEnvInt("FREE_PROXY_CLIENT_POOL_SIZE", defaultFreeProxyClientPoolSize)
	if size < 1 {
		return defaultFreeProxyClientPoolSize
	}
	if size > maximumFreeProxyClientPoolSize {
		return maximumFreeProxyClientPoolSize
	}
	return size
}

func catalogHedgeDelayForProxySource(proxySource string) time.Duration {
	key := "CATALOG_HEDGE_DELAY_MS"
	fallback := getEnvInt(key, 250)
	if proxySource == "free" {
		key = "FREE_PROXY_CATALOG_HEDGE_DELAY_MS"
		fallback = defaultFreeProxyHedgeDelayMilli
	}
	delay := getEnvInt(key, fallback)
	if delay < 0 {
		delay = 0
	}
	return time.Duration(delay) * time.Millisecond
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
		proxyKey = fmt.Sprintf("free:%s", m.Region)
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
	if err := e.db.CloseProxyIncident(ctx, m.ID, "worker_restarted"); err != nil {
		log.Printf("[%d] reconcile stale proxy incident: %v", m.ID, err)
	}
	var pool *ClientPool
	if proxySource == "free" {
		pool = e.existingPool(domain, proxyKey)
	}

	if e.fetcher.RequiresNetwork() && pm.Count() == 0 && (pool == nil || pool.Size() == 0) {
		log.Printf("[%d] ❌ ERROR: no valid proxies available (source: %s)", m.ID, proxySource)
		e.db.UpdateMonitorHealth(model.MonitorHealth{
			MonitorID:       m.ID,
			ConsecutiveErrs: -1,
			LastError:       "no valid proxies available",
			LastErrorCode:   proxyErrorNoValidProxies,
			ProxyState:      "unavailable",
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
			proxyKey = fmt.Sprintf("free:%s", m.Region)
			log.Printf("[%d] free proxy pool recovered with %d proxies", m.ID, pm.Count())
		} else {
			e.enqueueStatusNotification(m, "monitor_auto_stopped", "Monitor auto-stopped", "No valid proxies are available for this monitor.", "no-proxies")
			return
		}
	}

	if e.fetcher.RequiresNetwork() {
		log.Printf("[%d] proxy source: %s (%d proxies)", m.ID, proxySource, pm.Count())
		if pool == nil {
			pool = e.GetOrCreatePool(pm, domain, proxyKey, trafficRecorder, proxySource)
		} else if pm.Count() > 0 {
			pool.Reconcile(e.freePoolSize)
		}
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
	if e.fetcher.RequiresNetwork() && (e.enrichSeller || requiresSellerEnrichment(m)) {
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
	timeoutDuration := catalogTimeoutForProxySource(proxySource)
	consecutiveErrors := 0
	checks := 0
	initializedQueries, resumeQueries := initialQueryTracking(
		len(monitorQueries),
		m.ResumeAfterQuietHours,
	)
	var totalErrors int64
	localSeen := make(map[int64]time.Time, 128)
	waitingForProxy := false
	managerDegraded := false

	log.Printf("[%d] started | name=%q | queries=%d | delay=%s | hedge=%dms | url=%s", m.ID, m.Name, len(monitorQueries), interval, getEnvInt("CATALOG_HEDGE_DELAY_MS", 250), queryURLs[0])
	notificationsEnabled := e.monitorNotificationsEnabled(m)
	if notificationsEnabled && !m.SuppressStartupNotice {
		e.enqueueStatusNotification(
			m, "monitor_started", "Monitor started",
			fmt.Sprintf("The monitor %s is initialized. The initial scan is muted.", m.Name),
			fmt.Sprintf("%d", time.Now().Unix()/60),
		)
	}

	reportHealth := func(lastErr string, lastErrorCode string, proxyState string, retryAt time.Time, proxyLabel string) {
		h := model.MonitorHealth{
			MonitorID:       m.ID,
			TotalChecks:     int64(checks),
			TotalErrors:     totalErrors,
			ConsecutiveErrs: consecutiveErrors,
			LastErrorCode:   lastErrorCode,
			ProxyState:      proxyState,
			ProxyLabel:      proxyLabel,
			UpdatedAt:       time.Now().UTC().Format(time.RFC3339),
		}
		if lastErr != "" {
			h.LastError = lastErr
		}
		if !retryAt.IsZero() {
			h.RetryAt = retryAt.UTC().Format(time.RFC3339)
		}
		e.db.UpdateMonitorHealth(h)
	}

	defer func() {
		if waitingForProxy {
			_ = e.db.CloseProxyIncident(context.Background(), m.ID, "monitor_stopped")
		}
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
			if pool != nil && pool.Size() > 0 {
				if !managerDegraded {
					managerDegraded = true
					log.Printf("[%d] free proxy manager became empty; continuing with %d validated clients", m.ID, pool.Size())
					reportHealth("free proxy manager is rebuilding; using validated reserve clients", proxyErrorPoolWaiting, "degraded", time.Time{}, "")
					e.db.RecordMonitorEvent(model.MonitorEvent{
						MonitorID: m.ID,
						EventType: "free_proxy_recovery_started",
						Severity:  "warning",
						Message:   fmt.Sprintf("Free proxy pool for region %s is rebuilding; validated reserve clients remain active", m.Region),
					})
				}
			} else {
				log.Printf("[%d] free proxy pool became empty; waiting for recovery", m.ID)
				reportHealth("free proxy pool is waiting for recovery", proxyErrorPoolWaiting, "waiting_for_proxy", time.Time{}, "")
				waitingForProxy = true
				if err := e.db.OpenOrUpdateProxyIncident(ctx, m.ID, domain, proxySource, time.Now().Add(15*time.Second)); err != nil {
					log.Printf("[%d] open proxy incident: %v", m.ID, err)
				}
				if !waitForProxyManager(ctx, pm, 15*time.Second) {
					return
				}
				pool = e.GetOrCreatePool(pm, domain, proxyKey, trafficRecorder, proxySource)
				consecutiveErrors = 0
				if err := e.db.CloseProxyIncident(ctx, m.ID, "recovered"); err != nil {
					log.Printf("[%d] close proxy incident: %v", m.ID, err)
				}
				waitingForProxy = false
				log.Printf("[%d] free proxy pool recovered with %d proxies", m.ID, pm.Count())
			}
		} else if proxySource == "free" && managerDegraded {
			managerDegraded = false
			pool.Reconcile(e.freePoolSize)
			e.db.RecordMonitorEvent(model.MonitorEvent{
				MonitorID: m.ID,
				EventType: "free_proxy_pool_recovered",
				Severity:  "info",
				Message:   fmt.Sprintf("Free proxy pool for region %s received validated capacity", m.Region),
			})
		}

		nextCheck := checks + 1

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

		if nextCheck%20 == 0 {
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
				m.NotificationsEnabled = updated.NotificationsEnabled
				m.DedupeMonitorAlerts = updated.DedupeMonitorAlerts
				m.AllowedCountries = updated.AllowedCountries
				m.Status = updated.Status
				m.ProxyGroupLimitBytes = updated.ProxyGroupLimitBytes
				m.ProxyGroupRxBytes = updated.ProxyGroupRxBytes
				m.ProxyGroupTxBytes = updated.ProxyGroupTxBytes
				m.ProxyGroupResetAt = updated.ProxyGroupResetAt
			}
		}

		queryIndex, _ := monitorQueryForCheck(monitorQueries, nextCheck)
		apiURL := queryURLs[queryIndex]
		if proxySource == "free" {
			pool.Reconcile(e.freePoolSize)
		}
		fetchCtx, cancelFetch := context.WithTimeout(ctx, timeoutDuration)
		result := e.fetchCatalogHedgedWithDelay(
			fetchCtx,
			pool,
			apiURL,
			domain,
			catalogHedgeDelayForProxySource(proxySource),
		)
		cancelFetch()
		var waitErr *proxyPoolWaitError
		if errors.As(result.err, &waitErr) {
			retryAt := waitErr.RetryAt
			if retryAt.IsZero() || !retryAt.After(time.Now()) {
				retryAt = time.Now().Add(time.Second)
			}
			reportHealth(waitErr.Error(), waitErr.ErrorCode, "waiting_for_proxy", retryAt, waitErr.ProxyLabel)
			if err := e.db.OpenOrUpdateProxyIncident(ctx, m.ID, domain, proxySource, retryAt); err != nil {
				log.Printf("[%d] open proxy incident: %v", m.ID, err)
			}
			if !waitingForProxy {
				waitingForProxy = true
				log.Printf("[%d] all proxies for %s are temporarily unavailable; retrying at %s", m.ID, domain, retryAt.UTC().Format(time.RFC3339))
			}
			if !waitForProxyRetry(ctx, retryAt) {
				return
			}
			continue
		}

		checks = nextCheck
		gotSuccess := result.err == nil && result.status == 200
		// The fetch duration and attempt list were already measured by the hedged
		// fetch and previously thrown away. postFetchStart splits the remaining
		// cycle cost (filtering, diffing, building, enqueueing) away from it.
		postFetchStart := time.Now()
		recordCatalogCycle := func(itemCount int, newItemCount int) {
			e.catalogLatency.recordCycle(catalogLatencySample{
				fetchUS:   result.duration.Microseconds(),
				processUS: time.Since(postFetchStart).Microseconds(),
				attempts:  len(result.attempts),
				itemCount: itemCount,
				newItems:  newItemCount,
			})
		}
		// Runtime failures only drive this process's ClientPool cooldowns and
		// replacements. The regional maintainer is the sole authority for shared
		// negative health transitions, while successful catalog evidence is
		// sampled below to avoid the old per-request write storm.
		if gotSuccess {
			e.observeFreeProxyRuntimeSuccess(
				proxySource,
				m.Region,
				result.client,
				int(result.duration.Milliseconds()),
			)
		}

		if !gotSuccess {
			e.catalogLatency.recordFailedFetch(len(result.attempts))
			failureMessage := catalogFailureMessage(result)
			failureCode := catalogFailureCode(result.status, result.err)
			proxyLabel := clientProxyLabel(result.client, "")
			e.db.RecordMonitorRun(model.MonitorRun{
				MonitorID:    m.ID,
				Status:       "failed",
				StatusCode:   result.status,
				DurationMS:   int(time.Since(cycleStart).Milliseconds()),
				ErrorMessage: failureMessage,
				ProxySource:  proxySource,
				FetchSource:  "canonical",
				Region:       m.Region,
			})
			consecutiveErrors++
			totalErrors++
			if consecutiveErrors%5 == 0 {
				reportHealth(failureMessage, failureCode, "degraded", time.Time{}, proxyLabel)
				log.Printf("[%d] %d consecutive failures (%s), backing off...", m.ID, consecutiveErrors, failureMessage)
				if consecutiveErrors == 15 || consecutiveErrors == 30 {
					e.enqueueStatusNotification(
						m, "proxy_warning", "Proxy warning",
						fmt.Sprintf("Monitor %s has %d consecutive proxy errors.", m.Name, consecutiveErrors),
						fmt.Sprintf("%d", consecutiveErrors),
					)
				}
			}
			if shouldAutoStopMonitor(proxySource, consecutiveErrors, maxConsecutiveErrors) {
				log.Printf("[%d] ❌ auto-stopping: %d consecutive errors", m.ID, consecutiveErrors)
				e.db.SetMonitorStatus(m.ID, "error")
				e.db.RecordMonitorEvent(model.MonitorEvent{
					MonitorID: m.ID,
					EventType: "auto_stopped",
					Severity:  "error",
					Message:   fmt.Sprintf("Monitor auto-stopped after %d consecutive fetch errors", consecutiveErrors),
				})
				e.enqueueStatusNotification(
					m, "monitor_auto_stopped", "Monitor auto-stopped",
					fmt.Sprintf("Monitor %s was stopped after %d consecutive fetch errors.", m.Name, consecutiveErrors),
					fmt.Sprintf("%d", consecutiveErrors),
				)
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
		recoveredFromProxyWait := waitingForProxy
		if recoveredFromProxyWait {
			if err := e.db.CloseProxyIncident(ctx, m.ID, "recovered"); err != nil {
				log.Printf("[%d] close proxy incident: %v", m.ID, err)
			}
			waitingForProxy = false
		}
		if recoveredFromProxyWait || checks%5 == 0 || checks <= 3 {
			reportHealth("", "", "", time.Time{}, "")
		}

		items, titleBlockedCount := filterTitleOnlyItems(result.items, m.Query, m.TitleOnly)
		if titleBlockedCount > 0 && (checks <= 3 || checks%100 == 0) {
			log.Printf("[%d] skipped %d items because their titles did not match the query", m.ID, titleBlockedCount)
		}
		if len(items) == 0 {
			if !initializedQueries[queryIndex] {
				initializedQueries[queryIndex] = true
				log.Printf("[%d] initial scan completed with no items", m.ID)
			}
			if checks%10 == 0 {
				log.Printf("[%d] #%d | 0 items returned by Vinted", m.ID, checks)
			}
			recordCatalogCycle(0, 0)
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
			existingSeedIDs, err := e.db.BatchExistingItemIDs(m.ID, seedIDs)
			if err != nil {
				// A failed durable-state lookup must not turn a transient database
				// problem into thousands of foreground seller requests. The next
				// successful monitor start can seed any genuinely missing items.
				log.Printf("[%d] initial seed lookup failed; skipping seed enrichment: %v", m.ID, err)
				existingSeedIDs = make(map[int64]bool, len(seedIDs))
				for _, id := range seedIDs {
					existingSeedIDs[id] = true
				}
			}
			e.db.MarkItemsSeen(m.ID, seedIDs)
			filteredSeeds, _ := filterAntiKeywordItems(items, m.AntiKeywords)
			filteredSeeds, _ = filterBannedSellerItems(filteredSeeds, m.BannedSellerIDs)
			seeded := 0
			for _, seed := range filteredSeeds {
				if existingSeedIDs[seed.ID] {
					continue
				}
				built := e.buildItems(m, []model.VintedItem{seed})[0]
				requireSellerMatch := requiresSellerEnrichment(m)
				e.enqueueItem(enrichmentJob{
					ctx: ctx, item: built, vintedItem: seed, monitor: m, proxySource: proxySource,
					enricher: enricher, publishUpdate: false, backgroundOnly: true,
					requireSellerMatch: requireSellerMatch,
				}, false)
				seeded++
			}
			log.Printf("[%d] initial scan saw %d items; queued %d unpersisted seeds in background without notifications", m.ID, len(items), seeded)
			initializedQueries[queryIndex] = true
			recordCatalogCycle(len(items), 0)
			e.db.RecordMonitorRun(model.MonitorRun{
				MonitorID: m.ID, Status: "success", StatusCode: 200,
				DurationMS: int(time.Since(cycleStart).Milliseconds()), ItemCount: len(items),
				ProxySource: proxySource, FetchSource: "canonical", Region: m.Region,
			})
			sleepMonitorCycle(ctx, cycleStart, monitorQueryInterval(m, time.Now()))
			continue
		}

		newItems := make([]model.VintedItem, 0)
		if resumeQueries[queryIndex] {
			itemIDs := make([]int64, len(items))
			for index, item := range items {
				itemIDs[index] = item.ID
				localSeen[item.ID] = now
			}
			newItems, _ = splitIncomingItems(
				items,
				e.db.BatchIsNew(m.ID, itemIDs),
				true,
			)
			resumeQueries[queryIndex] = false
			log.Printf(
				"[%d] quiet-hours resume scan found %d unseen items out of %d",
				m.ID,
				len(newItems),
				len(items),
			)
		} else {
			for _, item := range items {
				if _, exists := localSeen[item.ID]; !exists {
					newItems = append(newItems, item)
				}
				localSeen[item.ID] = now
			}
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
		recordCatalogCycle(len(items), delivered)
		e.db.RecordMonitorRun(model.MonitorRun{
			MonitorID: m.ID, Status: "success", StatusCode: 200,
			DurationMS: int(time.Since(cycleStart).Milliseconds()), ItemCount: len(items),
			NewItemCount: delivered, ProxySource: proxySource, FetchSource: "canonical", Region: m.Region,
		})
		sleepMonitorCycle(ctx, cycleStart, monitorQueryInterval(m, time.Now()))
	}
}

func shouldAutoStopMonitor(proxySource string, consecutiveErrors int, maximum int) bool {
	return proxySource != "free" && maximum > 0 && consecutiveErrors >= maximum
}

func catalogTimeoutForProxySource(proxySource string) time.Duration {
	timeoutMS := getEnvInt("CATALOG_TIMEOUT_MS", 2000)
	if proxySource == "free" {
		freeTimeoutMS := getEnvInt("FREE_PROXY_CATALOG_TIMEOUT_MS", 3500)
		if freeTimeoutMS > timeoutMS {
			timeoutMS = freeTimeoutMS
		}
	}
	if timeoutMS < 500 {
		timeoutMS = 500
	}
	return time.Duration(timeoutMS) * time.Millisecond
}

func catalogFailureMessage(result catalogFetchResult) string {
	switch {
	case result.status != 0 && result.err != nil:
		return fmt.Sprintf("catalog fetch returned %d: %v", result.status, result.err)
	case result.status != 0:
		return fmt.Sprintf("catalog fetch returned %d", result.status)
	case result.err != nil:
		return fmt.Sprintf("catalog fetch failed: %v", result.err)
	default:
		return "all catalog fetch attempts failed"
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
	strictSellerGate := requiresSellerEnrichment(monitor)
	publishNow, alertAfterEnrich := detectedItemAlertPlan(
		monitor,
		strictSellerGate,
		e.monitorNotificationsEnabled(monitor),
	)
	e.enqueueItem(enrichmentJob{
		ctx: ctx, item: item, vintedItem: vintedItem, monitor: monitor, proxySource: proxySource,
		enricher: enricher, publishUpdate: !strictSellerGate,
		requireSellerMatch: strictSellerGate, alertAfterEnrich: alertAfterEnrich,
	}, publishNow)
	return true
}

func sleepMonitorCycle(ctx context.Context, cycleStart time.Time, interval time.Duration) {
	// Monitors are all started in one loop and a proxy-list change restarts them
	// together, so without jitter they stay in lockstep and every tick lands as
	// one burst of catalog requests and database writes. The discovery loop
	// already spreads itself the same way.
	remaining := interval + monitorCycleJitter() - time.Since(cycleStart)
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

// monitorCycleJitter spreads monitors across their interval. It is deliberately
// small relative to the 500ms interval floor so it never meaningfully slows a
// monitor down.
func monitorCycleJitter() time.Duration {
	return time.Duration(rand.Intn(101)) * time.Millisecond
}

func waitForProxyRetry(ctx context.Context, retryAt time.Time) bool {
	delay := time.Until(retryAt)
	if delay <= 0 {
		return ctx.Err() == nil
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-timer.C:
		return true
	case <-ctx.Done():
		return false
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

// observeFreeProxyRuntimeSuccess preserves useful positive evidence without
// restoring the old per-request write storm. Negative runtime outcomes remain
// local to ClientPool; the maintainer must reproduce them before shared health
// is degraded.
func (e *Engine) observeFreeProxyRuntimeSuccess(
	proxySource string,
	region string,
	client *Client,
	latencyMs int,
) {
	if proxySource != "free" || client == nil || client.ProxyURL == "" {
		return
	}
	proxyURL := client.ProxyURL
	key := strings.ToLower(strings.TrimSpace(region)) + "\x00" + proxyURL
	now := time.Now()
	e.freeProxySuccessSeenMu.Lock()
	lastSeen := e.freeProxySuccessSeen[key]
	if !lastSeen.IsZero() && now.Sub(lastSeen) < freeProxyRuntimeSuccessInterval {
		e.freeProxySuccessSeenMu.Unlock()
		return
	}
	e.freeProxySuccessSeen[key] = now
	e.freeProxySuccessSeenMu.Unlock()

	go func() {
		ctx, cancel := context.WithTimeout(e.jobsCtx, 5*time.Second)
		defer cancel()
		if err := e.db.TouchFreeProxyRuntimeSuccessContext(
			ctx,
			proxyURL,
			region,
			latencyMs,
		); err != nil {
			log.Printf("free proxy runtime success update failed: %v", err)
		}
	}()
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

func initialQueryTracking(queryCount int, resumeAfterQuietHours bool) ([]bool, []bool) {
	initialized := make([]bool, queryCount)
	resumeQueries := make([]bool, queryCount)
	if resumeAfterQuietHours {
		for index := range initialized {
			initialized[index] = true
			resumeQueries[index] = true
		}
	}
	return initialized, resumeQueries
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
			itemURL = "https://" + domain + itemURL
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
		if len(vItem.Photos) > 1 {
			extraImages = make([]string, 0, len(vItem.Photos)-1)
			for _, photo := range vItem.Photos[1:] {
				if photo.Url != "" {
					extraImages = append(extraImages, photo.Url)
				}
			}
			if len(extraImages) == 0 {
				// preserve the previous nil-on-empty behaviour
				extraImages = nil
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
			info := mockSellerMetadata(vItem.User.ID, vItem.ID)
			items[i].Location = info.Region
			items[i].Rating = info.Rating
			items[i].SellerRating = info.RatingStars
			items[i].SellerRatingCount = info.RatingCount
			items[i].SellerRatingAvailable = info.RatingAvailable
		}
	}

	return items
}

// buildSellerProfileURL runs once per built item. It is written with a single
// strings.Builder rather than three fmt.Sprintf calls because the fmt path was
// eight allocations per item.
func buildSellerProfileURL(domain string, sellerID int64, sellerLogin string) string {
	if sellerID == 0 {
		return ""
	}
	login := strings.TrimSpace(sellerLogin)
	id := strconv.FormatInt(sellerID, 10)

	var builder strings.Builder
	builder.Grow(len("https://") + len(domain) + len("/member/") + len(id) + 1 + len(login))
	builder.WriteString("https://")
	builder.WriteString(domain)
	builder.WriteString("/member/")
	builder.WriteString(id)
	if login != "" {
		builder.WriteByte('-')
		builder.WriteString(login)
	}
	return builder.String()
}

func mockSellerMetadata(userID int64, itemID int64) SellerInfo {
	locations := []string{
		"🇩🇪 DE",
		"🇫🇷 FR",
		"🇮🇹 IT",
		"🇳🇱 NL",
		"🇪🇸 ES",
		"🇦🇹 AT",
	}
	ratings := []SellerInfo{
		{Rating: "⭐ 5.0 (124)", RatingStars: 5.0, RatingCount: 124, RatingAvailable: true},
		{Rating: "⭐ 4.9 (58)", RatingStars: 4.9, RatingCount: 58, RatingAvailable: true},
		{Rating: "⭐ 4.8 (203)", RatingStars: 4.8, RatingCount: 203, RatingAvailable: true},
		{Rating: "⭐ 4.7 (31)", RatingStars: 4.7, RatingCount: 31, RatingAvailable: true},
		{Rating: "No rating", RatingAvailable: true},
	}

	location := locations[int((userID+itemID)%int64(len(locations)))]
	info := ratings[int((userID+itemID)%int64(len(ratings)))]
	info.Region = location
	return info
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
