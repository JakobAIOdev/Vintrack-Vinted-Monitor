package vinted

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"

	fhttp "github.com/bogdanfinn/fhttp"
	tls_client "github.com/bogdanfinn/tls-client"
	"vintrack-vinted/internal/session"
)

func TestCheckoutProxyRejectsUnsafeDestinationsAndRedactsErrors(t *testing.T) {
	for _, proxy := range []string{"", "ftp://proxy.example.com:8080", "http://127.0.0.1:8080", "http://10.0.0.1:8080", "http://[::ffff:127.0.0.1]:8080", "http://[::1]:8080", "http://169.254.169.254:80", "http://proxy.internal:8080", "http://proxy.example.com:0", "http://proxy.example.com:65536", "http://proxy.example.com:8080/path", "http://synthetic-user:synthetic-secret@127.0.0.1:8080"} {
		_, err := NewCheckoutClient(&session.VintedSession{}, proxy)
		if err == nil || strings.Contains(err.Error(), "synthetic-secret") {
			t.Fatal("unsafe proxy accepted or credentials exposed")
		}
	}
	for _, address := range []string{"127.0.0.1:80", "10.0.0.1:80", "169.254.169.254:80", "[::1]:80", "[fc00::1]:80", "[::ffff:127.0.0.1]:80", "192.0.2.1:80", "198.18.0.1:80"} {
		if publicProxyConnection("tcp", address, nil) == nil {
			t.Fatal("private resolved address accepted")
		}
	}
	for _, address := range []string{"8.8.8.8:8080", "[2606:4700:4700::1111]:8080"} {
		if publicProxyConnection("tcp", address, nil) != nil {
			t.Fatal("public resolved address rejected")
		}
	}
}

type proxiedCheckoutFixture struct {
	vintedHTTPClient
	origin *url.URL
}

func (p *proxiedCheckoutFixture) Do(req *fhttp.Request) (*fhttp.Response, error) {
	copy := req.Clone(req.Context())
	for _, cookie := range p.GetCookies(req.URL) {
		copy.AddCookie(cookie)
	}
	copy.URL.Scheme, copy.URL.Host = p.origin.Scheme, p.origin.Host
	return p.vintedHTTPClient.Do(copy)
}

