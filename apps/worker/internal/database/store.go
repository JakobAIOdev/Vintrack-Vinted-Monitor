package database

import (
	"database/sql"
	"fmt"
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
		return nil, err
	}

	if err := db.Ping(); err != nil {
		return nil, err
	}

	numCPU := runtime.NumCPU()
	db.SetMaxOpenConns(numCPU * 4)
	db.SetMaxIdleConns(numCPU * 2)
	db.SetConnMaxLifetime(10 * time.Minute)
	db.SetConnMaxIdleTime(5 * time.Minute)

	fmt.Printf("PostgreSQL connected (Pool: %d max, %d idle)\n",
		numCPU*4, numCPU*2)

	return &Store{
		db:    db,
		cache: redisCache,
	}, nil
}

func (s *Store) IsNew(itemID int64) bool {
	if s.cache != nil {
		return s.cache.IsNew(itemID)
	}

	var exists bool
	err := s.db.QueryRow("SELECT EXISTS(SELECT 1 FROM items WHERE id = $1)", itemID).Scan(&exists)
	if err != nil {
		fmt.Println("DB Error in IsNew:", err)
		return false
	}

	return !exists
}

func (s *Store) BatchIsNew(itemIDs []int64) map[int64]bool {
	if s.cache != nil {
		result, err := s.cache.BatchIsNew(itemIDs)
		if err == nil {
			return result
		}
		fmt.Printf("Redis batch check error: %v, falling back to individual checks\n", err)
	}

	result := make(map[int64]bool, len(itemIDs))
	for _, id := range itemIDs {
		result[id] = s.IsNew(id)
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
		ON CONFLICT (id) DO NOTHING
	`,
		item.ID,
		item.MonitorID,
		item.Title,
		item.Price,
		item.Size,
		item.Condition,
		item.URL,
		item.ImageURL,
		item.Location,
		item.Rating,
		time.Now(),
	)

	if err != nil {
		return err
	}

	if s.cache != nil {
		if err := s.cache.MarkAsSeen(item.ID); err != nil {
			fmt.Printf("Redis cache update failed: %v\n", err)
		}
	}

	return nil
}

func (s *Store) GetActiveMonitors() ([]model.Monitor, error) {
	query := `
		SELECT id, query, price_min, price_max, size_id, status, discord_webhook, webhook_active
		FROM monitors
		WHERE status = 'active'
	`

	rows, err := s.db.Query(query)
	if err != nil {
		return nil, err
	}

	defer rows.Close()

	var monitors []model.Monitor
	for rows.Next() {
		var m model.Monitor
		err := rows.Scan(
			&m.ID,
			&m.Query,
			&m.PriceMin,
			&m.PriceMax,
			&m.SizeID,
			&m.Status,
			&m.DiscordWebhook,
			&m.WebhookActive,
		)
		if err != nil {
			return nil, err
		}

		monitors = append(monitors, m)
	}

	return monitors, nil
}

func (s *Store) GetMonitorByID(id int) (model.Monitor, error) {
	query := `
		SELECT id, query, price_min, price_max, size_id, status, discord_webhook, webhook_active
		FROM monitors
		WHERE id = $1
	`

	var m model.Monitor
	err := s.db.QueryRow(query, id).Scan(
		&m.ID,
		&m.Query,
		&m.PriceMin,
		&m.PriceMax,
		&m.SizeID,
		&m.Status,
		&m.DiscordWebhook,
		&m.WebhookActive,
	)

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

func (s *Store) PublishItem(item model.Item) error {
	if s.cache != nil {
		return s.cache.PublishNewItem(item)
	}
	return nil
}
