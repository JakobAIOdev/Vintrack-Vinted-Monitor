package scraper

import (
	"context"
	"fmt"
	"log"
	"math/rand"
	"os"
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

func BuildDiscoverySpecs(monitors []model.Monitor, mode string) map[string]DiscoverySpec {
	specs := make(map[string]DiscoverySpec)
	resolvedMode := resolveDiscoveryMode(mode)
	if resolvedMode == "off" {
		return specs
	}

	for _, monitor := range monitors {
		if monitor.Status != "active" || !discoveryAllowsProxySource(monitor.ProxySource, resolvedMode) {
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

func discoveryAllowsProxySource(proxySource string, mode string) bool {
	if proxySource != "free" {
		return true
	}
	if mode == "shadow" {
		return true
	}
	return mode == "active" && strings.EqualFold(strings.TrimSpace(os.Getenv("DISCOVERY_ALLOW_FREE_ACTIVE")), "true")
}

func discoveryStructuralKey(m model.Monitor) string {
	return fmt.Sprintf(
		"region=%s|price=%s:%s|size=%s|catalog=%s|brand=%s|color=%s|status=%s|platform=%s|proxy=%s:%s",
		m.Region,
		nullableInt(m.PriceMin),
		nullableInt(m.PriceMax),
		nullableString(m.SizeID),
		nullableString(m.CatalogIDs),
		nullableString(m.BrandIDs),
		nullableString(m.ColorIDs),
		nullableString(m.StatusIDs),
		nullableString(m.VideoGamePlatformIDs),
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
	if len(spec.Monitors) == 0 || e.discoveryMode == "off" {
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
	if e.enrichSeller {
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
	log.Printf("[discovery:%s] started | monitors=%d | proxy=%s (%d proxies) | clients=%d | interval=%s | per_page=%d | timeout=%s | hedge=%s", e.discoveryMode, len(spec.Monitors), proxySource, pm.Count(), pool.Size(), interval, perPage, timeout, hedgeDelay)

	seen := make(map[int64]time.Time, perPage*4)
	previousPage := make(map[int64]struct{}, perPage)
	initialized := false
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

		pageOne := result.items
		allItems := append([]model.VintedItem(nil), pageOne...)
		if initialized && len(pageOne) > 0 && !hasDiscoveryOverlap(pageOne, previousPage) {
			for page := 2; page <= maxBackfillPages; page++ {
				pageCtx, pageCancel := context.WithTimeout(ctx, timeout)
				pageResult := e.fetchCatalogHedgedWithDelay(pageCtx, pool, BuildDiscoveryURLWithPerPage(representative, page, perPage), domain, hedgeDelay)
				pageCancel()
				if pageResult.err != nil || pageResult.status != 200 || len(pageResult.items) == 0 {
					break
				}
				allItems = append(allItems, pageResult.items...)
				if hasDiscoveryOverlap(pageResult.items, previousPage) {
					break
				}
			}
		}

		now := time.Now()
		newItems := make([]model.VintedItem, 0)
		for _, item := range allItems {
			if _, exists := seen[item.ID]; !exists && initialized {
				newItems = append(newItems, item)
			}
			seen[item.ID] = now
		}
		previousPage = discoveryIDSet(pageOne)
		if !initialized {
			initialized = true
		}
		if checks%100 == 0 {
			cutoff := now.Add(-10 * time.Minute)
			for id, seenAt := range seen {
				if seenAt.Before(cutoff) {
					delete(seen, id)
				}
			}
		}

		matchesByMonitor := make(map[int]int)
		for _, vintedItem := range newItems {
			for _, monitor := range spec.Monitors {
				if !matchesDiscovery(vintedItem, monitor) {
					continue
				}
				matchesByMonitor[monitor.ID]++
				seenAt := time.Now()
				e.db.RecordItemDetection(model.MonitorItemDetection{
					MonitorID: monitor.ID, ItemID: vintedItem.ID, Source: "discovery", SeenAt: seenAt,
				})
				if e.discoveryMode == "active" {
					e.handleDetectedItem(ctx, monitor, vintedItem, "discovery", proxySource, enricher)
				}
			}
		}

		for _, monitor := range spec.Monitors {
			e.db.RecordMonitorRun(model.MonitorRun{
				MonitorID: monitor.ID, Status: "success", StatusCode: 200,
				DurationMS: int(time.Since(cycleStart).Milliseconds()), ItemCount: len(allItems),
				NewItemCount: matchesByMonitor[monitor.ID], ProxySource: proxySource,
				FetchSource: "discovery", Region: monitor.Region,
			})
		}
		sleepDiscoveryCycle(ctx, cycleStart, interval)
	}
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

func matchesDiscovery(item model.VintedItem, monitor model.Monitor) bool {
	haystack := item.Title
	if !monitor.TitleOnly {
		haystack += "\n" + item.BrandTitle
	}
	haystack = strings.ToLower(haystack)
	if !matchesMonitorQuery(haystack, monitor.Query) {
		return false
	}
	antiKeywordHaystack := haystack + "\n" + strings.ToLower(item.Description)
	for _, keyword := range parseAntiKeywords(monitor.AntiKeywords) {
		if strings.Contains(antiKeywordHaystack, keyword) {
			return false
		}
	}
	if _, blocked := filterBannedSellerItems([]model.VintedItem{item}, monitor.BannedSellerIDs); blocked > 0 {
		return false
	}
	return true
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
