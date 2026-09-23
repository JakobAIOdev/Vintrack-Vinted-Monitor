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

	if !strings.HasPrefix(result, "https://api.vinted.de/svc-catalogue/items?") {
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
	if got := parsed.Query().Get("currency"); got != "EUR" {
		t.Errorf("currency = %q, want EUR", got)
	}
}

func TestBuildVintedURLForcesRegionCurrency(t *testing.T) {
	extra := "currency=USD"
	parsed, err := url.Parse(BuildVintedURL(model.Monitor{Region: "uk", VintedExtraParams: &extra}))
	if err != nil {
		t.Fatal(err)
	}
	if got := parsed.Query()["currency"]; len(got) != 1 || got[0] != "GBP" {
		t.Fatalf("currency = %v, want worker-controlled GBP", got)
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

	sizes := parsed.Query()["attribute_ids[size]"]
	if len(sizes) != 1 || sizes[0] != "1,2,3" {
		t.Errorf("size_ids = %v, want one comma-separated value", sizes)
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

	sizes := parsed.Query()["attribute_ids[size]"]
	if len(sizes) != 1 {
		t.Fatalf("size_ids values = %v, want one comma-separated value", sizes)
	}
	decoded := strings.Split(sizes[0], ",")
	if len(decoded) != 100 || decoded[0] != "1400" || decoded[99] != "1499" {
		t.Fatalf("decoded size_ids = %v, want 1400 through 1499", decoded)
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

	brands := parsed.Query()["attribute_ids[brand]"]
	if len(brands) != 1 || brands[0] != "10,20" {
		t.Errorf("brand_ids = %v, want one comma-separated value", brands)
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

	catalogs := parsed.Query()["attribute_ids[catalog]"]
	if len(catalogs) != 1 || catalogs[0] != "100,200,300" {
		t.Errorf("catalog_ids = %v, want one comma-separated value", catalogs)
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

	colors := parsed.Query()["attribute_ids[color]"]
	if len(colors) != 1 || colors[0] != "5,6" {
		t.Errorf("color_ids = %v, want one comma-separated value", colors)
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

	statuses := parsed.Query()["attribute_ids[status]"]
	if len(statuses) != 1 || statuses[0] != "1,4,6" {
		t.Errorf("status_ids = %v, want one comma-separated value", statuses)
	}
}

func TestBuildVintedURL_WithAdditionalVintedFilters(t *testing.T) {
	extraParams := "material_ids%5B%5D=12&material_ids%5B%5D=13&currency=EUR&search_id=temporary&order=price_high_to_low&page=9&auth_token=secret&brand_ids%5B%5D=999"
	m := model.Monitor{
		Query:             "linen",
		Region:            "de",
		VintedExtraParams: &extraParams,
	}

	parsed, err := url.Parse(BuildVintedURL(m))
	if err != nil {
		t.Fatalf("parse URL: %v", err)
	}
	query := parsed.Query()
	if got := query["attribute_ids[material]"]; len(got) != 1 || got[0] != "12,13" {
		t.Fatalf("material_ids = %v, want one comma-separated value", got)
	}
	if got := query.Get("currency"); got != "EUR" {
		t.Fatalf("currency = %q, want EUR", got)
	}
	if got := query.Get("order"); got != "newest_first" {
		t.Fatalf("order = %q, want worker-controlled newest_first", got)
	}
	for _, blocked := range []string{"search_id", "auth_token"} {
		if got := query.Get(blocked); got != "" {
			t.Fatalf("blocked parameter %s leaked with value %q", blocked, got)
		}
	}
	if got := query.Get("page"); got != "" {
		t.Fatalf("page = %q, want worker-controlled first page", got)
	}
	if got := query["attribute_ids[brand]"]; len(got) != 0 {
		t.Fatalf("extra brand_ids should be blocked, got %v", got)
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

	platforms := parsed.Query()["attribute_ids[video_game_platform]"]
	if len(platforms) != 1 || platforms[0] != "1277,1278" {
		t.Errorf("video_game_platform_ids = %v, want one comma-separated value", platforms)
	}
	catalogs := parsed.Query()["attribute_ids[catalog]"]
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
	if len(parsed.Query()["attribute_ids[size]"]) != 0 {
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
		"de": "api.vinted.de",
		"fr": "api.vinted.fr",
		"uk": "api.vinted.co.uk",
		"ie": "api.vinted.ie",
		"it": "api.vinted.it",
		"nl": "api.vinted.nl",
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

	if len(parsed.Query()["attribute_ids[size]"]) != 0 {
		t.Error("Empty sizeID should not produce size_ids params")
	}
}
