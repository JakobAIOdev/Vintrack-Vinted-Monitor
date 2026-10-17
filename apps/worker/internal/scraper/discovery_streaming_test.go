package scraper

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"vintrack-worker/internal/model"
)

func discoveryTestItems(ids ...int64) []model.VintedItem {
	items := make([]model.VintedItem, len(ids))
	for i, id := range ids {
		items[i].ID = id
	}
	return items
}

func TestDiscoveryProcessesNewestItemsBeforeBlockedBackfill(t *testing.T) {
	scan := discoveryScan{
		seen:         map[int64]time.Time{1: time.Now()},
		previousPage: discoveryIDSet(discoveryTestItems(1)),
		initialized:  true,
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	backfillStarted := make(chan struct{})
	releaseBackfill := make(chan struct{})
	detected := make(chan int64, 2)
	done := make(chan int, 1)
	go func() {
		done <- scan.processPages(ctx, discoveryTestItems(3), 3, func(page int) catalogFetchResult {
			close(backfillStarted)
			select {
			case <-releaseBackfill:
				return catalogFetchResult{status: 200, items: discoveryTestItems(2, 1)}
			case <-ctx.Done():
				return catalogFetchResult{err: ctx.Err()}
			}
		}, func(item model.VintedItem) { detected <- item.ID })
	}()

	select {
	case <-backfillStarted:
	case <-time.After(time.Second):
		t.Fatal("backfill did not start")
	}
	select {
	case id := <-detected:
		if id != 3 {
			t.Fatalf("first detection = %d, want newest item 3", id)
		}
	default:
		t.Fatal("page-one detection waited for backfill")
	}
	close(releaseBackfill)
	select {
	case count := <-done:
		if count != 3 {
			t.Fatalf("row count = %d, want 3", count)
		}
	case <-time.After(time.Second):
		t.Fatal("discovery cycle did not complete")
	}
	select {
	case id := <-detected:
		if id != 2 {
			t.Fatalf("backfill detection = %d, want 2", id)
		}
	default:
		t.Fatal("backfill item 2 was not detected")
	}
}

func TestDiscoveryStreamingPreservesMutedBaselineAndCrossPageDedupe(t *testing.T) {
	scan := discoveryScan{seen: make(map[int64]time.Time)}
	var detected []int64
	process := func(item model.VintedItem) { detected = append(detected, item.ID) }
	count := scan.processPages(context.Background(), discoveryTestItems(2, 1), 3, func(int) catalogFetchResult {
		t.Fatal("initial baseline must not fetch backfill")
		return catalogFetchResult{}
	}, process)
	if count != 2 || len(detected) != 0 || !scan.initialized {
		t.Fatalf("baseline count=%d detected=%v initialized=%v", count, detected, scan.initialized)
	}

	var fetched []int
	count = scan.processPages(context.Background(), discoveryTestItems(5, 5, 4), 4, func(page int) catalogFetchResult {
		fetched = append(fetched, page)
		return catalogFetchResult{status: 200, items: discoveryTestItems(4, 3, 2)}
	}, process)
	if !reflect.DeepEqual(detected, []int64{5, 4, 3}) {
		t.Fatalf("detections = %v, want [5 4 3]", detected)
	}
	if count != 6 || !reflect.DeepEqual(fetched, []int{2}) {
		t.Fatalf("count=%d pages=%v, want 6 rows and stop at page 2 overlap", count, fetched)
	}
	if !reflect.DeepEqual(scan.previousPage, discoveryIDSet(discoveryTestItems(5, 4))) {
		t.Fatalf("next overlap state = %v, want current page-one IDs", scan.previousPage)
	}

	detected = nil
	scan.processPages(context.Background(), discoveryTestItems(6, 5), 3, func(int) catalogFetchResult {
		t.Fatal("page-one overlap must skip backfill")
		return catalogFetchResult{}
	}, process)
	if !reflect.DeepEqual(detected, []int64{6}) {
		t.Fatalf("next cycle detections = %v, want [6]", detected)
	}
}

func TestDiscoveryStreamingBoundsBackfillAndKeepsPageOneOnFailure(t *testing.T) {
	for _, tc := range []struct {
		name       string
		result     catalogFetchResult
		cancel     bool
		limit      int
		wantCalls  int
		wantRows   int
		wantDetect []int64
	}{
		{name: "network error", result: catalogFetchResult{err: errors.New("offline")}, limit: 3, wantCalls: 1, wantRows: 1, wantDetect: []int64{3}},
		{name: "rate limit", result: catalogFetchResult{status: 429}, limit: 3, wantCalls: 1, wantRows: 1, wantDetect: []int64{3}},
		{name: "empty page", result: catalogFetchResult{status: 200}, limit: 3, wantCalls: 1, wantRows: 1, wantDetect: []int64{3}},
		{name: "cancellation", cancel: true, limit: 3, wantRows: 1, wantDetect: []int64{3}},
		{name: "page bound", result: catalogFetchResult{status: 200, items: discoveryTestItems(2)}, limit: 3, wantCalls: 2, wantRows: 3, wantDetect: []int64{3, 2}},
		{name: "backfill disabled", limit: 1, wantRows: 1, wantDetect: []int64{3}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			scan := discoveryScan{
				seen:         map[int64]time.Time{1: time.Now()},
				previousPage: discoveryIDSet(discoveryTestItems(1)),
				initialized:  true,
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			var detected []int64
			calls := 0
			count := scan.processPages(ctx, discoveryTestItems(3), tc.limit, func(int) catalogFetchResult {
				calls++
				return tc.result
			}, func(item model.VintedItem) {
				detected = append(detected, item.ID)
				if tc.cancel {
					cancel()
				}
			})
			if count != tc.wantRows || calls != tc.wantCalls || !reflect.DeepEqual(detected, tc.wantDetect) {
				t.Fatalf("rows=%d calls=%d detections=%v, want %d/%d/%v", count, calls, detected, tc.wantRows, tc.wantCalls, tc.wantDetect)
			}
		})
	}
}
