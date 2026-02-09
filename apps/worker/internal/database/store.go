package database

import (
	"database/sql"
	"sync"
	"vintrack-worker/internal/model"

	_ "github.com/lib/pq"
)

type Store struct {
	db        *sql.DB
	seenItems sync.Map
}

func NewStore(connStr string) (*Store, error) {
	db, err := sql.Open("postgres", connStr)
	if err != nil {
		return nil, err
	}

	if err := db.Ping(); err != nil {
		return nil, err
	}

	return &Store{db: db}, nil
}

func (s *Store) SaveItem(item model.Item) error {
	s.seenItems.Store(item.ID, true)

	query := `
		INSERT INTO items (id, monitor_id, title, price, url, image_url, found_at)
		VALUES ($1, $2, $3, $4, $5, $6, NOW())
		ON CONFLICT (id) DO NOTHING`

	_, err := s.db.Exec(query, item.ID, item.MonitorID, item.Title, item.Price, item.URL, item.ImageURL)
	return err
}

func (s *Store) IsNew(itemID int64) bool {
	_, exists := s.seenItems.Load(itemID)
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
