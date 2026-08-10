package database

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"vintrack-worker/internal/cache"
	"vintrack-worker/internal/model"

	"github.com/lib/pq"
)

type Store struct {
	db             *sql.DB
	connString     string
	cache          *cache.RedisCache
	healthErrLog   map[int]time.Time
	healthErrLogMu sync.Mutex
	trafficMu      sync.Mutex
	trafficTotals  map[int]proxyGroupBandwidthDelta
	trafficUsage   map[int]proxyGroupBandwidthState
	trafficStop    chan struct{}
	trafficDone    chan struct{}
	telemetryCh    chan telemetryEvent
	telemetryStop  chan struct{}
	telemetryDone  chan struct{}
}

type telemetryEvent struct {
	kind       string
	run        model.MonitorRun
	detection  model.MonitorItemDetection
	monitorID  int
	itemID     int64
	occurredAt time.Time
}

const (
	defaultMonitorRunRetentionHours       = 24
	defaultMonitorRunStatsRetentionDays   = 90
	monitorRunPruneBatchSize              = 10_000
	monitorRunPruneMaximumBatchesPerCycle = 100
	freeProxyMaintainerAdvisoryLockKey    = int64(8_670_505_012_026)
)

type proxyGroupBandwidthDelta struct {
	txBytes int64
	rxBytes int64
}

type proxyGroupBandwidthState struct {
	txBytes int64
	rxBytes int64
	resetAt time.Time
}

type FreeProxyCandidate struct {
	ProxyURL string
	Region   string
	Protocol string
	Source   string
	Proven   bool
}

type FreeProxyRecord struct {
	ProxyURL string
	Protocol string
	Host     string
	Port     int
	Source   string
	Sources  []string
}

type FreeProxyInventoryRecord struct {
	ProxyURL     string
	Source       string
	Protocol     string
	Host         string
	Port         int
	SuccessCount int
	LastChecked  *time.Time
}

type ProxyGroupCheckJob struct {
	ID      int
	Proxies string
	Region  string
	Total   int
}

type ProxyGroupCheckResult struct {
	Index     int     `json:"index"`
	Label     string  `json:"label"`
	Status    string  `json:"status"`
	LatencyMS *int    `json:"latencyMs"`
	ErrorCode *string `json:"errorCode"`
}

type PreindexProbe struct {
	Region      string
	ItemID      int64
	StatusCode  int
	DurationMS  int
	Outcome     string
	ProxySource string
}

func (s *Store) ClaimProxyGroupCheckJobContext(ctx context.Context, maximumSize int) (*ProxyGroupCheckJob, error) {
	if maximumSize < 1 {
		maximumSize = 100
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	var job ProxyGroupCheckJob
	err = tx.QueryRowContext(ctx, `
		WITH candidate AS (
			SELECT id
			FROM proxy_groups
			WHERE proxy_check_status = 'pending'
			   OR (
				proxy_check_status = 'running'
				AND proxy_check_started_at < NOW() - INTERVAL '3 minutes'
			   )
			ORDER BY
				CASE WHEN proxy_check_status = 'pending' THEN 0 ELSE 1 END,
				proxy_check_requested_at ASC NULLS FIRST
			LIMIT 1
			FOR UPDATE SKIP LOCKED
		)
		UPDATE proxy_groups pg
		SET proxy_check_status = 'running',
			proxy_check_total = LEAST(pg.proxy_check_total, $1),
			proxy_check_checked = 0,
			proxy_check_working = 0,
			proxy_check_slow = 0,
			proxy_check_failed = 0,
			proxy_check_results = NULL,
			proxy_check_error = NULL,
			proxy_check_started_at = NOW(),
			proxy_check_completed_at = NULL
		FROM candidate
		WHERE pg.id = candidate.id
		RETURNING
			pg.id,
			pg.proxies,
			COALESCE(pg.proxy_check_region, 'de'),
			pg.proxy_check_total`,
		maximumSize,
	).Scan(&job.ID, &job.Proxies, &job.Region, &job.Total)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return &job, nil
}

func (s *Store) UpdateProxyGroupCheckProgressContext(
	ctx context.Context,
	id int,
	total int,
	checked int,
	working int,
	slow int,
	failed int,
) error {
	_, err := s.db.ExecContext(ctx, `
		UPDATE proxy_groups
		SET proxy_check_total = $2,
			proxy_check_checked = $3,
			proxy_check_working = $4,
			proxy_check_slow = $5,
			proxy_check_failed = $6
		WHERE id = $1
		  AND proxy_check_status = 'running'`,
		id,
		total,
		checked,
		working,
		slow,
		failed,
	)
	return err
}

func (s *Store) CompleteProxyGroupCheckJobContext(
	ctx context.Context,
	id int,
	total int,
	working int,
	slow int,
	failed int,
	results []ProxyGroupCheckResult,
) error {
	encodedResults, err := json.Marshal(results)
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, `
		UPDATE proxy_groups
		SET proxy_check_status = 'completed',
			proxy_check_total = $2,
			proxy_check_checked = $2,
			proxy_check_working = $3,
			proxy_check_slow = $4,
			proxy_check_failed = $5,
			proxy_check_results = $6::jsonb,
			proxy_check_error = NULL,
			proxy_check_completed_at = NOW()
		WHERE id = $1
		  AND proxy_check_status = 'running'`,
		id,
		total,
		working,
		slow,
		failed,
		string(encodedResults),
	)
	return err
}

func (s *Store) FailProxyGroupCheckJobContext(ctx context.Context, id int, message string) error {
	if len(message) > 1000 {
		message = message[:1000]
	}
	_, err := s.db.ExecContext(ctx, `
		UPDATE proxy_groups
		SET proxy_check_status = 'failed',
			proxy_check_error = $2,
			proxy_check_completed_at = NOW()
		WHERE id = $1
		  AND proxy_check_status = 'running'`,
		id,
		message,
	)
	return err
}

func NewStore(connStr string, redisCache *cache.RedisCache) (*Store, error) {
	db, err := sql.Open("postgres", connStr)
	if err != nil {
		return nil, fmt.Errorf("sql open: %w", err)
	}

	if err := db.Ping(); err != nil {
		return nil, fmt.Errorf("db ping: %w", err)
	}

	maxConns := runtime.NumCPU() * 4
	db.SetMaxOpenConns(maxConns)
	db.SetMaxIdleConns(maxConns / 2)
	db.SetConnMaxLifetime(10 * time.Minute)
	db.SetConnMaxIdleTime(5 * time.Minute)

	log.Printf("PostgreSQL connected (pool: %d max, %d idle)", maxConns, maxConns/2)

	store := &Store{
		db:            db,
		connString:    connStr,
		cache:         redisCache,
		healthErrLog:  make(map[int]time.Time),
		trafficTotals: make(map[int]proxyGroupBandwidthDelta),
		trafficUsage:  make(map[int]proxyGroupBandwidthState),
		trafficStop:   make(chan struct{}),
		trafficDone:   make(chan struct{}),
		telemetryCh:   make(chan telemetryEvent, 4096),
		telemetryStop: make(chan struct{}),
		telemetryDone: make(chan struct{}),
	}

	go store.bandwidthFlushLoop()
	go store.telemetryFlushLoop()

	return store, nil
}

// TryAcquireFreeProxyMaintainerLease ensures that only one maintainer process
// validates the shared inventory at a time. The advisory lock lives on a
// dedicated PostgreSQL connection and is released automatically if the process
// or connection disappears.
func (s *Store) TryAcquireFreeProxyMaintainerLeaseContext(
	ctx context.Context,
) (release func(), acquired bool, err error) {
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return nil, false, err
	}

	if err := conn.QueryRowContext(
		ctx,
		`SELECT pg_try_advisory_lock($1)`,
		freeProxyMaintainerAdvisoryLockKey,
	).Scan(&acquired); err != nil {
		_ = conn.Close()
		return nil, false, err
	}
	if !acquired {
		_ = conn.Close()
		return nil, false, nil
	}

	var once sync.Once
	release = func() {
		once.Do(func() {
			releaseCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_, _ = conn.ExecContext(
				releaseCtx,
				`SELECT pg_advisory_unlock($1)`,
				freeProxyMaintainerAdvisoryLockKey,
			)
			_ = conn.Close()
		})
	}
	return release, true, nil
}

func (s *Store) BatchIsNew(monitorID int, itemIDs []int64) map[int64]bool {
	if s.cache != nil {
		result, err := s.cache.BatchIsNew(monitorID, itemIDs)
		if err == nil {
			return result
		}
		log.Printf("redis batch check error: %v, falling back to DB", err)
	}

	result := make(map[int64]bool, len(itemIDs))
	for _, id := range itemIDs {
		result[id] = true
	}

	if len(itemIDs) == 0 {
		return result
	}

	args := make([]interface{}, len(itemIDs)+1)
	args[0] = monitorID
	placeholders := make([]string, len(itemIDs))
	for i, id := range itemIDs {
		args[i+1] = id
		placeholders[i] = fmt.Sprintf("$%d", i+2)
	}
	query := fmt.Sprintf("SELECT id FROM items WHERE monitor_id = $1 AND id IN (%s)", strings.Join(placeholders, ","))
	rows, err := s.db.Query(query, args...)
	if err != nil {
		log.Printf("db BatchIsNew query error: %v", err)
		return result
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err == nil {
			result[id] = false
		}
	}
	return result
}

func (s *Store) ClaimMonitorItem(monitorID int, itemID int64, source string) bool {
	if monitorID <= 0 || itemID <= 0 {
		return false
	}
	if s.cache != nil {
		claimed, err := s.cache.ClaimMonitorItem(monitorID, itemID, source)
		if err == nil {
			return claimed
		}
		log.Printf("redis monitor item claim failed for %d:%d: %v", monitorID, itemID, err)
	}

	if strings.TrimSpace(source) == "" {
		source = "canonical"
	}
	var claimedItemID int64
	err := s.db.QueryRow(`
		INSERT INTO monitor_item_detections (
			monitor_id, item_id, first_source, early_seen_at, canonical_seen_at, updated_at
		)
		SELECT
			$1, $2, $3,
			CASE WHEN $3 = 'discovery' THEN NOW() END,
			CASE WHEN $3 <> 'discovery' THEN NOW() END,
			NOW()
		WHERE NOT EXISTS (
			SELECT 1 FROM items WHERE monitor_id = $1 AND id = $2
		)
		ON CONFLICT (monitor_id, item_id) DO NOTHING
		RETURNING item_id`, monitorID, itemID, source).Scan(&claimedItemID)
	if err == sql.ErrNoRows {
		return false
	}
	if err != nil {
		log.Printf("db monitor item claim fallback failed for %d:%d: %v", monitorID, itemID, err)
		var exists bool
		if fallbackErr := s.db.QueryRow(
			`SELECT EXISTS(SELECT 1 FROM items WHERE monitor_id = $1 AND id = $2)`,
			monitorID,
			itemID,
		).Scan(&exists); fallbackErr == nil {
			return !exists
		}
		return true
	}
	return claimedItemID == itemID
}

