package database

import (
	"database/sql"
	"fmt"
	"time"
	"vintrack-worker/internal/model"

	_ "github.com/lib/pq"
)

type Store struct {
	db *sql.DB
}

func NewStore(connStr string) (*Store, error) {
	db, err := sql.Open("postgres", connStr)
	if err != nil {
		return nil, err
	}

	if err := db.Ping(); err != nil {
		return nil, err
	}

	db.SetMaxOpenConns(25)
	db.SetMaxIdleConns(5)
	db.SetConnMaxLifetime(5 * time.Minute)

	return &Store{db: db}, nil
}

func (s *Store) SaveItem(item model.Item) error {
	if item.Size == "" {
		item.Size = "N/A"
	}
	if item.Condition == "" {
		item.Condition = "N/A"
	}

	_, err := s.db.Exec(`
		INSERT INTO items (id, monitor_id, title, price, size, condition, url, image_url, found_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		ON CONFLICT (id) DO NOTHING
	`, item.ID, item.MonitorID, item.Title, item.Price, item.Size, item.Condition, item.URL, item.ImageURL, time.Now())

	return err
}

func (s *Store) IsNew(itemID int64) bool {
	var exists bool
	err := s.db.QueryRow("SELECT EXISTS(SELECT 1 FROM items WHERE id = $1)", itemID).Scan(&exists)
	if err != nil {
		fmt.Println("WARNING: DB Error in IsNew:", err)
		return false
	}
	return !exists
}

func (s *Store) GetActiveMonitors() ([]model.Monitor, error) {
	query := `SELECT id, query, price_min, price_max, size_id, status FROM monitors WHERE status = 'active'`

	rows, err := s.db.Query(query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var monitors []model.Monitor
	for rows.Next() {
		var m model.Monitor
		err := rows.Scan(&m.ID, &m.Query, &m.PriceMin, &m.PriceMax, &m.SizeID, &m.Status)
		if err != nil {
			return nil, err
		}
		monitors = append(monitors, m)
	}
	return monitors, nil
}
