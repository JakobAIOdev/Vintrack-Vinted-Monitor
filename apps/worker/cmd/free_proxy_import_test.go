package main

import (
	"context"
	"errors"
	"maps"
	"slices"
	"testing"

	"vintrack-worker/internal/database"
)

type freeProxyImportInventoryStub struct {
	inventory map[string]database.FreeProxyInventoryRecord
	stale     map[string]bool
	fail      string
	loads     int
	calls     []string
	touched   []string
}

func (s *freeProxyImportInventoryStub) GetFreeProxyImportInventoryContext(context.Context) (map[string]database.FreeProxyInventoryRecord, error) {
	s.calls = append(s.calls, "load")
	s.loads++
	if s.fail == "load" || (s.fail == "reload" && s.loads > 1) {
		return nil, errors.New("synthetic inventory failure")
	}
	return maps.Clone(s.inventory), nil
}

func (s *freeProxyImportInventoryStub) TouchFreeProxiesSeenContext(_ context.Context, urls []string) error {
	s.calls = append(s.calls, "touch")
	s.touched = slices.Clone(urls)
	if s.fail == "touch" {
		return errors.New("synthetic freshness failure")
	}
	return nil
}

func (s *freeProxyImportInventoryStub) PruneUnselectedFreeProxiesContext(_ context.Context, keep []string) (int64, error) {
	s.calls = append(s.calls, "prune")
	if s.fail == "prune" {
		return 0, errors.New("synthetic cleanup failure")
	}
	var count int64
	for url := range s.inventory {
		if s.stale[url] && !slices.Contains(keep, url) {
			delete(s.inventory, url)
			count++
		}
	}
	return count, nil
}

func TestFreeProxyImportAdmitsReplacementInSameCycleAsFullInventoryCleanup(t *testing.T) {
	const current = "http://current.invalid:80"
	const stale = "http://stale-untested.invalid:80"
	const proven = "http://previously-working.invalid:80"
	const fresh = "http://new.invalid:80"
	store := &freeProxyImportInventoryStub{
		inventory: map[string]database.FreeProxyInventoryRecord{
			current: {ProxyURL: current},
			stale:   {ProxyURL: stale},
			proven:  {ProxyURL: proven, SuccessCount: 2},
		},
		stale: map[string]bool{stale: true},
	}
	inventory, pruned, err := prepareFreeProxyImportInventory(context.Background(), store, map[string]bool{current: true, fresh: true})
	if err != nil {
		t.Fatal(err)
	}
	selected, newCount := selectFreeProxyImportCandidates([][]freeProxyImportCandidate{{
		{ProxyURL: current, Source: "iplocate"},
		{ProxyURL: fresh, Source: "iplocate"},
	}}, inventory, 3)
	if pruned != 1 || newCount != 1 || len(inventory) != 3 || len(selected) != 2 {
		t.Fatalf("full inventory did not admit its replacement: pruned=%d new=%d inventory=%d selected=%#v", pruned, newCount, len(inventory), selected)
	}
	if _, ok := inventory[proven]; !ok {
		t.Fatal("previously working inventory was lost")
	}
	if !slices.Equal(store.calls, []string{"load", "touch", "prune", "load"}) {
		t.Fatalf("inventory preparation order = %v", store.calls)
	}
}

func TestFreeProxyImportPreservesSeenStoredURLVariants(t *testing.T) {
	const stored = "http://current.invalid:80/"
	const canonical = "http://current.invalid:80"
	store := &freeProxyImportInventoryStub{
		inventory: map[string]database.FreeProxyInventoryRecord{stored: {ProxyURL: stored}},
		stale:     map[string]bool{stored: true},
	}
	inventory, pruned, err := prepareFreeProxyImportInventory(context.Background(), store, map[string]bool{canonical: true})
	if err != nil || pruned != 0 {
		t.Fatalf("seen stored variant was not protected: pruned=%d err=%v", pruned, err)
	}
	if inventory[canonical].ProxyURL != stored || !slices.Equal(store.touched, []string{stored}) {
		t.Fatalf("stored variant lost its identity or freshness: %v, %v", inventory, store.touched)
	}
}

func TestFreeProxyImportFailsClosedOnInventoryMaintenanceErrors(t *testing.T) {
	for _, stage := range []string{"load", "touch", "prune", "reload"} {
		t.Run(stage, func(t *testing.T) {
			const stale = "http://stale.invalid:80"
			store := &freeProxyImportInventoryStub{
				inventory: map[string]database.FreeProxyInventoryRecord{stale: {ProxyURL: stale}},
				stale:     map[string]bool{stale: true},
				fail:      stage,
			}
			inventory, _, err := prepareFreeProxyImportInventory(context.Background(), store, map[string]bool{"http://new.invalid:80": true})
			if err == nil || inventory != nil {
				t.Fatalf("failed %s returned usable inventory: %v, %v", stage, inventory, err)
			}
			if (stage == "load" || stage == "touch") && slices.Contains(store.calls, "prune") {
				t.Fatalf("cleanup ran before freshness was established: %v", store.calls)
			}
		})
	}
}

func TestFreeProxyImportEmptyDownloadsCannotStartCleanup(t *testing.T) {
	store := &freeProxyImportInventoryStub{}
	if _, _, err := prepareFreeProxyImportInventory(context.Background(), store, nil); err == nil {
		t.Fatal("empty downloads authorized inventory preparation")
	}
	if len(store.calls) != 0 {
		t.Fatalf("empty downloads touched the inventory: %v", store.calls)
	}
}
