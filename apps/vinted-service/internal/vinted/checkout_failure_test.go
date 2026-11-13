package vinted

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	stdhttp "net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"

	"vintrack-vinted/internal/session"

	http "github.com/bogdanfinn/fhttp"
	"github.com/bogdanfinn/fhttp/cookiejar"
)

// Synthetic upstream bodies. None of them is a captured response.
const (
	syntheticCaptchaJSON    = `{"url":"https://geo.captcha-delivery.com/captcha/?x=synthetic"}`
	syntheticCaptchaHTML    = `<!doctype html><html><body><iframe src="https://geo.captcha-delivery.com/captcha/?initialCid=synthetic"></iframe></body></html>`
	syntheticDataDomeScript = `<!doctype html><html><head><script src="https://js.datadome.co/tags.js" async></script></head><body>synthetic error page</body></html>`
	syntheticPlainForbidden = `<!doctype html><html><body><h1>403 Forbidden</h1><p>synthetic edge denial</p></body></html>`
	syntheticAPIDenied      = `{"code":106,"message_code":"access_denied","message":"synthetic"}`
	syntheticInvalidToken   = `{"code":100,"message_code":"invalid_authentication_token","message":"synthetic"}`
)

const genericUnknownPaymentReason = "could not be verified"

func TestVintedHTTPErrorSeparatesChallengesEdgeDenialsAndAPIRefusals(t *testing.T) {
	for _, tc := range []struct {
		name            string
		status          int
		body            string
		kind            string // challenge, upstream or auth
		apiError        bool
		contextRejected bool
	}{
		{name: "403 JSON captcha URL", status: 403, body: syntheticCaptchaJSON, kind: "challenge", contextRejected: true},
		{name: "403 HTML captcha iframe", status: 403, body: syntheticCaptchaHTML, kind: "challenge", contextRejected: true},
		{name: "403 HTML DataDome script", status: 403, body: syntheticDataDomeScript, kind: "challenge", contextRejected: true},
		{name: "429 JSON captcha URL", status: 429, body: syntheticCaptchaJSON, kind: "challenge", contextRejected: true},
		{name: "503 HTML DataDome script", status: 503, body: syntheticDataDomeScript, kind: "upstream"},
		{name: "404 HTML DataDome script", status: 404, body: syntheticDataDomeScript, kind: "upstream"},
		{name: "429 HTML DataDome script", status: 429, body: syntheticDataDomeScript, kind: "upstream"},
		{name: "500 HTML DataDome script", status: 500, body: syntheticDataDomeScript, kind: "upstream"},
		{name: "403 API envelope", status: 403, body: syntheticAPIDenied, kind: "upstream", apiError: true},
		{name: "429 API envelope", status: 429, body: `{"code":150,"message_code":"rate_limited","message":"synthetic"}`, kind: "upstream", apiError: true},
		{name: "403 plain HTML", status: 403, body: syntheticPlainForbidden, kind: "upstream", contextRejected: true},
		{name: "403 empty body", status: 403, body: ``, kind: "upstream", contextRejected: true},
		{name: "403 JSON without envelope", status: 403, body: `{"error":"synthetic"}`, kind: "upstream", contextRejected: true},
		{name: "403 JSON code without message_code", status: 403, body: `{"code":106}`, kind: "upstream", contextRejected: true},
		{name: "403 JSON message_code without code", status: 403, body: `{"message_code":"access_denied"}`, kind: "upstream", contextRejected: true},
		{name: "429 empty JSON", status: 429, body: `{}`, kind: "upstream"},
		{name: "503 empty JSON", status: 503, body: `{}`, kind: "upstream"},
		{name: "401 invalid token", status: 401, body: syntheticInvalidToken, kind: "auth"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := isDataDomeChallenge(tc.status, tc.body); got != (tc.kind == "challenge") {
				t.Fatalf("isDataDomeChallenge = %v", got)
			}
			err := vintedHTTPError("buy conversation", tc.status, tc.body)
			var challenge *DataDomeChallengeError
			var upstream *UpstreamHTTPError
			var auth *AuthError
			switch tc.kind {
			case "challenge":
				if !errors.As(err, &challenge) || challenge.StatusCode != tc.status || challenge.Step != "buy conversation" {
					t.Fatalf("want a challenge, got %T %v", err, err)
				}
				if !strings.Contains(challenge.CaptchaURL, "captcha-delivery.com") && strings.Contains(tc.body, "captcha-delivery.com") {
					t.Fatal("captcha URL was not extracted")
				}
			case "upstream":
				if !errors.As(err, &upstream) || upstream.StatusCode != tc.status || upstream.Operation != "buy conversation" {
					t.Fatalf("want an upstream HTTP error, got %T %v", err, err)
				}
				if upstream.APIError != tc.apiError {
					t.Fatalf("APIError = %v, want %v", upstream.APIError, tc.apiError)
				}
			case "auth":
				if !errors.As(err, &auth) || auth.StatusCode != tc.status {
					t.Fatalf("want an auth error, got %T %v", err, err)
				}
			}
			if got := ContextRejected(err); got != tc.contextRejected {
				t.Fatalf("ContextRejected = %v, want %v", got, tc.contextRejected)
			}
			if got := ContextRejected(fmt.Errorf("wrapped: %w", err)); got != tc.contextRejected {
				t.Fatal("ContextRejected did not see through a wrapped error")
			}
			if UpstreamStatus(err) != tc.status || CheckoutFailureStep(err) != "transaction" {
				t.Fatalf("status=%d step=%s", UpstreamStatus(err), CheckoutFailureStep(err))
			}
			if strings.Contains(err.Error(), "synthetic") || strings.Contains(err.Error(), "captcha-delivery") {
				t.Fatalf("upstream text leaked into the error string: %v", err)
			}
		})
	}
	for _, err := range []error{nil, errors.New("synthetic"), &TransportError{Step: "buy conversation"}, &PaymentStateError{Step: "checkout payment", StatusCode: 403, Code: "payment_already_processing"}} {
		if ContextRejected(err) {
			t.Fatalf("%T must not reject the session context", err)
		}
	}
}

