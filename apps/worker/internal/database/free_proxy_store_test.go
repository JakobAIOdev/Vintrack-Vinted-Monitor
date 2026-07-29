package database

import "testing"

func TestPruneUnselectedFreeProxiesSkipsEmptyKeepSet(t *testing.T) {
	store := &Store{}

	pruned, err := store.PruneUnselectedFreeProxies(nil)
	if err != nil {
		t.Fatalf("PruneUnselectedFreeProxies(nil) error = %v", err)
	}
	if pruned != 0 {
		t.Fatalf("PruneUnselectedFreeProxies(nil) = %d, want 0", pruned)
	}
}

func TestFreeProxyExplorationQuota(t *testing.T) {
	tests := []struct {
		limit int
		want  int
	}{
		{limit: 0, want: 0},
		{limit: 1, want: 0},
		{limit: 2, want: 1},
		{limit: 24, want: 4},
		{limit: 120, want: 24},
	}

	for _, test := range tests {
		if got := freeProxyExplorationQuota(test.limit); got != test.want {
			t.Fatalf(
				"freeProxyExplorationQuota(%d) = %d, want %d",
				test.limit,
				got,
				test.want,
			)
		}
	}
}
