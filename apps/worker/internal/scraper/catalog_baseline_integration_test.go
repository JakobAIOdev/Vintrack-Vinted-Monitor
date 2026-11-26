package scraper

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"reflect"
	"testing"
	"time"

	"vintrack-worker/internal/cache"
	"vintrack-worker/internal/database"
	"vintrack-worker/internal/model"
	"vintrack-worker/internal/proxy"

	"github.com/redis/go-redis/v9"
)

// Exercise the actual polling loop and claim order against PostgreSQL, while
// capturing downstream jobs instead of starting delivery or network workers.
func TestMonitorTaskRejectsHistoricalCatalogPages(t *testing.T) {
	databaseURL := os.Getenv("MONITOR_ITEM_INTEGRATION_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("MONITOR_ITEM_INTEGRATION_DATABASE_URL is required")
	}
	t.Setenv("VINTED_MOCK_DISCORD_WEBHOOK_URL", "")
	db, err := sql.Open("postgres", databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	store, err := database.NewStore(databaseURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	userID := fmt.Sprintf("catalog-baseline-test-%d", time.Now().UnixNano())
	t.Cleanup(func() {
		_ = store.Close()
		_, _ = db.Exec(`DELETE FROM "User" WHERE id = $1`, userID)
	})
	if _, err := db.Exec(`INSERT INTO "User" (id, email, role) VALUES ($1, $2, 'free')`, userID, userID+"@example.test"); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name      string
		query     string
		pages     [][]int64
		titles    map[int64]string
		resume    bool
		savedItem int64
		want      []int64
	}{
		{
			name:  "empty startup then old page and delayed new items",
			pages: [][]int64{nil, nil, {1000, 990}, {800, 900}, {1030}, {1010}},
			want:  []int64{1030, 1010},
		},
		{
			name:   "baseline uses raw page before title filtering",
			pages:  [][]int64{{2000}, {1500}, {2100}},
			titles: map[int64]string{2000: "Unrelated listing"},
			want:   []int64{2100},
		},
		{
			name:  "search alternatives keep independent boundaries",
			query: "camera,photo",
			pages: [][]int64{{1000}, {2000}, {1500}, {1900}, {1400}, {2010}},
			want:  []int64{1500, 1400, 2010},
		},
		{
			name:   "quiet-hours catch-up still excludes saved items",
			pages:  [][]int64{{3000, 2900}, {2800, 3010}},
			resume: true, savedItem: 3000,
			want: []int64{2900, 3010},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var monitorID int
			if err := db.QueryRow(`INSERT INTO monitors ("userId", name, query, status, region)
				VALUES ($1, 'Baseline test', 'camera', 'active', 'pl') RETURNING id`, userID).Scan(&monitorID); err != nil {
				t.Fatal(err)
			}
			if tc.savedItem > 0 {
				if _, err := db.Exec(`INSERT INTO items (id, monitor_id, title, price, found_at)
					VALUES ($1, $2, 'Known camera', '10 PLN', NOW() - INTERVAL '24 days')`, tc.savedItem, monitorID); err != nil {
					t.Fatal(err)
				}
			}
			if tc.resume {
				key := catalogBaselineKey(BuildVintedURLForQuery(model.Monitor{Region: "pl"}, "camera"))
				if _, err := store.EstablishMonitorCatalogBaseline(context.Background(), monitorID, key, 2850); err != nil {
					t.Fatal(err)
				}
			}
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			fetcher := &baselineScriptedFetcher{pages: tc.pages, titles: tc.titles, cancel: cancel}
			scheduler := NewSellerEnrichmentScheduler(32, 1)
			engine := &Engine{
				db: store, serverProxy: &proxy.Manager{}, fetcher: fetcher,
				jobsCtx: context.Background(), enrichmentScheduler: scheduler,
			}
			query := tc.query
			if query == "" {
				query = "camera"
			}
			engine.MonitorTask(ctx, model.Monitor{
				ID: monitorID, UserID: userID, Query: query, TitleOnly: true,
				Region: "pl", Status: "active", QueryDelayMs: 1,
			})
			if fetcher.index != len(tc.pages) {
				t.Fatalf("processed %d/%d pages", fetcher.index, len(tc.pages))
			}
			var got []int64
			for len(scheduler.backgroundInput) > 0 {
				got = append(got, (<-scheduler.backgroundInput).item.ID)
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("downstream items=%v, want %v", got, tc.want)
			}
		})
	}
}