func TestTransportErrorNamesOnlyItsStep(t *testing.T) {
	for step, label := range map[string]string{"buy conversation": "transaction", "checkout build": "build", "checkout update": "update", "checkout payment": "payment", "session warmup": "unknown"} {
		err := fmt.Errorf("wrapped: %w", &TransportError{Step: step})
		if CheckoutFailureStep(err) != label || UpstreamStatus(err) != 0 {
			t.Fatalf("step %q -> %s status %d", step, CheckoutFailureStep(err), UpstreamStatus(err))
		}
	}
}

// Only a failure to reach the proxy, or to open the tunnel through it, proves
// that no byte reached Vinted. A timeout or reset after that proves nothing.
func TestTransportErrorBeforeSendOnlyForProxyConnectionFailures(t *testing.T) {
	refused := errors.New("synthetic-proxy.example.com: connection refused")
	for _, tc := range []struct {
		name string
		err  error
		want bool
		kind string
	}{
		{"dial", &net.OpError{Op: "dial", Net: "tcp", Err: refused}, true, "proxy_unreachable"},
		{"dial timeout", &net.OpError{Op: "dial", Net: "tcp", Err: context.DeadlineExceeded}, true, "proxy_unreachable"},
		{"proxyconnect", &net.OpError{Op: "proxyconnect", Net: "tcp", Err: refused}, true, "proxy_unreachable"},
		{"socks connect", &net.OpError{Op: "socks connect", Net: "tcp", Err: refused}, true, "proxy_unreachable"},
		{"wrapped dial", &url.Error{Op: "Post", URL: "https://www.vinted.de/api/v2/conversations", Err: &net.OpError{Op: "dial", Err: refused}}, true, "proxy_unreachable"},
		{"proxy rejected its credentials", errors.New("Proxy responded with non 200 code: 407 Proxy Authentication Required"), true, "proxy_refused_407"},
		{"wrapped proxy refusal", fmt.Errorf("synthetic: %w", errors.New("Proxy responded with non 200 code: 502")), true, "proxy_refused_502"},
		{"proxy refusal without a status", errors.New("Proxy responded with non 200 code"), true, "proxy_refused"},
		{"proxy resolves to a private address", &net.OpError{Op: "dial", Net: "tcp", Err: errors.New("checkout proxy must resolve to a public address")}, true, "proxy_address_not_public"},
		{"read", &net.OpError{Op: "read", Net: "tcp", Err: refused}, false, "no_answer"},
		{"write", &net.OpError{Op: "write", Net: "tcp", Err: refused}, false, "no_answer"},
		{"close", &net.OpError{Op: "close", Net: "tcp", Err: refused}, false, "no_answer"},
		{"wrapped read", &url.Error{Op: "Post", URL: "https://www.vinted.de/api/v2/conversations", Err: &net.OpError{Op: "read", Err: refused}}, false, "no_answer"},
		{"read timeout", &net.OpError{Op: "read", Net: "tcp", Err: context.DeadlineExceeded}, false, "timeout"},
		{"request timeout", context.DeadlineExceeded, false, "timeout"},
		{"cancelled", context.Canceled, false, "no_answer"},
		{"unexpected EOF", io.ErrUnexpectedEOF, false, "no_answer"},
		{"untyped", errors.New("synthetic connection lost after POST"), false, "no_answer"},
		{"untyped mentioning dial", errors.New("synthetic dial tcp failure text"), false, "no_answer"},
		{"nil", nil, false, "no_answer"},
	} {
		got := newTransportError("buy conversation", tc.err)
		if got.BeforeSend != tc.want || got.Step != "buy conversation" {
			t.Errorf("%s: BeforeSend = %v, want %v", tc.name, got.BeforeSend, tc.want)
		}
		if got.Kind != tc.kind {
			t.Errorf("%s: Kind = %q, want %q", tc.name, got.Kind, tc.kind)
		}
		if strings.Contains(got.Error(), "synthetic") || strings.Contains(got.Error(), "Proxy responded") || strings.Contains(got.Kind, "synthetic") {
			t.Errorf("%s: transport detail leaked: %v", tc.name, got)
		}
	}
}

