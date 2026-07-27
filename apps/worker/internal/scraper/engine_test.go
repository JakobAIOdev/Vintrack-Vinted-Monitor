package scraper

import (
	"net/http/httptest"
	"testing"
	"time"
	"vintrack-worker/internal/model"
)

func TestFreeProxyMonitorNeverAutoStopsForTransientPoolFailures(t *testing.T) {
	if shouldAutoStopMonitor("free", 10_000, 20) {
		t.Fatal("free proxy monitor should remain active while the shared pool recovers")
	}
	if !shouldAutoStopMonitor("server", 20, 20) {
		t.Fatal("non-free monitor should retain the configured auto-stop behavior")
	}
}

func TestBuildItems_BasicConstruction(t *testing.T) {
	e := &Engine{}
	m := model.Monitor{
		ID:     1,
		Query:  "test",
		Region: "de",
	}
	vItems := []model.VintedItem{
		{
			ID:         12345,
			Title:      "Nike Air Max 90",
			Price:      model.VintedPrice{Amount: "49.00", Currency: "EUR"},
			Url:        "/items/12345-nike-air-max-90",
			Photo:      model.VintedPhoto{Url: "https://img.vinted.de/photo1.jpg"},
			SizeTitle:  "42",
			BrandTitle: "Nike",
			Condition:  "Gut",
			User:       model.VintedUser{ID: 99, Login: "seller1"},
		},
	}

	items := e.buildItems(m, vItems)

	if len(items) != 1 {
		t.Fatalf("Expected 1 item, got %d", len(items))
	}

	item := items[0]

	if item.ID != 12345 {
		t.Errorf("ID = %d, want 12345", item.ID)
	}
	if item.MonitorID != 1 {
		t.Errorf("MonitorID = %d, want 1", item.MonitorID)
	}
	if item.Title != "Nike Air Max 90" {
		t.Errorf("Title = %q, want %q", item.Title, "Nike Air Max 90")
	}
	if item.Brand != "Nike" {
		t.Errorf("Brand = %q, want %q", item.Brand, "Nike")
	}
	if item.Price != "49.00 EUR" {
		t.Errorf("Price = %q, want %q", item.Price, "49.00 EUR")
	}
	if item.Size != "42" {
		t.Errorf("Size = %q, want %q", item.Size, "42")
	}
	if item.Condition != "Gut" {
		t.Errorf("Condition = %q, want %q", item.Condition, "Gut")
	}
	if item.SellerID != 99 {
		t.Errorf("SellerID = %d, want 99", item.SellerID)
	}
	if item.SellerLogin != "seller1" {
		t.Errorf("SellerLogin = %q, want seller1", item.SellerLogin)
	}
	if item.SellerURL != "https://www.vinted.de/member/99-seller1" {
		t.Errorf("SellerURL = %q, want seller profile URL", item.SellerURL)
	}
}

func TestBuildItems_URLPrefixing(t *testing.T) {
	e := &Engine{}
	m := model.Monitor{ID: 1, Region: "fr"}

	tests := []struct {
		name        string
		inputURL    string
		expectedURL string
	}{
		{"relative URL", "/items/123-test", "https://www.vinted.fr/items/123-test"},
		{"absolute URL", "https://www.vinted.fr/items/123-test", "https://www.vinted.fr/items/123-test"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			vItems := []model.VintedItem{
				{ID: 1, Url: tt.inputURL, Price: model.VintedPrice{Amount: "10", Currency: "EUR"}, User: model.VintedUser{ID: 1}},
			}
			items := e.buildItems(m, vItems)
			if items[0].URL != tt.expectedURL {
				t.Errorf("URL = %q, want %q", items[0].URL, tt.expectedURL)
			}
		})
	}
}

