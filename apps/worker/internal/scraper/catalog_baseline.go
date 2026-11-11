package scraper

import "vintrack-worker/internal/model"

// catalogBaseline fixes an ID boundary at startup, rather than advancing a
// high-water mark every cycle. This keeps later out-of-order search results
// eligible while rejecting resurfaced IDs from before monitoring began.
// IDs are a freshness heuristic, not a publication timestamp.
type catalogBaseline struct {
	itemID int64
}

func (b *catalogBaseline) seed(items []model.VintedItem) {
	for _, item := range items {
		if item.ID > b.itemID {
			b.itemID = item.ID
		}
	}
}

func (b catalogBaseline) allows(item model.VintedItem) bool {
	return item.ID > b.itemID
}

func (b catalogBaseline) filter(items []model.VintedItem) ([]model.VintedItem, int) {
	allowed := make([]model.VintedItem, 0, len(items))
	for _, item := range items {
		if b.allows(item) {
			allowed = append(allowed, item)
		}
	}
	return allowed, len(items) - len(allowed)
}