func TestPrepareCheckoutMarksProxyConnectionFailuresAsBeforeSend(t *testing.T) {
	chain := cardAutoResults(t, cardAutoQuote(t))
	dial := &net.OpError{Op: "dial", Net: "tcp", Err: errors.New("synthetic-proxy.example.com refused")}
	lost := errors.New("synthetic connection reset by peer")
	for _, tc := range []struct {
		name       string
		results    []fakeHTTPResult
		step       string
		beforeSend bool
		status     string
	}{
		{"conversation dial", []fakeHTTPResult{{err: dial}}, "buy conversation", true, "transaction_creating"},
		{"conversation reset", []fakeHTTPResult{{err: lost}}, "buy conversation", false, "transaction_creating"},
		{"conversation timeout", []fakeHTTPResult{{err: context.DeadlineExceeded}}, "buy conversation", false, "transaction_creating"},
		{"build dial", []fakeHTTPResult{chain[0], {err: dial}}, "checkout build", true, "checkout_building"},
		{"build reset", []fakeHTTPResult{chain[0], {err: lost}}, "checkout build", false, "checkout_building"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			client, transport := cardChainClient(t, tc.results...)
			link, err := client.PrepareCheckout(123, 456, func(session.CheckoutLink) error { return nil }, cardAutoPreferences())
			var transportErr *TransportError
			if !errors.As(err, &transportErr) || transportErr.Step != tc.step || transportErr.BeforeSend != tc.beforeSend {
				t.Fatalf("want TransportError{%s, BeforeSend=%v}, got %#v", tc.step, tc.beforeSend, err)
			}
			if link == nil || link.Status != tc.status || len(transport.requests) != len(tc.results) {
				t.Fatalf("link=%#v requests=%d", link, len(transport.requests))
			}
		})
	}
}

