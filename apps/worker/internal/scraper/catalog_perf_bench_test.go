package scraper

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"testing"
	"time"

	"vintrack-worker/internal/model"
)

// This file holds the offline performance baseline for the catalog hot path.
// Every benchmark here is deterministic and network-free: fetches go through
// stub CatalogFetcher implementations, and decoding uses a synthetic payload
// shaped like a real Vinted catalog page.

const (
	// canonical monitor pages request per_page=20; discovery uses 96.
	catalogBenchCanonicalPageSize = 20
	catalogBenchDiscoveryPageSize = 96
)

// catalogBenchItems builds a deterministic, realistically shaped catalog page.
func catalogBenchItems(count int) []model.VintedItem {
	items := make([]model.VintedItem, count)
	for i := range items {
		id := int64(900000000 + i)
		total := model.VintedPrice{Amount: fmt.Sprintf("%d.99", 20+i%40), Currency: "EUR"}
		items[i] = model.VintedItem{
			ID:          id,
			Title:       fmt.Sprintf("Nike Air Max 90 Sneaker Gr %d Original", 36+i%12),
			Description: "Getragen, guter Zustand, keine Mängel. Versand am selben Tag möglich.",
			Price:       model.VintedPrice{Amount: fmt.Sprintf("%d.00", 18+i%40), Currency: "EUR"},
			// roughly half of the live rows carry a total price
			TotalItemPrice: func() *model.VintedPrice {
				if i%2 == 0 {
					return &total
				}
				return nil
			}(),
			Url:        fmt.Sprintf("/items/%d-nike-air-max-90", id),
			Photo:      model.VintedPhoto{Url: fmt.Sprintf("https://images.vinted.net/t/%d/main.jpeg", id)},
			Photos:     catalogBenchPhotos(id, 4),
			SizeTitle:  fmt.Sprintf("%d", 36+i%12),
			Size:       fmt.Sprintf("%d", 36+i%12),
			BrandTitle: "Nike",
			Condition:  "Sehr gut",
			User:       model.VintedUser{ID: int64(700000 + i%97), Login: fmt.Sprintf("seller_%d", 700000+i%97)},
		}
	}
	return items
}

func catalogBenchPhotos(id int64, count int) []model.VintedPhoto {
	photos := make([]model.VintedPhoto, count)
	for i := range photos {
		photos[i] = model.VintedPhoto{Url: fmt.Sprintf("https://images.vinted.net/t/%d/photo-%d.jpeg", id, i)}
	}
	return photos
}

func catalogBenchPayload(tb testing.TB, count int) []byte {
	tb.Helper()
	raw, err := json.Marshal(model.VintedResponse{Items: catalogBenchItems(count)})
	if err != nil {
		tb.Fatalf("marshal benchmark payload: %v", err)
	}
	return raw
}

func catalogBenchMonitor() model.Monitor {
	return model.Monitor{
		ID:     4242,
		Region: "de",
		Query:  "nike air max",
		Name:   "bench monitor",
	}
}

// catalogBenchEngine returns an Engine usable for pure CPU paths. It has no
// database, Redis, or proxy manager, so only functions that do not touch
// durable state may be benchmarked with it.
func catalogBenchEngine() *Engine {
	return &Engine{fetcher: VintedCatalogFetcher{}}
}

// ---------------------------------------------------------------------------
// Decode
// ---------------------------------------------------------------------------

// BenchmarkCatalogDecodeResponse measures the JSON decode the live fetcher runs
// on every successful catalog response, through the same
// json.NewDecoder(io.LimitReader(...)) shape as fetchCatalogAttempt.
func BenchmarkCatalogDecodeResponse(b *testing.B) {
	for _, size := range []int{catalogBenchCanonicalPageSize, catalogBenchDiscoveryPageSize} {
		payload := catalogBenchPayload(b, size)
		b.Run(fmt.Sprintf("items=%d", size), func(b *testing.B) {
			b.SetBytes(int64(len(payload)))
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				var data model.VintedResponse
				if err := json.NewDecoder(bytes.NewReader(payload)).Decode(&data); err != nil {
					b.Fatalf("decode: %v", err)
				}
				if len(data.Items) != size {
					b.Fatalf("decoded %d items, want %d", len(data.Items), size)
				}
			}
		})
	}
}

// ---------------------------------------------------------------------------
// buildItems
// ---------------------------------------------------------------------------

