package database

import (
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
}

type FreeProxyRecord struct {
	ProxyURL string
	Protocol string
	Host     string
	Port     int
	Source   string
}

type PreindexProbe struct {
	Region      string
	ItemID      int64
	StatusCode  int
	DurationMS  int
	Outcome     string
	ProxySource string
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
	if s.cache != nil {
		return s.cache.GetUserRegion(userID)
	}
	return "", false
}

func (s *Store) SetUserRegion(userID int64, region string) {
	if s.cache != nil {
		s.cache.SetUserRegion(userID, region)
	}
}

func (s *Store) GetSettingValue(key string) (string, bool, error) {
	var value string
	err := s.db.QueryRow(`SELECT value FROM app_settings WHERE key = $1`, key).Scan(&value)
	if err == sql.ErrNoRows {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return value, true, nil
}

func (s *Store) GetActiveFreeProxyRegions() ([]string, error) {
	rows, err := s.db.Query(`
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

func (s *Store) GetActiveFreeProxies(region string, limit int) ([]string, error) {
	if limit <= 0 {
		limit = 500
	}
	rows, err := s.db.Query(`
		SELECT fp.proxy_url
		FROM free_proxy_health fph
		JOIN free_proxies fp ON fp.id = fph.proxy_id
		WHERE fph.region = $1
		  AND (
			fph.status = 'active'
			OR (fph.status = 'pending' AND fph.success_streak > 0)
		  )
		  AND fph.success_streak > 0
		  AND fph.last_status_code = 200
		  AND fph.last_error IS NULL
		  AND fph.last_success_at >= NOW() - INTERVAL '20 minutes'
		  AND fp.status <> 'disabled'
		  AND (fph.next_check_at IS NULL OR fph.next_check_at <= NOW() + INTERVAL '15 minutes')
		ORDER BY
		  CASE WHEN fph.status = 'active' THEN 0 ELSE 1 END,
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
	rows, err := s.db.Query(`SELECT proxy_url FROM free_proxies`)
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

func (s *Store) UpsertFreeProxies(proxies []FreeProxyRecord) (int, error) {
	const batchSize = 500
	processed := 0

	for offset := 0; offset < len(proxies); offset += batchSize {
		end := min(offset+batchSize, len(proxies))
		batch := proxies[offset:end]
		args := make([]any, 0, len(batch)*5)
		proxyURLs := make([]string, 0, len(batch))
		var query strings.Builder
		query.WriteString(`
			INSERT INTO free_proxies (
				proxy_url, protocol, host, port, source, status, failure_count, last_error, quarantined_until, updated_at
			)
			VALUES `)

		for index, proxy := range batch {
			if index > 0 {
				query.WriteString(", ")
			}
			placeholder := index*5 + 1
			fmt.Fprintf(
				&query,
				"($%d, $%d, $%d, $%d, $%d, 'pending', 0, NULL, NULL, NOW())",
				placeholder,
				placeholder+1,
				placeholder+2,
				placeholder+3,
				placeholder+4,
			)
			args = append(args, proxy.ProxyURL, proxy.Protocol, proxy.Host, proxy.Port, proxy.Source)
			proxyURLs = append(proxyURLs, proxy.ProxyURL)
		}

		query.WriteString(`
			ON CONFLICT (proxy_url) DO UPDATE
			SET protocol = EXCLUDED.protocol,
				host = EXCLUDED.host,
				port = EXCLUDED.port,
				source = EXCLUDED.source,
				status = CASE
					WHEN free_proxies.status = 'disabled'
					  AND (EXCLUDED.source LIKE 'iplocate%' OR EXCLUDED.source = 'proxyscrape')
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
					  AND (EXCLUDED.source LIKE 'iplocate%' OR EXCLUDED.source = 'proxyscrape')
					  AND (
						free_proxies.last_error LIKE 'invalid config:%'
						OR free_proxies.last_checked_at IS NULL
						OR free_proxies.last_checked_at < NOW() - INTERVAL '6 hours'
					  )
					THEN NULL
					ELSE free_proxies.last_error
				END,
				updated_at = NOW()`)

		tx, err := s.db.Begin()
		if err != nil {
			return processed, err
		}
		result, err := tx.Exec(query.String(), args...)
		if err != nil {
			_ = tx.Rollback()
			return processed, err
		}
		if _, err := tx.Exec(`
			UPDATE free_proxy_health fph
			SET status = 'pending',
				failure_streak = 0,
				last_error = NULL,
				next_check_at = NOW(),
				updated_at = NOW()
			FROM free_proxies fp
			WHERE fp.id = fph.proxy_id
			  AND fp.proxy_url = ANY($1)
			  AND (fp.source LIKE 'iplocate%' OR fp.source = 'proxyscrape')
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

func (s *Store) EnsureFreeProxyHealthRows(regions []string, limit int) error {
	if len(regions) == 0 {
		_, err := s.db.Exec(`DELETE FROM free_proxy_health`)
		return err
	}
	if limit <= 0 {
		limit = 1000
	}
	if _, err := s.db.Exec(`
		DELETE FROM free_proxy_health
		WHERE NOT (region = ANY($1))`, pq.Array(regions)); err != nil {
		return err
	}
	if _, err := s.db.Exec(`
		DELETE FROM free_proxy_health fph
		USING free_proxies fp
		WHERE fp.id = fph.proxy_id
		  AND fp.source LIKE 'iplocate:%'
		  AND fp.source <> 'iplocate:' || LOWER(fph.region)
		  AND fph.success_count = 0`,
	); err != nil {
		return err
	}

	for _, region := range regions {
		if _, err := s.db.Exec(`
			WITH desired AS (
				SELECT fp.id
				FROM free_proxies fp
				LEFT JOIN free_proxy_health current_health
				  ON current_health.proxy_id = fp.id
				 AND current_health.region = $1
				WHERE fp.status <> 'disabled'
				  AND (fp.source NOT LIKE 'iplocate:%' OR fp.source = 'iplocate:' || $1)
				ORDER BY
				  CASE
					WHEN current_health.status = 'active' THEN 0
					WHEN current_health.status = 'pending' AND current_health.success_streak > 0 THEN 1
					WHEN current_health.status = 'cooldown' THEN 2
					WHEN current_health.status = 'pending' THEN 3
					WHEN current_health.id IS NULL THEN 4
					ELSE 5
				  END,
				  CASE WHEN fp.source = 'iplocate:' || $1 THEN 0 ELSE 1 END,
				  CASE fp.protocol
					WHEN 'socks5' THEN 0
					WHEN 'http' THEN 1
					WHEN 'https' THEN 2
					WHEN 'socks4' THEN 3
					ELSE 3
				  END,
				  fp.last_success_at DESC NULLS LAST,
				  fp.failure_count ASC,
				  fp.updated_at DESC
				LIMIT $2
			), removed AS (
				DELETE FROM free_proxy_health fph
				WHERE fph.region = $1
				  AND NOT EXISTS (
					SELECT 1 FROM desired WHERE desired.id = fph.proxy_id
				  )
				RETURNING fph.id
			)
			INSERT INTO free_proxy_health (proxy_id, region, status, next_check_at, updated_at)
			SELECT desired.id, $1, 'pending', NOW(), NOW()
			FROM desired
			ON CONFLICT (proxy_id, region) DO NOTHING`, region, limit); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) GetFreeProxiesDueForCheck(regions []string, limit int, bootstrap bool) ([]FreeProxyCandidate, error) {
	if limit <= 0 {
		limit = 200
	}
	if len(regions) == 0 {
		regions = []string{"de"}
	}
	rows, err := s.db.Query(`
		SELECT fp.proxy_url, fph.region
		FROM free_proxy_health fph
		JOIN free_proxies fp ON fp.id = fph.proxy_id
		WHERE fph.region = ANY($1)
		  AND fp.status <> 'disabled'
		  AND fph.status IN ('pending', 'active', 'cooldown')
		  AND (fph.next_check_at IS NULL OR fph.next_check_at <= NOW())
		ORDER BY
		  CASE
			WHEN fph.status = 'active' THEN 0
			WHEN fph.status = 'pending' AND fph.success_streak > 0 THEN 1
			WHEN fph.status = 'cooldown' THEN 2
			WHEN $3 AND fph.status = 'pending' AND fph.success_streak = 0 AND fph.last_checked_at IS NULL THEN 3
			ELSE 4
		  END,
		  fph.success_streak DESC,
		  fph.last_checked_at ASC NULLS FIRST,
		  fph.score DESC
		LIMIT $2`, pq.Array(regions), limit, bootstrap)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var proxies []FreeProxyCandidate
	for rows.Next() {
		var candidate FreeProxyCandidate
		if err := rows.Scan(&candidate.ProxyURL, &candidate.Region); err != nil {
			return nil, err
		}
		proxies = append(proxies, candidate)
	}
	return proxies, rows.Err()
}

func (s *Store) RecordFreeProxySuccess(proxyURL string, region string, latencyMs int) {
	if proxyURL == "" {
		return
	}
	if _, err := s.db.Exec(`
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
			next_check_at = NOW() + INTERVAL '10 minutes',
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
			updated_at = NOW()
		WHERE fp.id IN (SELECT proxy_id FROM updated_health)`, proxyURL, region, latencyMs); err != nil {
		log.Printf("free proxy success update failed: %v", err)
	}
}

func (s *Store) RecordFreeProxyFailure(proxyURL string, region string, statusCode int, message string, failureThreshold int, quarantineMinutes int) {
	if proxyURL == "" {
		return
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
	if _, err := s.db.Exec(`
		WITH updated_health AS (
		UPDATE free_proxy_health fph
		SET failure_streak = fph.failure_streak + 1,
			success_streak = 0,
			failure_count = fph.failure_count + 1,
			last_status_code = NULLIF($3, 0),
			last_checked_at = NOW(),
			last_failure_at = NOW(),
			last_error = $4,
			status = CASE
				WHEN fph.status = 'pending' AND fph.success_streak = 0 THEN 'dead'
				WHEN fph.status = 'cooldown' AND fph.failure_streak + 1 >= $5 THEN 'dead'
				WHEN fph.status = 'active' THEN 'cooldown'
				WHEN fph.failure_streak + 1 >= $5 THEN 'cooldown'
				ELSE 'cooldown'
			END,
			next_check_at = CASE
				WHEN fph.status = 'pending' AND fph.success_streak = 0 THEN NULL
				WHEN fph.status = 'cooldown' AND fph.failure_streak + 1 >= $5 THEN NULL
				WHEN fph.status = 'active' THEN NOW() + INTERVAL '1 minute'
				ELSE NOW() + ($6::text || ' minutes')::interval
			END,
			score = CASE
				WHEN fph.status = 'pending' AND fph.success_streak = 0 THEN 0
				ELSE GREATEST(0, fph.score - 40)
			END,
			updated_at = NOW()
		FROM free_proxies fp
		WHERE fp.id = fph.proxy_id
		  AND fp.proxy_url = $1
		  AND fph.region = $2
		RETURNING fph.proxy_id
		)
		UPDATE free_proxies fp
		SET failure_count = failure_count + 1,
			last_checked_at = NOW(),
			last_failure_at = NOW(),
			last_error = $4,
			updated_at = NOW()
		WHERE fp.id IN (SELECT proxy_id FROM updated_health)`, proxyURL, region, statusCode, message, failureThreshold, quarantineMinutes); err != nil {
		log.Printf("free proxy failure update failed: %v", err)
	}
}

func (s *Store) DisableGloballyDeadFreeProxies() {
	if _, err := s.db.Exec(`
		UPDATE free_proxies fp
		SET status = 'disabled',
			updated_at = NOW(),
			last_error = 'disabled after failing all regional Vinted checks'
		WHERE fp.status <> 'disabled'
		  AND EXISTS (
			SELECT 1
			FROM free_proxy_health fph
			WHERE fph.proxy_id = fp.id
		  )
		  AND NOT EXISTS (
			SELECT 1
			FROM free_proxy_health fph
			WHERE fph.proxy_id = fp.id
			  AND fph.status <> 'dead'
		  )`); err != nil {
		log.Printf("free proxy dead disable failed: %v", err)
	}
}

func (s *Store) CountActiveFreeProxies(region string) (int, error) {
	var count int
	err := s.db.QueryRow(`
		SELECT COUNT(*)
		FROM free_proxy_health fph
		JOIN free_proxies fp ON fp.id = fph.proxy_id
		WHERE fph.region = $1
		  AND (
			fph.status = 'active'
			OR (fph.status = 'pending' AND fph.success_streak > 0)
		  )
		  AND fph.success_streak > 0
		  AND fph.last_status_code = 200
		  AND fph.last_error IS NULL
		  AND fph.last_success_at >= NOW() - INTERVAL '20 minutes'
		  AND fp.status <> 'disabled'`, region).Scan(&count)
	return count, err
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
		SELECT m.id, m."userId", m.name, m.query, m.anti_keywords, m.query_delay_ms, m.quiet_hours_enabled, m.quiet_hours_start_minute, m.quiet_hours_end_minute, m.quiet_hours_mode, m.quiet_hours_delay_ms, m.quiet_hours_timezone, m.price_min, m.price_max, m.size_id, m.catalog_ids, m.brand_ids, m.color_ids, m.status_ids, m.region, m.allowed_countries, m.status, m.discord_webhook, m.webhook_active, tc.chat_id, m.telegram_active, u.dedupe_monitor_alerts, m.proxy_group_id, COALESCE(NULLIF(m.proxy_source, ''), CASE WHEN m.proxy_group_id IS NULL THEN 'server' ELSE 'group' END), pg.name, pg.bandwidth_limit_bytes, COALESCE(pg.bandwidth_rx_bytes, 0), COALESCE(pg.bandwidth_tx_bytes, 0), pg.bandwidth_reset_at, pg.proxies
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
		if err := rows.Scan(&m.ID, &m.UserID, &m.Name, &m.Query, &m.AntiKeywords, &m.QueryDelayMs, &m.QuietHoursEnabled, &m.QuietHoursStartMinute, &m.QuietHoursEndMinute, &m.QuietHoursMode, &m.QuietHoursDelayMs, &m.QuietHoursTimezone, &m.PriceMin, &m.PriceMax, &m.SizeID, &m.CatalogIDs, &m.BrandIDs, &m.ColorIDs, &m.StatusIDs, &m.Region, &m.AllowedCountries, &m.Status, &m.DiscordWebhook, &m.WebhookActive, &m.TelegramChatID, &m.TelegramActive, &m.DedupeMonitorAlerts, &m.ProxyGroupID, &m.ProxySource, &m.ProxyGroupName, &m.ProxyGroupLimitBytes, &m.ProxyGroupRxBytes, &m.ProxyGroupTxBytes, &m.ProxyGroupResetAt, &m.Proxies); err != nil {
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
		SELECT m.id, m."userId", m.name, m.query, m.anti_keywords, m.query_delay_ms, m.quiet_hours_enabled, m.quiet_hours_start_minute, m.quiet_hours_end_minute, m.quiet_hours_mode, m.quiet_hours_delay_ms, m.quiet_hours_timezone, m.price_min, m.price_max, m.size_id, m.catalog_ids, m.brand_ids, m.color_ids, m.status_ids, m.region, m.allowed_countries, m.status, m.discord_webhook, m.webhook_active, tc.chat_id, m.telegram_active, u.dedupe_monitor_alerts, m.proxy_group_id, COALESCE(NULLIF(m.proxy_source, ''), CASE WHEN m.proxy_group_id IS NULL THEN 'server' ELSE 'group' END), pg.name, pg.bandwidth_limit_bytes, COALESCE(pg.bandwidth_rx_bytes, 0), COALESCE(pg.bandwidth_tx_bytes, 0), pg.bandwidth_reset_at, pg.proxies
		FROM monitors m
		JOIN "User" u ON u.id = m."userId"
		LEFT JOIN proxy_groups pg ON m.proxy_group_id = pg.id
		LEFT JOIN telegram_connections tc ON tc."userId" = m."userId"
		WHERE m.id = $1`, id,
	).Scan(&m.ID, &m.UserID, &m.Name, &m.Query, &m.AntiKeywords, &m.QueryDelayMs, &m.QuietHoursEnabled, &m.QuietHoursStartMinute, &m.QuietHoursEndMinute, &m.QuietHoursMode, &m.QuietHoursDelayMs, &m.QuietHoursTimezone, &m.PriceMin, &m.PriceMax, &m.SizeID, &m.CatalogIDs, &m.BrandIDs, &m.ColorIDs, &m.StatusIDs, &m.Region, &m.AllowedCountries, &m.Status, &m.DiscordWebhook, &m.WebhookActive, &m.TelegramChatID, &m.TelegramActive, &m.DedupeMonitorAlerts, &m.ProxyGroupID, &m.ProxySource, &m.ProxyGroupName, &m.ProxyGroupLimitBytes, &m.ProxyGroupRxBytes, &m.ProxyGroupTxBytes, &m.ProxyGroupResetAt, &m.Proxies)
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
			"userId", monitor_id, item_id, channel, status, failure_reason, metadata
		)
		VALUES (NULLIF($1, ''), NULLIF($2, 0), NULLIF($3, 0::bigint), $4, $5, NULLIF($6, ''), $7::jsonb)`,
		event.UserID,
		event.MonitorID,
		event.ItemID,
		event.Channel,
		event.Status,
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