// followRecordingClient records whether redirects would have been followed at
// the moment each request was dispatched.
type followRecordingClient struct {
	*fakeVintedHTTPClient
	followAtRequest []bool
}

func (f *followRecordingClient) Do(req *http.Request) (*http.Response, error) {
	f.followAtRequest = append(f.followAtRequest, f.GetFollowRedirect())
	return f.fakeVintedHTTPClient.Do(req)
}

func cardChainClient(t *testing.T, results ...fakeHTTPResult) (*Client, *followRecordingClient) {
	t.Helper()
	client, transport := testClient(results...)
	client.session.Domain = "www.vinted.de"
	recorder := &followRecordingClient{fakeVintedHTTPClient: transport}
	client.httpClient = recorder
	return client, recorder
}

func paymentRequests(requests []*http.Request) int {
	count := 0
	for _, request := range requests {
		if request.Method == "POST" && strings.HasSuffix(request.URL.Path, "/checkout/payment") {
			count++
		}
	}
	return count
}

func TestPrepareCheckoutTransportFailuresAreTypedPerStep(t *testing.T) {
	secret := errors.New("dial synthetic-proxy.example.com: synthetic-password refused")
	chain := cardAutoResults(t, cardAutoQuote(t))
	for _, tc := range []struct {
		name          string
		results       []fakeHTTPResult
		step, label   string
		status        string
		transactionID int64
	}{
		{"conversation", []fakeHTTPResult{{err: secret}}, "buy conversation", "transaction", "transaction_creating", 0},
		{"build", []fakeHTTPResult{chain[0], {err: secret}}, "checkout build", "build", "checkout_building", 77},
	} {
		t.Run(tc.name, func(t *testing.T) {
			client, transport := cardChainClient(t, tc.results...)
			var checkpoints []string
			link, err := client.PrepareCheckout(123, 456, func(link session.CheckoutLink) error { checkpoints = append(checkpoints, link.Status); return nil }, cardAutoPreferences())
			var transportErr *TransportError
			if !errors.As(err, &transportErr) || transportErr.Step != tc.step {
				t.Fatalf("want TransportError{%s}, got %T %v", tc.step, err, err)
			}
			if transportErr.BeforeSend {
				t.Fatal("a lost connection was reported as never sent")
			}
			if CheckoutFailureStep(err) != tc.label || UpstreamStatus(err) != 0 || ContextRejected(err) {
				t.Fatalf("step=%s status=%d", CheckoutFailureStep(err), UpstreamStatus(err))
			}
			if strings.Contains(err.Error(), "synthetic") {
				t.Fatal("proxy details leaked into the transport error")
			}
			if link == nil || link.Status != tc.status || link.TransactionID != tc.transactionID || link.CheckoutURL != "" {
				t.Fatalf("unexpected checkpoint: %#v", link)
			}
			if len(transport.requests) != len(tc.results) || paymentRequests(transport.requests) != 0 {
				t.Fatalf("a failed mutation was repeated or followed: requests=%d", len(transport.requests))
			}
			if checkpoints[len(checkpoints)-1] != tc.status {
				t.Fatalf("last saved checkpoint = %v", checkpoints)
			}
		})
	}
	t.Run("update", func(t *testing.T) {
		client, _ := cardChainClient(t, fakeHTTPResult{err: secret})
		_, err := client.updatePurchaseCheckout("synthetic-purchase", 77, map[string]interface{}{})
		var transportErr *TransportError
		if !errors.As(err, &transportErr) || transportErr.Step != "checkout update" || CheckoutFailureStep(err) != "update" {
			t.Fatalf("want TransportError{checkout update}, got %T %v", err, err)
		}
		// The chain keeps the already built checkout for manual review rather
		// than failing, and must not start a payment on an unverified quote.
		client, transport := cardChainClient(t, chain[0], chain[1], fakeHTTPResult{err: secret})
		link, err := client.PrepareCheckout(123, 456, func(session.CheckoutLink) error { return nil }, cardAutoPreferences())
		if err != nil || link.Status != "checkout_review_required" || link.CheckoutURL == "" || link.ServerContextRejected {
			t.Fatalf("update transport failure: %#v %v", link, err)
		}
		if len(transport.requests) != 3 || paymentRequests(transport.requests) != 0 {
			t.Fatal("payment started after a failed quote update")
		}
	})
}

