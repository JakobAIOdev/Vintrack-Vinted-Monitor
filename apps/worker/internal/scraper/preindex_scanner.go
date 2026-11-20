package scraper

import (
	"context"
	"fmt"
	"io"
	"log"
	"math/rand"
	"net/url"
	"os"
	"strings"
	"time"

	"vintrack-worker/internal/database"
	"vintrack-worker/internal/model"
	"vintrack-worker/internal/proxy"

	http "github.com/bogdanfinn/fhttp"
)

type PreindexScanner struct {
	db       *database.Store
	freePool *proxy.RegionPools
	region   string
	domain   string
}

type preindexProbeResult struct {
	status   int
	location string
	slug     string
	outcome  string
	err      error
	duration time.Duration
}

func NewPreindexScanner(db *database.Store, freePool *proxy.RegionPools) *PreindexScanner {
	region := strings.ToLower(strings.TrimSpace(os.Getenv("ID_SCANNER_REGION")))
	if region == "" {
		region = "de"
	}
	return &PreindexScanner{
		db: db, freePool: freePool, region: region, domain: model.RegionDomain(region),
	}
}

func (s *PreindexScanner) Run(ctx context.Context) {
	if !strings.EqualFold(strings.TrimSpace(os.Getenv("ID_SCANNER_ENABLED")), "true") {
		log.Println("Pre-index scanner disabled; set ID_SCANNER_ENABLED=true to run the shadow sampler")
		<-ctx.Done()
		return
	}

	stride := int64(getEnvInt("ID_SCANNER_STRIDE", 100))
	if stride < 1 {
		stride = 100
	}
	interval := time.Duration(getEnvInt("ID_SCANNER_INTERVAL_MS", 500)) * time.Millisecond
	if interval < 500*time.Millisecond {
		interval = 500 * time.Millisecond
	}
	jitterMS := getEnvInt("ID_SCANNER_JITTER_MS", 200)
	if jitterMS < 0 {
		jitterMS = 0
	}
	timeout := time.Duration(getEnvInt("ID_SCANNER_TIMEOUT_MS", 2000)) * time.Millisecond
	if timeout < 500*time.Millisecond {
		timeout = 500 * time.Millisecond
	}
	poolSize := getEnvInt("ID_SCANNER_POOL_SIZE", 16)
	configuredProxyOffset := getEnvInt("ID_SCANNER_PROXY_OFFSET", 32)
	stuckSkipAfter := getEnvInt("ID_SCANNER_STUCK_SKIP_AFTER", 10)
	if stuckSkipAfter < 2 {
		stuckSkipAfter = 2
	}
	maxAhead := int64(getEnvInt("ID_SCANNER_MAX_AHEAD", 10000))
	if maxAhead < stride {
		maxAhead = stride
	}

	pm := s.freePool.Manager(s.region)
	for pm.Count() < 2 {
		log.Printf("[preindex:%s] waiting for at least two ready free proxies (have %d)", s.region, pm.Count())
		if !waitWithContext(ctx, 30*time.Second) {
			return
		}
	}
	proxyOffset := clampPreindexProxyOffset(pm.Count(), poolSize, configuredProxyOffset)
	for index := 0; index < proxyOffset; index++ {
		pm.Next()
	}
	pool := NewClientPoolWithTimeout(pm, s.domain, poolSize, nil, timeout)
	var seed int64
	for seed <= 0 {
		var err error
		seed, err = s.db.LatestPreindexSeed(s.region)
		if err != nil {
			log.Printf("[preindex:%s] seed load failed: %v", s.region, err)
		} else if seed <= 0 {
			log.Printf("[preindex:%s] no catalog seed available; waiting for monitor detections", s.region)
		}
		if seed <= 0 && !waitWithContext(ctx, 30*time.Second) {
			return
		}
	}

	nextID := nextPreindexSampleID(seed, stride)
	probes := 0
	hits := 0
	misses := 0
	attemptsOnCandidate := 0
	consecutiveBlocks := 0
	log.Printf("[preindex:%s] shadow sampler started | seed=%d | next=%d | stride=%d | interval=%s+0..%dms | clients=%d | proxy_offset=%d | timeout=%s", s.region, seed, nextID, stride, interval, jitterMS, pool.Size(), proxyOffset, timeout)

	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		latestCatalogID, latestErr := s.db.LatestDetectedItemID(s.region)
		if latestErr == nil && latestCatalogID > nextID {
			nextID = nextPreindexSampleID(latestCatalogID, stride)
			attemptsOnCandidate = 0
		}
		if latestErr == nil && latestCatalogID > 0 && nextID > latestCatalogID+maxAhead {
			if !s.sleepCycle(ctx, interval, jitterMS, 0) {
				return
			}
			continue
		}

		client := pool.AcquireRoundRobin()
		if client == nil {
			consecutiveBlocks++
			if !s.sleepCycle(ctx, interval, jitterMS, preindexBlockBackoff(consecutiveBlocks)) {
				return
			}
			continue
		}

		probeCtx, cancel := context.WithTimeout(ctx, timeout)
		result := probeBareItemID(probeCtx, client, s.domain, nextID)
		cancel()
		healthStatus := result.status
		if result.outcome == "hit" || result.outcome == "miss" {
			healthStatus = 200
		}
		pool.Report(client, healthStatus, result.duration, result.err)
		probes++
		if err := s.db.RecordPreindexProbe(database.PreindexProbe{
			Region: s.region, ItemID: nextID, StatusCode: result.status,
			DurationMS: int(result.duration.Milliseconds()), Outcome: result.outcome,
			ProxySource: client.ProxyLabel(),
		}); err != nil {
			log.Printf("[preindex:%s] probe telemetry failed: %v", s.region, err)
		}

		extraBackoff := time.Duration(0)
		switch result.outcome {
		case "hit":
			hits++
			attemptsOnCandidate = 0
			consecutiveBlocks = 0
			seenAt := time.Now()
			if err := s.db.RecordPreindexSample(s.region, nextID, result.slug, seenAt, client.ProxyLabel()); err != nil {
				log.Printf("[preindex:%s] sample %d save failed: %v", s.region, nextID, err)
			} else if hits <= 10 || hits%25 == 0 {
				log.Printf("[preindex:%s] HIT id=%d slug=%q via=%s duration=%s", s.region, nextID, result.slug, client.ProxyLabel(), result.duration.Round(time.Millisecond))
			}
			nextID = nextPreindexSampleID(nextID, stride)
		case "miss":
			misses++
			consecutiveBlocks = 0
		case "blocked":
			consecutiveBlocks++
			extraBackoff = preindexBlockBackoff(consecutiveBlocks)
		case "error":
			consecutiveBlocks++
			extraBackoff = minDuration(5*time.Second, preindexBlockBackoff(consecutiveBlocks))
		default:
			consecutiveBlocks = 0
			extraBackoff = 2 * time.Second
		}
		var advanceCandidate bool
		attemptsOnCandidate, advanceCandidate = recordPreindexCandidateAttempt(
			result.outcome,
			attemptsOnCandidate,
			stuckSkipAfter,
		)
		if advanceCandidate {
			nextID = nextPreindexSampleID(nextID, stride)
		}

		if probes%100 == 0 {
			log.Printf("[preindex:%s] probes=%d hits=%d misses=%d next=%d pool=%d", s.region, probes, hits, misses, nextID, pool.Size())
		}
		if !s.sleepCycle(ctx, interval, jitterMS, extraBackoff) {
			return
		}
	}
}