func (s *Store) LatestPreindexSeed(region string) (int64, error) {
	var seed int64
	err := s.db.QueryRow(`
		SELECT GREATEST(
			COALESCE((
				SELECT MAX(item_id)
				FROM item_preindex_samples
				WHERE region = $1
			), 0),
			COALESCE((
				SELECT MAX(mid.item_id)
				FROM monitor_item_detections mid
				JOIN monitors m ON m.id = mid.monitor_id
				WHERE m.region = $1
			), 0)
		)`, region).Scan(&seed)
	return seed, err
}

func (s *Store) LatestDetectedItemID(region string) (int64, error) {
	var itemID int64
	err := s.db.QueryRow(`
		SELECT COALESCE(MAX(mid.item_id), 0)
		FROM monitor_item_detections mid
		JOIN monitors m ON m.id = mid.monitor_id
		WHERE m.region = $1`, region).Scan(&itemID)
	return itemID, err
}

func (s *Store) RecordPreindexSample(region string, itemID int64, slug string, seenAt time.Time, proxySource string) error {
	if region == "" || itemID <= 0 {
		return nil
	}
	if seenAt.IsZero() {
		seenAt = time.Now()
	}
	_, err := s.db.Exec(`
		INSERT INTO item_preindex_samples (
			region, item_id, slug, first_seen_at, proxy_source, updated_at
		)
		VALUES ($1, $2, NULLIF($3, ''), $4, NULLIF($5, ''), NOW())
		ON CONFLICT (region, item_id) DO UPDATE SET
			first_seen_at = LEAST(item_preindex_samples.first_seen_at, EXCLUDED.first_seen_at),
			slug = COALESCE(item_preindex_samples.slug, EXCLUDED.slug),
			proxy_source = COALESCE(item_preindex_samples.proxy_source, EXCLUDED.proxy_source),
			updated_at = NOW()`, region, itemID, slug, seenAt, proxySource)
	return err
}

func (s *Store) RecordPreindexProbe(probe PreindexProbe) error {
	if probe.Region == "" || probe.ItemID <= 0 || probe.Outcome == "" {
		return nil
	}
	_, err := s.db.Exec(`
		INSERT INTO preindex_probe_runs (
			region, item_id, status_code, duration_ms, outcome, proxy_source
		)
		VALUES ($1, $2, NULLIF($3, 0), NULLIF($4, 0), $5, NULLIF($6, ''))`,
		probe.Region, probe.ItemID, probe.StatusCode, probe.DurationMS, probe.Outcome, probe.ProxySource)
	return err
}

func (s *Store) PrunePreindexTelemetry(probeRetentionHours int, sampleRetentionDays int) {
	if probeRetentionHours < 1 {
		probeRetentionHours = 48
	}
	if sampleRetentionDays < 1 {
		sampleRetentionDays = 14
	}
	if _, err := s.db.Exec(
		`DELETE FROM preindex_probe_runs WHERE checked_at < NOW() - ($1::text || ' hours')::interval`,
		probeRetentionHours,
	); err != nil {
		log.Printf("preindex probe cleanup failed: %v", err)
	}
	if _, err := s.db.Exec(
		`DELETE FROM item_preindex_samples WHERE first_seen_at < NOW() - ($1::text || ' days')::interval`,
		sampleRetentionDays,
	); err != nil {
		log.Printf("preindex sample cleanup failed: %v", err)
	}
}

func (s *Store) GetUserRegion(userID int64) (string, bool) {
	return s.GetUserRegionContext(context.Background(), userID)
}

func (s *Store) GetUserRegionContext(ctx context.Context, userID int64) (string, bool) {
	if s.cache != nil {
		return s.cache.GetUserRegionContext(ctx, userID)
	}
	return "", false
}

func (s *Store) SetUserRegion(userID int64, region string) {
	if s.cache != nil {
		s.cache.SetUserRegion(userID, region)
	}
}

func (s *Store) GetSellerInfoCache(ctx context.Context, domain string, userID int64) (cache.SellerInfo, bool) {
	if s.cache == nil {
		return cache.SellerInfo{}, false
	}
	return s.cache.GetSellerInfo(ctx, domain, userID)
}

func (s *Store) SetSellerInfoCache(ctx context.Context, domain string, userID int64, info cache.SellerInfo, ttl time.Duration) error {
	if s.cache == nil {
		return nil
	}
	return s.cache.SetSellerInfo(ctx, domain, userID, info, ttl)
}

func (s *Store) GetSettingValue(key string) (string, bool, error) {
	return s.GetSettingValueContext(context.Background(), key)
}

func (s *Store) GetSettingValueContext(ctx context.Context, key string) (string, bool, error) {
	var value string
	err := s.db.QueryRowContext(ctx, `SELECT value FROM app_settings WHERE key = $1`, key).Scan(&value)
	if err == sql.ErrNoRows {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return value, true, nil
}

func (s *Store) SetSettingValueContext(ctx context.Context, key string, value string) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO app_settings (key, value, updated_at)
		VALUES ($1, $2, NOW())
		ON CONFLICT (key) DO UPDATE
		SET value = EXCLUDED.value,
			updated_at = NOW()`, key, value)
	return err
}

func (s *Store) FreeProxyEgressLimitedContext(ctx context.Context) (bool, error) {
	var limited bool
	err := s.db.QueryRowContext(ctx, `
		SELECT
			COUNT(*) >= 100
			AND COUNT(*) FILTER (
				WHERE last_status_code = 200
				  AND last_error IS NULL
			) * 100 <= COUNT(*)
			AND COUNT(*) FILTER (
				WHERE last_error_stage = 'warmup'
				  AND last_error_code IN (
					'connect',
					'timeout',
					'tls',
					'proxy_handshake',
					'transport'
				  )
			) * 100 >= COUNT(*) * 80
		FROM free_proxy_health
		WHERE last_checked_at >= NOW() - INTERVAL '15 minutes'`).Scan(&limited)
	return limited, err
}

func (s *Store) GetActiveFreeProxyRegions() ([]string, error) {
	return s.GetActiveFreeProxyRegionsContext(context.Background())
}

func (s *Store) GetActiveFreeProxyRegionsContext(ctx context.Context) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT DISTINCT region
		FROM monitors
		WHERE status = 'active'
		  AND proxy_source = 'free'
		ORDER BY region`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var regions []string
	for rows.Next() {
		var region string
		if err := rows.Scan(&region); err != nil {
			return nil, err
		}
		regions = append(regions, region)
	}
	return regions, rows.Err()
}

func (s *Store) GetFreeProxyRegionDemandContext(ctx context.Context) (map[string]int, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT region, COUNT(*)
		FROM monitors
		WHERE status = 'active'
		  AND proxy_source = 'free'
		GROUP BY region`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	demand := make(map[string]int)
	for rows.Next() {
		var region string
		var count int
		if err := rows.Scan(&region, &count); err != nil {
			return nil, err
		}
		demand[region] = count
	}
	return demand, rows.Err()
}

func (s *Store) GetActiveFreeProxies(region string, limit int) ([]string, error) {
	return s.GetActiveFreeProxiesContext(context.Background(), region, limit)
}

func (s *Store) GetActiveFreeProxiesContext(ctx context.Context, region string, limit int) ([]string, error) {
	if limit <= 0 {
		limit = 500
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT fp.proxy_url
		FROM free_proxy_health fph
		JOIN free_proxies fp ON fp.id = fph.proxy_id
		WHERE fph.region = $1
		  AND (
			(
				(
					fph.status = 'active'
					OR (fph.status = 'pending' AND fph.success_streak > 0)
					OR (
						fph.status = 'cooldown'
						AND fph.success_count > 0
						AND fph.failure_streak <= 2
					)
				)
				AND fph.last_success_at >= NOW() - INTERVAL '20 minutes'
			)
			OR (
				(
					fph.status = 'active'
					OR (
						fph.status = 'cooldown'
						AND fph.success_count > 0
					)
				)
				AND fph.failure_streak <= 2
				AND fph.last_success_at >= NOW() - INTERVAL '90 minutes'
			)
		  )
		  AND fp.status <> 'disabled'
		  AND (
			fp.success_count > 0
			OR fp.quarantined_until IS NULL
			OR fp.quarantined_until <= NOW()
		  )
		ORDER BY
		  CASE
			WHEN fph.last_success_at >= NOW() - INTERVAL '20 minutes' THEN 0
			ELSE 1
		  END,
		  fph.failure_streak ASC,
		  fph.score DESC,
		  fph.latency_ms ASC NULLS LAST,
		  fph.last_success_at DESC NULLS LAST
		LIMIT $2`, region, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var proxies []string
	for rows.Next() {
		var proxyURL string
		if err := rows.Scan(&proxyURL); err != nil {
			return nil, err
		}
		proxies = append(proxies, proxyURL)
	}
	return proxies, rows.Err()
}

func (s *Store) GetFreeProxyURLSet() (map[string]struct{}, error) {
	return s.GetFreeProxyURLSetContext(context.Background())
}

func (s *Store) GetFreeProxyURLSetContext(ctx context.Context) (map[string]struct{}, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT proxy_url FROM free_proxies`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	proxyURLs := make(map[string]struct{})
	for rows.Next() {
		var proxyURL string
		if err := rows.Scan(&proxyURL); err != nil {
			return nil, err
		}
		proxyURLs[proxyURL] = struct{}{}
	}
	return proxyURLs, rows.Err()
}

func (s *Store) GetFreeProxyImportInventoryContext(ctx context.Context) (map[string]FreeProxyInventoryRecord, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT proxy_url, source, protocol, host, port, success_count, last_checked_at
		FROM free_proxies`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	inventory := make(map[string]FreeProxyInventoryRecord)
	for rows.Next() {
		var record FreeProxyInventoryRecord
		if err := rows.Scan(
			&record.ProxyURL,
			&record.Source,
			&record.Protocol,
			&record.Host,
			&record.Port,
			&record.SuccessCount,
			&record.LastChecked,
		); err != nil {
			return nil, err
		}
		inventory[record.ProxyURL] = record
	}
	return inventory, rows.Err()
}

func (s *Store) UpsertFreeProxies(proxies []FreeProxyRecord) (int, error) {
	return s.UpsertFreeProxiesContext(context.Background(), proxies)
}

