package scraper

import (
	"fmt"
	"net/url"
	"strings"
	"vintrack-worker/internal/model"
)

func BuildVintedURL(m model.Monitor) string {
	baseURL := "https://www.vinted.de/api/v2/catalog/items"
	params := url.Values{}

	params.Add("search_text", m.Query)
	params.Add("order", "newest_first")
	params.Add("per_page", "20")

	if m.PriceMin != nil {
		params.Add("price_from", fmt.Sprintf("%d", *m.PriceMin))
	}
	if m.PriceMax != nil {
		params.Add("price_to", fmt.Sprintf("%d", *m.PriceMax))
	}

	if m.SizeID != nil && *m.SizeID != "" {
		sizes := strings.Split(*m.SizeID, ",")
		for _, s := range sizes {
			s = strings.TrimSpace(s)
			if s != "" {
				params.Add("size_ids[]", s)
			}
		}
	}

	return fmt.Sprintf("%s?%s", baseURL, params.Encode())
}
