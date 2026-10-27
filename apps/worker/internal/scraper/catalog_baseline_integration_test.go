package scraper

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"reflect"
	"testing"
	"time"

	"vintrack-worker/internal/database"
	"vintrack-worker/internal/model"
	"vintrack-worker/internal/proxy"
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
				ResumeAfterQuietHours: tc.resume,
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