func TestPrepareCheckoutDisablesRedirectsForTheWholeChain(t *testing.T) {
	results := append(cardAutoResults(t, cardAutoQuote(t)), fakeHTTPResult{status: 200, body: `{"payment":{"status":"success"}}`})
	client, transport := cardChainClient(t, results...)
	link, err := client.PrepareCheckout(123, 456, func(session.CheckoutLink) error { return nil }, cardAutoPreferences())
	if err != nil || link.Status != "card_payment_confirmed" || len(transport.followAtRequest) != 4 {
		t.Fatalf("chain did not complete: %#v %v", link, err)
	}
	for index, following := range transport.followAtRequest {
		if following {
			t.Fatalf("request %d could have followed a redirect", index)
		}
	}
	if !transport.GetFollowRedirect() {
		t.Fatal("redirect policy was not restored after the chain")
	}
}

// Real local HTTP connections: a redirect that the client followed would reach
// the second server. Only the destination host is rewritten.
func TestPrepareCheckoutNeverFollowsUpstreamRedirects(t *testing.T) {
	build := cardAutoQuote(t)
	build["purchase"] = map[string]interface{}{"id": "synthetic-purchase"}
	quote := cardAutoQuote(t)
	quote["checksum"] = "synthetic-final-quote"
	for _, tc := range []struct {
		name, redirectAt   string
		code               int
		wantErr            bool
		wantStep           string
		wantStatus         string
		wantOriginRequests int
	}{
		{"conversation 307", "POST /api/v2/conversations", 307, true, "transaction", "transaction_creating", 1},
		{"conversation 302", "POST /api/v2/conversations", 302, true, "transaction", "transaction_creating", 1},
		{"conversation 301", "POST /api/v2/conversations", 301, true, "transaction", "transaction_creating", 1},
		{"conversation 308", "POST /api/v2/conversations", 308, true, "transaction", "transaction_creating", 1},
		{"build 307", "POST /api/v2/purchases/checkout/build", 307, true, "build", "checkout_building", 2},
		{"update 307", "PUT /api/v2/purchases/synthetic-purchase/checkout", 307, false, "", "checkout_review_required", 3},
		{"payment 307", "POST /api/v2/purchases/synthetic-purchase/checkout/payment", 307, false, "", "payment_outcome_unknown", 4},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var mu sync.Mutex
			var originRequests, redirectedRequests []string
			elsewhere := httptest.NewServer(stdhttp.HandlerFunc(func(w stdhttp.ResponseWriter, r *stdhttp.Request) {
				mu.Lock()
				redirectedRequests = append(redirectedRequests, r.Method+" "+r.URL.Path)
				mu.Unlock()
				fmt.Fprint(w, `{}`)
			}))
			defer elsewhere.Close()
			origin := httptest.NewServer(stdhttp.HandlerFunc(func(w stdhttp.ResponseWriter, r *stdhttp.Request) {
				key := r.Method + " " + r.URL.Path
				mu.Lock()
				originRequests = append(originRequests, key)
				mu.Unlock()
				if key == tc.redirectAt {
					w.Header().Set("Location", elsewhere.URL+"/synthetic-redirect-target")
					w.WriteHeader(tc.code)
					return
				}
				w.Header().Set("Content-Type", "application/json")
				switch key {
				case "POST /api/v2/conversations":
					fmt.Fprint(w, `{"conversation":{"transaction":{"id":77}}}`)
				case "POST /api/v2/purchases/checkout/build":
					_ = json.NewEncoder(w).Encode(build)
				case "PUT /api/v2/purchases/synthetic-purchase/checkout":
					_ = json.NewEncoder(w).Encode(quote)
				case "POST /api/v2/purchases/synthetic-purchase/checkout/payment":
					fmt.Fprint(w, `{"payment":{"status":"success"}}`)
				default:
					w.WriteHeader(500)
				}
			}))
			defer origin.Close()
			newClient := func() (*Client, *checkoutFixtureTransport) {
				originURL, _ := url.Parse(origin.URL)
				jar, _ := cookiejar.New(nil)
				transport := &checkoutFixtureTransport{client: &http.Client{}, jar: jar, origin: originURL, follow: true}
				return &Client{httpClient: transport, csrfToken: "synthetic-csrf", session: &session.VintedSession{Domain: "www.vinted.de", VintedUserID: 42, AccessToken: "synthetic-access"}}, transport
			}
			if tc.redirectAt == "POST /api/v2/conversations" {
				// Control: without the chain's redirect policy this fixture does
				// follow the redirect, so the assertions below can detect it.
				control, _ := newClient()
				_, _ = control.createBuyTransaction(123, 456)
				mu.Lock()
				followed := len(redirectedRequests)
				originRequests, redirectedRequests = nil, nil
				mu.Unlock()
				if followed == 0 {
					t.Skip("fixture transport does not follow this redirect; nothing to prove")
				}
			}
			client, transport := newClient()
			link, err := client.PrepareCheckout(123, 456, func(session.CheckoutLink) error { return nil }, cardAutoPreferences())
			mu.Lock()
			defer mu.Unlock()
			if len(redirectedRequests) != 0 {
				t.Fatalf("checkout followed a redirect and replayed the request: %v", redirectedRequests)
			}
			if len(originRequests) != tc.wantOriginRequests {
				t.Fatalf("origin requests = %v, want %d", originRequests, tc.wantOriginRequests)
			}
			if link == nil || link.Status != tc.wantStatus || link.PaymentURL != "" {
				t.Fatalf("link = %#v", link)
			}
			if tc.wantErr {
				var upstream *UpstreamHTTPError
				if !errors.As(err, &upstream) || UpstreamStatus(err) != tc.code || CheckoutFailureStep(err) != tc.wantStep {
					t.Fatalf("want UpstreamHTTPError %d at %s, got %T %v", tc.code, tc.wantStep, err, err)
				}
				if ContextRejected(err) || upstream.APIError {
					t.Fatal("a redirect is neither a context denial nor an API refusal")
				}
			} else if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if tc.wantStatus == "payment_outcome_unknown" && (strings.Contains(link.AutoCheckoutReason, "refused") || !strings.Contains(link.AutoCheckoutReason, genericUnknownPaymentReason)) {
				t.Fatalf("a redirected payment is not a refusal: %q", link.AutoCheckoutReason)
			}
			if !transport.follow {
				t.Fatal("redirect policy was not restored after the chain")
			}
		})
	}
}