// BenchmarkCatalogBuildItems measures the whole-page model conversion.
func BenchmarkCatalogBuildItems(b *testing.B) {
	engine := catalogBenchEngine()
	monitor := catalogBenchMonitor()
	for _, size := range []int{catalogBenchCanonicalPageSize, catalogBenchDiscoveryPageSize} {
		items := catalogBenchItems(size)
		b.Run(fmt.Sprintf("items=%d", size), func(b *testing.B) {
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				built := engine.buildItems(monitor, items)
				if len(built) != size {
					b.Fatalf("built %d items, want %d", len(built), size)
				}
			}
		})
	}
}

// BenchmarkCatalogBuildSingleItem measures the per-detected-item conversion
// exactly as handleDetectedItem performs it, including the one-element slice.
func BenchmarkCatalogBuildSingleItem(b *testing.B) {
	engine := catalogBenchEngine()
	monitor := catalogBenchMonitor()
	item := catalogBenchItems(1)[0]

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		built := engine.buildItems(monitor, []model.VintedItem{item})[0]
		if built.ID != item.ID {
			b.Fatalf("built wrong item %d", built.ID)
		}
	}
}

// BenchmarkCatalogSellerProfileURL isolates the fmt-based URL construction that
// runs once per built item.
func BenchmarkCatalogSellerProfileURL(b *testing.B) {
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if buildSellerProfileURL("www.vinted.de", 700123, "seller_700123") == "" {
			b.Fatal("empty seller URL")
		}
	}
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

// BenchmarkCatalogFilterTitleOnly measures the title-only gate. matchesMonitorQuery
// re-parses the monitor query for every item, so this is the clearest place to
// see per-item parse cost.
func BenchmarkCatalogFilterTitleOnly(b *testing.B) {
	queries := map[string]string{
		"single_query": "nike air max",
		"multi_query":  "nike air max, adidas samba, new balance 550, asics gel",
	}
	for name, query := range queries {
		for _, size := range []int{catalogBenchCanonicalPageSize, catalogBenchDiscoveryPageSize} {
			items := catalogBenchItems(size)
			b.Run(fmt.Sprintf("%s/items=%d", name, size), func(b *testing.B) {
				b.ReportAllocs()
				b.ResetTimer()
				for i := 0; i < b.N; i++ {
					filtered, _ := filterTitleOnlyItems(items, query, true)
					if len(filtered) != size {
						b.Fatalf("filtered %d items, want %d", len(filtered), size)
					}
				}
			})
		}
	}
}

// BenchmarkCatalogMatchesMonitorQuery isolates one title match.
func BenchmarkCatalogMatchesMonitorQuery(b *testing.B) {
	const query = "nike air max, adidas samba, new balance 550, asics gel"
	const title = "Nike Air Max 90 Sneaker Gr 42 Original"

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if !matchesMonitorQuery(title, query) {
			b.Fatal("expected match")
		}
	}
}

// BenchmarkCatalogFilterAntiKeywords measures the anti-keyword gate, which runs
// on every cycle for both the whole page and the new-item slice.
func BenchmarkCatalogFilterAntiKeywords(b *testing.B) {
	raw := "defekt, kaputt, replica, fake, reserviert, beschädigt, löcher, flecken"
	for _, size := range []int{catalogBenchCanonicalPageSize, catalogBenchDiscoveryPageSize} {
		items := catalogBenchItems(size)
		b.Run(fmt.Sprintf("items=%d", size), func(b *testing.B) {
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				filtered, _ := filterAntiKeywordItems(items, &raw)
				if len(filtered) != size {
					b.Fatalf("filtered %d items, want %d", len(filtered), size)
				}
			}
		})
	}
}

// BenchmarkCatalogFilterBannedSellers measures the banned-seller gate, which
// rebuilds its lookup map on every call.
func BenchmarkCatalogFilterBannedSellers(b *testing.B) {
	banned := make([]int64, 0, 64)
	for i := 0; i < 64; i++ {
		banned = append(banned, int64(500000+i))
	}
	items := catalogBenchItems(catalogBenchDiscoveryPageSize)

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		filtered, _ := filterBannedSellerItems(items, banned)
		if len(filtered) != len(items) {
			b.Fatalf("filtered %d items, want %d", len(filtered), len(items))
		}
	}
}

// ---------------------------------------------------------------------------
// Client pool
// ---------------------------------------------------------------------------

func catalogBenchPool(size int) *ClientPool {
	states := make([]*clientState, size)
	for i := range states {
		states[i] = &clientState{
			client:        &Client{ProxyURL: fmt.Sprintf("http://proxy-%03d:8080", i), warmed: make(map[string]bool)},
			ewmaLatencyMS: float64(200 + i*7),
		}
	}
	fixedNow := time.Date(2026, time.March, 1, 12, 0, 0, 0, time.UTC)
	return &ClientPool{
		states:      states,
		domain:      "www.vinted.de",
		quarantined: make(map[string]proxyQuarantine),
		reserved:    make(map[string]bool),
		now:         func() time.Time { return fixedNow },
	}
}

