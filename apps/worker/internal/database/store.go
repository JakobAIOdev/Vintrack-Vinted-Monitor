package database

import (
	"database/sql"
	"fmt"
	"log"
	"runtime"
	"time"

	"vintrack-worker/internal/cache"
	"vintrack-worker/internal/model"

	_ "github.com/lib/pq"
)

type Store struct {
	db    *sql.DB
	cache *cache.RedisCache
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

	return &Store{db: db, cache: redisCache}, nil
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
		var exists bool
		err := s.db.QueryRow("SELECT EXISTS(SELECT 1 FROM items WHERE id = $1)", id).Scan(&exists)
		if err != nil {
			log.Printf("db IsNew error: %v", err)
			result[id] = false
			continue
		}
		result[id] = !exists
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
		INSERT INTO items (id, monitor_id, title, price, size, condition, url, image_url, location, rating, found_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
		ON CONFLICT (id) DO NOTHING`,
		item.ID, item.MonitorID, item.Title, item.Price, item.Size, item.Condition,
		item.URL, item.ImageURL, item.Location, item.Rating, item.FoundAt,
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

func (s *Store) GetActiveMonitors() ([]model.Monitor, error) {
	rows, err := s.db.Query(`
		SELECT id, query, price_min, price_max, size_id, catalog_ids, brand_ids, status, discord_webhook, webhook_active
		FROM monitors WHERE status = 'active'`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var monitors []model.Monitor
	for rows.Next() {
		var m model.Monitor
		if err := rows.Scan(&m.ID, &m.Query, &m.PriceMin, &m.PriceMax, &m.SizeID, &m.CatalogIDs, &m.BrandIDs, &m.Status, &m.DiscordWebhook, &m.WebhookActive); err != nil {
			return nil, err
		}
		monitors = append(monitors, m)
	}
	return monitors, nil
}

func (s *Store) GetMonitorByID(id int) (model.Monitor, error) {
	var m model.Monitor
	err := s.db.QueryRow(`
		SELECT id, query, price_min, price_max, size_id, catalog_ids, brand_ids, status, discord_webhook, webhook_active
		FROM monitors WHERE id = $1`, id,
	).Scan(&m.ID, &m.Query, &m.PriceMin, &m.PriceMax, &m.SizeID, &m.CatalogIDs, &m.BrandIDs, &m.Status, &m.DiscordWebhook, &m.WebhookActive)
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