func TestBuildItems_SizeFallback(t *testing.T) {
	e := &Engine{}
	m := model.Monitor{ID: 1, Region: "de"}

	// When SizeTitle is empty, should fall back to Size
	vItems := []model.VintedItem{
		{ID: 1, SizeTitle: "", Size: "M", Price: model.VintedPrice{Amount: "10", Currency: "EUR"}, User: model.VintedUser{ID: 1}},
	}
	items := e.buildItems(m, vItems)
	if items[0].Size != "M" {
		t.Errorf("Size fallback: got %q, want %q", items[0].Size, "M")
	}

	// When SizeTitle is set, should use SizeTitle
	vItems[0].SizeTitle = "L / 42"
	items = e.buildItems(m, vItems)
	if items[0].Size != "L / 42" {
		t.Errorf("Size from SizeTitle: got %q, want %q", items[0].Size, "L / 42")
	}
}

func TestBuildItems_TotalPrice(t *testing.T) {
	e := &Engine{}
	m := model.Monitor{ID: 1, Region: "de"}

	// With total price
	vItems := []model.VintedItem{
		{
			ID:             1,
			Price:          model.VintedPrice{Amount: "10", Currency: "EUR"},
			TotalItemPrice: &model.VintedPrice{Amount: "12.50", Currency: "EUR"},
			User:           model.VintedUser{ID: 1},
		},
	}
	items := e.buildItems(m, vItems)
	if items[0].TotalPrice != "12.50 EUR" {
		t.Errorf("TotalPrice = %q, want %q", items[0].TotalPrice, "12.50 EUR")
	}

	// Without total price
	vItems[0].TotalItemPrice = nil
	items = e.buildItems(m, vItems)
	if items[0].TotalPrice != "" {
		t.Errorf("TotalPrice should be empty when nil, got %q", items[0].TotalPrice)
	}
}

func TestBuildItems_ExtraImages(t *testing.T) {
	e := &Engine{}
	m := model.Monitor{ID: 1, Region: "de"}

	vItems := []model.VintedItem{
		{
			ID:    1,
			Photo: model.VintedPhoto{Url: "https://img1.jpg"},
			Photos: []model.VintedPhoto{
				{Url: "https://img1.jpg"}, // First photo (skipped, it's the main photo)
				{Url: "https://img2.jpg"},
				{Url: "https://img3.jpg"},
			},
			Price: model.VintedPrice{Amount: "10", Currency: "EUR"},
			User:  model.VintedUser{ID: 1},
		},
	}
	items := e.buildItems(m, vItems)

	if len(items[0].ExtraImages) != 2 {
		t.Errorf("ExtraImages count = %d, want 2", len(items[0].ExtraImages))
	}
	if items[0].ExtraImages[0] != "https://img2.jpg" {
		t.Errorf("ExtraImages[0] = %q, want %q", items[0].ExtraImages[0], "https://img2.jpg")
	}
}

func TestBuildItems_FoundAtIsRecent(t *testing.T) {
	e := &Engine{}
	m := model.Monitor{ID: 1, Region: "de"}

	before := time.Now().Add(-time.Second)
	vItems := []model.VintedItem{
		{ID: 1, Price: model.VintedPrice{Amount: "10", Currency: "EUR"}, User: model.VintedUser{ID: 1}},
	}
	items := e.buildItems(m, vItems)
	after := time.Now().Add(time.Second)

	if items[0].FoundAt.Before(before) || items[0].FoundAt.After(after) {
		t.Errorf("FoundAt = %v, should be close to now", items[0].FoundAt)
	}
}

func TestBuildItems_MockModeAddsSellerMetadata(t *testing.T) {
	fetcher, err := NewMockCatalogFetcher("empty")
	if err != nil {
		t.Fatalf("NewMockCatalogFetcher() error = %v", err)
	}

	e := &Engine{fetcher: fetcher}
	m := model.Monitor{ID: 1, Region: "de"}
	vItems := []model.VintedItem{
		{
			ID:         123,
			Title:      "Mock Item",
			Price:      model.VintedPrice{Amount: "19.00", Currency: "EUR"},
			BrandTitle: "Nike",
			SizeTitle:  "42",
			Condition:  "Sehr gut",
			User:       model.VintedUser{ID: 456},
		},
	}

	items := e.buildItems(m, vItems)

	if items[0].Location == "" {
		t.Fatal("Location should be set for mock items")
	}
	if items[0].Rating == "" {
		t.Fatal("Rating should be set for mock items")
	}
	if items[0].Brand != "Nike" {
		t.Fatalf("Brand = %q, want Nike", items[0].Brand)
	}
	if items[0].Price != "19.00 EUR" {
		t.Fatalf("Price = %q, want 19.00 EUR", items[0].Price)
	}
}

