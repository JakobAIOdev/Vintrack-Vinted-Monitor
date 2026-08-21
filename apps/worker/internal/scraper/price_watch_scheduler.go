package scraper

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"strconv"
	"strings"
	"time"

	"vintrack-worker/internal/database"
	"vintrack-worker/internal/model"
	"vintrack-worker/internal/proxy"
)

const (
	priceWatchClaimLease            = 30 * time.Second
	priceWatchProxyAttempts         = 2
	defaultPriceWatchInterval       = 2 * time.Minute
	minimumPriceWatchInterval       = 30 * time.Second
	maximumPriceWatchInterval       = 60 * time.Minute
	priceWatchSharedRPMSettingKey   = "price_watch_shared_max_rpm"
	priceWatchPersonalRPMSettingKey = "price_watch_personal_max_rpm_per_proxy"
	priceWatchEnabledSettingKey     = "price_watch_enabled"
)

type priceWatchRateWindow struct {
	startedAt time.Time
	attempts  int
}

type priceWatchFetchFunc func(context.Context, *Client, model.PriceWatchTarget) (PriceWatchPage, error)

type priceWatchTransportMode string

const (
	priceWatchTransportAuto   priceWatchTransportMode = "auto"
	priceWatchTransportDirect priceWatchTransportMode = "direct"
	priceWatchTransportProxy  priceWatchTransportMode = "proxy"
)

func priceWatchConfiguredByEnvironment() bool {
	return !strings.EqualFold(strings.TrimSpace(os.Getenv("PRICE_WATCH_ENABLED")), "false")
}

func configuredPriceWatchTransportMode() priceWatchTransportMode {
	switch priceWatchTransportMode(strings.ToLower(strings.TrimSpace(os.Getenv("PRICE_WATCH_TRANSPORT_MODE")))) {
	case priceWatchTransportDirect:
		return priceWatchTransportDirect
	case priceWatchTransportProxy:
		return priceWatchTransportProxy
	default:
		return priceWatchTransportAuto
	}
}

func (e *Engine) startPriceWatchPipeline() {
	if !priceWatchConfiguredByEnvironment() {
		log.Printf("Price watch polling disabled by environment")
		return
	}
	loadCtx, cancel := context.WithTimeout(e.jobsCtx, 2*time.Second)
	e.refreshPriceWatchRuntimeSettings(loadCtx)
	cancel()
	proxyCount := 0
	if e.serverProxy != nil {
		proxyCount = e.serverProxy.Count()
	}
	log.Printf(
		"Price watch polling enabled: workers=%d shared_max_rpm=%d personal_rpm_per_proxy=%d transport=%s server_proxies=%d",
		e.priceWatchWorkers,
		e.priceWatchSharedMaxRPM.Load(),
		e.priceWatchPersonalRPM.Load(),
		configuredPriceWatchTransportMode(),
		proxyCount,
	)
	for range e.priceWatchWorkers {
		e.jobsWG.Add(1)
		go e.priceWatchWorker()
	}
	e.jobsWG.Add(1)
	go e.priceWatchCoordinator()
}