func (s *PreindexScanner) sleepCycle(ctx context.Context, interval time.Duration, jitterMS int, extra time.Duration) bool {
	jitter := time.Duration(0)
	if jitterMS > 0 {
		jitter = time.Duration(rand.Intn(jitterMS+1)) * time.Millisecond
	}
	return waitWithContext(ctx, interval+jitter+extra)
}

func probeBareItemID(ctx context.Context, client *Client, domain string, itemID int64) preindexProbeResult {
	startedAt := time.Now()
	targetURL := fmt.Sprintf("https://%s/items/%d", domain, itemID)
	req, err := http.NewRequestWithContext(ctx, "GET", targetURL, nil)
	if err != nil {
		return preindexProbeResult{outcome: "error", err: err, duration: time.Since(startedAt)}
	}
	req.Header = newWarmupHeaders(domain)
	req.Header.Set("Cache-Control", "no-cache")
	req.Header.Set("Pragma", "no-cache")

	resp, err := client.do(req)
	if err != nil {
		client.FlushTrackedTraffic()
		return preindexProbeResult{outcome: "error", err: err, duration: time.Since(startedAt)}
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 8*1024))
	resp.Body.Close()
	client.FlushTrackedTraffic()

	result := preindexProbeResult{
		status: resp.StatusCode, location: resp.Header.Get("Location"), duration: time.Since(startedAt),
	}
	result.outcome, result.slug = classifyPreindexResponse(resp.StatusCode, result.location, itemID)
	if result.outcome == "error" {
		result.err = fmt.Errorf("item probe returned %d", resp.StatusCode)
	}
	return result
}

