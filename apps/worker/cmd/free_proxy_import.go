package main

import (
	"context"
	"fmt"

	"vintrack-worker/internal/database"
)

type freeProxyImportInventoryStore interface {
	GetFreeProxyImportInventoryContext(context.Context) (map[string]database.FreeProxyInventoryRecord, error)
	TouchFreeProxiesSeenContext(context.Context, []string) error
	PruneUnselectedFreeProxiesContext(context.Context, []string) (int64, error)
}

// Reclaim stale unsuccessful candidates before selection checks the inventory
// limit. Otherwise a full pool can never admit their replacements. An empty
// download cannot authorize cleanup; an unseen candidate still needs to have
// aged out of the feeds before the store will remove it.
func prepareFreeProxyImportInventory(
	ctx context.Context,
	store freeProxyImportInventoryStore,
	seen map[string]bool,
) (map[string]database.FreeProxyInventoryRecord, int64, error) {
	if len(seen) == 0 {
		return nil, 0, fmt.Errorf("no valid candidates downloaded; inventory kept unchanged")
	}
	inventory, err := store.GetFreeProxyImportInventoryContext(ctx)
	if err != nil {
		return nil, 0, fmt.Errorf("load inventory: %w", err)
	}
	keep := make([]string, 0, len(seen))
	for proxyURL := range seen {
		keep = append(keep, proxyURL)
	}
	touched := make([]string, 0, len(inventory))
	for storedURL := range inventory {
		if seen[canonicalFreeProxyURL(storedURL)] {
			touched = append(touched, storedURL)
			// Preserve stored URL variants as well as canonical feed URLs.
			if !seen[storedURL] {
				keep = append(keep, storedURL)
			}
		}
	}
	if err := store.TouchFreeProxiesSeenContext(ctx, touched); err != nil {
		return nil, 0, fmt.Errorf("refresh source freshness: %w", err)
	}
	pruned, err := store.PruneUnselectedFreeProxiesContext(ctx, keep)
	if err != nil {
		return nil, 0, fmt.Errorf("prune stale inventory: %w", err)
	}
	if pruned > 0 {
		inventory, err = store.GetFreeProxyImportInventoryContext(ctx)
		if err != nil {
			return nil, pruned, fmt.Errorf("reload pruned inventory: %w", err)
		}
	}
	canonical := make(map[string]database.FreeProxyInventoryRecord, len(inventory))
	for storedURL, record := range inventory {
		proxyURL := canonicalFreeProxyURL(storedURL)
		current, exists := canonical[proxyURL]
		if !exists || (storedURL == proxyURL && current.ProxyURL != proxyURL) {
			canonical[proxyURL] = record
		}
	}
	return canonical, pruned, nil
}
