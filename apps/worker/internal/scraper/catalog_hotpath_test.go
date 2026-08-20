package scraper

import (
	"fmt"
	"strings"
	"testing"

	"vintrack-worker/internal/model"
)

// legacyMatchesMonitorQuery is the pre-optimisation implementation, kept here so
// the compiled catalogQueryMatcher can be proven equivalent rather than assumed
// equivalent.
func legacyMatchesMonitorQuery(haystack string, rawQuery string) bool {
	queries := parseMonitorQueries(rawQuery)
	if len(queries) == 0 {
		return true
	}
	normalizedHaystack := strings.ToLower(haystack)
	for _, query := range queries {
		matched := true
		for _, term := range strings.Fields(strings.ToLower(query)) {
			if !strings.Contains(normalizedHaystack, term) {
				matched = false
				break
			}
		}
		if matched {
			return true
		}
	}
	return false
}

func TestCatalogQueryMatcherMatchesLegacySemantics(t *testing.T) {
	queries := []string{
		"",
		"   ",
		"nike",
		"nike air max",
		"nike air max, adidas samba",
		"NIKE   Air\nMax, ,, asics",
		",",
	}
	haystacks := []string{
		"",
		"Nike Air Max 90",
		"nike",
		"Adidas Samba OG",
		"ASICS Gel Lyte III",
		"Air Max",
		"NIKE AIR MAX",
	}

	for _, query := range queries {
		matcher := compileCatalogQueryMatcher(query)
		for _, haystack := range haystacks {
			want := legacyMatchesMonitorQuery(haystack, query)
			if got := matcher.matches(haystack); got != want {
				t.Errorf("matcher.matches(%q) with query %q = %v, want %v", haystack, query, got, want)
			}
			if got := matchesMonitorQuery(haystack, query); got != want {
				t.Errorf("matchesMonitorQuery(%q, %q) = %v, want %v", haystack, query, got, want)
			}
			if got := matcher.matchesLowered(strings.ToLower(haystack)); got != want {
				t.Errorf("matcher.matchesLowered(%q) with query %q = %v, want %v", haystack, query, got, want)
			}
		}
	}
}

// legacyMatchesDiscovery is the pre-optimisation implementation of
// matchesDiscovery, including its per-item re-parsing.
func legacyMatchesDiscovery(item model.VintedItem, monitor model.Monitor) bool {
	haystack := item.Title
	if !monitor.TitleOnly {
		haystack += "\n" + item.BrandTitle
	}
	haystack = strings.ToLower(haystack)
	if !legacyMatchesMonitorQuery(haystack, monitor.Query) {
		return false
	}
	antiKeywordHaystack := haystack + "\n" + strings.ToLower(item.Description)
	for _, keyword := range parseAntiKeywords(monitor.AntiKeywords) {
		if strings.Contains(antiKeywordHaystack, keyword) {
			return false
		}
	}
	if _, blocked := filterBannedSellerItems([]model.VintedItem{item}, monitor.BannedSellerIDs); blocked > 0 {
		return false
	}
	return true
}

func TestDiscoveryMonitorMatcherMatchesLegacySemantics(t *testing.T) {
	antiKeywords := []*string{nil}
	for _, raw := range []string{"", "defekt", "defekt, replica", "  , ,  ", "NIKE"} {
		value := raw
		antiKeywords = append(antiKeywords, &value)
	}

	bannedSets := [][]int64{nil, {}, {0}, {700001}, {0, 700002, 700003}}
	queries := []string{"", "nike", "nike air max", "nike air max, adidas", "brandonly"}

	items := []model.VintedItem{
		{ID: 1, Title: "Nike Air Max 90", BrandTitle: "Nike", Description: "guter Zustand", User: model.VintedUser{ID: 700001}},
		{ID: 2, Title: "Sneaker", BrandTitle: "BrandOnly", Description: "defekt an der Sohle", User: model.VintedUser{ID: 700002}},
		{ID: 3, Title: "", BrandTitle: "", Description: "", User: model.VintedUser{ID: 0}},
		{ID: 4, Title: "Adidas Samba OG", BrandTitle: "Adidas", Description: "replica", User: model.VintedUser{ID: 700009}},
		{ID: 5, Title: "NIKE AIR MAX", BrandTitle: "nike", Description: "", User: model.VintedUser{ID: 700003}},
	}

	cases := 0
	for _, query := range queries {
		for _, titleOnly := range []bool{true, false} {
			for _, keywords := range antiKeywords {
				for _, banned := range bannedSets {
					monitor := model.Monitor{
						ID:              7,
						Query:           query,
						TitleOnly:       titleOnly,
						AntiKeywords:    keywords,
						BannedSellerIDs: banned,
					}
					matcher := compileDiscoveryMonitorMatcher(monitor)
					for _, item := range items {
						want := legacyMatchesDiscovery(item, monitor)
						if got := matcher.matches(item); got != want {
							t.Fatalf(
								"matcher.matches(item %d) = %v, want %v (query=%q titleOnly=%v anti=%v banned=%v)",
								item.ID, got, want, query, titleOnly, keywords, banned,
							)
						}
						if got := matchesDiscovery(item, monitor); got != want {
							t.Fatalf(
								"matchesDiscovery(item %d) = %v, want %v (query=%q titleOnly=%v)",
								item.ID, got, want, query, titleOnly,
							)
						}
						cases++
					}
				}
			}
		}
	}
	if cases == 0 {
		t.Fatal("no discovery matcher cases were exercised")
	}
}

