package scraper

import (
	"context"
	"fmt"
	"log"
	"math/rand"
	"sort"
	"strings"
	"time"

	"vintrack-worker/internal/model"
)

type DiscoverySpec struct {
	Fingerprint string
	Monitors    []model.Monitor
}

func resolveDiscoveryMode(raw string) string {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "active":
		return "active"
	case "shadow":
		return "shadow"
	default:
		return "off"
	}
}

func BuildDiscoverySpecsWithPolicy(monitors []model.Monitor, mode string, allowFreeActive bool) map[string]DiscoverySpec {
	specs := make(map[string]DiscoverySpec)
	resolvedMode := resolveDiscoveryMode(mode)
	if resolvedMode == "off" {
		return specs
	}

	for _, monitor := range monitors {
		if monitor.Status != "active" || !discoveryAllowsProxySource(monitor.ProxySource, resolvedMode, allowFreeActive) {
			continue
		}
		key := discoveryStructuralKey(monitor)
		spec := specs[key]
		spec.Monitors = append(spec.Monitors, monitor)
		specs[key] = spec
	}

	for key, spec := range specs {
		sort.Slice(spec.Monitors, func(i, j int) bool { return spec.Monitors[i].ID < spec.Monitors[j].ID })
		parts := make([]string, 0, len(spec.Monitors))
		for _, monitor := range spec.Monitors {
			parts = append(parts, discoveryMonitorFingerprint(monitor))
		}
		spec.Fingerprint = strings.Join(parts, "||")
		specs[key] = spec
	}
	return specs
}

func discoveryAllowsProxySource(proxySource string, mode string, allowFreeActive bool) bool {
	if proxySource != "free" {
		return true
	}
	if mode == "shadow" {
		return true
	}
	return mode == "active" && allowFreeActive
}

func discoveryStructuralKey(m model.Monitor) string {
	return fmt.Sprintf(
		"region=%s|price=%s:%s|size=%s|catalog=%s|brand=%s|color=%s|status=%s|platform=%s|extra=%s|proxy=%s:%s",
		m.Region,
		nullableInt(m.PriceMin),
		nullableInt(m.PriceMax),
		nullableString(m.SizeID),
		nullableString(m.CatalogIDs),
		nullableString(m.BrandIDs),
		nullableString(m.ColorIDs),
		nullableString(m.StatusIDs),
		nullableString(m.VideoGamePlatformIDs),
		nullableString(m.VintedExtraParams),
		m.ProxySource,
		discoveryProxyFingerprint(m),
	)
}

func discoveryProxyFingerprint(m model.Monitor) string {
	if m.ProxyGroupID != nil {
		return fmt.Sprintf("group:%d:%s", *m.ProxyGroupID, shortProxyHash(m.Proxies.String))
	}
	if m.ProxySource == "free" {
		return fmt.Sprintf("free:%s", m.Region)
	}
	return proxyFingerprint(m)
}

func discoveryMonitorFingerprint(m model.Monitor) string {
	return fmt.Sprintf(
		"%d|%s|discord=%v:%s|telegram=%v:%s|dedupe=%v",
		m.ID,
		monitorConfigFingerprint(m),
		m.WebhookActive,
		nullString(m.DiscordWebhook),
		m.TelegramActive,
		nullString(m.TelegramChatID),
		m.DedupeMonitorAlerts,
	)
}

