package scraper

import (
	"net/url"
	"strconv"
	"strings"
	"testing"
	"vintrack-worker/internal/model"
)

func TestBuildVintedURL_BasicQuery(t *testing.T) {
	m := model.Monitor{
		Query:  "nike air max",
		Region: "de",
	}

	result := BuildVintedURL(m)

	if !strings.HasPrefix(result, "https://www.vinted.de/api/v2/catalog/items?") {
		t.Errorf("URL should start with vinted.de API base, got: %s", result)
	}

	parsed, err := url.Parse(result)
	if err != nil {
		t.Fatalf("Failed to parse URL: %v", err)
	}

	if got := parsed.Query().Get("search_text"); got != "nike air max" {
		t.Errorf("search_text = %q, want %q", got, "nike air max")
	}
	if got := parsed.Query().Get("order"); got != "newest_first" {
		t.Errorf("order = %q, want %q", got, "newest_first")
	}
}

func TestBuildVintedURLUsesFirstQueryAlternative(t *testing.T) {
	m := model.Monitor{Query: "console ps1, playstation 1, ps one", Region: "de"}
	parsed, err := url.Parse(BuildVintedURL(m))
	if err != nil {
		t.Fatalf("Failed to parse URL: %v", err)
	}
	if got := parsed.Query().Get("search_text"); got != "console ps1" {
		t.Fatalf("search_text = %q, want first alternative", got)
	}
}

func TestBuildVintedURLForQueryUsesSelectedAlternative(t *testing.T) {
	m := model.Monitor{Query: "console ps1, playstation 1, ps one", Region: "de"}
	parsed, err := url.Parse(BuildVintedURLForQuery(m, "playstation 1"))
	if err != nil {
		t.Fatalf("Failed to parse URL: %v", err)
	}
	if got := parsed.Query().Get("search_text"); got != "playstation 1" {
		t.Fatalf("search_text = %q, want selected alternative", got)
	}
}

func TestBuildVintedURL_WithPriceFilters(t *testing.T) {
	min, max := 10, 50
	m := model.Monitor{
		Query:    "test",
		Region:   "fr",
		PriceMin: &min,
		PriceMax: &max,
	}

	result := BuildVintedURL(m)

	parsed, _ := url.Parse(result)
	if got := parsed.Query().Get("price_from"); got != "10" {
		t.Errorf("price_from = %q, want %q", got, "10")
	}
	if got := parsed.Query().Get("price_to"); got != "50" {
		t.Errorf("price_to = %q, want %q", got, "50")
	}
}

func TestBuildVintedURL_WithSizeIDs(t *testing.T) {
	sizeID := "1,2,3"
	m := model.Monitor{
		Query:  "test",
		Region: "de",
		SizeID: &sizeID,
	}

	result := BuildVintedURL(m)
	parsed, _ := url.Parse(result)

	sizes := parsed.Query()["size_ids[]"]
	if len(sizes) != 3 {
		t.Errorf("Expected 3 size_ids, got %d: %v", len(sizes), sizes)
	}
}

func TestBuildVintedURL_WithMaximumMonitorSizeIDs(t *testing.T) {
	ids := make([]string, 100)
	for index := range ids {
		ids[index] = strconv.Itoa(1400 + index)
	}
	sizeID := strings.Join(ids, ",")
	m := model.Monitor{Region: "de", SizeID: &sizeID}

	parsed, err := url.Parse(BuildVintedURL(m))
	if err != nil {
		t.Fatalf("parse URL: %v", err)
	}

	sizes := parsed.Query()["size_ids[]"]
	if len(sizes) != 100 {
		t.Fatalf("size_ids count = %d, want 100", len(sizes))
	}
	if sizes[0] != "1400" || sizes[99] != "1499" {
		t.Fatalf("size_ids endpoints = %q, %q", sizes[0], sizes[99])
	}
}

func TestBuildVintedURL_WithBrandIDs(t *testing.T) {
	brandIDs := "10,20"
	m := model.Monitor{
		Query:    "test",
		Region:   "de",
		BrandIDs: &brandIDs,
	}

	result := BuildVintedURL(m)
	parsed, _ := url.Parse(result)

	brands := parsed.Query()["brand_ids[]"]
	if len(brands) != 2 {
		t.Errorf("Expected 2 brand_ids, got %d", len(brands))
	}
}