func (e *Engine) priceWatchCoordinator() {
	defer e.jobsWG.Done()
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	heartbeat := time.NewTicker(10 * time.Second)
	defer heartbeat.Stop()
	prune := time.NewTicker(6 * time.Hour)
	defer prune.Stop()
	wake := true

	for {
		if wake && e.priceWatchEnabled.Load() {
			wake = false
			capacity := e.priceWatchWorkers - int(e.priceWatchInFlight.Load())
			if capacity > 0 {
				claimToken, err := newAlertClaimToken()
				if err != nil {
					log.Printf("price watch claim token: %v", err)
				} else {
					claimCtx, cancel := context.WithTimeout(e.jobsCtx, 2*time.Second)
					targets, err := e.db.ClaimPriceWatchTargets(claimCtx, claimToken, capacity, priceWatchClaimLease)
					cancel()
					if err != nil {
						log.Printf("price watch claim: %v", err)
					} else {
						for _, target := range targets {
							e.priceWatchInFlight.Add(1)
							select {
							case e.priceWatchJobs <- target:
							case <-e.jobsCtx.Done():
								e.priceWatchInFlight.Add(-1)
								return
							}
						}
					}
				}
			}
		}

		select {
		case <-e.jobsCtx.Done():
			return
		case <-ticker.C:
			wake = true
		case <-heartbeat.C:
			heartbeatCtx, cancel := context.WithTimeout(e.jobsCtx, 2*time.Second)
			_ = e.db.SetSettingValueContext(heartbeatCtx, "price_watch_worker_heartbeat", time.Now().UTC().Format(time.RFC3339Nano))
			e.refreshPriceWatchRuntimeSettings(heartbeatCtx)
			cancel()
		case <-prune.C:
			pruneCtx, cancel := context.WithTimeout(e.jobsCtx, 10*time.Second)
			if err := e.db.PrunePriceWatchTelemetry(pruneCtx, 30); err != nil {
				log.Printf("price watch telemetry prune: %v", err)
			}
			cancel()
		}
	}
}

func (e *Engine) priceWatchWorker() {
	defer e.jobsWG.Done()
	for {
		select {
		case <-e.jobsCtx.Done():
			return
		case target := <-e.priceWatchJobs:
			e.processPriceWatchTarget(e.jobsCtx, target)
			e.priceWatchInFlight.Add(-1)
		}
	}
}

