package scraper

import (
	"context"
	"reflect"
	"testing"
	"time"

	"vintrack-worker/internal/model"
)

func TestCatalogBaselineRejectsResurfacedListingsWithoutAdvancingBoundary(t *testing.T) {
	var baseline catalogBaseline
	baseline.seed(discoveryTestItems(990, 1000, 995))
	for _, tc := range []struct {
		name string
		ids  []int64
		want []int64
	}{
		{"older page replaces current results", []int64{800, 850, 999, 1000}, []int64{}},
		{"new results", []int64{1030, 1020}, []int64{1030, 1020}},
		{"delayed indexing below latest result", []int64{1010, 1005}, []int64{1010, 1005}},
		{"mixed old and new", []int64{900, 1040, 700}, []int64{1040}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			items, blocked := baseline.filter(discoveryTestItems(tc.ids...))
			got := make([]int64, 0, len(items))
			for _, item := range items {
				got = append(got, item.ID)
			}
			if !reflect.DeepEqual(got, tc.want) || blocked != len(tc.ids)-len(tc.want) {
				t.Fatalf("allowed=%v blocked=%d, want %v/%d", got, blocked, tc.want, len(tc.ids)-len(tc.want))
			}
			if baseline.itemID != 1000 {
				t.Fatalf("startup boundary advanced to %d", baseline.itemID)
			}
		})
	}
}

func TestCatalogBaselinesKeepQueryBoundariesIndependent(t *testing.T) {
	baselines := make([]catalogBaseline, 2)
	baselines[0].seed(discoveryTestItems(1000))
	baselines[1].seed(discoveryTestItems(2000))
	item := model.VintedItem{ID: 1500}
	if !baselines[0].allows(item) || baselines[1].allows(item) {
		t.Fatal("each search alternative must retain its own startup boundary")
	}
}

func TestDiscoveryBackfillRejectsIDsBelowStartupBoundary(t *testing.T) {
	scan := discoveryScan{seen: make(map[int64]time.Time)}
	var detected []int64
	process := func(item model.VintedItem) { detected = append(detected, item.ID) }
	ctx := context.Background()
	scan.processPages(ctx, discoveryTestItems(1000, 990), 2, nil, process)
	count := scan.processPages(ctx, discoveryTestItems(1050), 2, func(page int) catalogFetchResult {
		if page != 2 {
			t.Fatalf("unexpected backfill page %d", page)
		}
		return catalogFetchResult{status: 200, items: discoveryTestItems(1040, 900, 1000)}
	}, process)
	if count != 4 || !reflect.DeepEqual(detected, []int64{1050, 1040}) {
		t.Fatalf("rows=%d detections=%v, want 4/[1050 1040]", count, detected)
	}
}

func TestDiscoveryEmptyStartupWaitsForMutedBaseline(t *testing.T) {
	scan := discoveryScan{seen: make(map[int64]time.Time)}
	var detected []int64
	process := func(item model.VintedItem) { detected = append(detected, item.ID) }
	noBackfill := func(int) catalogFetchResult {
		t.Fatal("overlapping or initial pages must not fetch backfill")
		return catalogFetchResult{}
	}
	for range 3 {
		scan.processPages(context.Background(), nil, 1, noBackfill, process)
	}
	if scan.initialized {
		t.Fatal("empty successful pages must not finish startup")
	}
	scan.processPages(context.Background(), discoveryTestItems(1000, 990), 1, noBackfill, process)
	if len(detected) != 0 || !scan.initialized {
		t.Fatalf("first nonempty page was not muted: detected=%v initialized=%v", detected, scan.initialized)
	}
	// The old page contains previously unseen IDs, so a seen-set alone would
	// publish every entry. Clearing it also models pruning or expired cache.
	clear(scan.seen)
	scan.processPages(context.Background(), discoveryTestItems(800, 900), 1, noBackfill, process)
	scan.processPages(context.Background(), discoveryTestItems(1030), 1, noBackfill, process)
	scan.processPages(context.Background(), discoveryTestItems(1010), 1, noBackfill, process)
	if !reflect.DeepEqual(detected, []int64{1030, 1010}) {
		t.Fatalf("detections=%v, want [1030 1010]", detected)
	}
}
