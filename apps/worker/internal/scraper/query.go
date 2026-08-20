package scraper

import (
	"strings"

	"vintrack-worker/internal/model"
)

func parseMonitorQueries(raw string) []string {
	parts := strings.FieldsFunc(raw, func(r rune) bool {
		return r == ',' || r == '\n' || r == '\r'
	})
	queries := make([]string, 0, len(parts))
	seen := make(map[string]bool, len(parts))
	for _, part := range parts {
		query := strings.Join(strings.Fields(part), " ")
		key := strings.ToLower(query)
		if key == "" || seen[key] {
			continue
		}
		seen[key] = true
		queries = append(queries, query)
	}
	return queries
}

func monitorQueryForCheck(queries []string, check int) (int, string) {
	if len(queries) == 0 {
		return 0, ""
	}
	if check < 1 {
		check = 1
	}
	index := (check - 1) % len(queries)
	return index, queries[index]
}

// catalogQueryMatcher is the compiled form of a monitor query: one slice of
// lowercased terms per comma-separated alternative. Compiling once per catalog
// page instead of once per item removes an O(items) re-parse of a value that is
// constant for the whole cycle.
type catalogQueryMatcher struct {
	terms [][]string
}

func compileCatalogQueryMatcher(rawQuery string) catalogQueryMatcher {
	queries := parseMonitorQueries(rawQuery)
	if len(queries) == 0 {
		return catalogQueryMatcher{}
	}
	terms := make([][]string, 0, len(queries))
	for _, query := range queries {
		terms = append(terms, strings.Fields(strings.ToLower(query)))
	}
	return catalogQueryMatcher{terms: terms}
}

// matches lowercases the haystack before testing it.
func (m catalogQueryMatcher) matches(haystack string) bool {
	if len(m.terms) == 0 {
		return true
	}
	return m.matchesLowered(strings.ToLower(haystack))
}

// matchesLowered skips the ToLower for callers that already normalized the
// haystack, so a shared haystack is lowered once rather than once per check.
func (m catalogQueryMatcher) matchesLowered(loweredHaystack string) bool {
	if len(m.terms) == 0 {
		return true
	}
	for _, terms := range m.terms {
		matched := true
		for _, term := range terms {
			if !strings.Contains(loweredHaystack, term) {
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

func matchesMonitorQuery(haystack string, rawQuery string) bool {
	return compileCatalogQueryMatcher(rawQuery).matches(haystack)
}

func filterTitleOnlyItems(items []model.VintedItem, rawQuery string, titleOnly bool) ([]model.VintedItem, int) {
	if !titleOnly || len(items) == 0 {
		return items, 0
	}

	matcher := compileCatalogQueryMatcher(rawQuery)
	filtered := make([]model.VintedItem, 0, len(items))
	blocked := 0
	for _, item := range items {
		if !matcher.matches(item.Title) {
			blocked++
			continue
		}
		filtered = append(filtered, item)
	}
	return filtered, blocked
}