func (e *Engine) processPriceWatchTarget(ctx context.Context, target model.PriceWatchTarget) {
	checkedAt := time.Now().UTC()
	timeout := time.Duration(getEnvInt("PRICE_WATCH_TIMEOUT_MS", 6000)) * time.Millisecond
	if timeout < time.Second {
		timeout = time.Second
	}
	if timeout > 20*time.Second {
		timeout = 20 * time.Second
	}
	if target.PollIntervalSeconds < 30 {
		target.PollIntervalSeconds = 30
	}
	if target.ProxyGroupID != nil && target.ProxyGroupLimitBytes.Valid &&
		target.ProxyGroupRxBytes+target.ProxyGroupTxBytes >= target.ProxyGroupLimitBytes.Int64 {
		next := checkedAt.Add(15 * time.Minute)
		_ = e.db.RecordPriceWatchError(ctx, target.ID, target.ClaimToken, checkedAt, next, "proxy_bandwidth_limit", "personal proxy group bandwidth limit reached")
		return
	}

	domain := model.RegionDomain(target.Region)
	poolSize := getEnvInt("PRICE_WATCH_CLIENT_POOL_SIZE", e.priceWatchWorkers)
	if poolSize < 1 {
		poolSize = 1
	}
	if poolSize > 32 {
		poolSize = 32
	}

	var pool *ClientPool
	var directPool *ClientPool
	mode := configuredPriceWatchTransportMode()
	if target.TransportKind == "proxy_group" {
		mode = priceWatchTransportProxy
		pm := proxy.FromString(target.Proxies)
		if pm.Count() > 0 && target.ProxyGroupID != nil {
			groupID := *target.ProxyGroupID
			recorder := func(txBytes int64, rxBytes int64) {
				e.db.RecordProxyGroupBandwidth(groupID, txBytes, rxBytes)
			}
			pool = e.GetOrCreatePoolSizedWithTimeout(
				pm, domain,
				fmt.Sprintf("price-watch-group:%d:%s", groupID, shortProxyHash(target.Proxies)),
				recorder, fmt.Sprintf("price-watch-group:%d", groupID),
				minInt(poolSize, pm.Count()), timeout,
			)
		}
	} else {
		if e.serverProxy != nil && e.serverProxy.Count() > 0 {
			pool = e.GetOrCreatePoolSizedWithTimeout(
				e.serverProxy, domain,
				fmt.Sprintf("price-watch-shared:%d", e.ServerProxyVersion()),
				nil, "price-watch-shared", poolSize, timeout,
			)
		}
		production := strings.EqualFold(os.Getenv("APP_ENV"), "production") ||
			strings.EqualFold(os.Getenv("NODE_ENV"), "production") ||
			strings.EqualFold(os.Getenv("ENVIRONMENT"), "production")
		// Shared production polling never falls back to the host IP. Direct is
		// available only to local/development installs.
		if !production && mode == priceWatchTransportDirect {
			directPool = e.GetOrCreatePoolSizedWithTimeout(
				nil, domain, "price-watch-direct", nil,
				"price-watch-direct", 1, timeout,
			)
			mode = priceWatchTransportDirect
		} else if !production && mode == priceWatchTransportAuto {
			directPool = e.GetOrCreatePoolSizedWithTimeout(
				nil, domain, "price-watch-direct", nil,
				"price-watch-direct", 1, timeout,
			)
		} else {
			mode = priceWatchTransportProxy
		}
	}

	rateKey, rateLimit := e.priceWatchRatePolicy(target)
	rateLimitedFetch := func(fetchCtx context.Context, client *Client, fetchTarget model.PriceWatchTarget) (PriceWatchPage, error) {
		if retryAfter := e.reservePriceWatchAttempt(rateKey, rateLimit); retryAfter > 0 {
			return PriceWatchPage{}, &PriceWatchFetchError{
				Code: "capacity_limited", RetryAfter: retryAfter,
				Detail: "price watch transport request budget is exhausted",
			}
		}
		return fetchPriceWatchPage(fetchCtx, client, fetchTarget)
	}

	started := time.Now()
	page, err := fetchPriceWatchWithFallbacks(ctx, target, timeout, mode, directPool, pool, rateLimitedFetch)
	duration := time.Since(started)
	statusCode := 200
	errorCode := ""
	if err != nil {
		statusCode = 0
		var fetchErr *PriceWatchFetchError
		if errors.As(err, &fetchErr) {
			statusCode = fetchErr.StatusCode
			errorCode = fetchErr.Code
		}
	}
	telemetryCtx, telemetryCancel := context.WithTimeout(ctx, 2*time.Second)
	_ = e.db.RecordPriceWatchCheck(telemetryCtx, database.PriceWatchCheckSample{
		ScheduleID: target.ID, CheckedAt: checkedAt, Success: err == nil,
		StatusCode: statusCode, DurationMS: int(duration.Milliseconds()), ErrorCode: errorCode,
	})
	telemetryCancel()

	if err != nil {
		var fetchErr *PriceWatchFetchError
		code := "fetch_error"
		detail := "item page fetch failed"
		retryAfter := time.Duration(0)
		if errors.As(err, &fetchErr) {
			code, detail, retryAfter = fetchErr.Code, fetchErr.Detail, fetchErr.RetryAfter
		}
		backoff := priceWatchErrorBackoff(target.ConsecutiveErrors + 1)
		if retryAfter > backoff {
			backoff = retryAfter
		}
		if backoff > 30*time.Minute {
			backoff = 30 * time.Minute
		}
		if recordErr := e.db.RecordPriceWatchError(ctx, target.ID, target.ClaimToken, checkedAt, checkedAt.Add(backoff), code, detail); recordErr != nil {
			log.Printf("price watch schedule=%d region=%s transport=%s record error: %v", target.ID, target.Region, target.TransportKind, recordErr)
		}
		return
	}

	interval := time.Duration(target.PollIntervalSeconds) * time.Second
	nextCheckAt := checkedAt.Add(priceWatchSuccessDelay(target.ID, interval))
	if !page.Available {
		stopped, recordErr := e.db.RecordPriceWatchUnavailable(ctx, target.ID, target.ClaimToken, checkedAt, nextCheckAt, "Vinted item is no longer available")
		if recordErr != nil {
			log.Printf("price watch schedule=%d region=%s record unavailable: %v", target.ID, target.Region, recordErr)
		} else if stopped {
			log.Printf("price watch schedule=%d region=%s stopped after three unavailable checks", target.ID, target.Region)
		}
		return
	}

	eventID, alertCount, applyErr := e.db.ApplyPriceWatchObservation(ctx, databasePriceWatchObservation(target, page, checkedAt, nextCheckAt))
	if applyErr != nil {
		log.Printf("price watch schedule=%d region=%s apply observation: %v", target.ID, target.Region, applyErr)
		return
	}
	if eventID > 0 {
		log.Printf("price watch schedule=%d target=%d region=%s price_drop_event=%d alerts=%d", target.ID, target.TargetID, target.Region, eventID, alertCount)
	}
}