func TestCheckoutChainUsesAuthenticatedProxyWithoutDirectFallback(t *testing.T) {
	for _, reject := range []bool{false, true} {
		t.Run(fmt.Sprintf("proxyRejects=%v", reject), func(t *testing.T) {
			var upstreamHits, tunnels atomic.Int32
			build, quote := cardAutoQuote(t), cardAutoQuote(t)
			build["purchase"] = map[string]interface{}{"id": "synthetic-purchase"}
			build["checksum"], quote["checksum"] = "synthetic-build", "synthetic-final"
			upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				upstreamHits.Add(1)
				if cookie, _ := r.Cookie("access_token_web"); cookie == nil || cookie.Value != "synthetic-access" {
					t.Error("lost session cookie")
				}
				if r.Header.Get("X-Csrf-Token") != "synthetic-csrf" {
					t.Error("lost CSRF context")
				}
				for name, expected := range map[string]string{"datadome": "synthetic-context", "anon_id": "synthetic-anon", "_vinted_fr_session": "synthetic-session", "v_udt": "synthetic-device"} {
					if cookie, _ := r.Cookie(name); cookie == nil || cookie.Value != expected {
						t.Errorf("lost browser checkout cookie %s", name)
					}
				}
				if r.Header.Get("User-Agent") != "synthetic-browser" || r.Header.Get("X-Anon-Id") != "synthetic-anon" {
					t.Error("lost browser identity")
				}
				w.Header().Set("Content-Type", "application/json")
				switch r.Method + " " + r.URL.Path {
				case "POST /api/v2/conversations":
					fmt.Fprint(w, `{"conversation":{"transaction":{"id":77}}}`)
				case "POST /api/v2/purchases/checkout/build":
					json.NewEncoder(w).Encode(build)
				case "PUT /api/v2/purchases/synthetic-purchase/checkout":
					json.NewEncoder(w).Encode(quote)
				case "POST /api/v2/purchases/synthetic-purchase/checkout/payment":
					fmt.Fprint(w, `{"payment":{"status":"success"}}`)
				default:
					t.Error("unexpected checkout step")
					w.WriteHeader(500)
				}
			}))
			defer upstream.Close()
			origin, _ := url.Parse(upstream.URL)
			proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				tunnels.Add(1)
				if r.Method != "CONNECT" || r.Host != origin.Host || r.Header.Get("Proxy-Authorization") != "Basic c3ludGhldGljOnByaXZhdGU=" {
					t.Error("wrong proxy tunnel or authentication")
					w.WriteHeader(400)
					return
				}
				if reject {
					w.WriteHeader(http.StatusProxyAuthRequired)
					return
				}
				remote, err := net.Dial("tcp", origin.Host)
				if err != nil {
					t.Error(err)
					w.WriteHeader(502)
					return
				}
				conn, _, err := w.(http.Hijacker).Hijack()
				if err != nil {
					remote.Close()
					t.Error(err)
					return
				}
				fmt.Fprint(conn, "HTTP/1.1 200 Connection Established\r\n\r\n")
				go func() { defer conn.Close(); defer remote.Close(); io.Copy(remote, conn) }()
				go func() { defer remote.Close(); defer conn.Close(); io.Copy(conn, remote) }()
			}))
			defer proxy.Close()
			proxyURL, _ := url.Parse(proxy.URL)
			proxyURL.User = url.UserPassword("synthetic", "private")
			// The fixture deliberately replaces the production public-address
			// guard and trusts only this local test server's self-signed certificate.
			options := append(checkoutProxyOptions(proxyURL.String(), net.Dialer{}), tls_client.WithInsecureSkipVerify())
			client, err := newClient(&session.VintedSession{
				Domain: "www.vinted.de", VintedUserID: 42, AccessToken: "synthetic-access",
				BrowserLinked: true, UserAgent: "synthetic-browser", CsrfToken: "synthetic-csrf",
				CookieHeader: "datadome=synthetic-context; anon_id=synthetic-anon; _vinted_fr_session=synthetic-session; v_udt=synthetic-device", AnonID: "synthetic-anon",
			}, options)
			if err != nil {
				t.Fatal("fixture client unavailable")
			}
			client.httpClient = &proxiedCheckoutFixture{vintedHTTPClient: client.httpClient, origin: origin}
			if err := client.WarmUp(); err != nil {
				t.Fatal("browser checkout context was not reused")
			}
			link, err := client.PrepareCheckout(123, 456, func(session.CheckoutLink) error { return nil }, cardAutoPreferences())
			if reject {
				if err == nil || upstreamHits.Load() != 0 || tunnels.Load() == 0 {
					t.Fatal("proxy failure fell back to a direct checkout")
				}
			} else if err != nil || link.Status != "card_payment_confirmed" || upstreamHits.Load() != 4 || tunnels.Load() == 0 {
				t.Fatalf("proxied checkout failed: status=%v err=%v requests=%d tunnels=%d", link, err, upstreamHits.Load(), tunnels.Load())
			}
		})
	}
}

func TestCheckoutProxyDNSResolutionCannotReachLocalServer(t *testing.T) {
	var hits atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hits.Add(1) }))
	defer server.Close()
	_, port, _ := net.SplitHostPort(strings.TrimPrefix(server.URL, "http://"))
	// A dotted hostname passes syntax validation but resolves to loopback. The
	// connection-time guard must stop CONNECT before contacting that server.
	client, err := NewCheckoutClient(&session.VintedSession{Domain: "www.vinted.de"}, "http://localhost.:"+port)
	// localhost. is rejected by the syntax guard (no public DNS label); test
	// the actual dialer separately so a future parser relaxation stays safe.
	if err == nil {
		_ = client.WarmUp()
	}
	dialer := net.Dialer{Control: publicProxyConnection}
	conn, err := dialer.Dial("tcp", "localhost:"+port)
	if conn != nil {
		conn.Close()
	}
	if err == nil || hits.Load() != 0 {
		t.Fatal("private proxy endpoint contacted")
	}
}

func TestCheckoutWarmupDenialsPreserveUpstreamStatus(t *testing.T) {
	for _, status := range []int{401, 403, 429, 503} {
		transport := &fakeVintedHTTPClient{results: []fakeHTTPResult{{status: status, body: `{}`}}}
		client := &Client{httpClient: transport, session: &session.VintedSession{Domain: "www.vinted.de"}}
		if err := client.WarmUp(); err == nil || UpstreamStatus(err) != status || len(transport.requests) != 1 || client.warmedUp {
			t.Fatal("warmup denial lost its status or was retried")
		}
	}
}