func (s *Store) TouchFreeProxiesSeenContext(ctx context.Context, proxyURLs []string) error {
	const batchSize = 1000
	for offset := 0; offset < len(proxyURLs); offset += batchSize {
		end := min(offset+batchSize, len(proxyURLs))
		if _, err := s.db.ExecContext(ctx, `
			UPDATE free_proxies
			SET last_seen_at = NOW()
			WHERE proxy_url = ANY($1)`, pq.Array(proxyURLs[offset:end])); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) UpsertFreeProxiesContext(ctx context.Context, proxies []FreeProxyRecord) (int, error) {
	const batchSize = 500
	processed := 0

	for offset := 0; offset < len(proxies); offset += batchSize {
		end := min(offset+batchSize, len(proxies))
		batch := proxies[offset:end]
		args := make([]any, 0, len(batch)*6)
		proxyURLs := make([]string, 0, len(batch))
		var query strings.Builder
		query.WriteString(`
			INSERT INTO free_proxies (
				proxy_url, protocol, host, port, source, sources, status, failure_count,
				last_error, last_error_code, quarantined_until, last_seen_at, updated_at
			)
			VALUES `)

		for index, proxy := range batch {
			if index > 0 {
				query.WriteString(", ")
			}
			placeholder := index*6 + 1
			fmt.Fprintf(
				&query,
				"($%d, $%d, $%d, $%d, $%d, $%d, 'pending', 0, NULL, NULL, NULL, NOW(), NOW())",
				placeholder,
				placeholder+1,
				placeholder+2,
				placeholder+3,
				placeholder+4,
				placeholder+5,
			)
			sources := proxy.Sources
			if len(sources) == 0 {
				sources = []string{proxy.Source}
			}
			args = append(args, proxy.ProxyURL, proxy.Protocol, proxy.Host, proxy.Port, proxy.Source, pq.Array(sources))
			proxyURLs = append(proxyURLs, proxy.ProxyURL)
		}

		query.WriteString(`
			ON CONFLICT (proxy_url) DO UPDATE
			SET protocol = EXCLUDED.protocol,
				host = EXCLUDED.host,
				port = EXCLUDED.port,
				source = CASE
					WHEN free_proxies.source = 'manual' THEN free_proxies.source
					ELSE EXCLUDED.source
				END,
				sources = ARRAY(
					SELECT DISTINCT source_name
					FROM unnest(free_proxies.sources || EXCLUDED.sources) AS source_rows(source_name)
					WHERE source_name <> ''
				),
				status = CASE
					WHEN free_proxies.status = 'disabled'
					  AND (
						EXCLUDED.source LIKE 'iplocate%'
						OR EXCLUDED.source IN ('proxyscrape', 'proxifly', 'monosans')
						OR EXCLUDED.source LIKE 'databay%'
					  )
					  AND (
						free_proxies.last_error LIKE 'invalid config:%'
						OR free_proxies.last_checked_at IS NULL
						OR free_proxies.last_checked_at < NOW() - INTERVAL '6 hours'
					  )
					THEN 'pending'
					ELSE free_proxies.status
				END,
				last_error = CASE
					WHEN free_proxies.status = 'disabled'
					  AND (
						EXCLUDED.source LIKE 'iplocate%'
						OR EXCLUDED.source IN ('proxyscrape', 'proxifly', 'monosans')
						OR EXCLUDED.source LIKE 'databay%'
					  )
					  AND (
						free_proxies.last_error LIKE 'invalid config:%'
						OR free_proxies.last_checked_at IS NULL
						OR free_proxies.last_checked_at < NOW() - INTERVAL '6 hours'
					  )
					THEN NULL
					ELSE free_proxies.last_error
				END,
				last_error_code = CASE
					WHEN free_proxies.status = 'disabled'
					  AND (
						free_proxies.last_checked_at IS NULL
						OR free_proxies.last_checked_at < NOW() - INTERVAL '6 hours'
					  )
					THEN NULL
					ELSE free_proxies.last_error_code
				END,
				last_seen_at = NOW(),
				updated_at = NOW()`)

		tx, err := s.db.BeginTx(ctx, nil)
		if err != nil {
			return processed, err
		}
		result, err := tx.ExecContext(ctx, query.String(), args...)
		if err != nil {
			_ = tx.Rollback()
			return processed, err
		}
		if _, err := tx.ExecContext(ctx, `
			UPDATE free_proxy_health fph
			SET status = 'pending',
				failure_streak = 0,
				last_error = NULL,
				next_check_at = NOW(),
				updated_at = NOW()
			FROM free_proxies fp
			WHERE fp.id = fph.proxy_id
			  AND fp.proxy_url = ANY($1)
			  AND (
				fp.source LIKE 'iplocate%'
				OR fp.source IN ('proxyscrape', 'proxifly', 'monosans')
				OR fp.source LIKE 'databay%'
			  )
			  AND (
				(fph.status IN ('dead', 'cooldown') AND fph.last_error LIKE 'invalid config:%')
				OR (
					fph.status = 'dead'
					AND (fph.last_checked_at IS NULL OR fph.last_checked_at < NOW() - INTERVAL '6 hours')
				)
			  )`, pq.Array(proxyURLs)); err != nil {
			_ = tx.Rollback()
			return processed, err
		}
		if err := tx.Commit(); err != nil {
			return processed, err
		}

		rowsAffected, err := result.RowsAffected()
		if err != nil {
			return processed, err
		}
		processed += int(rowsAffected)
	}

	return processed, nil
}

func (s *Store) UpsertFreeProxy(proxyURL string, protocol string, host string, port int, source string) error {
	_, err := s.UpsertFreeProxies([]FreeProxyRecord{{
		ProxyURL: proxyURL,
		Protocol: protocol,
		Host:     host,
		Port:     port,
		Source:   source,
	}})
	return err
}

func (s *Store) PruneUnselectedFreeProxies(keepProxyURLs []string) (int64, error) {
	return s.PruneUnselectedFreeProxiesContext(context.Background(), keepProxyURLs)
}

func (s *Store) PruneUnselectedFreeProxiesContext(ctx context.Context, keepProxyURLs []string) (int64, error) {
	if len(keepProxyURLs) == 0 {
		return 0, nil
	}
	result, err := s.db.ExecContext(ctx, `
		DELETE FROM free_proxies fp
		WHERE (
				fp.source LIKE 'iplocate%'
				OR fp.source IN ('proxyscrape', 'proxifly', 'monosans')
				OR fp.source LIKE 'databay%'
		  )
		  AND NOT (fp.proxy_url = ANY($1))
		  AND fp.success_count = 0
		  AND fp.last_checked_at IS NOT NULL
		  AND fp.last_seen_at < NOW() - INTERVAL '24 hours'
		  AND NOT EXISTS (
			SELECT 1
			FROM free_proxy_health fph
			WHERE fph.proxy_id = fp.id
			  AND fph.last_success_at IS NOT NULL
		  )`, pq.Array(keepProxyURLs))
	if err != nil {
		return 0, err
	}
	return result.RowsAffected()
}

func (s *Store) EnsureFreeProxyHealthRows(regions []string, limit int) error {
	return s.EnsureFreeProxyHealthRowsContext(context.Background(), regions, limit)
}

func (s *Store) EnsureFreeProxyHealthRowsContext(ctx context.Context, regions []string, limit int) error {
	limits := make(map[string]int, len(regions))
	for _, region := range regions {
		limits[region] = limit
	}
	return s.EnsureFreeProxyHealthRowsWithLimitsContext(ctx, limits)
}

func (s *Store) EnsureFreeProxyHealthRowsWithLimitsContext(ctx context.Context, limits map[string]int) error {
	regions := make([]string, 0, len(limits))
	for region := range limits {
		regions = append(regions, region)
	}
	sort.Strings(regions)
	if len(regions) == 0 {
		_, err := s.db.ExecContext(ctx, `DELETE FROM free_proxy_health`)
		return err
	}
	if _, err := s.db.ExecContext(ctx, `
		DELETE FROM free_proxy_health
		WHERE NOT (region = ANY($1))`, pq.Array(regions)); err != nil {
		return err
	}
	for _, region := range regions {
		limit := limits[region]
		if limit <= 0 {
			limit = 1000
		}
		if _, err := s.db.ExecContext(ctx, `
			WITH desired AS (
				SELECT fp.id
				FROM free_proxies fp
				LEFT JOIN free_proxy_health current_health
				  ON current_health.proxy_id = fp.id
				 AND current_health.region = $1
				WHERE fp.status <> 'disabled'
				ORDER BY
				  CASE
					WHEN current_health.candidate_window_token =
					  FLOOR(EXTRACT(EPOCH FROM NOW()) / 3600)::bigint THEN 0
					ELSE 1
				  END,
				  CASE
					WHEN current_health.status = 'active' THEN 0
					WHEN current_health.success_count > 0 THEN 1
					WHEN current_health.id IS NULL OR current_health.last_checked_at IS NULL THEN 2
					WHEN current_health.status = 'pending' THEN 3
					WHEN current_health.status = 'cooldown' THEN 4
					ELSE 5
				  END,
				  CASE
					WHEN current_health.next_check_at IS NULL
					  OR current_health.next_check_at <= NOW() THEN 0
					ELSE 1
				  END,
				  CASE WHEN fp.source = 'iplocate:' || $1 THEN 0 ELSE 1 END,
				  CASE fp.protocol
					WHEN 'http' THEN 0
					WHEN 'https' THEN 1
					WHEN 'socks5' THEN 2
					WHEN 'socks4' THEN 3
					ELSE 3
				  END,
				  fp.last_success_at DESC NULLS LAST,
				  fp.failure_count ASC,
				  MD5(
					fp.proxy_url || ':' ||
					FLOOR(EXTRACT(EPOCH FROM NOW()) / 3600)::text
				  ),
				  fp.updated_at DESC
				LIMIT $2::bigint
			)
			INSERT INTO free_proxy_health (
				proxy_id, region, status, next_check_at,
				candidate_window_token, updated_at
			)
			SELECT
				desired.id,
				$1,
				'pending',
				NOW(),
				FLOOR(EXTRACT(EPOCH FROM NOW()) / 3600)::bigint,
				NOW()
			FROM desired
			ON CONFLICT (proxy_id, region) DO UPDATE
			SET candidate_window_token = EXCLUDED.candidate_window_token
			WHERE free_proxy_health.candidate_window_token IS DISTINCT FROM
				EXCLUDED.candidate_window_token`, region, limit); err != nil {
			return err
		}
		if _, err := s.db.ExecContext(ctx, `
			WITH excess AS (
				SELECT fph.id
				FROM free_proxy_health fph
				JOIN free_proxies fp ON fp.id = fph.proxy_id
				WHERE fph.region = $1
				  AND fph.candidate_window_token =
					FLOOR(EXTRACT(EPOCH FROM NOW()) / 3600)::bigint
				ORDER BY
				  CASE
					WHEN fph.status = 'active' THEN 0
					WHEN fph.success_count > 0 THEN 1
					WHEN fph.last_checked_at IS NULL THEN 2
					WHEN fph.status = 'pending' THEN 3
					WHEN fph.status = 'cooldown' THEN 4
					ELSE 5
				  END,
				  fph.last_success_at DESC NULLS LAST,
				  fph.last_checked_at ASC NULLS FIRST,
				  fp.id
				OFFSET $2::bigint
			)
			UPDATE free_proxy_health fph
			SET candidate_window_token = NULL
			FROM excess
			WHERE fph.id = excess.id`, region, limit); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) GetFreeProxiesDueForCheck(regions []string, limit int, bootstrap bool) ([]FreeProxyCandidate, error) {
	return s.ClaimFreeProxiesDueForCheck(context.Background(), regions, limit, bootstrap)
}

func (s *Store) ClaimFreeProxiesDueForCheck(ctx context.Context, regions []string, limit int, bootstrap bool) ([]FreeProxyCandidate, error) {
	if limit <= 0 {
		limit = 200
	}
	if len(regions) == 0 {
		regions = []string{"de"}
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	claim := func(lane string, claimLimit int) ([]FreeProxyCandidate, error) {
		if claimLimit <= 0 {
			return nil, nil
		}
		rows, queryErr := tx.QueryContext(ctx, `
			WITH proxy_ranked AS (
				SELECT
					fph.id,
					fph.proxy_id,
					fph.region,
					fp.source,
					fp.protocol,
					CASE
						WHEN fph.status = 'active' THEN 0
						WHEN fph.success_count > 0 THEN 1
						WHEN fp.success_count > 0 THEN 2
						WHEN $3 AND fph.last_checked_at IS NULL THEN 3
						WHEN fph.status = 'cooldown' THEN 4
						WHEN fph.status = 'dead' THEN 6
						ELSE 5
					END AS priority,
					ROW_NUMBER() OVER (
						PARTITION BY fp.id
						ORDER BY
							CASE
								WHEN fph.status = 'active' THEN 0
								WHEN fph.success_count > 0 THEN 1
								WHEN fp.success_count > 0 THEN 2
								WHEN $3 AND fph.last_checked_at IS NULL THEN 3
								WHEN fph.status = 'cooldown' THEN 4
								WHEN fph.status = 'dead' THEN 6
								ELSE 5
							END,
							fph.last_checked_at ASC NULLS FIRST,
					fph.score DESC,
					MD5(fp.proxy_url || ':' || fph.region)
					) AS proxy_rank,
					(COALESCE(source_stats.success_count, 0) + 1.0) /
						(COALESCE(source_stats.checked_count, 0) + 20.0) AS source_yield_score,
					(fph.success_count + 1.0) /
						(fph.success_count + fph.failure_count + 20.0) AS proxy_yield_score,
					fp.last_success_at AS global_last_success_at,
					fph.last_checked_at,
					fph.score
				FROM free_proxy_health fph
				JOIN free_proxies fp ON fp.id = fph.proxy_id
				LEFT JOIN free_proxy_source_health_stats source_stats
				  ON source_stats.region = fph.region
				 AND source_stats.source = fp.source
				 AND source_stats.protocol = fp.protocol
				WHERE fph.region = ANY($1)
				  AND fp.status <> 'disabled'
				  AND (fp.quarantined_until IS NULL OR fp.quarantined_until <= NOW())
				  AND (
					fp.check_claimed_until IS NULL
					OR fp.check_claimed_until <= NOW()
				  )
				  AND fph.status IN ('pending', 'active', 'cooldown', 'dead')
				  AND fph.candidate_window_token =
					FLOOR(EXTRACT(EPOCH FROM NOW()) / 3600)::bigint
				  AND (fph.next_check_at IS NULL OR fph.next_check_at <= NOW())
				  AND CASE $4
					WHEN 'explore' THEN fph.last_checked_at IS NULL
					WHEN 'fanout' THEN fph.success_count = 0 AND fp.success_count > 0
					WHEN 'keepalive' THEN fph.success_count > 0
					ELSE TRUE
				  END
			), ranked AS (
				SELECT
					proxy_ranked.*,
					ROW_NUMBER() OVER (
						PARTITION BY source
						ORDER BY
							priority,
							global_last_success_at DESC NULLS LAST,
							last_checked_at ASC NULLS FIRST,
							score DESC
					) AS source_rank,
					ROW_NUMBER() OVER (
						PARTITION BY source, protocol
						ORDER BY
							priority,
							last_checked_at ASC NULLS FIRST,
							score DESC
					) AS group_rank,
					ROW_NUMBER() OVER (
						PARTITION BY region
						ORDER BY
							priority,
							source_yield_score DESC,
							proxy_yield_score DESC,
							global_last_success_at DESC NULLS LAST,
							last_checked_at ASC NULLS FIRST,
							score DESC
					) AS region_rank
				FROM proxy_ranked
				WHERE proxy_rank = 1
			), due AS (
				SELECT fph.id, fp.id AS proxy_id
				FROM ranked
				JOIN free_proxy_health fph ON fph.id = ranked.id
				JOIN free_proxies fp ON fp.id = ranked.proxy_id
				ORDER BY
					ranked.priority,
					ranked.region_rank,
					ranked.group_rank,
					ranked.source_yield_score DESC,
					ranked.proxy_yield_score DESC,
					ranked.source_rank,
					ranked.global_last_success_at DESC NULLS LAST,
					ranked.last_checked_at ASC NULLS FIRST,
					ranked.score DESC
				LIMIT $2
				FOR UPDATE OF fph, fp SKIP LOCKED
			), claimed_health AS (
				UPDATE free_proxy_health fph
				SET next_check_at = NOW() + INTERVAL '10 minutes',
					updated_at = NOW()
				FROM due
				WHERE fph.id = due.id
				RETURNING fph.proxy_id, fph.region
			), claimed_proxies AS (
				UPDATE free_proxies fp
				SET check_claimed_until = NOW() + INTERVAL '6 minutes',
					updated_at = NOW()
				FROM claimed_health
				WHERE fp.id = claimed_health.proxy_id
				RETURNING
					fp.id,
					fp.proxy_url,
					fp.protocol,
					fp.source,
					fp.success_count > 0 AS proven
			)
			SELECT
				claimed_proxies.proxy_url,
				claimed_health.region,
				claimed_proxies.protocol,
				claimed_proxies.source,
				claimed_proxies.proven
			FROM claimed_health
			JOIN claimed_proxies
			  ON claimed_proxies.id = claimed_health.proxy_id`,
			pq.Array(regions),
			claimLimit,
			bootstrap,
			lane,
		)
		if queryErr != nil {
			return nil, queryErr
		}
		defer rows.Close()

		candidates := make([]FreeProxyCandidate, 0, claimLimit)
		for rows.Next() {
			var candidate FreeProxyCandidate
			if scanErr := rows.Scan(
				&candidate.ProxyURL,
				&candidate.Region,
				&candidate.Protocol,
				&candidate.Source,
				&candidate.Proven,
			); scanErr != nil {
				return nil, scanErr
			}
			candidates = append(candidates, candidate)
		}
		return candidates, rows.Err()
	}

	proxies := make([]FreeProxyCandidate, 0, limit)
	for _, lane := range freeProxyLaneQuotas(limit, bootstrap) {
		claimed, claimErr := claim(lane.name, lane.limit)
		if claimErr != nil {
			return nil, claimErr
		}
		proxies = append(proxies, claimed...)
	}
	if remaining := limit - len(proxies); remaining > 0 {
		claimed, claimErr := claim("any", remaining)
		if claimErr != nil {
			return nil, claimErr
		}
		proxies = append(proxies, claimed...)
	}

	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return proxies, nil
}

type freeProxyLaneQuota struct {
	name  string
	limit int
}

func freeProxyLaneQuotas(limit int, bootstrap bool) []freeProxyLaneQuota {
	if limit <= 0 {
		return nil
	}
	if !bootstrap {
		explore := max(1, limit*20/100)
		if explore >= limit {
			explore = 0
		}
		return []freeProxyLaneQuota{
			{name: "keepalive", limit: limit - explore},
			{name: "explore", limit: explore},
		}
	}

	// Recovery gets the fastest known path to usable regional capacity:
	// proxies already proven in another region first, then regional keepalive,
	// while retaining a bounded exploration lane for new inventory.
	fanout := max(1, limit*50/100)
	keepalive := max(1, limit*30/100)
	if fanout+keepalive > limit {
		keepalive = max(0, limit-fanout)
	}
	explore := max(0, limit-fanout-keepalive)
	return []freeProxyLaneQuota{
		{name: "fanout", limit: fanout},
		{name: "keepalive", limit: keepalive},
		{name: "explore", limit: explore},
	}
}

func (s *Store) RecordFreeProxySuccess(proxyURL string, region string, latencyMs int) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := s.RecordFreeProxySuccessContext(ctx, proxyURL, region, latencyMs); err != nil {
		log.Printf("free proxy success update failed: %v", err)
	}
}

func (s *Store) RecordFreeProxySuccessContext(ctx context.Context, proxyURL string, region string, latencyMs int) error {
	if proxyURL == "" {
		return nil
	}
	_, err := s.db.ExecContext(ctx, `
		WITH updated_health AS (
		UPDATE free_proxy_health fph
		SET status = 'active',
			success_streak = fph.success_streak + 1,
			failure_streak = 0,
			success_count = fph.success_count + 1,
			latency_ms = $3,
			last_status_code = 200,
			last_checked_at = NOW(),
			last_success_at = NOW(),
			last_error = NULL,
			last_error_code = NULL,
			last_error_stage = NULL,
			next_check_at = NOW()
				+ INTERVAL '8 minutes'
				+ MOD(fp.id::bigint + fph.id, 300) * INTERVAL '1 second',
			score = LEAST(100, 50 + ((fph.success_streak + 1) * 10) - GREATEST(0, $3 - 1000) / 100),
			updated_at = NOW()
		FROM free_proxies fp
		WHERE fp.id = fph.proxy_id
		  AND fp.proxy_url = $1
		  AND fph.region = $2
		RETURNING fph.proxy_id
		)
		UPDATE free_proxies fp
		SET status = 'active',
			success_count = success_count + 1,
			failure_count = 0,
			last_checked_at = NOW(),
			last_success_at = NOW(),
			last_error = NULL,
			last_error_code = NULL,
			last_error_stage = NULL,
			quarantined_until = NULL,
			check_claimed_until = NULL,
			updated_at = NOW()
		WHERE fp.id IN (SELECT proxy_id FROM updated_health)`, proxyURL, region, latencyMs)
	if err != nil {
		return err
	}
	return s.recordFreeProxySourceOutcomeContext(ctx, proxyURL, region, true)
}

// TouchFreeProxyRuntimeSuccessContext records sampled positive data-plane
// evidence without incrementing validator counters. Runtime failures are kept
// local until the maintainer independently reproduces them.
func (s *Store) TouchFreeProxyRuntimeSuccessContext(
	ctx context.Context,
	proxyURL string,
	region string,
	latencyMs int,
) error {
	if proxyURL == "" {
		return nil
	}
	_, err := s.db.ExecContext(ctx, `
		WITH updated_health AS (
			UPDATE free_proxy_health fph
			SET status = 'active',
				success_streak = GREATEST(fph.success_streak, 1),
				failure_streak = 0,
				latency_ms = $3,
				last_status_code = 200,
				last_checked_at = NOW(),
				last_success_at = NOW(),
				last_error = NULL,
				last_error_code = NULL,
				last_error_stage = NULL,
				next_check_at = NOW() + INTERVAL '8 minutes',
				score = GREATEST(fph.score, 50),
				updated_at = NOW()
			FROM free_proxies fp
			WHERE fp.id = fph.proxy_id
			  AND fp.proxy_url = $1
			  AND fph.region = $2
			RETURNING fph.proxy_id
		)
		UPDATE free_proxies fp
		SET status = 'active',
			failure_count = 0,
			last_checked_at = NOW(),
			last_success_at = NOW(),
			last_error = NULL,
			last_error_code = NULL,
			last_error_stage = NULL,
			quarantined_until = NULL,
			updated_at = NOW()
		WHERE fp.id IN (SELECT proxy_id FROM updated_health)`,
		proxyURL,
		region,
		latencyMs,
	)
	return err
}

func (s *Store) recordFreeProxySourceOutcomeContext(
	ctx context.Context,
	proxyURL string,
	region string,
	success bool,
) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO free_proxy_source_health_stats (
			region,
			source,
			protocol,
			checked_count,
			success_count,
			failure_count,
			last_checked_at,
			last_success_at,
			updated_at
		)
		SELECT DISTINCT
			$2,
			LEFT(source_name, 50),
			fp.protocol,
			1,
			CASE WHEN $3 THEN 1 ELSE 0 END,
			CASE WHEN $3 THEN 0 ELSE 1 END,
			NOW(),
			CASE WHEN $3 THEN NOW() ELSE NULL END,
			NOW()
		FROM free_proxies fp
		CROSS JOIN LATERAL unnest(
			array_append(COALESCE(fp.sources, ARRAY[]::text[]), fp.source)
		) AS source_name
		WHERE fp.proxy_url = $1
		  AND BTRIM(source_name) <> ''
		ON CONFLICT (region, source, protocol) DO UPDATE
		SET checked_count = free_proxy_source_health_stats.checked_count + 1,
			success_count = free_proxy_source_health_stats.success_count
				+ CASE WHEN $3 THEN 1 ELSE 0 END,
			failure_count = free_proxy_source_health_stats.failure_count
				+ CASE WHEN $3 THEN 0 ELSE 1 END,
			last_checked_at = NOW(),
			last_success_at = CASE
				WHEN $3 THEN NOW()
				ELSE free_proxy_source_health_stats.last_success_at
			END,
			updated_at = NOW()`,
		proxyURL,
		region,
		success,
	)
	return err
}

func (s *Store) RecordFreeProxyFailure(proxyURL string, region string, statusCode int, message string, failureThreshold int, quarantineMinutes int) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := s.RecordFreeProxyFailureContext(
		ctx,
		proxyURL,
		region,
		statusCode,
		message,
		failureThreshold,
		quarantineMinutes,
	); err != nil {
		log.Printf("free proxy failure update failed: %v", err)
	}
}

func (s *Store) RecordFreeProxyFailureClass(
	proxyURL string,
	region string,
	statusCode int,
	message string,
	errorCode string,
	failureThreshold int,
	quarantineMinutes int,
) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := s.RecordFreeProxyFailureClassContext(
		ctx,
		proxyURL,
		region,
		statusCode,
		message,
		errorCode,
		failureThreshold,
		quarantineMinutes,
	); err != nil {
		log.Printf("free proxy failure update failed: %v", err)
	}
}

func (s *Store) RecordFreeProxyFailureContext(ctx context.Context, proxyURL string, region string, statusCode int, message string, failureThreshold int, quarantineMinutes int) error {
	errorCode := "transport"
	switch {
	case statusCode == 401:
		errorCode = "vinted_401"
	case statusCode == 403:
		errorCode = "vinted_403"
	case statusCode == 429:
		errorCode = "vinted_429"
	case statusCode >= 500:
		errorCode = "upstream_5xx"
	}
	return s.RecordFreeProxyFailureClassContext(
		ctx,
		proxyURL,
		region,
		statusCode,
		message,
		errorCode,
		failureThreshold,
		quarantineMinutes,
	)
}

func (s *Store) RecordFreeProxyFailureClassContext(
	ctx context.Context,
	proxyURL string,
	region string,
	statusCode int,
	message string,
	errorCode string,
	failureThreshold int,
	quarantineMinutes int,
) error {
	return s.RecordFreeProxyFailureStageContext(
		ctx,
		proxyURL,
		region,
		statusCode,
		message,
		errorCode,
		"",
		failureThreshold,
		quarantineMinutes,
	)
}

func (s *Store) RecordFreeProxyFailureStageContext(
	ctx context.Context,
	proxyURL string,
	region string,
	statusCode int,
	message string,
	errorCode string,
	errorStage string,
	failureThreshold int,
	quarantineMinutes int,
) error {
	if proxyURL == "" {
		return nil
	}
	if failureThreshold < 1 {
		failureThreshold = 3
	}
	if quarantineMinutes < 1 {
		quarantineMinutes = 30
	}
	if len(message) > 1000 {
		message = message[:1000]
	}
	if len(errorCode) > 50 {
		errorCode = errorCode[:50]
	}
	if errorCode == "" {
		errorCode = "unknown"
	}
	if len(errorStage) > 20 {
		errorStage = errorStage[:20]
	}

	if errorCode == "upstream_5xx" || errorCode == "decode" || errorCode == "schema" || errorCode == "canceled" {
		_, err := s.db.ExecContext(ctx, `
			WITH updated_health AS (
			UPDATE free_proxy_health fph
			SET last_status_code = NULLIF($3, 0),
				last_checked_at = NOW(),
				last_error = $4,
				last_error_code = $5,
				last_error_stage = NULLIF($6, ''),
				next_check_at = NOW() + INTERVAL '5 minutes',
				updated_at = NOW()
			FROM free_proxies fp
			WHERE fp.id = fph.proxy_id
			  AND fp.proxy_url = $1
			  AND fph.region = $2
			RETURNING fph.proxy_id
			)
			UPDATE free_proxies fp
			SET last_checked_at = NOW(),
				last_error = $4,
				last_error_code = $5,
				last_error_stage = NULLIF($6, ''),
				check_claimed_until = NULL,
				updated_at = NOW()
			WHERE fp.id IN (SELECT proxy_id FROM updated_health)`,
			proxyURL,
			region,
			statusCode,
			message,
			errorCode,
			errorStage,
		)
		return err
	}

	regionalAccessFailure := errorCode == "vinted_401" ||
		errorCode == "vinted_403" ||
		errorCode == "vinted_429"
	hardTransportFailure := errorCode == "connect" ||
		errorCode == "timeout" ||
		errorCode == "tls" ||
		errorCode == "proxy_handshake" ||
		errorCode == "transport"
	globalTransportFailure := hardTransportFailure

	_, err := s.db.ExecContext(ctx, `
		WITH updated_health AS (
		UPDATE free_proxy_health fph
		SET failure_streak = fph.failure_streak + 1,
			success_streak = CASE WHEN $7 THEN fph.success_streak ELSE 0 END,
			failure_count = fph.failure_count + 1,
			last_status_code = NULLIF($3, 0),
			last_checked_at = NOW(),
			last_failure_at = NOW(),
			last_error = $4,
			last_error_code = $5,
			last_error_stage = NULLIF($10, ''),
			status = CASE
				WHEN fph.status = 'active' AND fph.failure_streak + 1 < $6 THEN 'active'
				WHEN $7 THEN 'cooldown'
				WHEN fph.failure_streak + 1 >= $6 THEN 'dead'
				WHEN fph.status = 'active' THEN 'cooldown'
				ELSE 'cooldown'
			END,
			next_check_at = CASE
				WHEN fph.success_count = 0 AND fp.success_count = 0
					THEN NOW() + INTERVAL '6 hours'
				WHEN fph.failure_streak + 1 = 1 THEN NOW() + INTERVAL '5 minutes'
				WHEN fph.failure_streak + 1 = 2 THEN NOW() + INTERVAL '30 minutes'
				WHEN $7 THEN NOW() + ($8::text || ' minutes')::interval
				WHEN fph.failure_streak + 1 = 3 THEN NOW() + INTERVAL '2 hours'
				ELSE NOW() + INTERVAL '6 hours'
			END,
			score = CASE
				WHEN $7 THEN GREATEST(0, fph.score - 10)
				WHEN fph.failure_streak + 1 >= $6 THEN 0
				ELSE GREATEST(0, fph.score - 30)
			END,
			updated_at = NOW()
		FROM free_proxies fp
		WHERE fp.id = fph.proxy_id
		  AND fp.proxy_url = $1
		  AND fph.region = $2
		RETURNING fph.proxy_id
		)
		UPDATE free_proxies fp
		SET failure_count = CASE
				WHEN $9 THEN failure_count + 1
				ELSE failure_count
			END,
			last_checked_at = NOW(),
			last_failure_at = NOW(),
			last_error = $4,
			last_error_code = $5,
			last_error_stage = NULLIF($10, ''),
			check_claimed_until = NULL,
			quarantined_until = CASE
				WHEN $9 AND fp.success_count > 0 AND fp.failure_count + 1 >= 3
					THEN NOW() + INTERVAL '15 minutes'
				WHEN $9 AND fp.success_count = 0 THEN GREATEST(
					COALESCE(fp.quarantined_until, NOW()),
					NOW() + CASE
						WHEN fp.failure_count + 1 = 1 THEN INTERVAL '5 minutes'
						WHEN fp.failure_count + 1 = 2 THEN INTERVAL '30 minutes'
						WHEN fp.failure_count + 1 = 3 THEN INTERVAL '2 hours'
						ELSE INTERVAL '6 hours'
					END
				)
				ELSE fp.quarantined_until
			END,
			updated_at = NOW()
		WHERE fp.id IN (SELECT proxy_id FROM updated_health)`,
		proxyURL,
		region,
		statusCode,
		message,
		errorCode,
		failureThreshold,
		regionalAccessFailure,
		quarantineMinutes,
		globalTransportFailure,
		errorStage,
	)
	if err != nil {
		return err
	}
	if globalTransportFailure {
		_, err = s.db.ExecContext(ctx, `
			UPDATE free_proxy_health fph
			SET next_check_at = GREATEST(
					COALESCE(fph.next_check_at, NOW()),
					fp.quarantined_until
				),
				updated_at = NOW()
			FROM free_proxies fp
			WHERE fp.id = fph.proxy_id
			  AND fp.proxy_url = $1
			  AND fp.quarantined_until IS NOT NULL`, proxyURL)
	}
	if err != nil {
		return err
	}
	return s.recordFreeProxySourceOutcomeContext(ctx, proxyURL, region, false)
}

// RecordFreeProxyInfrastructureFailureContext releases a health-check claim
// without degrading a previously proven proxy. It is used only while the
// maintainer's own egress is circuit-broken, where a warmup transport failure
// is not reliable evidence that the proxy itself stopped working.
func (s *Store) RecordFreeProxyInfrastructureFailureContext(
	ctx context.Context,
	proxyURL string,
	region string,
	statusCode int,
	message string,
	errorCode string,
	errorStage string,
) error {
	if proxyURL == "" {
		return nil
	}
	if len(message) > 1000 {
		message = message[:1000]
	}
	_, err := s.db.ExecContext(ctx, `
		WITH observed AS (
			UPDATE free_proxy_health fph
			SET last_status_code = NULLIF($3, 0),
				last_checked_at = NOW(),
				last_error = $4,
				last_error_code = $5,
				last_error_stage = NULLIF($6, ''),
				next_check_at = NOW() + INTERVAL '10 minutes',
				updated_at = NOW()
			FROM free_proxies fp
			WHERE fp.id = fph.proxy_id
			  AND fp.proxy_url = $1
			  AND fph.region = $2
			RETURNING fph.proxy_id
		)
		UPDATE free_proxies fp
		SET last_checked_at = NOW(),
			last_error = $4,
			last_error_code = $5,
			last_error_stage = NULLIF($6, ''),
			check_claimed_until = NULL,
			updated_at = NOW()
		WHERE fp.id IN (SELECT proxy_id FROM observed)`,
		proxyURL,
		region,
		statusCode,
		message,
		errorCode,
		errorStage,
	)
	return err
}

func (s *Store) CountActiveFreeProxies(region string) (int, error) {
	return s.CountActiveFreeProxiesContext(context.Background(), region)
}

func (s *Store) CountActiveFreeProxiesContext(ctx context.Context, region string) (int, error) {
	var count int
	err := s.db.QueryRowContext(ctx, `
		SELECT COUNT(*)
		FROM free_proxy_health fph
		JOIN free_proxies fp ON fp.id = fph.proxy_id
		WHERE fph.region = $1
		  AND (
			(
				(
					fph.status = 'active'
					OR (fph.status = 'pending' AND fph.success_streak > 0)
					OR (
						fph.status = 'cooldown'
						AND fph.success_count > 0
						AND fph.failure_streak <= 2
					)
				)
				AND fph.last_success_at >= NOW() - INTERVAL '20 minutes'
			)
			OR (
				(
					fph.status = 'active'
					OR (
						fph.status = 'cooldown'
						AND fph.success_count > 0
					)
				)
				AND fph.failure_streak <= 2
				AND fph.last_success_at >= NOW() - INTERVAL '90 minutes'
			)
		  )
		  AND fp.status <> 'disabled'
		  AND (
			fp.success_count > 0
			OR fp.quarantined_until IS NULL
			OR fp.quarantined_until <= NOW()
		  )`, region).Scan(&count)
	return count, err
}

func (s *Store) SyncFreeProxyRegionMilestoneContext(ctx context.Context, region string, readyCount int) error {
	region = strings.ToLower(strings.TrimSpace(region))
	if region == "" {
		return nil
	}
	state := "recovering"
	eventType := "free_proxy_recovery_started"
	severity := "warning"
	switch {
	case readyCount <= 0:
		state = "outage"
		eventType = "free_proxy_pool_outage"
		severity = "error"
	case readyCount >= 50:
		state = "ready_50"
		eventType = "free_proxy_pool_reached_50"
		severity = "info"
	case readyCount >= 10:
		state = "ready_10"
		eventType = "free_proxy_pool_reached_10"
		severity = "info"
	}

	metadata := fmt.Sprintf(`{"region":%q,"ready":%d,"state":%q}`, region, readyCount, state)
	_, err := s.db.ExecContext(ctx, `
		WITH changed AS (
			INSERT INTO app_settings (key, value, updated_at)
			VALUES ('free_proxy_region_state:' || $1, $2, NOW())
			ON CONFLICT (key) DO UPDATE
			SET value = EXCLUDED.value,
				updated_at = NOW()
			WHERE app_settings.value <> EXCLUDED.value
			RETURNING key
		)
		INSERT INTO audit_events (
			action, target_type, target_id, status, metadata, created_at
		)
		SELECT $3, 'free_proxy_pool', $1, $4, $5::jsonb, NOW()
		FROM changed`, region, state, eventType, severity, metadata)
	return err
}

func (s *Store) SaveItem(item model.Item) error {
	if item.Size == "" {
		item.Size = "N/A"
	}
	if item.Condition == "" {
		item.Condition = "N/A"
	}

	_, err := s.db.Exec(`
		INSERT INTO items (id, monitor_id, title, brand, price, total_price, size, condition, url, image_url, extra_images, location, rating, seller_id, seller_login, seller_profile_url, found_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
		ON CONFLICT (id, monitor_id) DO UPDATE SET
			total_price = COALESCE(EXCLUDED.total_price, items.total_price),
			brand = COALESCE(EXCLUDED.brand, items.brand),
			extra_images = COALESCE(EXCLUDED.extra_images, items.extra_images),
			location = COALESCE(NULLIF(EXCLUDED.location, ''), items.location),
			rating = COALESCE(NULLIF(EXCLUDED.rating, ''), items.rating),
			seller_login = COALESCE(NULLIF(EXCLUDED.seller_login, ''), items.seller_login),
			seller_profile_url = COALESCE(NULLIF(EXCLUDED.seller_profile_url, ''), items.seller_profile_url)`,
		item.ID, item.MonitorID, item.Title, item.Brand, item.Price, nilIfEmpty(item.TotalPrice), item.Size, item.Condition,
		item.URL, item.ImageURL, pq.Array(item.ExtraImages), item.Location, item.Rating, nilIfZero(item.SellerID), nilIfEmpty(item.SellerLogin), nilIfEmpty(item.SellerURL), item.FoundAt,
	)
	if err != nil {
		return fmt.Errorf("insert item %d: %w", item.ID, err)
	}

	if s.cache != nil {
		if err := s.cache.MarkAsSeen(item.MonitorID, item.ID); err != nil {
			log.Printf("redis mark-seen failed for %d:%d: %v", item.MonitorID, item.ID, err)
		}
	}

	return nil
}

func (s *Store) BatchSaveItems(items []model.Item) error {
	if len(items) == 0 {
		return nil
	}

	for i := range items {
		if items[i].Size == "" {
			items[i].Size = "N/A"
		}
		if items[i].Condition == "" {
			items[i].Condition = "N/A"
		}
	}

	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback()

	stmt, err := tx.Prepare(`
		INSERT INTO items (id, monitor_id, title, brand, price, total_price, size, condition, url, image_url, extra_images, location, rating, seller_id, seller_login, seller_profile_url, found_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
		ON CONFLICT (id, monitor_id) DO UPDATE SET 
			total_price = COALESCE(EXCLUDED.total_price, items.total_price),
			brand = COALESCE(EXCLUDED.brand, items.brand),
			extra_images = COALESCE(EXCLUDED.extra_images, items.extra_images),
			location = COALESCE(NULLIF(EXCLUDED.location, ''), items.location),
			rating = COALESCE(NULLIF(EXCLUDED.rating, ''), items.rating),
			seller_login = COALESCE(NULLIF(EXCLUDED.seller_login, ''), items.seller_login),
			seller_profile_url = COALESCE(NULLIF(EXCLUDED.seller_profile_url, ''), items.seller_profile_url)`)
	if err != nil {
		return fmt.Errorf("prepare: %w", err)
	}
	defer stmt.Close()

	for _, item := range items {
		_, err := stmt.Exec(item.ID, item.MonitorID, item.Title, item.Brand, item.Price, nilIfEmpty(item.TotalPrice), item.Size, item.Condition,
			item.URL, item.ImageURL, pq.Array(item.ExtraImages), item.Location, item.Rating, nilIfZero(item.SellerID), nilIfEmpty(item.SellerLogin), nilIfEmpty(item.SellerURL), item.FoundAt)
		if err != nil {
			return fmt.Errorf("insert item %d: %w", item.ID, err)
		}
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit: %w", err)
	}

	return nil
}

func (s *Store) MarkItemsSeen(monitorID int, ids []int64) {
	if s.cache != nil {
		if err := s.cache.BatchMarkAsSeen(monitorID, ids); err != nil {
			log.Printf("redis mark-seen failed: %v", err)
		}
	}
}

func (s *Store) PublishItem(item model.Item) error {
	if s.cache != nil {
		return s.cache.PublishNewItem(item)
	}
	return nil
}

func (s *Store) ClaimUserItemAlert(userID string, itemID int64) bool {
	if userID == "" {
		return true
	}
	if s.cache == nil {
		return true
	}
	claimed, err := s.cache.ClaimUserItemAlert(userID, itemID)
	if err != nil {
		log.Printf("redis alert dedupe failed for %s:%d: %v", userID, itemID, err)
		return true
	}
	return claimed
}

func (s *Store) UpdateItemSellerInfo(itemID int64, location, rating string) error {
	_, err := s.db.Exec(
		`UPDATE items SET location = $1, rating = $2 WHERE id = $3`,
		location, rating, itemID,
	)
	return err
}

func nilIfZero(v int64) interface{} {
	if v == 0 {
		return nil
	}
	return v
}

func nilIfEmpty(v string) interface{} {
	if v == "" {
		return nil
	}
	return v
}

func (s *Store) GetActiveMonitors() ([]model.Monitor, error) {
	rows, err := s.db.Query(`
		SELECT m.id, m."userId", m.name, m.query, m.title_only, m.anti_keywords, m.query_delay_ms, m.quiet_hours_enabled, m.quiet_hours_start_minute, m.quiet_hours_end_minute, m.quiet_hours_mode, m.quiet_hours_delay_ms, m.quiet_hours_timezone, m.price_min, m.price_max, m.size_id, m.catalog_ids, m.brand_ids, m.color_ids, m.status_ids, m.video_game_platform_ids, m.region, m.allowed_countries, m.min_seller_rating, m.min_seller_rating_count, m.status, m.discord_webhook, m.webhook_active, tc.chat_id, m.telegram_active, m.notifications_enabled, u.dedupe_monitor_alerts, COALESCE(NULLIF(u.telegram_message_style, ''), 'rich'), COALESCE(NULLIF(u.discord_message_style, ''), 'rich'), m.proxy_group_id, COALESCE(NULLIF(m.proxy_source, ''), CASE WHEN m.proxy_group_id IS NULL THEN 'server' ELSE 'group' END), pg.name, pg.bandwidth_limit_bytes, COALESCE(pg.bandwidth_rx_bytes, 0), COALESCE(pg.bandwidth_tx_bytes, 0), pg.bandwidth_reset_at, pg.proxies
		FROM monitors m
		JOIN "User" u ON u.id = m."userId"
		LEFT JOIN proxy_groups pg ON m.proxy_group_id = pg.id
		LEFT JOIN telegram_connections tc ON tc."userId" = m."userId"
		WHERE m.status = 'active'`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var monitors []model.Monitor
	for rows.Next() {
		var m model.Monitor
		if err := rows.Scan(&m.ID, &m.UserID, &m.Name, &m.Query, &m.TitleOnly, &m.AntiKeywords, &m.QueryDelayMs, &m.QuietHoursEnabled, &m.QuietHoursStartMinute, &m.QuietHoursEndMinute, &m.QuietHoursMode, &m.QuietHoursDelayMs, &m.QuietHoursTimezone, &m.PriceMin, &m.PriceMax, &m.SizeID, &m.CatalogIDs, &m.BrandIDs, &m.ColorIDs, &m.StatusIDs, &m.VideoGamePlatformIDs, &m.Region, &m.AllowedCountries, &m.MinSellerRating, &m.MinSellerRatingCount, &m.Status, &m.DiscordWebhook, &m.WebhookActive, &m.TelegramChatID, &m.TelegramActive, &m.NotificationsEnabled, &m.DedupeMonitorAlerts, &m.TelegramMessageStyle, &m.DiscordMessageStyle, &m.ProxyGroupID, &m.ProxySource, &m.ProxyGroupName, &m.ProxyGroupLimitBytes, &m.ProxyGroupRxBytes, &m.ProxyGroupTxBytes, &m.ProxyGroupResetAt, &m.Proxies); err != nil {
			return nil, err
		}
		s.SyncProxyGroupBandwidthState(m)
		monitors = append(monitors, m)
	}
	if err := s.attachBannedSellerIDs(monitors); err != nil {
		return nil, err
	}
	return monitors, nil
}

func (s *Store) GetMonitorByID(id int) (model.Monitor, error) {
	var m model.Monitor
	err := s.db.QueryRow(`
		SELECT m.id, m."userId", m.name, m.query, m.title_only, m.anti_keywords, m.query_delay_ms, m.quiet_hours_enabled, m.quiet_hours_start_minute, m.quiet_hours_end_minute, m.quiet_hours_mode, m.quiet_hours_delay_ms, m.quiet_hours_timezone, m.price_min, m.price_max, m.size_id, m.catalog_ids, m.brand_ids, m.color_ids, m.status_ids, m.video_game_platform_ids, m.region, m.allowed_countries, m.min_seller_rating, m.min_seller_rating_count, m.status, m.discord_webhook, m.webhook_active, tc.chat_id, m.telegram_active, m.notifications_enabled, u.dedupe_monitor_alerts, COALESCE(NULLIF(u.telegram_message_style, ''), 'rich'), COALESCE(NULLIF(u.discord_message_style, ''), 'rich'), m.proxy_group_id, COALESCE(NULLIF(m.proxy_source, ''), CASE WHEN m.proxy_group_id IS NULL THEN 'server' ELSE 'group' END), pg.name, pg.bandwidth_limit_bytes, COALESCE(pg.bandwidth_rx_bytes, 0), COALESCE(pg.bandwidth_tx_bytes, 0), pg.bandwidth_reset_at, pg.proxies
		FROM monitors m
		JOIN "User" u ON u.id = m."userId"
		LEFT JOIN proxy_groups pg ON m.proxy_group_id = pg.id
		LEFT JOIN telegram_connections tc ON tc."userId" = m."userId"
		WHERE m.id = $1`, id,
	).Scan(&m.ID, &m.UserID, &m.Name, &m.Query, &m.TitleOnly, &m.AntiKeywords, &m.QueryDelayMs, &m.QuietHoursEnabled, &m.QuietHoursStartMinute, &m.QuietHoursEndMinute, &m.QuietHoursMode, &m.QuietHoursDelayMs, &m.QuietHoursTimezone, &m.PriceMin, &m.PriceMax, &m.SizeID, &m.CatalogIDs, &m.BrandIDs, &m.ColorIDs, &m.StatusIDs, &m.VideoGamePlatformIDs, &m.Region, &m.AllowedCountries, &m.MinSellerRating, &m.MinSellerRatingCount, &m.Status, &m.DiscordWebhook, &m.WebhookActive, &m.TelegramChatID, &m.TelegramActive, &m.NotificationsEnabled, &m.DedupeMonitorAlerts, &m.TelegramMessageStyle, &m.DiscordMessageStyle, &m.ProxyGroupID, &m.ProxySource, &m.ProxyGroupName, &m.ProxyGroupLimitBytes, &m.ProxyGroupRxBytes, &m.ProxyGroupTxBytes, &m.ProxyGroupResetAt, &m.Proxies)
	if err != nil {
		return model.Monitor{}, err
	}
	s.SyncProxyGroupBandwidthState(m)
	monitors := []model.Monitor{m}
	if err := s.attachBannedSellerIDs(monitors); err != nil {
		return model.Monitor{}, err
	}
	return monitors[0], nil
}

func (s *Store) attachBannedSellerIDs(monitors []model.Monitor) error {
	if len(monitors) == 0 {
		return nil
	}

	userIDs := make([]string, 0, len(monitors))
	seenUsers := make(map[string]bool, len(monitors))
	for _, m := range monitors {
		if m.UserID == "" || seenUsers[m.UserID] {
			continue
		}
		seenUsers[m.UserID] = true
		userIDs = append(userIDs, m.UserID)
	}
	if len(userIDs) == 0 {
		return nil
	}

	rows, err := s.db.Query(`
		SELECT "userId", seller_id
		FROM seller_bans
		WHERE "userId" = ANY($1)`,
		pq.Array(userIDs),
	)
	if err != nil {
		return err
	}
	defer rows.Close()

	bansByUser := make(map[string][]int64, len(userIDs))
	for rows.Next() {
		var userID string
		var sellerID int64
		if err := rows.Scan(&userID, &sellerID); err != nil {
			return err
		}
		bansByUser[userID] = append(bansByUser[userID], sellerID)
	}
	if err := rows.Err(); err != nil {
		return err
	}

	for userID := range bansByUser {
		sort.Slice(bansByUser[userID], func(i, j int) bool {
			return bansByUser[userID][i] < bansByUser[userID][j]
		})
	}
	for i := range monitors {
		monitors[i].BannedSellerIDs = bansByUser[monitors[i].UserID]
	}
	return nil
}

func (s *Store) Close() error {
	close(s.telemetryStop)
	<-s.telemetryDone
	close(s.trafficStop)
	<-s.trafficDone
	if s.cache != nil {
		s.cache.Close()
	}
	return s.db.Close()
}

func (s *Store) RecordProxyGroupBandwidth(groupID int, txBytes int64, rxBytes int64) {
	if groupID <= 0 || (txBytes <= 0 && rxBytes <= 0) {
		return
	}

	s.trafficMu.Lock()
	current := s.trafficTotals[groupID]
	current.txBytes += txBytes
	current.rxBytes += rxBytes
	s.trafficTotals[groupID] = current
	usage := s.trafficUsage[groupID]
	usage.txBytes += txBytes
	usage.rxBytes += rxBytes
	s.trafficUsage[groupID] = usage
	s.trafficMu.Unlock()
}

func (s *Store) SyncProxyGroupBandwidthState(m model.Monitor) {
	if m.ProxyGroupID == nil {
		return
	}

	groupID := *m.ProxyGroupID
	var resetAt time.Time
	if m.ProxyGroupResetAt.Valid {
		resetAt = m.ProxyGroupResetAt.Time.UTC()
	}

	s.trafficMu.Lock()
	defer s.trafficMu.Unlock()

	current, exists := s.trafficUsage[groupID]
	if !exists || resetAt.After(current.resetAt) {
		s.trafficUsage[groupID] = proxyGroupBandwidthState{
			txBytes: m.ProxyGroupTxBytes,
			rxBytes: m.ProxyGroupRxBytes,
			resetAt: resetAt,
		}
		s.trafficTotals[groupID] = proxyGroupBandwidthDelta{}
		return
	}

	if m.ProxyGroupTxBytes > current.txBytes {
		current.txBytes = m.ProxyGroupTxBytes
	}
	if m.ProxyGroupRxBytes > current.rxBytes {
		current.rxBytes = m.ProxyGroupRxBytes
	}
	s.trafficUsage[groupID] = current
}

func (s *Store) GetProxyGroupBandwidthUsage(groupID int) (txBytes int64, rxBytes int64, ok bool) {
	s.trafficMu.Lock()
	defer s.trafficMu.Unlock()

	usage, exists := s.trafficUsage[groupID]
	if !exists {
		return 0, 0, false
	}

	return usage.txBytes, usage.rxBytes, true
}

func (s *Store) bandwidthFlushLoop() {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	defer close(s.trafficDone)

	for {
		select {
		case <-ticker.C:
			s.flushProxyGroupBandwidth()
		case <-s.trafficStop:
			s.flushProxyGroupBandwidth()
			return
		}
	}
}

func (s *Store) flushProxyGroupBandwidth() {
	s.trafficMu.Lock()
	if len(s.trafficTotals) == 0 {
		s.trafficMu.Unlock()
		return
	}

	pending := s.trafficTotals
	s.trafficTotals = make(map[int]proxyGroupBandwidthDelta)
	s.trafficMu.Unlock()

	for groupID, delta := range pending {
		if delta.txBytes <= 0 && delta.rxBytes <= 0 {
			continue
		}
		if _, err := s.db.Exec(`
			UPDATE proxy_groups
			SET bandwidth_tx_bytes = bandwidth_tx_bytes + $2,
			    bandwidth_rx_bytes = bandwidth_rx_bytes + $3
			WHERE id = $1`,
			groupID, delta.txBytes, delta.rxBytes,
		); err != nil {
			log.Printf("proxy group bandwidth flush failed for %d: %v", groupID, err)
			s.trafficMu.Lock()
			current := s.trafficTotals[groupID]
			current.txBytes += delta.txBytes
			current.rxBytes += delta.rxBytes
			s.trafficTotals[groupID] = current
			s.trafficMu.Unlock()
		}
	}
}

func (s *Store) UpdateMonitorHealth(health model.MonitorHealth) {
	if s.cache == nil {
		return
	}
	data, err := json.Marshal(health)
	if err != nil {
		log.Printf("marshal health for monitor %d: %v", health.MonitorID, err)
		return
	}
	if err := s.cache.SetMonitorHealth(health.MonitorID, data); err != nil {
		s.logHealthErrorOnce(health.MonitorID, err)
	}
}

func (s *Store) ClearMonitorHealth(monitorID int) {
	if s.cache == nil {
		return
	}
	s.cache.DeleteMonitorHealth(monitorID)
}

func (s *Store) SetMonitorStatus(monitorID int, status string) {
	_, err := s.db.Exec(`UPDATE monitors SET status = $1 WHERE id = $2`, status, monitorID)
	if err != nil {
		log.Printf("set monitor %d status to %s: %v", monitorID, status, err)
	}
}

func (s *Store) PauseExpiredDemoMonitors() ([]int, error) {
	rows, err := s.db.Query(`
		UPDATE monitors
		SET status = 'paused'
		WHERE status = 'active'
		  AND demo_expires_at IS NOT NULL
		  AND demo_expires_at <= NOW()
		RETURNING id`)
	if err != nil {
		return nil, err
	}

	var monitorIDs []int
	for rows.Next() {
		var monitorID int
		if err := rows.Scan(&monitorID); err != nil {
			rows.Close()
			return nil, err
		}
		monitorIDs = append(monitorIDs, monitorID)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}

	for _, monitorID := range monitorIDs {
		s.RecordMonitorEvent(model.MonitorEvent{
			MonitorID: monitorID,
			EventType: "demo_auto_paused",
			Severity:  "info",
			Message:   "Demo monitor automatically paused after 30 minutes",
		})
	}

	return monitorIDs, nil
}

func (s *Store) RecordMonitorRun(run model.MonitorRun) {
	if run.MonitorID <= 0 || run.Status == "" {
		return
	}
	if run.FetchSource == "" {
		run.FetchSource = "canonical"
	}
	s.enqueueTelemetry(telemetryEvent{kind: "run", run: run})
}

func (s *Store) RecordItemDetection(detection model.MonitorItemDetection) {
	if detection.MonitorID <= 0 || detection.ItemID <= 0 {
		return
	}
	if detection.Source != "discovery" {
		detection.Source = "canonical"
	}
	if detection.SeenAt.IsZero() {
		detection.SeenAt = time.Now()
	}
	s.enqueueTelemetry(telemetryEvent{kind: "detection", detection: detection})
}

func (s *Store) RecordDetectionAlertQueued(monitorID int, itemID int64, occurredAt time.Time) {
	s.recordDetectionTiming("alert_queued", monitorID, itemID, occurredAt)
}

func (s *Store) RecordDetectionAlertSent(monitorID int, itemID int64, occurredAt time.Time) {
	s.recordDetectionTiming("alert_sent", monitorID, itemID, occurredAt)
}

func (s *Store) recordDetectionTiming(kind string, monitorID int, itemID int64, occurredAt time.Time) {
	if monitorID <= 0 || itemID <= 0 {
		return
	}
	if occurredAt.IsZero() {
		occurredAt = time.Now()
	}
	s.enqueueTelemetry(telemetryEvent{kind: kind, monitorID: monitorID, itemID: itemID, occurredAt: occurredAt})
}

func (s *Store) enqueueTelemetry(event telemetryEvent) {
	select {
	case s.telemetryCh <- event:
	default:
		log.Printf("telemetry queue full, dropping %s event", event.kind)
	}
}

func (s *Store) telemetryFlushLoop() {
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	defer close(s.telemetryDone)

	batch := make([]telemetryEvent, 0, 100)
	flush := func() {
		if len(batch) == 0 {
			return
		}
		s.flushTelemetry(batch)
		batch = batch[:0]
	}

	for {
		select {
		case event := <-s.telemetryCh:
			batch = append(batch, event)
			if len(batch) >= 100 {
				flush()
			}
		case <-ticker.C:
			flush()
		case <-s.telemetryStop:
			for {
				select {
				case event := <-s.telemetryCh:
					batch = append(batch, event)
				default:
					flush()
					return
				}
			}
		}
	}
}

func (s *Store) flushTelemetry(events []telemetryEvent) {
	tx, err := s.db.Begin()
	if err != nil {
		log.Printf("telemetry batch begin failed: %v", err)
		return
	}
	defer tx.Rollback()

	for _, event := range events {
		switch event.kind {
		case "run":
			run := event.run
			_, err = tx.Exec(`
				INSERT INTO monitor_runs (
					monitor_id, status, status_code, duration_ms, item_count,
					new_item_count, error_message, proxy_source, fetch_source, region
				)
				VALUES ($1, $2, NULLIF($3, 0), NULLIF($4, 0), $5, $6, NULLIF($7, ''), NULLIF($8, ''), $9, $10)`,
				run.MonitorID, run.Status, run.StatusCode, run.DurationMS, run.ItemCount,
				run.NewItemCount, run.ErrorMessage, run.ProxySource, run.FetchSource, run.Region,
			)
		case "detection":
			detection := event.detection
			var earlySeenAt interface{}
			var canonicalSeenAt interface{}
			if detection.Source == "discovery" {
				earlySeenAt = detection.SeenAt
			} else {
				canonicalSeenAt = detection.SeenAt
			}
			_, err = tx.Exec(`
				INSERT INTO monitor_item_detections (
					monitor_id, item_id, first_source, early_seen_at, canonical_seen_at, updated_at
				)
				VALUES ($1, $2, $3, $4, $5, NOW())
				ON CONFLICT (monitor_id, item_id) DO UPDATE SET
					early_seen_at = COALESCE(monitor_item_detections.early_seen_at, EXCLUDED.early_seen_at),
					canonical_seen_at = COALESCE(monitor_item_detections.canonical_seen_at, EXCLUDED.canonical_seen_at),
					updated_at = NOW()`,
				detection.MonitorID, detection.ItemID, detection.Source, earlySeenAt, canonicalSeenAt,
			)
		case "alert_queued":
			_, err = tx.Exec(`
				UPDATE monitor_item_detections
				SET alert_queued_at = COALESCE(alert_queued_at, $3), updated_at = NOW()
				WHERE monitor_id = $1 AND item_id = $2`, event.monitorID, event.itemID, event.occurredAt)
		case "alert_sent":
			_, err = tx.Exec(`
				UPDATE monitor_item_detections
				SET alert_sent_at = COALESCE(alert_sent_at, $3), updated_at = NOW()
				WHERE monitor_id = $1 AND item_id = $2`, event.monitorID, event.itemID, event.occurredAt)
		}
		if err != nil {
			log.Printf("telemetry %s write failed: %v", event.kind, err)
			return
		}
	}

	if err := tx.Commit(); err != nil {
		log.Printf("telemetry batch commit failed: %v", err)
	}
}

func (s *Store) PruneDetectionTelemetry(retentionDays int) {
	if retentionDays < 1 {
		retentionDays = 14
	}
	if _, err := s.db.Exec(
		`DELETE FROM monitor_item_detections WHERE created_at < NOW() - ($1::text || ' days')::interval`,
		retentionDays,
	); err != nil {
		log.Printf("detection telemetry cleanup failed: %v", err)
	}
}

func (s *Store) PruneMonitorRuns(retentionHours int) {
	if retentionHours < 1 {
		retentionHours = defaultMonitorRunRetentionHours
	}

	var totalDeleted int64
	for batch := 0; batch < monitorRunPruneMaximumBatchesPerCycle; batch++ {
		result, err := s.db.Exec(`
			WITH expired AS (
				SELECT id
				FROM monitor_runs
				WHERE checked_at < NOW() - ($1::text || ' hours')::interval
				ORDER BY checked_at
				LIMIT $2
			)
			DELETE FROM monitor_runs AS run
			USING expired
			WHERE run.id = expired.id`,
			retentionHours,
			monitorRunPruneBatchSize,
		)
		if err != nil {
			log.Printf("monitor run cleanup failed after deleting %d rows: %v", totalDeleted, err)
			return
		}

		deleted, err := result.RowsAffected()
		if err != nil {
			log.Printf("monitor run cleanup could not read affected rows: %v", err)
			return
		}
		totalDeleted += deleted
		if deleted < monitorRunPruneBatchSize {
			if totalDeleted > 0 {
				log.Printf("monitor run cleanup deleted %d rows older than %d hours", totalDeleted, retentionHours)
			}
			return
		}
	}

	log.Printf(
		"monitor run cleanup deleted %d rows older than %d hours; additional expired rows will be removed next cycle",
		totalDeleted,
		retentionHours,
	)
}

func (s *Store) PruneMonitorRunStats(retentionDays int) {
	if retentionDays < 1 {
		retentionDays = defaultMonitorRunStatsRetentionDays
	}

	result, err := s.db.Exec(
		`DELETE FROM monitor_run_hourly_stats WHERE bucket_hour < NOW() - ($1::text || ' days')::interval`,
		retentionDays,
	)
	if err != nil {
		log.Printf("monitor run stats cleanup failed: %v", err)
		return
	}

	deleted, err := result.RowsAffected()
	if err != nil {
		log.Printf("monitor run stats cleanup could not read affected rows: %v", err)
		return
	}
	if deleted > 0 {
		log.Printf("monitor run stats cleanup deleted %d rows older than %d days", deleted, retentionDays)
	}
}

func (s *Store) RecordMonitorEvent(event model.MonitorEvent) {
	if event.MonitorID <= 0 || event.EventType == "" || event.Message == "" {
		return
	}
	metadata := event.Metadata
	if strings.TrimSpace(metadata) == "" {
		metadata = "{}"
	}
	severity := event.Severity
	if severity == "" {
		severity = "info"
	}
	_, err := s.db.Exec(`
		INSERT INTO monitor_events (monitor_id, event_type, severity, message, metadata)
		VALUES ($1, $2, $3, $4, $5::jsonb)`,
		event.MonitorID,
		event.EventType,
		severity,
		event.Message,
		metadata,
	)
	if err != nil {
		log.Printf("record monitor event for %d: %v", event.MonitorID, err)
	}
}

func (s *Store) RecordAlertEvent(event model.AlertEvent) {
	if event.Channel == "" || event.Status == "" {
		return
	}
	metadata := event.Metadata
	if strings.TrimSpace(metadata) == "" {
		metadata = "{}"
	}
	_, err := s.db.Exec(`
		INSERT INTO alert_events (
			"userId", monitor_id, item_id, notification_id, delivery_id,
			channel, status, notification_kind, reason_code, attempt_number,
			failure_reason, metadata
		)
		VALUES (
			NULLIF($1, ''), NULLIF($2, 0), NULLIF($3, 0::bigint),
			NULLIF($4, 0::bigint), NULLIF($5, 0::bigint), $6, $7, $8,
			NULLIF($9, ''), NULLIF($10, 0), NULLIF($11, ''), $12::jsonb
		)`,
		event.UserID,
		event.MonitorID,
		event.ItemID,
		event.NotificationID,
		event.DeliveryID,
		event.Channel,
		event.Status,
		defaultAlertKind(event.NotificationKind),
		event.ReasonCode,
		event.AttemptNumber,
		event.FailureReason,
		metadata,
	)
	if err != nil {
		log.Printf("record alert event for monitor %d item %d: %v", event.MonitorID, event.ItemID, err)
	}
}

func (s *Store) logHealthErrorOnce(monitorID int, err error) {
	s.healthErrLogMu.Lock()
	defer s.healthErrLogMu.Unlock()

	now := time.Now()
	if last, ok := s.healthErrLog[monitorID]; ok && now.Sub(last) < 60*time.Second {
		return
	}
	s.healthErrLog[monitorID] = now
	log.Printf("set health for monitor %d: %v (suppressing repeats for 60s)", monitorID, err)
}
