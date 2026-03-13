package database

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"runtime"
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

	return &Store{db: db, cache: redisCache, healthErrLog: make(map[int]time.Time)}, nil
}

func (s *Store) BatchIsNew(itemIDs []int64) map[int64]bool {
	if s.cache != nil {
		result, err := s.cache.BatchIsNew(itemIDs)
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

	args := make([]interface{}, len(itemIDs))
	placeholders := make([]string, len(itemIDs))
	for i, id := range itemIDs {
		args[i] = id
		placeholders[i] = fmt.Sprintf("$%d", i+1)
	}
	query := fmt.Sprintf("SELECT id FROM items WHERE id IN (%s)", strings.Join(placeholders, ","))
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

func (s *Store) SaveItem(item model.Item) error {
	if item.Size == "" {
		item.Size = "N/A"
	}
	if item.Condition == "" {
		item.Condition = "N/A"
	}

	_, err := s.db.Exec(`
		INSERT INTO items (id, monitor_id, title, brand, price, total_price, size, condition, url, image_url, extra_images, location, rating, seller_id, found_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
		ON CONFLICT (id) DO UPDATE SET 
			total_price = COALESCE(EXCLUDED.total_price, items.total_price),
			brand = COALESCE(EXCLUDED.brand, items.brand),
			extra_images = COALESCE(EXCLUDED.extra_images, items.extra_images)`,
		item.ID, item.MonitorID, item.Title, item.Brand, item.Price, nilIfEmpty(item.TotalPrice), item.Size, item.Condition,
		item.URL, item.ImageURL, pq.Array(item.ExtraImages), item.Location, item.Rating, nilIfZero(item.SellerID), item.FoundAt,
	)
	if err != nil {
		return fmt.Errorf("insert item %d: %w", item.ID, err)
	}

	if s.cache != nil {
		if err := s.cache.MarkAsSeen(item.ID); err != nil {
			log.Printf("redis mark-seen failed for %d: %v", item.ID, err)
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
		INSERT INTO items (id, monitor_id, title, brand, price, total_price, size, condition, url, image_url, extra_images, location, rating, seller_id, found_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
		ON CONFLICT (id) DO UPDATE SET 
			total_price = COALESCE(EXCLUDED.total_price, items.total_price),
			brand = COALESCE(EXCLUDED.brand, items.brand),
			extra_images = COALESCE(EXCLUDED.extra_images, items.extra_images)`)
	if err != nil {
		return fmt.Errorf("prepare: %w", err)
	}
	defer stmt.Close()

	for _, item := range items {
		_, err := stmt.Exec(item.ID, item.MonitorID, item.Title, item.Brand, item.Price, nilIfEmpty(item.TotalPrice), item.Size, item.Condition,
			item.URL, item.ImageURL, pq.Array(item.ExtraImages), item.Location, item.Rating, nilIfZero(item.SellerID), item.FoundAt)
		if err != nil {
			return fmt.Errorf("insert item %d: %w", item.ID, err)
		}
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit: %w", err)
	}

	if s.cache != nil {
		ids := make([]int64, len(items))
		for i, item := range items {
			ids[i] = item.ID
		}
		if err := s.cache.BatchMarkAsSeen(ids); err != nil {
			log.Printf("redis batch mark-seen failed: %v", err)
		}
	}

	return nil
}

func (s *Store) MarkItemsSeen(ids []int64) {
	if s.cache != nil {
		if err := s.cache.BatchMarkAsSeen(ids); err != nil {
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
		SELECT m.id, m.query, m.price_min, m.price_max, m.size_id, m.catalog_ids, m.brand_ids, m.color_ids, m.region, m.status, m.discord_webhook, m.webhook_active, m.proxy_group_id, pg.name, pg.proxies
		FROM monitors m
		LEFT JOIN proxy_groups pg ON m.proxy_group_id = pg.id
		WHERE m.status = 'active'`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var monitors []model.Monitor
	for rows.Next() {
		var m model.Monitor
		if err := rows.Scan(&m.ID, &m.Query, &m.PriceMin, &m.PriceMax, &m.SizeID, &m.CatalogIDs, &m.BrandIDs, &m.ColorIDs, &m.Region, &m.Status, &m.DiscordWebhook, &m.WebhookActive, &m.ProxyGroupID, &m.ProxyGroupName, &m.Proxies); err != nil {
			return nil, err
		}
		monitors = append(monitors, m)
	}
	return monitors, nil
}

func (s *Store) GetMonitorByID(id int) (model.Monitor, error) {
	var m model.Monitor
	err := s.db.QueryRow(`
		SELECT m.id, m.query, m.price_min, m.price_max, m.size_id, m.catalog_ids, m.brand_ids, m.color_ids, m.region, m.status, m.discord_webhook, m.webhook_active, m.proxy_group_id, pg.name, pg.proxies
		FROM monitors m
		LEFT JOIN proxy_groups pg ON m.proxy_group_id = pg.id
		WHERE m.id = $1`, id,
	).Scan(&m.ID, &m.Query, &m.PriceMin, &m.PriceMax, &m.SizeID, &m.CatalogIDs, &m.BrandIDs, &m.ColorIDs, &m.Region, &m.Status, &m.DiscordWebhook, &m.WebhookActive, &m.ProxyGroupID, &m.ProxyGroupName, &m.Proxies)
	if err != nil {
		return model.Monitor{}, err
	}
	return m, nil
}

func (s *Store) Close() error {
	if s.cache != nil {
		s.cache.Close()
	}
	return s.db.Close()
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