// BenchmarkClientPoolAcquireExcluding measures the latency-scored linear scan at
// the two configured pool sizes (CLIENT_POOL_SIZE=5, FREE_PROXY_CLIENT_POOL_SIZE=50).
func BenchmarkClientPoolAcquireExcluding(b *testing.B) {
	for _, size := range []int{5, 50} {
		b.Run(fmt.Sprintf("pool=%d", size), func(b *testing.B) {
			pool := catalogBenchPool(size)
			excluded := make(map[*Client]bool, 4)
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				client := pool.AcquireExcluding(excluded)
				if client == nil {
					b.Fatal("nil client")
				}
				pool.Report(client, 200, 120*time.Millisecond, nil)
			}
		})
	}
}

// BenchmarkClientPoolAcquireExcludingParallel measures the same scan under lock
// contention, which is what a large free-proxy pool with many monitors sees.
func BenchmarkClientPoolAcquireExcludingParallel(b *testing.B) {
	for _, size := range []int{5, 50} {
		b.Run(fmt.Sprintf("pool=%d", size), func(b *testing.B) {
			pool := catalogBenchPool(size)
			b.ReportAllocs()
			b.ResetTimer()
			b.RunParallel(func(pb *testing.PB) {
				excluded := make(map[*Client]bool, 4)
				for pb.Next() {
					client := pool.AcquireExcluding(excluded)
					if client == nil {
						continue
					}
					pool.Report(client, 200, 120*time.Millisecond, nil)
				}
			})
		})
	}
}

// ---------------------------------------------------------------------------
// Hedged fetch orchestration
// ---------------------------------------------------------------------------

// instantCatalogFetcher returns immediately so the benchmark measures only the
// orchestration around the fetch, never network or sleep time.
type instantCatalogFetcher struct {
	items  []model.VintedItem
	status int
}

func (f instantCatalogFetcher) FetchCatalog(ctx context.Context, _ *Client, _ string, _ string) ([]model.VintedItem, int, error) {
	if err := ctx.Err(); err != nil {
		return nil, 0, err
	}
	status := f.status
	if status == 0 {
		status = 200
	}
	return f.items, status, nil
}

func (instantCatalogFetcher) RequiresNetwork() bool { return true }
func (instantCatalogFetcher) Name() string          { return "instant-bench" }

// BenchmarkFetchCatalogHedgedOrchestration measures the per-cycle cost of the
// hedged fetch wrapper itself: env lookups, the attempted map, the results
// channel, the hedge timer, and the attempts slice. The fetch returns instantly
// and the hedge delay is long enough never to fire, so a successful first
// attempt is the measured path.
func BenchmarkFetchCatalogHedgedOrchestration(b *testing.B) {
	engine := &Engine{fetcher: instantCatalogFetcher{items: catalogBenchItems(catalogBenchCanonicalPageSize)}}
	for _, size := range []int{5, 50} {
		b.Run(fmt.Sprintf("pool=%d", size), func(b *testing.B) {
			pool := catalogBenchPool(size)
			ctx := context.Background()
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				result := engine.fetchCatalogHedgedWithDelay(
					ctx,
					pool,
					"https://www.vinted.de/api/v2/catalog/items?per_page=20",
					"www.vinted.de",
					time.Hour,
				)
				if result.err != nil || result.status != 200 {
					b.Fatalf("hedged fetch failed: status %d err %v", result.status, result.err)
				}
			}
		})
	}
}

// BenchmarkFetchCatalogHedgedEnvLookups isolates the environment lookups the
// hedged fetch path performs on every single catalog cycle.
func BenchmarkFetchCatalogHedgedEnvLookups(b *testing.B) {
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if getEnvInt("CATALOG_HEDGE_DELAY_MS", 250) == 0 {
			b.Fatal("unexpected zero")
		}
		if getEnvInt("CATALOG_MAX_ATTEMPTS", 5) == 0 {
			b.Fatal("unexpected zero")
		}
	}
}

// ---------------------------------------------------------------------------
// Per-cycle new-item detection
// ---------------------------------------------------------------------------