func (e *Engine) DiscoveryTask(ctx context.Context, spec DiscoverySpec) {
	policy := e.workerPolicySnapshot()
	discoveryMode := policy.DiscoveryMode
	if len(spec.Monitors) == 0 || discoveryMode == "off" {
		return
	}
	representative := spec.Monitors[0]
	pm, proxySource, proxyKey, trafficRecorder := e.proxyContext(representative)
	if pm.Count() < 2 {
		for _, monitor := range spec.Monitors {
			e.db.RecordMonitorEvent(model.MonitorEvent{
				MonitorID: monitor.ID,
				EventType: "discovery_proxy_capacity",
				Severity:  "warning",
				Message:   fmt.Sprintf("Hybrid discovery requires at least two proxies in the %s pool; canonical monitoring remains active", proxySource),
			})
		}
		return
	}

	domain := model.RegionDomain(representative.Region)
	discoveryPoolKey := proxyKey + ":discovery"
	discoveryPoolSize := e.poolSize
	if representative.ProxySource == "free" {
		discoveryPoolKey = fmt.Sprintf("free:%s:discovery", representative.Region)
		discoveryPoolSize = getEnvInt("DISCOVERY_FREE_CLIENT_POOL_SIZE", 8)
	}
	pool := e.GetOrCreatePoolSized(pm, domain, discoveryPoolKey, trafficRecorder, proxySource+":discovery", discoveryPoolSize)
	var enricher *SellerEnricher
	needsSellerEnrichment := policy.EnrichSellerInfo
	for _, monitor := range spec.Monitors {
		needsSellerEnrichment = needsSellerEnrichment || requiresSellerEnrichment(monitor)
	}
	if e.fetcher.RequiresNetwork() && needsSellerEnrichment {
		enricher = e.GetOrCreateEnricher(pm, domain, proxyKey, trafficRecorder, proxySource)
	}

	interval := time.Duration(getEnvInt("DISCOVERY_INTERVAL_MS", 500)) * time.Millisecond
	if representative.ProxySource == "free" {
		interval = time.Duration(getEnvInt("DISCOVERY_FREE_INTERVAL_MS", 500)) * time.Millisecond
	}
	if interval < 500*time.Millisecond {
		interval = 500 * time.Millisecond
	}
	perPage := getEnvInt("DISCOVERY_PER_PAGE", 96)
	if representative.ProxySource == "free" {
		perPage = getEnvInt("DISCOVERY_FREE_PER_PAGE", 64)
	}
	if perPage < 1 {
		perPage = 96
	}
	maxBackfillPages := getEnvInt("DISCOVERY_MAX_BACKFILL_PAGES", 3)
	if maxBackfillPages < 1 {
		maxBackfillPages = 1
	}
	timeout := time.Duration(getEnvInt("CATALOG_TIMEOUT_MS", 2000)) * time.Millisecond
	hedgeDelay := time.Duration(getEnvInt("CATALOG_HEDGE_DELAY_MS", 250)) * time.Millisecond
	if representative.ProxySource == "free" {
		timeout = time.Duration(getEnvInt("DISCOVERY_FREE_TIMEOUT_MS", 3000)) * time.Millisecond
		hedgeDelay = time.Duration(getEnvInt("DISCOVERY_FREE_HEDGE_DELAY_MS", 150)) * time.Millisecond
	}
	if timeout < 500*time.Millisecond {
		timeout = 500 * time.Millisecond
	}
	log.Printf("[discovery:%s] started | monitors=%d | proxy=%s (%d proxies) | clients=%d | interval=%s | per_page=%d | timeout=%s | hedge=%s", discoveryMode, len(spec.Monitors), proxySource, pm.Count(), pool.Size(), interval, perPage, timeout, hedgeDelay)

	scan := discoveryScan{
		seen:         make(map[int64]time.Time, perPage*4),
		previousPage: make(map[int64]struct{}, perPage),
	}
	checks := 0
	consecutiveFailures := 0

	for {
		cycleStart := time.Now()
		select {
		case <-ctx.Done():
			return
		default:
		}
		checks++

		fetchCtx, cancel := context.WithTimeout(ctx, timeout)
		result := e.fetchCatalogHedgedWithDelay(fetchCtx, pool, BuildDiscoveryURLWithPerPage(representative, 1, perPage), domain, hedgeDelay)
		cancel()
		if result.err != nil || result.status != 200 {
			consecutiveFailures++
			for _, monitor := range spec.Monitors {
				e.db.RecordMonitorRun(model.MonitorRun{
					MonitorID: monitor.ID, Status: "failed", StatusCode: result.status,
					DurationMS: int(time.Since(cycleStart).Milliseconds()), ErrorMessage: "discovery fetch failed",
					ProxySource: proxySource, FetchSource: "discovery", Region: monitor.Region,
				})
			}
			sleepDiscoveryCycle(ctx, cycleStart, interval+discoveryFailureBackoff(proxySource, consecutiveFailures))
			continue
		}
		consecutiveFailures = 0

		matchesByMonitor := make(map[int]int)
		monitorMatchers := compileDiscoveryMonitorMatchers(spec.Monitors)
		itemCount := scan.processPages(ctx, result.items, maxBackfillPages, func(page int) catalogFetchResult {
			pageCtx, pageCancel := context.WithTimeout(ctx, timeout)
			defer pageCancel()
			return e.fetchCatalogHedgedWithDelay(pageCtx, pool, BuildDiscoveryURLWithPerPage(representative, page, perPage), domain, hedgeDelay)
		}, func(vintedItem model.VintedItem) {
			for _, matcher := range monitorMatchers {
				if !matcher.matches(vintedItem) {
					continue
				}
				monitor := matcher.monitor
				matchesByMonitor[monitor.ID]++
				if discoveryMode == "active" {
					e.handleDetectedItem(ctx, monitor, vintedItem, "discovery", proxySource, enricher)
				} else {
					e.db.RecordItemDetection(model.MonitorItemDetection{
						MonitorID: monitor.ID, ItemID: vintedItem.ID, Source: "discovery", SeenAt: time.Now(),
					})
				}
			}
		})
		if checks%100 == 0 {
			cutoff := time.Now().Add(-10 * time.Minute)
			for id, seenAt := range scan.seen {
				if seenAt.Before(cutoff) {
					delete(scan.seen, id)
				}
			}
		}

		for _, monitor := range spec.Monitors {
			e.db.RecordMonitorRun(model.MonitorRun{
				MonitorID: monitor.ID, Status: "success", StatusCode: 200,
				DurationMS: int(time.Since(cycleStart).Milliseconds()), ItemCount: itemCount,
				NewItemCount: matchesByMonitor[monitor.ID], ProxySource: proxySource,
				FetchSource: "discovery", Region: monitor.Region,
			})
		}
		sleepDiscoveryCycle(ctx, cycleStart, interval)
	}
}

