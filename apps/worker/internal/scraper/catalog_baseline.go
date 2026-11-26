package scraper

import (
	"crypto/sha256"
	"fmt"
	"net/url"

	"vintrack-worker/internal/model"
)

// catalogBaseline fixes a durable ID boundary at initialization, rather than
// advancing a high-water mark every cycle. This keeps later out-of-order results
// eligible while rejecting resurfaced IDs from before monitoring began.
// IDs are a freshness heuristic, not a publication timestamp.
type catalogBaseline struct {
	itemID int64
}

// Use the catalog search identity, not its position in the alternatives list.
// Page size and notification settings do not change a search's baseline.
func catalogBaselineKey(catalogURL string) string {
	parsed, _ := url.Parse(catalogURL) // URLs are produced by BuildVintedURLForQuery.
	params := parsed.Query()
	params.Del("per_page")
	parsed.RawQuery = params.Encode()
	return fmt.Sprintf("%x", sha256.Sum256([]byte(parsed.String())))
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