func classifyPreindexResponse(status int, location string, itemID int64) (string, string) {
	switch status {
	case 200:
		// The bare item route normally redirects to its canonical slug. A 200 can
		// be an intermediary challenge page, so it is not identity evidence.
		return "unexpected", ""
	case 301, 302, 303, 307, 308:
		slug := itemSlugFromRedirect(location, itemID)
		if slug != "" {
			return "hit", slug
		}
		return "unexpected", ""
	case 404, 410:
		return "miss", ""
	case 401, 403, 407, 429:
		return "blocked", ""
	default:
		if status >= 500 {
			return "error", ""
		}
		return "unexpected", ""
	}
}

func itemSlugFromRedirect(rawLocation string, itemID int64) string {
	parsed, err := url.Parse(strings.TrimSpace(rawLocation))
	if err != nil {
		return ""
	}
	prefix := fmt.Sprintf("/items/%d-", itemID)
	if !strings.HasPrefix(parsed.Path, prefix) {
		return ""
	}
	return strings.TrimPrefix(parsed.Path, prefix)
}

func nextPreindexSampleID(seed int64, stride int64) int64 {
	if stride < 1 {
		stride = 1
	}
	if seed < 0 {
		seed = 0
	}
	block := seed/stride + 1
	offset := int64(mixPreindexBlock(uint64(block)) % uint64(stride))
	return block*stride + offset
}

func mixPreindexBlock(value uint64) uint64 {
	value ^= value >> 30
	value *= 0xbf58476d1ce4e5b9
	value ^= value >> 27
	value *= 0x94d049bb133111eb
	return value ^ (value >> 31)
}

func clampPreindexProxyOffset(proxyCount int, poolSize int, configured int) int {
	if configured < 0 || proxyCount <= 0 {
		return 0
	}
	if poolSize < 1 {
		poolSize = 1
	}
	maxOffset := proxyCount - min(poolSize, proxyCount)
	return min(configured, maxOffset)
}

func recordPreindexCandidateAttempt(outcome string, attempts int, limit int) (int, bool) {
	if outcome == "hit" {
		return 0, false
	}
	if limit < 1 {
		limit = 1
	}
	attempts++
	if attempts >= limit {
		return 0, true
	}
	return attempts, false
}

func preindexBlockBackoff(consecutive int) time.Duration {
	// A single blocked proxy is already cooled down by ClientPool. Only slow the
	// whole scanner when different sessions fail consecutively.
	if consecutive < 2 {
		return 0
	}
	backoff := time.Duration(1<<min(consecutive-2, 6)) * time.Second
	if backoff > 60*time.Second {
		return 60 * time.Second
	}
	return backoff
}

func minDuration(a time.Duration, b time.Duration) time.Duration {
	if a < b {
		return a
	}
	return b
}

func waitWithContext(ctx context.Context, duration time.Duration) bool {
	if duration <= 0 {
		return true
	}
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-timer.C:
		return true
	case <-ctx.Done():
		return false
	}
}