func TestAutoCheckoutPaymentAnswersAreReportedOnceAndNeverRetried(t *testing.T) {
	for _, payment := range []string{"card", "paypal"} {
		for _, tc := range []struct {
			name            string
			result          fakeHTTPResult
			refusedStatus   int // 0 keeps the generic unknown-outcome text
			contextRejected bool
		}{
			// Definite refusals: authentication, rate limit, or a denial of
			// the session context itself.
			{"403 captcha JSON", fakeHTTPResult{status: 403, body: syntheticCaptchaJSON}, 403, true},
			{"403 captcha HTML", fakeHTTPResult{status: 403, body: syntheticCaptchaHTML}, 403, true},
			{"403 DataDome script page", fakeHTTPResult{status: 403, body: syntheticDataDomeScript}, 403, true},
			{"403 plain HTML", fakeHTTPResult{status: 403, body: syntheticPlainForbidden}, 403, true},
			{"403 empty body", fakeHTTPResult{status: 403, body: ``}, 403, true},
			{"429 captcha JSON", fakeHTTPResult{status: 429, body: syntheticCaptchaJSON}, 429, true},
			{"429 empty JSON", fakeHTTPResult{status: 429, body: `{}`}, 429, false},
			{"429 API envelope", fakeHTTPResult{status: 429, body: `{"code":150,"message_code":"rate_limited","message":"synthetic"}`}, 429, false},
			{"429 DataDome script page", fakeHTTPResult{status: 429, body: syntheticDataDomeScript}, 429, false},
			{"401 invalid token", fakeHTTPResult{status: 401, body: syntheticInvalidToken}, 401, false},
			{"401 without envelope", fakeHTTPResult{status: 401, body: `{"error":"synthetic"}`}, 401, false},
			// Everything else stays unknown: Vinted may be processing a payment.
			{"403 API envelope", fakeHTTPResult{status: 403, body: syntheticAPIDenied}, 0, false},
			{"400 API envelope", fakeHTTPResult{status: 400, body: `{"code":99,"message_code":"validation_error","message":"synthetic"}`}, 0, false},
			{"400 empty JSON", fakeHTTPResult{status: 400, body: `{}`}, 0, false},
			{"404 HTML", fakeHTTPResult{status: 404, body: syntheticDataDomeScript}, 0, false},
			{"409 API envelope", fakeHTTPResult{status: 409, body: `{"code":99,"message_code":"conflict","message":"synthetic"}`}, 0, false},
			{"422 API envelope", fakeHTTPResult{status: 422, body: `{"code":99,"message_code":"validation_error","message":"synthetic"}`}, 0, false},
			{"400 payment already processing", fakeHTTPResult{status: 400, body: `{"code":99,"message_code":"checkout_error","message":"Der Bezahlungsvorgang wird bereits bearbeitet (synthetic)"}`}, 0, false},
			{"401 payment already processing", fakeHTTPResult{status: 401, body: `{"code":99,"message_code":"checkout_error","message":"Der Bezahlungsvorgang wird bereits bearbeitet (synthetic)"}`}, 0, false},
			{"429 payment already processing", fakeHTTPResult{status: 429, body: `{"code":99,"message_code":"checkout_error","message":"Der Bezahlungsvorgang wurde bereits abgeschlossen (synthetic)"}`}, 0, false},
			{"503 empty JSON", fakeHTTPResult{status: 503, body: `{}`}, 0, false},
			{"503 DataDome script page", fakeHTTPResult{status: 503, body: syntheticDataDomeScript}, 0, false},
			{"500 HTML", fakeHTTPResult{status: 500, body: syntheticPlainForbidden}, 0, false},
			{"302 redirect", fakeHTTPResult{status: 302, body: ``}, 0, false},
			{"dial error", fakeHTTPResult{err: &net.OpError{Op: "dial", Err: errors.New("synthetic refused")}}, 0, false},
			{"transport error", fakeHTTPResult{err: errors.New("synthetic connection lost")}, 0, false},
		} {
			t.Run(payment+"/"+tc.name, func(t *testing.T) {
				results, preferences := autoResults(t, autoQuote(t)), autoPreferences()
				if payment == "card" {
					results, preferences = cardAutoResults(t, cardAutoQuote(t)), cardAutoPreferences()
				}
				client, transport := cardChainClient(t, append(results, tc.result)...)
				var checkpoints []session.CheckoutLink
				link, err := client.PrepareCheckout(123, 456, func(link session.CheckoutLink) error { checkpoints = append(checkpoints, link); return nil }, preferences)
				if err != nil || link == nil || link.Status != "payment_outcome_unknown" || link.PaymentURL != "" {
					t.Fatalf("payment refusal must stay a recorded unknown outcome: %#v %v", link, err)
				}
				if len(transport.requests) != 4 || paymentRequests(transport.requests) != 1 {
					t.Fatalf("payment requests = %d of %d", paymentRequests(transport.requests), len(transport.requests))
				}
				if transport.followAtRequest[3] {
					t.Fatal("payment request could have followed a redirect")
				}
				reason := link.AutoCheckoutReason
				if tc.refusedStatus != 0 {
					if !strings.Contains(reason, "refused") || !strings.Contains(reason, fmt.Sprintf("(HTTP %d)", tc.refusedStatus)) || !strings.Contains(reason, "no payment was accepted") {
						t.Fatalf("refusal not reported: %q", reason)
					}
				} else if strings.Contains(reason, "refused") || !strings.Contains(reason, genericUnknownPaymentReason) {
					t.Fatalf("unknown outcome reported as a refusal: %q", reason)
				}
				if link.ServerContextRejected != tc.contextRejected {
					t.Fatalf("ServerContextRejected = %v, want %v", link.ServerContextRejected, tc.contextRejected)
				}
				if strings.Contains(reason, "synthetic") || strings.Contains(reason, "captcha") {
					t.Fatalf("upstream text leaked into the member-facing reason: %q", reason)
				}
				last := checkpoints[len(checkpoints)-1]
				if last.Status != link.Status || last.AutoCheckoutReason != reason || last.ServerContextRejected != link.ServerContextRejected || last.PaymentURL != "" {
					t.Fatalf("final checkpoint differs from the returned outcome: %#v", last)
				}
				if checkpoints[len(checkpoints)-2].Status != "payment_starting" {
					t.Fatal("payment intent was not checkpointed before the request")
				}
			})
		}
	}
}