// BenchmarkCatalogNewItemDetection measures the local-seen diffing loop that
// decides which catalog rows are new, at the steady state where almost nothing
// is new (the normal case) and at a full-page drop (the worst case). The
// full-page variant clears the seen map inside the timed region; that map clear
// is a few hundred nanoseconds and is noted rather than excluded, because
// StopTimer per iteration costs far more than the loop being measured.
func BenchmarkCatalogNewItemDetection(b *testing.B) {
	items := catalogBenchItems(catalogBenchCanonicalPageSize)

	b.Run("steady_state", func(b *testing.B) {
		localSeen := make(map[int64]time.Time, len(items))
		now := time.Now()
		for _, item := range items {
			localSeen[item.ID] = now
		}
		b.ReportAllocs()
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			newItems := make([]model.VintedItem, 0)
			for _, item := range items {
				if _, exists := localSeen[item.ID]; !exists {
					newItems = append(newItems, item)
				}
				localSeen[item.ID] = now
			}
			if len(newItems) != 0 {
				b.Fatalf("found %d new items, want 0", len(newItems))
			}
		}
	})

	b.Run("full_page_new", func(b *testing.B) {
		localSeen := make(map[int64]time.Time, len(items))
		now := time.Now()
		b.ReportAllocs()
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			clear(localSeen)
			newItems := make([]model.VintedItem, 0)
			for _, item := range items {
				if _, exists := localSeen[item.ID]; !exists {
					newItems = append(newItems, item)
				}
				localSeen[item.ID] = now
			}
			if len(newItems) != len(items) {
				b.Fatalf("found %d new items, want %d", len(newItems), len(items))
			}
		}
	})
}

// BenchmarkCatalogCycleCPU approximates one full successful monitor cycle's
// CPU work, excluding all I/O: decode, title filter, new-item diff,
// anti-keyword filter, banned-seller filter, and per-item build.
func BenchmarkCatalogCycleCPU(b *testing.B) {
	engine := catalogBenchEngine()
	monitor := catalogBenchMonitor()
	monitor.TitleOnly = true
	antiKeywords := "defekt, kaputt, replica, fake"
	monitor.AntiKeywords = &antiKeywords
	payload := catalogBenchPayload(b, catalogBenchCanonicalPageSize)

	localSeen := make(map[int64]time.Time, 256)
	b.SetBytes(int64(len(payload)))
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		var data model.VintedResponse
		if err := json.NewDecoder(bytes.NewReader(payload)).Decode(&data); err != nil {
			b.Fatalf("decode: %v", err)
		}
		items, _ := filterTitleOnlyItems(data.Items, monitor.Query, monitor.TitleOnly)
		now := time.Now()
		newItems := make([]model.VintedItem, 0)
		for _, item := range items {
			if _, exists := localSeen[item.ID]; !exists {
				newItems = append(newItems, item)
			}
			localSeen[item.ID] = now
		}
		alertItems, _ := filterAntiKeywordItems(newItems, monitor.AntiKeywords)
		alertItems, _ = filterBannedSellerItems(alertItems, monitor.BannedSellerIDs)
		for _, item := range alertItems {
			_ = engine.buildItems(monitor, []model.VintedItem{item})[0]
		}
	}
}

// ---------------------------------------------------------------------------
// Discovery matching
// ---------------------------------------------------------------------------

func catalogBenchDiscoveryMonitors(count int) []model.Monitor {
	monitors := make([]model.Monitor, count)
	for i := range monitors {
		antiKeywords := "defekt, kaputt, replica, fake"
		banned := make([]int64, 0, 16)
		for j := 0; j < 16; j++ {
			banned = append(banned, int64(500000+j))
		}
		monitors[i] = model.Monitor{
			ID:              1000 + i,
			Region:          "de",
			Query:           "nike air max, adidas samba, new balance 550",
			TitleOnly:       i%2 == 0,
			AntiKeywords:    &antiKeywords,
			BannedSellerIDs: banned,
		}
	}
	return monitors
}

