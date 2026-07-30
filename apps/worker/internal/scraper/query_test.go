package scraper

import (
	"reflect"
	"testing"

	"vintrack-worker/internal/model"
)

func TestParseMonitorQueriesNormalizesAndDeduplicates(t *testing.T) {
	got := parseMonitorQueries(" console ps1, playstation   1\nCONSOLE PS1, ps one ")
	want := []string{"console ps1", "playstation 1", "ps one"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("parseMonitorQueries() = %#v, want %#v", got, want)
	}
}

func TestMonitorQueryForCheckRotatesAlternatives(t *testing.T) {
	queries := []string{"ps1", "playstation 1", "ps one"}
	want := []string{"ps1", "playstation 1", "ps one", "ps1"}
	for check, expected := range want {
		_, got := monitorQueryForCheck(queries, check+1)
		if got != expected {
			t.Fatalf("check %d selected %q, want %q", check+1, got, expected)
		}
	}
}

func TestMatchesMonitorQueryUsesORBetweenAlternatives(t *testing.T) {
	query := "console ps1, playstation 1 bundle, ps one"
	tests := []struct {
		name     string
		haystack string
		want     bool
	}{
		{name: "first alternative", haystack: "Console Sony PS1 grigia", want: true},
		{name: "second alternative", haystack: "Bundle PlayStation 1 con giochi", want: true},
		{name: "third alternative", haystack: "PS One boxed", want: true},
		{name: "partial alternative", haystack: "PlayStation 2 bundle", want: false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := matchesMonitorQuery(test.haystack, query); got != test.want {
				t.Fatalf("matchesMonitorQuery() = %v, want %v", got, test.want)
			}
		})
	}
}

func TestFilterTitleOnlyItems(t *testing.T) {
	items := []model.VintedItem{
		{ID: 1, Title: "Nike Air Max 90"},
		{ID: 2, Title: "Vintage trainers", Description: "Nike Air Max 90"},
		{ID: 3, Title: "Adidas Samba OG"},
	}

	filtered, blocked := filterTitleOnlyItems(items, "nike air, adidas samba", true)

	if blocked != 1 {
		t.Fatalf("blocked = %d, want 1", blocked)
	}
	if len(filtered) != 2 || filtered[0].ID != 1 || filtered[1].ID != 3 {
		t.Fatalf("filtered items = %#v, want IDs [1 3]", filtered)
	}
}

func TestFilterTitleOnlyItemsDisabledReturnsOriginal(t *testing.T) {
	items := []model.VintedItem{{
		ID:          1,
		Title:       "Vintage trainers",
		Description: "Nike Air Max",
	}}

	filtered, blocked := filterTitleOnlyItems(items, "nike", false)

	if blocked != 0 || len(filtered) != 1 {
		t.Fatalf("blocked = %d, filtered = %d, want 0 and 1", blocked, len(filtered))
	}
}