func TestBuildItems_MultipleItems(t *testing.T) {
	e := &Engine{}
	m := model.Monitor{ID: 5, Region: "nl"}

	vItems := make([]model.VintedItem, 20)
	for i := range vItems {
		vItems[i] = model.VintedItem{
			ID:    int64(i + 1),
			Title: "Item",
			Price: model.VintedPrice{Amount: "10", Currency: "EUR"},
			User:  model.VintedUser{ID: int64(i)},
		}
	}

	items := e.buildItems(m, vItems)
	if len(items) != 20 {
		t.Errorf("Expected 20 items, got %d", len(items))
	}
	for i, item := range items {
		if item.MonitorID != 5 {
			t.Errorf("Item %d: MonitorID = %d, want 5", i, item.MonitorID)
		}
	}
}

func TestSplitIncomingItems_InitialScanMuted(t *testing.T) {
	items := []model.VintedItem{
		{ID: 1},
		{ID: 2},
	}
	newMap := map[int64]bool{
		1: true,
		2: true,
	}

	processItems, seedItems := splitIncomingItems(items, newMap, false)

	if len(processItems) != 0 {
		t.Fatalf("processItems = %d, want 0 during initial scan", len(processItems))
	}
	if len(seedItems) != 2 {
		t.Fatalf("seedItems = %d, want 2 during initial scan", len(seedItems))
	}
}

func TestSplitIncomingItems_AfterInitializationOnlyNewItems(t *testing.T) {
	items := []model.VintedItem{
		{ID: 1},
		{ID: 2},
		{ID: 3},
	}
	newMap := map[int64]bool{
		1: false,
		2: true,
		3: false,
	}

	processItems, seedItems := splitIncomingItems(items, newMap, true)

	if len(seedItems) != 0 {
		t.Fatalf("seedItems = %d, want 0 after initialization", len(seedItems))
	}
	if len(processItems) != 1 {
		t.Fatalf("processItems = %d, want 1 after initialization", len(processItems))
	}
	if processItems[0].ID != 2 {
		t.Fatalf("processItems[0].ID = %d, want 2", processItems[0].ID)
	}
}

func TestFilterAntiKeywordItems_TitleAndDescription(t *testing.T) {
	raw := "fake, damaged\nreplica"
	items := []model.VintedItem{
		{ID: 1, Title: "Nike Air Max"},
		{ID: 2, Title: "Nike Air Max fake"},
		{ID: 3, Title: "Adidas Samba", Description: "Small DAMAGED spot"},
		{ID: 4, Title: "New Balance", Description: "Looks great"},
	}

	filtered, blocked := filterAntiKeywordItems(items, &raw)

	if blocked != 2 {
		t.Fatalf("blocked = %d, want 2", blocked)
	}
	if len(filtered) != 2 {
		t.Fatalf("filtered = %d, want 2", len(filtered))
	}
	if filtered[0].ID != 1 || filtered[1].ID != 4 {
		t.Fatalf("filtered IDs = [%d, %d], want [1, 4]", filtered[0].ID, filtered[1].ID)
	}
}

func TestFilterAntiKeywordItems_NoKeywordsReturnsOriginal(t *testing.T) {
	items := []model.VintedItem{{ID: 1, Title: "Nike"}}

	filtered, blocked := filterAntiKeywordItems(items, nil)

	if blocked != 0 {
		t.Fatalf("blocked = %d, want 0", blocked)
	}
	if len(filtered) != 1 || filtered[0].ID != 1 {
		t.Fatalf("filtered = %#v, want original item", filtered)
	}
}