func TestCompileDiscoveryMonitorMatchersPreservesMonitorOrder(t *testing.T) {
	monitors := []model.Monitor{{ID: 3}, {ID: 1}, {ID: 2}}
	matchers := compileDiscoveryMonitorMatchers(monitors)
	if len(matchers) != len(monitors) {
		t.Fatalf("compiled %d matchers, want %d", len(matchers), len(monitors))
	}
	for i, matcher := range matchers {
		if matcher.monitor.ID != monitors[i].ID {
			t.Fatalf("matcher %d carries monitor %d, want %d", i, matcher.monitor.ID, monitors[i].ID)
		}
	}
}

// legacyBuildSellerProfileURL is the pre-optimisation fmt-based implementation.
func legacyBuildSellerProfileURL(domain string, sellerID int64, sellerLogin string) string {
	if sellerID == 0 {
		return ""
	}
	sellerPath := fmt.Sprintf("%d", sellerID)
	if strings.TrimSpace(sellerLogin) != "" {
		sellerPath = fmt.Sprintf("%d-%s", sellerID, strings.TrimSpace(sellerLogin))
	}
	return fmt.Sprintf("https://%s/member/%s", domain, sellerPath)
}

func TestBuildSellerProfileURLMatchesLegacyOutput(t *testing.T) {
	domains := []string{"www.vinted.de", "www.vinted.co.uk", ""}
	logins := []string{"", "  ", "seller_1", "  padded  ", "ünicode"}
	ids := []int64{0, 1, 700123, -5}

	for _, domain := range domains {
		for _, id := range ids {
			for _, login := range logins {
				want := legacyBuildSellerProfileURL(domain, id, login)
				if got := buildSellerProfileURL(domain, id, login); got != want {
					t.Fatalf(
						"buildSellerProfileURL(%q, %d, %q) = %q, want %q",
						domain, id, login, got, want,
					)
				}
			}
		}
	}
}

func TestBuildItemsExtraImagesPreservesNilForThinPhotoSets(t *testing.T) {
	engine := &Engine{fetcher: VintedCatalogFetcher{}}
	monitor := model.Monitor{ID: 1, Region: "de"}

	tests := map[string]struct {
		photos []model.VintedPhoto
		want   []string
	}{
		"no_photos":        {photos: nil, want: nil},
		"single_photo":     {photos: []model.VintedPhoto{{Url: "a"}}, want: nil},
		"blank_extras":     {photos: []model.VintedPhoto{{Url: "a"}, {Url: ""}, {Url: ""}}, want: nil},
		"two_photos":       {photos: []model.VintedPhoto{{Url: "a"}, {Url: "b"}}, want: []string{"b"}},
		"mixed_extras":     {photos: []model.VintedPhoto{{Url: "a"}, {Url: ""}, {Url: "c"}}, want: []string{"c"}},
		"leading_blank_ok": {photos: []model.VintedPhoto{{Url: ""}, {Url: "b"}, {Url: "c"}}, want: []string{"b", "c"}},
	}

	for name, test := range tests {
		t.Run(name, func(t *testing.T) {
			built := engine.buildItems(monitor, []model.VintedItem{{ID: 5, Photos: test.photos}})
			got := built[0].ExtraImages
			if len(got) != len(test.want) {
				t.Fatalf("ExtraImages = %#v, want %#v", got, test.want)
			}
			if test.want == nil && got != nil {
				t.Fatalf("ExtraImages = %#v, want nil", got)
			}
			for i := range test.want {
				if got[i] != test.want[i] {
					t.Fatalf("ExtraImages = %#v, want %#v", got, test.want)
				}
			}
		})
	}
}