type baselineScriptedFetcher struct {
	pages  [][]int64
	titles map[int64]string
	index  int
	cancel context.CancelFunc
}

func (*baselineScriptedFetcher) RequiresNetwork() bool { return false }
func (*baselineScriptedFetcher) Name() string          { return "baseline-regression" }
func (f *baselineScriptedFetcher) FetchCatalog(context.Context, *Client, string, string) ([]model.VintedItem, int, error) {
	if f.index == len(f.pages) {
		f.cancel()
		return nil, 200, nil
	}
	items := discoveryTestItems(f.pages[f.index]...)
	f.index++
	for i := range items {
		items[i].Title = "Camera photo"
		if title, ok := f.titles[items[i].ID]; ok {
			items[i].Title = title
		}
	}
	return items, 200, nil
}

func newCatalogBaselineTestMonitor(t *testing.T, query string, withRedis bool) (*sql.DB, *database.Store, model.Monitor) {
	t.Helper()
	databaseURL := os.Getenv("MONITOR_ITEM_INTEGRATION_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("MONITOR_ITEM_INTEGRATION_DATABASE_URL is required")
	}
	db, err := sql.Open("postgres", databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	var redisCache *cache.RedisCache
	if withRedis {
		addr := os.Getenv("REDIS_INTEGRATION_ADDR")
		if addr == "" {
			t.Skip("REDIS_INTEGRATION_ADDR is required")
		}
		redisCache, err = cache.NewRedisCache(addr, os.Getenv("REDIS_INTEGRATION_PASSWORD"), 15)
		if err != nil {
			t.Fatal(err)
		}
	}
	store, err := database.NewStore(databaseURL, redisCache)
	if err != nil {
		if redisCache != nil {
			redisCache.Close()
		}
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	userID := fmt.Sprintf("baseline-restart-test-%d", time.Now().UnixNano())
	if _, err := db.Exec(`INSERT INTO "User" (id, email, role) VALUES ($1, $2, 'free')`, userID, userID+"@example.test"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = db.Exec(`DELETE FROM "User" WHERE id = $1`, userID) })
	var monitorID int
	if err := db.QueryRow(`INSERT INTO monitors ("userId", name, query, status, region)
		VALUES ($1, 'Restart test', $2, 'active', 'pl') RETURNING id`, userID, query).Scan(&monitorID); err != nil {
		t.Fatal(err)
	}
	return db, store, model.Monitor{ID: monitorID, UserID: userID, Query: query, Region: "pl", Status: "active", QueryDelayMs: 1}
}

func runCatalogBaselineTestPages(t *testing.T, store *database.Store, monitor model.Monitor, pages [][]int64, want []int64) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	fetcher := &baselineScriptedFetcher{pages: pages, cancel: cancel}
	scheduler := NewSellerEnrichmentScheduler(32, 1)
	engine := &Engine{db: store, serverProxy: &proxy.Manager{}, fetcher: fetcher,
		jobsCtx: context.Background(), enrichmentScheduler: scheduler}
	engine.MonitorTask(ctx, monitor)
	if fetcher.index != len(pages) {
		t.Fatalf("processed %d/%d pages", fetcher.index, len(pages))
	}
	var got []int64
	for len(scheduler.backgroundInput) > 0 {
		got = append(got, (<-scheduler.backgroundInput).item.ID)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("downstream items=%v, want %v", got, want)
	}
}

