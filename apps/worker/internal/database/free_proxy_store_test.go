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

func TestFreeProxyProtocolQuotas(t *testing.T) {
	web, socks5, socks4 := freeProxyProtocolQuotas(120)
	if web != 72 || socks5 != 30 || socks4 != 18 {
		t.Fatalf(
			"freeProxyProtocolQuotas(120) = %d/%d/%d, want 72/30/18",
			web,
			socks5,
			socks4,
		)
	}

	web, socks5, socks4 = freeProxyProtocolQuotas(3)
	if web+socks5+socks4 != 3 || web == 0 || socks5 == 0 || socks4 == 0 {
		t.Fatalf(
			"freeProxyProtocolQuotas(3) = %d/%d/%d, want every protocol represented",
			web,
			socks5,
			socks4,
		)
	}
}