func TestFilterBannedSellerItems(t *testing.T) {
	items := []model.VintedItem{
		{ID: 1, User: model.VintedUser{ID: 101}},
		{ID: 2, User: model.VintedUser{ID: 202}},
		{ID: 3, User: model.VintedUser{ID: 303}},
	}

	filtered, blocked := filterBannedSellerItems(items, []int64{202, 404})

	if blocked != 1 {
		t.Fatalf("blocked = %d, want 1", blocked)
	}
	if len(filtered) != 2 {
		t.Fatalf("filtered = %d, want 2", len(filtered))
	}
	if filtered[0].ID != 1 || filtered[1].ID != 3 {
		t.Fatalf("filtered IDs = [%d, %d], want [1, 3]", filtered[0].ID, filtered[1].ID)
	}
}

func TestBuildSellerProfileURL(t *testing.T) {
	tests := []struct {
		name   string
		id     int64
		login  string
		domain string
		want   string
	}{
		{name: "with login", id: 42, login: "seller-name", domain: "www.vinted.de", want: "https://www.vinted.de/member/42-seller-name"},
		{name: "without login", id: 42, domain: "www.vinted.fr", want: "https://www.vinted.fr/member/42"},
		{name: "without id", id: 0, domain: "www.vinted.de", want: ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := buildSellerProfileURL(tt.domain, tt.id, tt.login); got != tt.want {
				t.Fatalf("buildSellerProfileURL() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestResolveQueryDelayMs(t *testing.T) {
	tests := []struct {
		name  string
		input int
		want  int
	}{
		{name: "valid monitor value", input: 1500, want: 1500},
		{name: "clamps below minimum", input: 100, want: 500},
		{name: "clamps above maximum", input: 7200000, want: 3600000},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := resolveQueryDelayMs(tt.input); got != tt.want {
				t.Fatalf("resolveQueryDelayMs(%d) = %d, want %d", tt.input, got, tt.want)
			}
		})
	}
}

func TestResolveRedirectURL(t *testing.T) {
	tests := []struct {
		name     string
		current  string
		location string
		want     string
	}{
		{
			name:     "relative path",
			current:  "https://www.vinted.co.uk/api/v2/catalog/items?order=newest_first",
			location: "/member/general?ref=%2Fapi%2Fv2%2Fcatalog%2Fitems",
			want:     "https://www.vinted.co.uk/member/general?ref=%2Fapi%2Fv2%2Fcatalog%2Fitems",
		},
		{
			name:     "absolute url",
			current:  "https://www.vinted.co.uk/api/v2/catalog/items",
			location: "https://www.vinted.co.uk/session-refresh?ref_url=%2F",
			want:     "https://www.vinted.co.uk/session-refresh?ref_url=%2F",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := resolveRedirectURL(tt.current, tt.location)
			if err != nil {
				t.Fatalf("resolveRedirectURL() error = %v", err)
			}
			if got != tt.want {
				t.Errorf("resolveRedirectURL() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestAcceptLanguageForDomain(t *testing.T) {
	tests := []struct {
		domain string
		want   string
	}{
		{"www.vinted.co.uk", "en-GB,en;q=0.9"},
		{"www.vinted.ie", "en-IE,en;q=0.9"},
		{"www.vinted.fr", "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7"},
		{"www.vinted.de", "de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7"},
	}

	for _, tt := range tests {
		if got := acceptLanguageForDomain(tt.domain); got != tt.want {
			t.Errorf("acceptLanguageForDomain(%q) = %q, want %q", tt.domain, got, tt.want)
		}
	}
}

func TestHostFromURL(t *testing.T) {
	server := httptest.NewServer(nil)
	defer server.Close()

	if got := hostFromURL(server.URL+"/path", "fallback.example"); got == "fallback.example" {
		t.Errorf("hostFromURL() should prefer parsed host, got %q", got)
	}

	if got := hostFromURL("::bad-url::", "fallback.example"); got != "fallback.example" {
		t.Errorf("hostFromURL() fallback = %q, want %q", got, "fallback.example")
	}
}