func TestMonitorTaskKeepsMutedBaselineAfterRestart(t *testing.T) {
	for _, withRedis := range []bool{false, true} {
		for _, multiQuery := range []bool{false, true} {
			t.Run(fmt.Sprintf("redis=%t/multiple_queries=%t", withRedis, multiQuery), func(t *testing.T) {
				query := "camera"
				initialPages := [][]int64{{1000, 990}, {1030}}
				initialAlerts := []int64{1030}
				resumePages := [][]int64{{1040, 1030, 1000, 990}, {1010}, {800}}
				resumeAlerts := []int64{1040, 1010}
				if multiQuery {
					query = "camera,photo"
					initialPages = [][]int64{{1000, 990}, {2000, 1990}, {1500}, {2010}}
					initialAlerts = []int64{1500, 2010}
					resumePages = [][]int64{{2020, 2010, 2000, 1990}, {1510, 1500, 1000, 990}, {2005}, {1400}}
					resumeAlerts = []int64{2020, 1510, 2005, 1400}
				}
				db, store, monitor := newCatalogBaselineTestMonitor(t, query, withRedis)
				// Legacy monitors also arrive in resume mode without durable state.
				prepareMonitorResume(&monitor)
				runCatalogBaselineTestPages(t, store, monitor, initialPages, initialAlerts)
				for _, id := range initialAlerts {
					if _, err := db.Exec(`INSERT INTO items (id, monitor_id, title, price) VALUES ($1, $2, 'Known camera', '10 PLN')`, id, monitor.ID); err != nil {
						t.Fatal(err)
					}
				}
				if withRedis {
					client := redis.NewClient(&redis.Options{Addr: os.Getenv("REDIS_INTEGRATION_ADDR"), Password: os.Getenv("REDIS_INTEGRATION_PASSWORD"), DB: 15})
					defer client.Close()
					ctx := context.Background()
					keys := make([]string, 8)
					for offset := range keys {
						keys[offset] = fmt.Sprintf("item:seen:v2:%d:%s", monitor.ID, time.Now().UTC().AddDate(0, 0, -offset).Format("2006-01-02"))
					}
					defer client.Del(ctx, keys...)
					before := store.BatchIsNew(monitor.ID, []int64{1000, 990})
					if before[1000] || before[990] {
						t.Fatal("baseline was not recorded in Redis")
					}
					// Simulate day-eight bucket expiry while Redis remains healthy.
					if err := client.Del(ctx, keys...).Err(); err != nil {
						t.Fatal(err)
					}
					after := store.BatchIsNew(monitor.ID, []int64{1000, 990})
					if !after[1000] || !after[990] {
						t.Fatal("Redis still remembers the expired baseline")
					}
				}
				if multiQuery {
					monitor.Query = "photo,camera" // Boundaries must follow the search, not its index.
				}
				// A new engine has no local seen map or in-memory baseline.
				runCatalogBaselineTestPages(t, store, monitor, resumePages, resumeAlerts)
			})
		}
	}
}

func TestMonitorTaskRetriesBaselinePersistence(t *testing.T) {
	db, store, monitor := newCatalogBaselineTestMonitor(t, "camera", false)
	// Fail only this monitor's first baseline write. Sequence changes survive
	// transaction rollback, so the following retry can succeed normally.
	name := fmt.Sprintf("baseline_failure_%d", monitor.ID)
	statement := fmt.Sprintf(`CREATE SEQUENCE %[1]s;
		CREATE FUNCTION %[1]s() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN
			IF NEW.monitor_id = %[2]d AND nextval('%[1]s') = 1 THEN
				RAISE EXCEPTION 'injected baseline write failure';
			END IF;
			RETURN NEW;
		END $$;
		CREATE TRIGGER %[1]s BEFORE INSERT ON monitor_catalog_baselines FOR EACH ROW EXECUTE FUNCTION %[1]s();`, name, monitor.ID)
	if _, err := db.Exec(statement); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = db.Exec(fmt.Sprintf(`DROP TRIGGER %s ON monitor_catalog_baselines; DROP FUNCTION %s(); DROP SEQUENCE %s;`, name, name, name))
	})
	// The original boundary must be retried, not replaced by the newer page.
	runCatalogBaselineTestPages(t, store, monitor, [][]int64{{1000, 990}, {1040}, {1010}, {800}}, []int64{1040, 1010})
	var boundary int64
	if err := db.QueryRow(`SELECT item_id FROM monitor_catalog_baselines WHERE monitor_id = $1`, monitor.ID).Scan(&boundary); err != nil || boundary != 1000 {
		t.Fatalf("persisted boundary=%d err=%v, want 1000", boundary, err)
	}
}
