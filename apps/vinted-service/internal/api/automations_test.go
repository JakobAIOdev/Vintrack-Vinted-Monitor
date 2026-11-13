package api

import (
	"strings"
	"testing"
	"vintrack-vinted/internal/session"
)

func TestAutomaticOfferUsesMinorUnitsAndListingLimit(t *testing.T) {
	for _, tc := range []struct {
		price    string
		discount int
		limit    int64
		want     string
		valid    bool
	}{
		{"25.00 EUR", 10, 2500, "22.50", true}, {"19.99 GBP", 15, 2000, "16.99", true},
		{"12.5 PLN", 10, 2000, "11.25", true}, {"100 EUR", 50, 10000, "50.00", true},
		{"25.01 EUR", 10, 2500, "", false}, {"0.01 EUR", 1, 100, "", false},
		{"0 EUR", 10, 100, "", false}, {"-5 EUR", 10, 100, "", false}, {"1e2 EUR", 10, 10000, "", false},
		{"1,234.00 EUR", 10, 1000000, "", false}, {"25.00", 10, 10000, "", false}, {"25.00 EUR", 51, 10000, "", false},
	} {
		price, _, valid := automaticOfferPrice(session.AutomationCandidate{Price: tc.price, DiscountPercent: tc.discount, MaxPriceMinor: tc.limit})
		if valid != tc.valid || price != tc.want {
			t.Fatalf("%+v: price=%s valid=%v", tc, price, valid)
		}
	}
}

func TestAutomationRegionCurrencyMatchesMarketplace(t *testing.T) {
	for region, want := range map[string]string{
		"de": "EUR", "fr": "EUR", "uk": "GBP", "pl": "PLN", "us": "USD", "unknown": "EUR",
	} {
		if got := automationRegionCurrency(region); got != want {
			t.Errorf("automationRegionCurrency(%q) = %q, want %q", region, got, want)
		}
	}
	price, currency, valid := automaticOfferPrice(session.AutomationCandidate{Price: "30.00 USD", DiscountPercent: 10, MaxPriceMinor: 5000})
	if !valid || price != "27.00" || currency != automationRegionCurrency("us") {
		t.Fatalf("US offer = %s %s valid=%v", price, currency, valid)
	}
	if currency == automationRegionCurrency("de") {
		t.Fatal("a USD listing must not pass the currency check of a EUR region")
	}
}

func TestAutomaticMessageValidatesExpandedPayload(t *testing.T) {
	c := session.AutomationCandidate{Template: "Hi {seller}, {title} for {price} {currency}? {url} ({monitor})", Seller: "seller", Title: "Jacket {seller}", Price: "25.00 EUR", URL: "https://example.invalid/item", MonitorName: "Jackets"}
	got, valid := automaticMessage(c)
	if !valid || got != "Hi seller, Jacket {seller} for 25.00 EUR? https://example.invalid/item (Jackets)" {
		t.Fatalf("%q %v", got, valid)
	}
	for _, template := range []string{" ", "{unknown}", "{title", "title}", strings.Repeat("ü", 501)} {
		c.Template = template
		if _, valid := automaticMessage(c); valid {
			t.Fatalf("accepted invalid template %q", template)
		}
	}
	c.Template = "{title}{title}{title}"
	c.Title = strings.Repeat("ü", 400)
	if _, valid := automaticMessage(c); valid {
		t.Fatal("accepted oversized expanded message")
	}
}
