package database

import (
	"context"
	"time"

	"github.com/lib/pq"
)

// SyncMonitorCatalogBaselines loads the fixed boundaries for the current
// searches and removes obsolete searches, keeping storage bounded per monitor.
func (s *Store) SyncMonitorCatalogBaselines(ctx context.Context, monitorID int, queryKeys []string) (map[string]int64, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `DELETE FROM monitor_catalog_baselines
		WHERE monitor_id = $1 AND NOT (query_key = ANY($2))`, monitorID, pq.Array(queryKeys)); err != nil {
		return nil, err
	}
	rows, err := tx.QueryContext(ctx, `SELECT query_key, item_id FROM monitor_catalog_baselines WHERE monitor_id = $1`, monitorID)
	if err != nil {
		return nil, err
	}
	baselines := make(map[string]int64, len(queryKeys))
	for rows.Next() {
		var key string
		var itemID int64
		if err := rows.Scan(&key, &itemID); err != nil {
			rows.Close()
			return nil, err
		}
		baselines[key] = itemID
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return baselines, nil
}

// EstablishMonitorCatalogBaseline never advances an existing boundary. Later
// out-of-order results must remain eligible, including after a worker restart.
func (s *Store) EstablishMonitorCatalogBaseline(ctx context.Context, monitorID int, queryKey string, itemID int64) (int64, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	var boundary int64
	err := s.db.QueryRowContext(ctx, `INSERT INTO monitor_catalog_baselines (monitor_id, query_key, item_id)
		VALUES ($1, $2, $3)
		ON CONFLICT (monitor_id, query_key) DO UPDATE SET item_id = monitor_catalog_baselines.item_id
		RETURNING item_id`, monitorID, queryKey, itemID).Scan(&boundary)
	return boundary, err
}