// discoveryScan keeps the baseline and dedupe state across discovery cycles.
// Each page is processed before fetching older backfill pages, so a slow or
// failed backfill cannot hold up detections already returned on page one.
type discoveryScan struct {
	seen         map[int64]time.Time
	previousPage map[int64]struct{}
	initialized  bool
	baseline     catalogBaseline
}

func (s *discoveryScan) processPages(
	ctx context.Context,
	pageOne []model.VintedItem,
	maxBackfillPages int,
	fetchPage func(int) catalogFetchResult,
	processItem func(model.VintedItem),
) int {
	if !s.initialized {
		s.baseline.seed(pageOne)
	}
	itemCount := 0
	processPage := func(items []model.VintedItem) {
		itemCount += len(items)
		now := time.Now()
		for _, item := range items {
			_, exists := s.seen[item.ID]
			s.seen[item.ID] = now
			if !exists && s.initialized && s.baseline.allows(item) {
				processItem(item)
			}
		}
	}

	processPage(pageOne)
	if s.initialized && len(pageOne) > 0 && !hasDiscoveryOverlap(pageOne, s.previousPage) {
		for page := 2; page <= maxBackfillPages && ctx.Err() == nil; page++ {
			result := fetchPage(page)
			if result.err != nil || result.status != 200 || len(result.items) == 0 {
				break
			}
			processPage(result.items)
			if hasDiscoveryOverlap(result.items, s.previousPage) {
				break
			}
		}
	}
	// Overlap checks above must retain the previous cycle's page-one IDs.
	s.previousPage = discoveryIDSet(pageOne)
	s.initialized = s.initialized || len(pageOne) > 0
	return itemCount
}

