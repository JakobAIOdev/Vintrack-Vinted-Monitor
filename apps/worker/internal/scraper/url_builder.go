package scraper

import (
	"fmt"
	"net/url"
	"os"
	"strings"
	"vintrack-worker/internal/model"
)

const videoGamePlatformCatalogID = "3002"

func BuildVintedURL(m model.Monitor) string {
	_, query := monitorQueryForCheck(parseMonitorQueries(m.Query), 1)
	return BuildVintedURLForQuery(m, query)
}

func BuildVintedURLForQuery(m model.Monitor, query string) string {
	perPage := os.Getenv("VINTED_PER_PAGE")
	if perPage == "" {
		perPage = "20"
	}
	m.Query = strings.TrimSpace(query)
	return buildVintedURL(m, perPage, true, 1)
}

func BuildDiscoveryURL(m model.Monitor, page int) string {
	return BuildDiscoveryURLWithPerPage(m, page, getEnvInt("DISCOVERY_PER_PAGE", 96))
}

func BuildDiscoveryURLWithPerPage(m model.Monitor, page int, perPage int) string {
	if perPage < 1 {
		perPage = 96
	}
	return buildVintedURL(m, fmt.Sprintf("%d", perPage), false, page)
}

func buildVintedURL(m model.Monitor, perPage string, includeQuery bool, page int) string {
	domain := model.RegionDomain(m.Region)
	baseURL := fmt.Sprintf("https://%s/api/v2/catalog/items", domain)
	params := url.Values{}

	if includeQuery && m.Query != "" {
		params.Add("search_text", m.Query)
	}
	params.Add("order", "newest_first")
	params.Add("per_page", perPage)
	if page > 1 {
		params.Add("page", fmt.Sprintf("%d", page))
	}

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

	var videoGamePlatformIDs []string
	if m.VideoGamePlatformIDs != nil {
		for _, platform := range strings.Split(*m.VideoGamePlatformIDs, ",") {
			if platform = strings.TrimSpace(platform); platform != "" {
				videoGamePlatformIDs = append(videoGamePlatformIDs, platform)
			}
		}
	}

	if len(videoGamePlatformIDs) > 0 {
		params.Add("catalog_ids[]", videoGamePlatformCatalogID)
	} else if m.CatalogIDs != nil && *m.CatalogIDs != "" {
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

	if m.StatusIDs != nil && *m.StatusIDs != "" {
		statuses := strings.Split(*m.StatusIDs, ",")
		for _, s := range statuses {
			s = strings.TrimSpace(s)
			if s != "" {
				params.Add("status_ids[]", s)
			}
		}
	}

	for _, platform := range videoGamePlatformIDs {
		params.Add("video_game_platform_ids[]", platform)
	}

	return fmt.Sprintf("%s?%s", baseURL, params.Encode())
}
