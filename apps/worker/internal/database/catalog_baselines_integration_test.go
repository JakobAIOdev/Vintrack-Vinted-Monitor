package database

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"reflect"
	"testing"
	"time"
)

func TestMonitorCatalogBaselines(t *testing.T) {
	databaseURL := os.Getenv("MONITOR_ITEM_INTEGRATION_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("MONITOR_ITEM_INTEGRATION_DATABASE_URL is required")
	}
	db, err := sql.Open("postgres", databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	store := &Store{db: db}
	ctx := context.Background()
	userID := fmt.Sprintf("catalog-boundaries-test-%d", time.Now().UnixNano())
	if _, err := db.Exec(`INSERT INTO "User" (id, email, role) VALUES ($1, $2, 'free')`, userID, userID+"@example.test"); err != nil {
		t.Fatal(err)
	}
	defer db.Exec(`DELETE FROM "User" WHERE id = $1`, userID)
	var monitorID int
	if err := db.QueryRow(`INSERT INTO monitors ("userId", name, query) VALUES ($1, 'Baseline test', 'camera,photo') RETURNING id`, userID).Scan(&monitorID); err != nil {
		t.Fatal(err)
	}
	keys := []string{"camera", "photo"}
	for _, tc := range []struct {
		key  string
		id   int64
		want int64
	}{{"camera", 1000, 1000}, {"photo", 2000, 2000}, {"camera", 3000, 1000}} {
		got, err := store.EstablishMonitorCatalogBaseline(ctx, monitorID, tc.key, tc.id)
		if err != nil || got != tc.want {
			t.Fatalf("establish %s: boundary=%d err=%v, want %d", tc.key, got, err, tc.want)
		}
	}
	// Load through a fresh store to rule out an in-process baseline cache.
	store = &Store{db: db}
	got, err := store.SyncMonitorCatalogBaselines(ctx, monitorID, keys)
	if err != nil || !reflect.DeepEqual(got, map[string]int64{"camera": 1000, "photo": 2000}) {
		t.Fatalf("restored baselines=%v err=%v", got, err)
	}
	// Reordering alternatives preserves both; removing one bounds storage.
	got, err = store.SyncMonitorCatalogBaselines(ctx, monitorID, []string{"photo", "camera"})
	if err != nil || len(got) != 2 {
		t.Fatalf("reordered baselines=%v err=%v", got, err)
	}
	got, err = store.SyncMonitorCatalogBaselines(ctx, monitorID, []string{"camera"})
	if err != nil || !reflect.DeepEqual(got, map[string]int64{"camera": 1000}) {
		t.Fatalf("pruned baselines=%v err=%v", got, err)
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := store.EstablishMonitorCatalogBaseline(cancelled, monitorID, "photo", 2000); err == nil {
		t.Fatal("cancelled baseline write succeeded")
	}
	if _, err := store.SyncMonitorCatalogBaselines(cancelled, monitorID, nil); err == nil {
		t.Fatal("cancelled baseline load succeeded")
	}
	got, err = store.SyncMonitorCatalogBaselines(ctx, monitorID, keys)
	if err != nil || !reflect.DeepEqual(got, map[string]int64{"camera": 1000}) {
		t.Fatalf("failed operations changed baselines=%v err=%v", got, err)
	}
	if _, err := db.Exec(`DELETE FROM monitors WHERE id = $1`, monitorID); err != nil {
		t.Fatal(err)
	}
	var remaining int
	if err := db.QueryRow(`SELECT COUNT(*) FROM monitor_catalog_baselines WHERE monitor_id = $1`, monitorID).Scan(&remaining); err != nil || remaining != 0 {
		t.Fatalf("deleted monitor retained %d baselines: %v", remaining, err)
	}
}