func discoveryFailureBackoff(proxySource string, consecutiveFailures int) time.Duration {
	if proxySource != "free" || consecutiveFailures < 2 {
		return 0
	}
	backoff := time.Duration(250*(1<<min(consecutiveFailures-2, 3))) * time.Millisecond
	if backoff > 2*time.Second {
		return 2 * time.Second
	}
	return backoff
}

// discoveryMonitorMatcher is the compiled per-cycle form of one monitor's
// discovery filters. matchesDiscovery used to re-parse the monitor query,
// re-parse the anti-keyword list, and rebuild the banned-seller lookup map for
// every (item, monitor) pair, which made a shared discovery page cost
// O(items x monitors) parses. Compiling once per cycle makes that O(monitors)
// while leaving the accept/reject decision identical.
type discoveryMonitorMatcher struct {
	monitor       model.Monitor
	query         catalogQueryMatcher
	antiKeywords  []string
	bannedSellers map[int64]struct{}
}

func compileDiscoveryMonitorMatcher(monitor model.Monitor) discoveryMonitorMatcher {
	matcher := discoveryMonitorMatcher{
		monitor:      monitor,
		query:        compileCatalogQueryMatcher(monitor.Query),
		antiKeywords: parseAntiKeywords(monitor.AntiKeywords),
	}
	if len(monitor.BannedSellerIDs) > 0 {
		banned := make(map[int64]struct{}, len(monitor.BannedSellerIDs))
		for _, sellerID := range monitor.BannedSellerIDs {
			if sellerID != 0 {
				banned[sellerID] = struct{}{}
			}
		}
		if len(banned) > 0 {
			matcher.bannedSellers = banned
		}
	}
	return matcher
}

func compileDiscoveryMonitorMatchers(monitors []model.Monitor) []discoveryMonitorMatcher {
	matchers := make([]discoveryMonitorMatcher, 0, len(monitors))
	for _, monitor := range monitors {
		matchers = append(matchers, compileDiscoveryMonitorMatcher(monitor))
	}
	return matchers
}

func (m discoveryMonitorMatcher) matches(item model.VintedItem) bool {
	haystack := item.Title
	if !m.monitor.TitleOnly {
		haystack += "\n" + item.BrandTitle
	}
	haystack = strings.ToLower(haystack)
	if !m.query.matchesLowered(haystack) {
		return false
	}
	if len(m.antiKeywords) > 0 {
		antiKeywordHaystack := haystack + "\n" + strings.ToLower(item.Description)
		for _, keyword := range m.antiKeywords {
			if strings.Contains(antiKeywordHaystack, keyword) {
				return false
			}
		}
	}
	if m.bannedSellers != nil && item.User.ID != 0 {
		if _, banned := m.bannedSellers[item.User.ID]; banned {
			return false
		}
	}
	return true
}

func matchesDiscovery(item model.VintedItem, monitor model.Monitor) bool {
	return compileDiscoveryMonitorMatcher(monitor).matches(item)
}

func hasDiscoveryOverlap(items []model.VintedItem, previous map[int64]struct{}) bool {
	if len(previous) == 0 {
		return true
	}
	for _, item := range items {
		if _, ok := previous[item.ID]; ok {
			return true
		}
	}
	return false
}

func discoveryIDSet(items []model.VintedItem) map[int64]struct{} {
	result := make(map[int64]struct{}, len(items))
	for _, item := range items {
		result[item.ID] = struct{}{}
	}
	return result
}

func sleepDiscoveryCycle(ctx context.Context, cycleStart time.Time, interval time.Duration) {
	target := interval + time.Duration(rand.Intn(101))*time.Millisecond
	remaining := target - time.Since(cycleStart)
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
