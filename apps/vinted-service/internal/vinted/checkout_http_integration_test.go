package vinted

import (
	"encoding/json"
	"fmt"
	stdhttp "net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"sync"
	"testing"

	"vintrack-vinted/internal/session"

	http "github.com/bogdanfinn/fhttp"
	"github.com/bogdanfinn/fhttp/cookiejar"
)

// Use actual local HTTP connections for the checkout chain while keeping every
// account, quote and payment synthetic. Only the destination is rewritten; the
// production client constructs the requests, headers and JSON bodies.
type checkoutFixtureTransport struct {
	client *http.Client
	jar    http.CookieJar
	origin *url.URL
	follow bool
}

func (f *checkoutFixtureTransport) Do(request *http.Request) (*http.Response, error) {
	copy := request.Clone(request.Context())
	for _, cookie := range f.jar.Cookies(request.URL) {
		copy.AddCookie(cookie)
	}
	copy.URL.Scheme, copy.URL.Host = f.origin.Scheme, f.origin.Host
	return f.client.Do(copy)
}

func (f *checkoutFixtureTransport) GetCookies(u *url.URL) []*http.Cookie {
	return f.jar.Cookies(u)
}

func (f *checkoutFixtureTransport) SetCookies(u *url.URL, cookies []*http.Cookie) {
	f.jar.SetCookies(u, cookies)
}
func (f *checkoutFixtureTransport) GetFollowRedirect() bool { return f.follow }
func (f *checkoutFixtureTransport) SetFollowRedirect(follow bool) {
	f.follow = follow
	if follow {
		f.client.CheckRedirect = nil
	} else {
		f.client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	}
}

func TestFullCheckoutOverHTTP(t *testing.T) {
	for _, tc := range []struct {
		name, payment, status string
		validate, overLimit   bool
		paymentStatus         int
		paymentBody           string
		count                 int
	}{
		{name: "card completes without browser", payment: "card", status: "card_payment_confirmed", paymentStatus: 200, paymentBody: `{"payment":{"status":"success"}}`, count: 4},
		{name: "PayPal requires provider approval", payment: "paypal", status: "paypal_redirect_ready", paymentStatus: 200, paymentBody: `{"action":{"type":"redirect","parameters":{"url":"https://www.paypal.com/checkoutnow?token=synthetic"}}}`, count: 4},
		{name: "card validation cannot send payment", payment: "card", validate: true, status: "payment_ready", count: 3},
		{name: "PayPal validation cannot send payment", payment: "paypal", validate: true, status: "payment_ready", count: 3},
		{name: "validation rejects over-budget quote", payment: "card", validate: true, overLimit: true, status: "checkout_review_required", count: 3},
		{name: "ambiguous payment is never retried", payment: "card", status: "payment_outcome_unknown", paymentStatus: 503, paymentBody: `{}`, count: 4},
	} {
		t.Run(tc.name, func(t *testing.T) {
			preferences := autoPreferences()
			quote := autoQuote(t)
			if tc.payment == "card" {
				preferences, quote = cardAutoPreferences(), cardAutoQuote(t)
			}
			if tc.overLimit {
				checkoutMap(quote, "checkout", "components", "pay_button_v2", "total", "price")["amount"] = "30.01"
			}
			quote["checksum"] = "synthetic-final-quote"
			build := autoQuote(t)
			if tc.payment == "card" {
				build = cardAutoQuote(t)
			}
			build["purchase"] = map[string]interface{}{"id": "synthetic-purchase"}
			build["checksum"] = "synthetic-build-quote"
			var requests []string
			var requestsMu sync.Mutex
			server := httptest.NewServer(stdhttp.HandlerFunc(func(w stdhttp.ResponseWriter, r *stdhttp.Request) {
				requestsMu.Lock()
				defer requestsMu.Unlock()
				requests = append(requests, r.Method+" "+r.URL.Path)
				cookie, _ := r.Cookie("access_token_web")
				if cookie == nil || cookie.Value != "synthetic-access" || r.Header.Get("X-Csrf-Token") != "synthetic-csrf" || r.Header.Get("Origin") != "https://www.vinted.de" {
					t.Error("checkout lost its authenticated request context")
				}
				w.Header().Set("Content-Type", "application/json")
				var payload map[string]interface{}
				if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
					t.Error("checkout request was not JSON")
				}
				switch r.Method + " " + r.URL.Path {
				case "POST /api/v2/conversations":
					fmt.Fprint(w, `{"conversation":{"transaction":{"id":77}}}`)
				case "POST /api/v2/purchases/checkout/build":
					_ = json.NewEncoder(w).Encode(build)
				case "PUT /api/v2/purchases/synthetic-purchase/checkout":
					native := tc.payment
					if tc.payment == "card" {
						native = "credit_card"
					}
					if checkoutMap(payload, "components", "payment_method")["payment_method"] != native {
						t.Error("saved payment choice was not sent")
					}
					_ = json.NewEncoder(w).Encode(quote)
				case "POST /api/v2/purchases/synthetic-purchase/checkout/payment":
					if tc.validate || tc.overLimit {
						t.Error("payment crossed the validation boundary")
					}
					if payload["checksum"] != "synthetic-final-quote" {
						t.Error("payment did not use the final verified quote")
					}
					w.WriteHeader(tc.paymentStatus)
					fmt.Fprint(w, tc.paymentBody)
				default:
					t.Error("unexpected checkout request")
					w.WriteHeader(500)
				}
			}))
			defer server.Close()
			origin, _ := url.Parse(server.URL)
			jar, _ := cookiejar.New(nil)
			transport := &checkoutFixtureTransport{client: &http.Client{}, jar: jar, origin: origin, follow: true}
			client := &Client{httpClient: transport, csrfToken: "synthetic-csrf", session: &session.VintedSession{Domain: "www.vinted.de", VintedUserID: 42, AccessToken: "synthetic-access"}}
			client.injectAuthCookie()
			var checkpoints []session.CheckoutLink
			save := func(link session.CheckoutLink) error { checkpoints = append(checkpoints, link); return nil }
			var link *session.CheckoutLink
			var err error
			if tc.validate {
				link, err = client.ValidateCheckout(123, 456, save, preferences)
			} else {
				link, err = client.PrepareCheckout(123, 456, save, preferences)
			}
			requestsMu.Lock()
			defer requestsMu.Unlock()
			if err != nil || link.Status != tc.status || len(requests) != tc.count {
				t.Fatalf("checkout status=%v err=%v requests=%v", link, err, requests)
			}
			want := []string{"POST /api/v2/conversations", "POST /api/v2/purchases/checkout/build", "PUT /api/v2/purchases/synthetic-purchase/checkout", "POST /api/v2/purchases/synthetic-purchase/checkout/payment"}
			if !reflect.DeepEqual(requests, want[:tc.count]) {
				t.Fatalf("wrong request sequence: %v", requests)
			}
			for _, checkpoint := range checkpoints {
				if checkpoint.PaymentURL != "" || (tc.validate && checkpoint.Status == "payment_starting") {
					t.Fatal("unsafe durable checkpoint")
				}
			}
			encoded, _ := json.Marshal(checkpoints)
			if strings.Contains(string(encoded), "synthetic-access") || strings.Contains(string(encoded), "synthetic-csrf") {
				t.Fatal("request credentials entered checkpoint storage")
			}
		})
	}
}
