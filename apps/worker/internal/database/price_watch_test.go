package database

import (
	"database/sql"
	"testing"
)

func TestPriceWatchStoppedMessageNamesTheReason(t *testing.T) {
	price := sql.NullInt64{Int64: 1500, Valid: true}
	tests := []struct {
		reason  string
		heading string
		message string
	}{
		{
			PriceWatchStopSold, "Price Watch ended: listing sold",
			"“Wool coat” was sold or is no longer for sale, so Vintrack stopped watching it.\nLast price: 15.00 EUR\nhttps://www.vinted.de/items/300-wool-coat",
		},
		{
			PriceWatchStopDeleted, "Price Watch ended: listing removed",
			"“Wool coat” was removed from Vinted, so Vintrack stopped watching it.\nLast price: 15.00 EUR\nhttps://www.vinted.de/items/300-wool-coat",
		},
		{
			PriceWatchStopUnavailable, "Price Watch ended: listing unavailable",
			"“Wool coat” is no longer available, so Vintrack stopped watching it.\nLast price: 15.00 EUR\nhttps://www.vinted.de/items/300-wool-coat",
		},
	}
	for _, test := range tests {
		heading, message := priceWatchStoppedMessage(test.reason, " Wool coat ", 300, price, "eur", "https://www.vinted.de/items/300-wool-coat")
		if heading != test.heading || message != test.message {
			t.Fatalf("%s: heading=%q message=%q", test.reason, heading, message)
		}
	}
}

func TestPriceWatchStoppedMessageOmitsWhatIsUnknown(t *testing.T) {
	heading, message := priceWatchStoppedMessage(PriceWatchStopSold, "", 300, sql.NullInt64{}, "", "javascript:alert(1)")
	if heading != "Price Watch ended: listing sold" {
		t.Fatalf("heading = %q", heading)
	}
	if message != "“Vinted item #300” was sold or is no longer for sale, so Vintrack stopped watching it." {
		t.Fatalf("message = %q", message)
	}
	// A price without a usable currency is not shown.
	_, message = priceWatchStoppedMessage(PriceWatchStopSold, "Coat", 300, sql.NullInt64{Int64: 5, Valid: true}, "EURO", "")
	if message != "“Coat” was sold or is no longer for sale, so Vintrack stopped watching it." {
		t.Fatalf("message = %q", message)
	}
}