// BenchmarkDiscoveryMatchLoop measures the O(items x monitors) discovery
// matching loop, which is where a shared discovery page is tested against every
// monitor that subscribes to it.
//
// per_item_compile is the historical shape: matchesDiscovery re-parses the
// monitor query, re-parses the anti-keyword list, and rebuilds the
// banned-seller map for every (item, monitor) pair. per_cycle_compile is the
// shape the discovery loop now uses: matchers are compiled once per cycle.
// matchesDiscovery is retained as a thin wrapper, so per_item_compile keeps
// measuring the old cost and the two rows are directly comparable.
func BenchmarkDiscoveryMatchLoop(b *testing.B) {
	items := catalogBenchItems(catalogBenchDiscoveryPageSize)
	for _, monitorCount := range []int{1, 10, 50} {
		monitors := catalogBenchDiscoveryMonitors(monitorCount)

		b.Run(fmt.Sprintf("per_item_compile/monitors=%d", monitorCount), func(b *testing.B) {
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				matched := 0
				for _, item := range items {
					for _, monitor := range monitors {
						if matchesDiscovery(item, monitor) {
							matched++
						}
					}
				}
				if matched == 0 {
					b.Fatal("expected at least one discovery match")
				}
			}
		})

		b.Run(fmt.Sprintf("per_cycle_compile/monitors=%d", monitorCount), func(b *testing.B) {
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				matchers := compileDiscoveryMonitorMatchers(monitors)
				matched := 0
				for _, item := range items {
					for _, matcher := range matchers {
						if matcher.matches(item) {
							matched++
						}
					}
				}
				if matched == 0 {
					b.Fatal("expected at least one discovery match")
				}
			}
		})
	}
}

// BenchmarkDiscoveryMatchLoopEquivalentResults is a guard rather than a timing
// benchmark: it fails the benchmark run if the compiled and legacy paths ever
// disagree on the match count.
func BenchmarkDiscoveryMatchLoopEquivalentResults(b *testing.B) {
	items := catalogBenchItems(catalogBenchDiscoveryPageSize)
	monitors := catalogBenchDiscoveryMonitors(10)
	matchers := compileDiscoveryMonitorMatchers(monitors)

	legacy := 0
	compiled := 0
	for _, item := range items {
		for i, monitor := range monitors {
			if matchesDiscovery(item, monitor) {
				legacy++
			}
			if matchers[i].matches(item) {
				compiled++
			}
		}
	}
	if legacy != compiled {
		b.Fatalf("match counts differ: legacy %d, compiled %d", legacy, compiled)
	}

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_ = matchers[0].matches(items[0])
	}
}

// BenchmarkDiscoveryMatchSingle isolates one item-versus-monitor decision using
// an already compiled matcher.
func BenchmarkDiscoveryMatchSingle(b *testing.B) {
	item := catalogBenchItems(1)[0]
	monitor := catalogBenchDiscoveryMonitors(1)[0]
	matcher := compileDiscoveryMonitorMatcher(monitor)

	b.Run("per_item_compile", func(b *testing.B) {
		b.ReportAllocs()
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			if !matchesDiscovery(item, monitor) {
				b.Fatal("expected match")
			}
		}
	})

	b.Run("precompiled", func(b *testing.B) {
		b.ReportAllocs()
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			if !matcher.matches(item) {
				b.Fatal("expected match")
			}
		}
	})
}

// ---------------------------------------------------------------------------
// Decode strategy comparison (measurement only, not a proposed change)
// ---------------------------------------------------------------------------

// BenchmarkCatalogDecodeStrategy compares the streaming decoder that
// fetchCatalogAttempt uses against buffering the bounded body and calling
// json.Unmarshal. It exists so the decision to keep the streaming decoder is
// backed by numbers: the streaming form never materialises the whole body, and
// the worker runs under GOMEMLIMIT=340MiB with one goroutine per monitor.
func BenchmarkCatalogDecodeStrategy(b *testing.B) {
	for _, size := range []int{catalogBenchCanonicalPageSize, catalogBenchDiscoveryPageSize} {
		payload := catalogBenchPayload(b, size)

		b.Run(fmt.Sprintf("stream_decoder/items=%d", size), func(b *testing.B) {
			b.SetBytes(int64(len(payload)))
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				var data model.VintedResponse
				reader := io.LimitReader(bytes.NewReader(payload), maxAPIResponseBytes)
				if err := json.NewDecoder(reader).Decode(&data); err != nil {
					b.Fatalf("decode: %v", err)
				}
				if len(data.Items) != size {
					b.Fatalf("decoded %d items, want %d", len(data.Items), size)
				}
			}
		})

		b.Run(fmt.Sprintf("read_all_unmarshal/items=%d", size), func(b *testing.B) {
			b.SetBytes(int64(len(payload)))
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				var data model.VintedResponse
				reader := io.LimitReader(bytes.NewReader(payload), maxAPIResponseBytes)
				raw, err := io.ReadAll(reader)
				if err != nil {
					b.Fatalf("read: %v", err)
				}
				if err := json.Unmarshal(raw, &data); err != nil {
					b.Fatalf("unmarshal: %v", err)
				}
				if len(data.Items) != size {
					b.Fatalf("decoded %d items, want %d", len(data.Items), size)
				}
			}
		})
	}
}
