package scraper

import (
	"fmt"
	"net/url"
	"os"
	"strings"
	"vintrack-worker/internal/model"
)

const videoGamePlatformCatalogID = "3002"

const maxVintedExtraParamsLength = 2000

var reservedVintedParams = map[string]struct{}{
	"_":                         {},
	"brand_ids":                 {},
	"brand_ids[]":               {},
	"catalog":                   {},
	"catalog[]":                 {},
	"catalog_ids":               {},
	"catalog_ids[]":             {},
	"color_ids":                 {},
	"color_ids[]":               {},
	"currency":                  {},
	"order":                     {},
	"page":                      {},
	"per_page":                  {},
	"platform_ids":              {},
	"platform_ids[]":            {},
	"price_from":                {},
	"price_to":                  {},
	"search_id":                 {},
	"search_text":               {},
	"size_ids":                  {},
	"size_ids[]":                {},
	"status_ids":                {},
	"status_ids[]":              {},
	"time":                      {},
	"video_game_platform_ids":   {},
	"video_game_platform_ids[]": {},
}

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
	baseURL := fmt.Sprintf("https://%s/svc-catalogue/items", catalogAPIHost(domain))
	params := url.Values{}

	if includeQuery && m.Query != "" {
		params.Add("search_text", m.Query)
	}
	params.Add("order", "newest_first")
	params.Add("per_page", perPage)
	params.Add("currency", model.RegionCurrency(m.Region))
	if page > 1 {
		params.Add("page", fmt.Sprintf("%d", page))
	}

	if m.PriceMin != nil {
		params.Add("price_from", fmt.Sprintf("%d", *m.PriceMin))
	}
	if m.PriceMax != nil {
		params.Add("price_to", fmt.Sprintf("%d", *m.PriceMax))
	}

	if m.SizeID != nil {
		setVintedAttributeIDs(params, "size", *m.SizeID)
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
		setVintedAttributeIDs(params, "catalog", videoGamePlatformCatalogID)
	} else if m.CatalogIDs != nil {
		setVintedAttributeIDs(params, "catalog", *m.CatalogIDs)
	}

	if m.BrandIDs != nil {
		setVintedAttributeIDs(params, "brand", *m.BrandIDs)
	}
	if m.ColorIDs != nil {
		setVintedAttributeIDs(params, "color", *m.ColorIDs)
	}
	if m.StatusIDs != nil {
		setVintedAttributeIDs(params, "status", *m.StatusIDs)
	}
	setVintedAttributeIDs(params, "video_game_platform", videoGamePlatformIDs...)

	appendVintedExtraParams(params, m.VintedExtraParams)

	return fmt.Sprintf("%s?%s", baseURL, params.Encode())
}

func catalogAPIHost(domain string) string {
	if strings.HasPrefix(domain, "www.") {
		return "api." + strings.TrimPrefix(domain, "www.")
	}
	return domain
}

func setVintedAttributeIDs(params url.Values, attribute string, rawValues ...string) {
	key := fmt.Sprintf("attribute_ids[%s]", attribute)
	values := make([]string, 0, len(rawValues))
	if existing := strings.TrimSpace(params.Get(key)); existing != "" {
		values = append(values, strings.Split(existing, ",")...)
	}
	for _, raw := range rawValues {
		for _, value := range strings.Split(raw, ",") {
			if value = strings.TrimSpace(value); value != "" {
				values = append(values, value)
			}
		}
	}
	if len(values) > 0 {
		params.Set(key, strings.Join(values, ","))
	}
}

func appendVintedExtraParams(params url.Values, raw *string) {
	if raw == nil {
		return
	}
	normalized := strings.TrimSpace(*raw)
	if normalized == "" || len(normalized) > maxVintedExtraParamsLength {
		return
	}

	extraParams, err := url.ParseQuery(normalized)
	if err != nil {
		return
	}

	accepted := 0
	for key, values := range extraParams {
		key = strings.ToLower(strings.TrimSpace(key))
		if !isSafeVintedExtraParamKey(key) {
			continue
		}
		if _, reserved := reservedVintedParams[key]; reserved {
			continue
		}

		targetKey := key
		if strings.TrimSuffix(key, "[]") == "material_ids" {
			targetKey = "attribute_ids[material]"
		}

		for _, value := range values {
			value = strings.TrimSpace(value)
			if value == "" || len(value) > 256 || accepted >= 50 {
				continue
			}
			if targetKey == "attribute_ids[material]" {
				setVintedAttributeIDs(params, "material", value)
			} else {
				params.Add(targetKey, value)
			}
			accepted++
		}
	}
}

func isSafeVintedExtraParamKey(key string) bool {
	if key == "" || len(key) > 64 {
		return false
	}
	if strings.HasPrefix(key, "utm_") || key == "fbclid" || key == "gclid" {
		return false
	}
	base := strings.TrimSuffix(key, "[]")
	if base == "" {
		return false
	}
	for index, char := range base {
		if (char >= 'a' && char <= 'z') || (index > 0 && char >= '0' && char <= '9') || (index > 0 && char == '_') {
			continue
		}
		return false
	}
	for _, sensitive := range []string{"auth", "bearer", "cookie", "credential", "csrf", "password", "redirect", "session", "token", "url"} {
		if strings.Contains(base, sensitive) {
			return false
		}
	}
	return true
}