func (e *Engine) priceWatchRatePolicy(target model.PriceWatchTarget) (string, int) {
	if target.TransportKind == "proxy_group" && target.ProxyGroupID != nil {
		limit := target.WorkingProxyCount * int(e.priceWatchPersonalRPM.Load())
		if limit < 1 {
			limit = 1
		}
		if limit > 60 {
			limit = 60
		}
		return fmt.Sprintf("proxy:%d", *target.ProxyGroupID), limit
	}
	limit := int(e.priceWatchSharedMaxRPM.Load())
	if limit < 1 {
		limit = 1
	}
	return "shared", limit
}

func (e *Engine) reservePriceWatchAttempt(key string, limit int) time.Duration {
	now := time.Now().UTC()
	e.priceWatchRateMu.Lock()
	defer e.priceWatchRateMu.Unlock()
	window := e.priceWatchRateWindows[key]
	if window == nil || now.Sub(window.startedAt) >= time.Minute {
		e.priceWatchRateWindows[key] = &priceWatchRateWindow{startedAt: now, attempts: 1}
		return 0
	}
	if window.attempts >= limit {
		return time.Until(window.startedAt.Add(time.Minute))
	}
	window.attempts++
	return 0
}

func fetchPriceWatchWithFallbacks(
	ctx context.Context,
	target model.PriceWatchTarget,
	timeout time.Duration,
	mode priceWatchTransportMode,
	directPool *ClientPool,
	proxyPool *ClientPool,
	fetch priceWatchFetchFunc,
) (PriceWatchPage, error) {
	if fetch == nil {
		return PriceWatchPage{}, &PriceWatchFetchError{Code: "fetcher_unavailable", Detail: "price watch fetcher is unavailable"}
	}
	type transportAttempt struct {
		pool  *ClientPool
		count int
	}
	var attempts []transportAttempt
	switch mode {
	case priceWatchTransportDirect:
		attempts = []transportAttempt{{pool: directPool, count: 1}}
	case priceWatchTransportProxy:
		attempts = []transportAttempt{{pool: proxyPool, count: priceWatchProxyAttempts}}
	default:
		attempts = []transportAttempt{{pool: proxyPool, count: priceWatchProxyAttempts}}
		if directPool != nil {
			attempts = append(attempts, transportAttempt{pool: directPool, count: 1})
		}
	}
	var lastErr error
	for _, candidate := range attempts {
		if candidate.pool == nil {
			continue
		}
		for range candidate.count {
			if err := ctx.Err(); err != nil {
				return PriceWatchPage{}, err
			}
			client := candidate.pool.AcquireRoundRobin()
			if client == nil {
				break
			}
			fetchCtx, cancel := context.WithTimeout(ctx, timeout)
			started := time.Now()
			page, err := fetch(fetchCtx, client, target)
			cancel()
			statusCode := 0
			var fetchErr *PriceWatchFetchError
			if errors.As(err, &fetchErr) {
				statusCode = fetchErr.StatusCode
			}
			if err == nil {
				statusCode = 200
			}
			candidate.pool.Report(client, statusCode, time.Since(started), err)
			if err == nil {
				return page, nil
			}
			lastErr = err
			if !shouldFallbackPriceWatchFetch(err) {
				return PriceWatchPage{}, err
			}
		}
	}
	if lastErr == nil {
		lastErr = &PriceWatchFetchError{Code: "client_pool_unavailable", Detail: "no price watch client is currently available"}
	}
	return PriceWatchPage{}, lastErr
}

