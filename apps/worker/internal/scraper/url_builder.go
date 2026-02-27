package scraper

import (
	"fmt"
	"net/url"
	"strings"
	"vintrack-worker/internal/model"
)

func BuildVintedURL(m model.Monitor) string {
	domain := model.RegionDomain(m.Region)
	baseURL := fmt.Sprintf("https://%s/api/v2/catalog/items", domain)
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

	if m.CatalogIDs != nil && *m.CatalogIDs != "" {
		cats := strings.Split(*m.CatalogIDs, ",")
		for _, c := range cats {
			c = strings.TrimSpace(c)
			if c != "" {
				params.Add("catalog_ids[]", c)
			}
		}
	}

	if m.BrandIDs != nil && *m.BrandIDs != "" {
		brands := strings.Split(*m.BrandIDs, ",")
		for _, b := range brands {
			b = strings.TrimSpace(b)
			if b != "" {
				params.Add("brand_ids[]", b)
			}
		}
	}

	if m.ColorIDs != nil && *m.ColorIDs != "" {
		colors := strings.Split(*m.ColorIDs, ",")
		for _, c := range colors {
			c = strings.TrimSpace(c)
			if c != "" {
				params.Add("color_ids[]", c)
			}
		}
	}

	return fmt.Sprintf("%s?%s", baseURL, params.Encode())
}
