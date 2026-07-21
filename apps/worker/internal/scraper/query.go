package scraper

import "strings"

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

func matchesMonitorQuery(haystack string, rawQuery string) bool {
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