func shouldFallbackPriceWatchFetch(err error) bool {
	if err == nil {
		return false
	}
	var fetchErr *PriceWatchFetchError
	if !errors.As(err, &fetchErr) {
		return true
	}
	switch fetchErr.Code {
	case "invalid_item_url", "invalid_redirect", "too_many_redirects", "response_too_large", "capacity_limited":
		return false
	default:
		return true
	}
}

func databasePriceWatchObservation(target model.PriceWatchTarget, page PriceWatchPage, checkedAt time.Time, nextCheckAt time.Time) database.PriceWatchObservation {
	return database.PriceWatchObservation{
		ScheduleID: target.ID, TargetID: target.TargetID, ClaimToken: target.ClaimToken,
		CanonicalURL: page.CanonicalURL, Title: page.Title, ImageURL: page.ImageURL,
		PriceMinor: page.PriceMinor, CurrencyCode: page.CurrencyCode,
		ObservedAt: checkedAt, NextCheckAt: nextCheckAt,
	}
}

func (e *Engine) refreshPriceWatchRuntimeSettings(ctx context.Context) {
	enabled := true
	if raw, ok, err := e.db.GetSettingValueContext(ctx, priceWatchEnabledSettingKey); err == nil && ok {
		if parsed, parseErr := strconv.ParseBool(strings.TrimSpace(raw)); parseErr == nil {
			enabled = parsed
		}
	}
	e.priceWatchEnabled.Store(enabled)
	refreshIntSetting := func(key string, fallback int64, minimum int64, maximum int64) int64 {
		raw, ok, err := e.db.GetSettingValueContext(ctx, key)
		if err != nil || !ok {
			return fallback
		}
		value, err := strconv.ParseInt(strings.TrimSpace(raw), 10, 64)
		if err != nil || value < minimum || value > maximum {
			return fallback
		}
		return value
	}
	e.priceWatchSharedMaxRPM.Store(refreshIntSetting(priceWatchSharedRPMSettingKey, 30, 1, 300))
	e.priceWatchPersonalRPM.Store(refreshIntSetting(priceWatchPersonalRPMSettingKey, 2, 1, 10))
}

func priceWatchSuccessDelay(scheduleID int64, interval time.Duration) time.Duration {
	if interval < minimumPriceWatchInterval || interval > maximumPriceWatchInterval {
		interval = defaultPriceWatchInterval
	}
	maxJitterSeconds := int64(interval / (10 * time.Second))
	if maxJitterSeconds < 1 {
		maxJitterSeconds = 1
	}
	if maxJitterSeconds > 30 {
		maxJitterSeconds = 30
	}
	jitterSeconds := scheduleID * 37 % (maxJitterSeconds + 1)
	if jitterSeconds < 0 {
		jitterSeconds = -jitterSeconds
	}
	return interval + time.Duration(jitterSeconds)*time.Second
}

func priceWatchErrorBackoff(attempt int) time.Duration {
	delays := [...]time.Duration{time.Minute, 2 * time.Minute, 5 * time.Minute, 10 * time.Minute, 20 * time.Minute, 30 * time.Minute}
	if attempt < 1 {
		attempt = 1
	}
	if attempt > len(delays) {
		attempt = len(delays)
	}
	return delays[attempt-1]
}

func minInt(left int, right int) int {
	if left < right {
		return left
	}
	return right
}
