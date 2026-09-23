package model

import "testing"

func TestRegionDomain_AllKnownRegions(t *testing.T) {
	known := map[string]string{
		"de": "www.vinted.de",
		"fr": "www.vinted.fr",
		"it": "www.vinted.it",
		"es": "www.vinted.es",
		"nl": "www.vinted.nl",
		"pl": "www.vinted.pl",
		"pt": "www.vinted.pt",
		"be": "www.vinted.be",
		"at": "www.vinted.at",
		"lu": "www.vinted.lu",
		"uk": "www.vinted.co.uk",
		"cz": "www.vinted.cz",
		"sk": "www.vinted.sk",
		"lt": "www.vinted.lt",
		"se": "www.vinted.se",
		"dk": "www.vinted.dk",
		"ro": "www.vinted.ro",
		"hu": "www.vinted.hu",
		"hr": "www.vinted.hr",
		"fi": "www.vinted.fi",
		"ie": "www.vinted.ie",
		"si": "www.vinted.si",
		"ee": "www.vinted.ee",
		"lv": "www.vinted.lv",
		"gr": "www.vinted.gr",
	}

	for region, expectedDomain := range known {
		t.Run(region, func(t *testing.T) {
			got := RegionDomain(region)
			if got != expectedDomain {
				t.Errorf("RegionDomain(%q) = %q, want %q", region, got, expectedDomain)
			}
		})
	}
}

func TestRegionDomain_UnknownFallback(t *testing.T) {
	got := RegionDomain("xx")
	if got != "www.vinted.de" {
		t.Errorf("RegionDomain(unknown) = %q, want %q", got, "www.vinted.de")
	}
}

func TestRegionDomain_EmptyString(t *testing.T) {
	got := RegionDomain("")
	if got != "www.vinted.de" {
		t.Errorf("RegionDomain(\"\") = %q, want %q", got, "www.vinted.de")
	}
}

func TestRegionCurrency(t *testing.T) {
	for region, want := range map[string]string{
		"de": "EUR", "uk": "GBP", "pl": "PLN", "cz": "CZK", "se": "SEK", "dk": "DKK", "ro": "RON", "hu": "HUF",
	} {
		if got := RegionCurrency(region); got != want {
			t.Errorf("RegionCurrency(%q) = %q, want %q", region, got, want)
		}
		if got := DomainCurrency(RegionDomain(region)); got != want {
			t.Errorf("DomainCurrency(%q) = %q, want %q", RegionDomain(region), got, want)
		}
	}
}