func TestBuildVintedURL_WithCatalogIDs(t *testing.T) {
	catalogIDs := "100, 200, 300"
	m := model.Monitor{
		Query:      "test",
		Region:     "de",
		CatalogIDs: &catalogIDs,
	}

	result := BuildVintedURL(m)
	parsed, _ := url.Parse(result)

	catalogs := parsed.Query()["catalog_ids[]"]
	if len(catalogs) != 3 {
		t.Errorf("Expected 3 catalog_ids, got %d", len(catalogs))
	}
}

func TestBuildVintedURL_WithColorIDs(t *testing.T) {
	colorIDs := "5,6"
	m := model.Monitor{
		Query:    "test",
		Region:   "de",
		ColorIDs: &colorIDs,
	}

	result := BuildVintedURL(m)
	parsed, _ := url.Parse(result)

	colors := parsed.Query()["color_ids[]"]
	if len(colors) != 2 {
		t.Errorf("Expected 2 color_ids, got %d", len(colors))
	}
}

func TestBuildVintedURL_WithStatusIDs(t *testing.T) {
	statusIDs := "1, 4,6"
	m := model.Monitor{
		Query:     "test",
		Region:    "de",
		StatusIDs: &statusIDs,
	}

	result := BuildVintedURL(m)
	parsed, _ := url.Parse(result)

	statuses := parsed.Query()["status_ids[]"]
	if len(statuses) != 3 {
		t.Errorf("Expected 3 status_ids, got %d", len(statuses))
	}
}

func TestBuildVintedURL_WithVideoGamePlatformIDs(t *testing.T) {
	platformIDs := "1277, 1278"
	conflictingCatalogIDs := "100, 200"
	m := model.Monitor{
		Query:                "playstation",
		Region:               "de",
		CatalogIDs:           &conflictingCatalogIDs,
		VideoGamePlatformIDs: &platformIDs,
	}

	result := BuildVintedURL(m)
	parsed, _ := url.Parse(result)

	platforms := parsed.Query()["video_game_platform_ids[]"]
	if len(platforms) != 2 {
		t.Errorf("Expected 2 video_game_platform_ids, got %d", len(platforms))
	}
	catalogs := parsed.Query()["catalog_ids[]"]
	if len(catalogs) != 1 || catalogs[0] != videoGamePlatformCatalogID {
		t.Errorf(
			"catalog_ids = %v, want only platform catalog %s",
			catalogs,
			videoGamePlatformCatalogID,
		)
	}
}

func TestBuildVintedURL_NilFilters(t *testing.T) {
	m := model.Monitor{
		Query:  "shoes",
		Region: "it",
	}

	result := BuildVintedURL(m)
	parsed, _ := url.Parse(result)

	if parsed.Query().Get("price_from") != "" {
		t.Error("price_from should not be set for nil PriceMin")
	}
	if parsed.Query().Get("price_to") != "" {
		t.Error("price_to should not be set for nil PriceMax")
	}
	if len(parsed.Query()["size_ids[]"]) != 0 {
		t.Error("size_ids should not be set for nil SizeID")
	}
}

func TestBuildVintedURL_EmptyQuery(t *testing.T) {
	m := model.Monitor{
		Query:  "",
		Region: "de",
	}

	result := BuildVintedURL(m)
	parsed, _ := url.Parse(result)

	if got := parsed.Query().Get("search_text"); got != "" {
		t.Errorf("search_text = %q, want empty", got)
	}
}

func TestBuildVintedURL_Regions(t *testing.T) {
	regions := map[string]string{
		"de": "www.vinted.de",
		"fr": "www.vinted.fr",
		"uk": "www.vinted.co.uk",
		"ie": "www.vinted.ie",
		"it": "www.vinted.it",
		"nl": "www.vinted.nl",
	}

	for region, expectedDomain := range regions {
		t.Run(region, func(t *testing.T) {
			m := model.Monitor{Query: "test", Region: region}
			result := BuildVintedURL(m)
			if !strings.Contains(result, expectedDomain) {
				t.Errorf("Region %q: URL should contain %s, got: %s", region, expectedDomain, result)
			}
		})
	}
}

func TestBuildVintedURL_EmptySizeID(t *testing.T) {
	empty := ""
	m := model.Monitor{
		Query:  "test",
		Region: "de",
		SizeID: &empty,
	}

	result := BuildVintedURL(m)
	parsed, _ := url.Parse(result)

	if len(parsed.Query()["size_ids[]"]) != 0 {
		t.Error("Empty sizeID should not produce size_ids params")
	}
}