func TestAutoCheckoutTerminalCheckpointFailureStillReturnsTheOutcome(t *testing.T) {
	const approval = "https://www.paypal.com/checkoutnow?token=synthetic"
	for _, tc := range []struct {
		name, payment, status, paymentURL string
		result                            fakeHTTPResult
	}{
		{"PayPal redirect", "paypal", "paypal_redirect_ready", approval, fakeHTTPResult{status: 200, body: `{"action":{"type":"redirect","parameters":{"url":"` + approval + `"}}}`}},
		{"card confirmed", "card", "card_payment_confirmed", "", fakeHTTPResult{status: 200, body: `{"payment":{"status":"success"}}`}},
		{"card authentication", "card", "card_authentication_required", "", fakeHTTPResult{status: 200, body: `{"action":{"type":"native_adyen_payment_3ds"}}`}},
		{"refused payment", "card", "payment_outcome_unknown", "", fakeHTTPResult{status: 403, body: syntheticCaptchaJSON}},
		{"lost response", "paypal", "payment_outcome_unknown", "", fakeHTTPResult{err: errors.New("synthetic connection lost")}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			results, preferences := autoResults(t, autoQuote(t)), autoPreferences()
			if tc.payment == "card" {
				results, preferences = cardAutoResults(t, cardAutoQuote(t)), cardAutoPreferences()
			}
			client, transport := cardChainClient(t, append(results, tc.result)...)
			storage := errors.New("synthetic storage unavailable")
			var saved []session.CheckoutLink
			link, err := client.PrepareCheckout(123, 456, func(link session.CheckoutLink) error {
				if link.Status == tc.status {
					return storage
				}
				saved = append(saved, link)
				return nil
			}, preferences)
			if !errors.Is(err, storage) {
				t.Fatalf("checkpoint failure was hidden: %v", err)
			}
			if link == nil || link.Status != tc.status || link.PaymentURL != tc.paymentURL || link.CheckoutURL == "" {
				t.Fatalf("outcome lost with its checkpoint: %#v", link)
			}
			if len(transport.requests) != 4 || paymentRequests(transport.requests) != 1 {
				t.Fatal("payment was not sent exactly once")
			}
			if saved[len(saved)-1].Status != "payment_starting" {
				t.Fatal("payment intent checkpoint missing")
			}
			for _, checkpoint := range saved {
				if checkpoint.PaymentURL != "" {
					t.Fatal("provider link entered a checkpoint")
				}
			}
		})
	}
}
