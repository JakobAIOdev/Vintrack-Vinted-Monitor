package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestStoreCheckoutLinkKeepsOnlyACheckoutPageOfTheLinkedDomain(t *testing.T) {
	manager := checkoutTestManager(t)
	server := &Server{sessions: manager}
	store := func(userID, body string) int {
		t.Helper()
		request := httptest.NewRequest(http.MethodPost, "/api/items/checkout-links", strings.NewReader(body))
		request.Header.Set("X-User-ID", userID)
		recorder := httptest.NewRecorder()
		server.handleStoreCheckoutLink(recorder, request)
		return recorder.Code
	}
	if status := store("", `{"checkout_url":"https://www.vinted.de/checkout?purchase_id=synthetic"}`); status != http.StatusUnauthorized {
		t.Fatalf("unauthenticated store = %d", status)
	}
	if status := store("synthetic-unlinked-user", `{"checkout_url":"https://www.vinted.de/checkout?purchase_id=synthetic"}`); status != http.StatusNotFound {
		t.Fatalf("store without a linked session = %d", status)
	}
	for _, body := range []string{
		`{`,
		`{}`,
		`{"item_id":1,"payment_url":"https://www.paypal.com/checkoutnow?token=synthetic"}`,
		`{"item_id":1,"checkout_url":"https://www.paypal.com/checkoutnow?token=synthetic"}`,
		`{"item_id":1,"checkout_url":"https://www.vinted.fr/checkout?purchase_id=synthetic"}`,
		`{"item_id":1,"checkout_url":"https://www.vinted.de.evil.test/checkout?purchase_id=synthetic"}`,
		`{"item_id":1,"checkout_url":"https://evil.test/checkout?next=www.vinted.de"}`,
		`{"item_id":1,"checkout_url":"http://www.vinted.de/checkout?purchase_id=synthetic"}`,
		`{"item_id":1,"checkout_url":"https://synthetic@www.vinted.de/checkout?purchase_id=synthetic"}`,
		`{"item_id":1,"checkout_url":"https://www.vinted.de/checkout/payment?purchase_id=synthetic"}`,
		`{"item_id":1,"checkout_url":"https://www.vinted.de/checkout?purchase_id=synthetic#synthetic"}`,
		`{"item_id":1,"checkout_url":"https://www.vinted.de:8443/checkout?purchase_id=synthetic"}`,
		`{"item_id":1,"checkout_url":"//www.vinted.de/checkout?purchase_id=synthetic"}`,
		`{"item_id":1,"checkout_url":"javascript:alert('synthetic')"}`,
	} {
		if status := store("synthetic-user", body); status != http.StatusBadRequest {
			t.Fatalf("%s accepted with status %d", body, status)
		}
	}
	if links, err := manager.GetCheckoutLinks("synthetic-user"); err != nil || len(links) != 0 {
		t.Fatalf("a rejected link entered the history: %+v %v", links, err)
	}
	accepted := `{"item_id":123,"seller_id":456,"transaction_id":77,"purchase_id":"synthetic-purchase","checkout_url":" https://www.vinted.de/checkout?purchase_id=synthetic-purchase&order_id=77 ","payment_url":"https://www.paypal.com/checkoutnow?token=synthetic-must-not-be-kept"}`
	if status := store("synthetic-user", accepted); status != http.StatusOK {
		t.Fatalf("valid checkout link refused with status %d", status)
	}
	links, err := manager.GetCheckoutLinks("synthetic-user")
	if err != nil || len(links) != 1 {
		t.Fatalf("history = %+v %v", links, err)
	}
	link := links[0]
	if link.PaymentURL != "" {
		t.Fatal("a provider payment link entered the checkout history")
	}
	if link.CheckoutURL != "https://www.vinted.de/checkout?purchase_id=synthetic-purchase&order_id=77" || link.ItemID != 123 || link.SellerID != 456 || link.TransactionID != 77 || link.Domain != "www.vinted.de" || link.Status != "checkout_ready" {
		t.Fatalf("stored link = %+v", link)
	}
	if other, err := manager.GetCheckoutLinks("synthetic-unlinked-user"); err != nil || len(other) != 0 {
		t.Fatal("history crossed the member boundary")
	}
}

func TestAccessTokenExpiresWithin(t *testing.T) {
	token := func(expiry time.Time) string {
		return syntheticAccessToken(map[string]interface{}{"sub": "42", "exp": expiry.Unix()})
	}
	now := time.Now()
	for _, tc := range []struct {
		name  string
		token string
		want  bool
	}{
		{"expired", token(now.Add(-time.Hour)), true},
		{"expires in 30s", token(now.Add(30 * time.Second)), true},
		{"expires in 80s", token(now.Add(80 * time.Second)), true},
		{"expires in 3m", token(now.Add(3 * time.Minute)), false},
		{"expires in 2h", token(now.Add(2 * time.Hour)), false},
		{"no expiry claim", syntheticAccessToken(map[string]interface{}{"sub": "42"}), false},
		{"opaque token", "synthetic-never-live", false},
		{"empty", "", false},
	} {
		if got := accessTokenExpiresWithin(tc.token, 90*time.Second); got != tc.want {
			t.Errorf("%s: expires within window = %v, want %v", tc.name, got, tc.want)
		}
	}
}
