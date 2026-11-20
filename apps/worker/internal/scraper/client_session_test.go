package scraper

import (
	"context"
	"io"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"vintrack-worker/internal/proxy"

	http "github.com/bogdanfinn/fhttp"
	tls_client "github.com/bogdanfinn/tls-client"
)

// Use fhttp's real cookie handling with a deterministic, in-memory transport.
// Embedding the production client keeps its actual jar replacement behavior.
type sessionTestHTTPClient struct {
	tls_client.HttpClient
	transport sessionTestTransport
	closed    atomic.Int32
}

type sessionTestTransport func(*http.Request) (*http.Response, error)

func (f sessionTestTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

func (c *sessionTestHTTPClient) Do(req *http.Request) (*http.Response, error) {
	client := &http.Client{Jar: c.GetCookieJar(), Transport: c.transport}
	return client.Do(req)
}

func (c *sessionTestHTTPClient) CloseIdleConnections() {
	c.closed.Add(1)
	c.HttpClient.CloseIdleConnections()
}

func sessionTestResponse(req *http.Request, status int, cookie string) *http.Response {
	header := make(http.Header)
	if cookie != "" {
		header.Set("Set-Cookie", "access_token_web="+cookie+"; Path=/")
	}
	return &http.Response{
		StatusCode: status, Header: header, Request: req,
		Body: io.NopCloser(strings.NewReader(`{"items":[]}`)),
	}
}

func newSessionTestClient(t *testing.T, transport sessionTestTransport) (*Client, *sessionTestHTTPClient) {
	t.Helper()
	client, err := NewClient("", nil)
	if err != nil {
		t.Fatal(err)
	}
	httpClient := &sessionTestHTTPClient{HttpClient: client.HttpClient, transport: transport}
	client.HttpClient = httpClient
	t.Cleanup(client.Close)
	return client, httpClient
}

func TestCatalogRejectedSessionRecoversOnSameClient(t *testing.T) {
	const domain = "www.vinted.co.uk"
	var warmups, attempts atomic.Int32
	client, httpClient := newSessionTestClient(t, func(req *http.Request) (*http.Response, error) {
		cookie, _ := req.Cookie("access_token_web")
		if req.URL.Path == "/help" {
			warmups.Add(1)
			// A rejected session is not renewed while its cookie is still sent.
			if cookie != nil && cookie.Value == "rejected" {
				return sessionTestResponse(req, 200, ""), nil
			}
			return sessionTestResponse(req, 200, "fresh"), nil
		}
		attempts.Add(1)
		status := 401
		if cookie != nil && cookie.Value == "fresh" {
			status = 200
		}
		return sessionTestResponse(req, status, ""), nil
	})
	marketplace, _ := url.Parse("https://" + domain + "/")
	httpClient.SetCookies(marketplace, []*http.Cookie{{Name: "access_token_web", Value: "rejected", Path: "/"}})
	client.synchronizeCatalogCookies(domain)
	client.warmed[domain] = true
	client.catalogReady[domain] = true

	_, status, err := (VintedCatalogFetcher{}).FetchCatalog(context.Background(), client, "https://api.vinted.co.uk/api/v2/catalog/items", domain)
	if err != nil || status != 200 {
		t.Fatalf("catalog after rejected session: status=%d err=%v, want recovery on the same client", status, err)
	}
	if warmups.Load() != 1 || attempts.Load() != 2 || httpClient.closed.Load() != 1 {
		t.Fatalf("warmups=%d attempts=%d connection resets=%d, want 1/2/1", warmups.Load(), attempts.Load(), httpClient.closed.Load())
	}
}

func TestPoolSessionResetRecoversSingleProxyAfterQuarantine(t *testing.T) {
	const domain = "www.vinted.co.uk"
	client, httpClient := newSessionTestClient(t, func(req *http.Request) (*http.Response, error) {
		if req.URL.Path == "/help" {
			if cookie, _ := req.Cookie("access_token_web"); cookie != nil {
				t.Errorf("rewarm carried a rejected cookie")
			}
			return sessionTestResponse(req, 200, "fresh"), nil
		}
		if cookie, _ := req.Cookie("access_token_web"); cookie != nil && cookie.Value == "fresh" {
			return sessionTestResponse(req, 200, ""), nil
		}
		return sessionTestResponse(req, 401, ""), nil
	})
	client.ProxyURL = "http://127.0.0.1:12345"
	marketplace, _ := url.Parse("https://" + domain + "/")
	httpClient.SetCookies(marketplace, []*http.Cookie{{Name: "access_token_web", Value: "rejected", Path: "/"}})
	client.warmed[domain], client.catalogReady[domain] = true, true
	now := time.Date(2026, 11, 20, 12, 0, 0, 0, time.UTC)
	pool := &ClientPool{
		states: []*clientState{{client: client}},
		domain: domain, requireProxy: true, now: func() time.Time { return now },
	}
	// Model the report's existing quarantine without starting an asynchronous
	// replacement search: a single quarantined proxy cannot be its replacement.
	pool.Report(client, 401, time.Millisecond, nil)
	pool.pm = proxy.FromString(client.ProxyURL)
	if got := pool.Acquire(nil); got != nil {
		t.Fatal("acquired proxy during its quarantine")
	}
	if _, err := pool.reserveReplacementProxy(pool.states[0]); err == nil {
		t.Fatal("quarantined single proxy unexpectedly provided a replacement")
	}
	now = now.Add(vintedSessionRejectedQuarantine + time.Second)
	if got := pool.Acquire(nil); got != client {
		t.Fatal("original client was not available after quarantine")
	}
	_, status, err := (VintedCatalogFetcher{}).FetchCatalog(context.Background(), client, "https://api.vinted.co.uk/api/v2/catalog/items", domain)
	if err != nil || status != 200 || httpClient.closed.Load() != 1 {
		t.Fatalf("single proxy recovery: status=%d err=%v resets=%d, want 200/nil/1", status, err, httpClient.closed.Load())
	}
}

func TestConcurrentRejectionsDrainOldResponsesBeforeFreshWarmup(t *testing.T) {
	const domain = "www.vinted.co.uk"
	var oldAttempts, warmups, attempts atomic.Int32
	bothStarted, releaseLate := make(chan struct{}), make(chan struct{})
	client, httpClient := newSessionTestClient(t, func(req *http.Request) (*http.Response, error) {
		if req.URL.Path == "/help" {
			warmups.Add(1)
			if cookie, _ := req.Cookie("access_token_web"); cookie != nil {
				t.Errorf("warmup reused an old response's cookie")
			}
			return sessionTestResponse(req, 200, "fresh"), nil
		}
		attempts.Add(1)
		cookie, _ := req.Cookie("access_token_web")
		if cookie != nil && cookie.Value == "fresh" {
			return sessionTestResponse(req, 200, ""), nil
		}
		if oldAttempts.Add(1) == 2 {
			close(bothStarted)
			<-releaseLate
		} else {
			<-bothStarted
		}
		return sessionTestResponse(req, 401, "late-rejected"), nil
	})
	marketplace, _ := url.Parse("https://" + domain + "/")
	httpClient.SetCookies(marketplace, []*http.Cookie{{Name: "access_token_web", Value: "rejected", Path: "/"}})
	client.synchronizeCatalogCookies(domain)
	client.warmed[domain], client.catalogReady[domain] = true, true

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	results := make(chan error, 2)
	for i := 0; i < 2; i++ {
		go func() {
			_, status, err := (VintedCatalogFetcher{}).FetchCatalog(ctx, client, "https://api.vinted.co.uk/api/v2/catalog/items", domain)
			if err == nil && status != 200 {
				err = &httpStatusError{statusCode: status}
			}
			results <- err
		}()
	}
	// Wait until the first rejection has invalidated the session while the
	// second old request is still able to write response cookies.
	for {
		client.warmedMu.Lock()
		pending := client.sessionResetPending
		client.warmedMu.Unlock()
		if pending {
			break
		}
		if ctx.Err() != nil {
			close(releaseLate)
			t.Fatal("first rejection did not invalidate the session")
		}
		time.Sleep(time.Millisecond)
	}
	if warmups.Load() != 0 || httpClient.closed.Load() != 0 {
		t.Error("replaced session while an old response was still in flight")
	}
	close(releaseLate)
	for i := 0; i < 2; i++ {
		if err := <-results; err != nil {
			t.Fatal(err)
		}
	}
	if attempts.Load() != 4 || warmups.Load() != 1 || httpClient.closed.Load() != 1 {
		t.Fatalf("attempts=%d warmups=%d connection resets=%d, want 4/1/1", attempts.Load(), warmups.Load(), httpClient.closed.Load())
	}
}

func TestResetDuringWarmupDoesNotPublishInvalidatedSession(t *testing.T) {
	const domain = "www.vinted.co.uk"
	var warmups int
	client := &Client{}
	client.warmUp = func(context.Context, string) error {
		warmups++
		if warmups == 1 {
			client.ResetWarm(domain)
		}
		return nil
	}
	if err := client.EnsureWarmContext(context.Background(), domain); err != nil {
		t.Fatal(err)
	}
	if warmups != 2 || !client.warmed[domain] || !client.CatalogReady(domain) {
		t.Fatalf("warmups=%d warmed=%v ready=%v, want a second valid warmup", warmups, client.warmed[domain], client.CatalogReady(domain))
	}
}

func TestSessionRecoveryStillRetriesOnlyOnce(t *testing.T) {
	const domain = "www.vinted.co.uk"
	var warmups, attempts int
	client, _ := newSessionTestClient(t, func(req *http.Request) (*http.Response, error) {
		if req.URL.Path == "/help" {
			warmups++
			return sessionTestResponse(req, 200, "fresh"), nil
		}
		attempts++
		return sessionTestResponse(req, 401, ""), nil
	})
	client.warmed[domain], client.catalogReady[domain] = true, true
	_, status, err := (VintedCatalogFetcher{}).FetchCatalog(context.Background(), client, "https://api.vinted.co.uk/api/v2/catalog/items", domain)
	if err != nil || status != 401 || attempts != 2 || warmups != 1 {
		t.Fatalf("status=%d err=%v attempts=%d warmups=%d, want 401/nil/2/1", status, err, attempts, warmups)
	}
}

func TestSessionResetInvalidatesSharedJarDomainsButNotOtherClients(t *testing.T) {
	const domain, otherDomain = "www.vinted.co.uk", "www.vinted.com"
	client, _ := newSessionTestClient(t, func(req *http.Request) (*http.Response, error) {
		return sessionTestResponse(req, 200, "fresh"), nil
	})
	other, otherHTTP := newSessionTestClient(t, nil)
	marketplace, _ := url.Parse("https://" + domain + "/")
	otherHTTP.SetCookies(marketplace, []*http.Cookie{{Name: "access_token_web", Value: "unrelated", Path: "/"}})
	other.warmed[domain], other.catalogReady[domain] = true, true
	for _, host := range []string{domain, otherDomain} {
		if err := client.EnsureWarmContext(context.Background(), host); err != nil {
			t.Fatal(err)
		}
	}
	previous := client.warmGeneration(otherDomain)
	client.ResetWarm(domain)
	if client.CatalogReady(otherDomain) || client.warmGeneration(otherDomain) == previous {
		t.Fatal("reset left another domain ready with the discarded shared jar")
	}
	if err := client.EnsureWarmContext(context.Background(), domain); err != nil {
		t.Fatal(err)
	}
	if !other.CatalogReady(domain) || !other.warmed[domain] || otherHTTP.closed.Load() != 0 {
		t.Fatal("reset changed an unrelated client's session")
	}
	if cookies := otherHTTP.GetCookies(marketplace); len(cookies) != 1 || cookies[0].Value != "unrelated" {
		t.Fatal("reset changed an unrelated client's cookies")
	}
}

func TestRejectedGenerationIsInvalidatedBeforeRewarmCompletes(t *testing.T) {
	const domain = "www.vinted.co.uk"
	var warmups atomic.Int32
	started, release := make(chan struct{}), make(chan struct{})
	client := &Client{warmUp: func(context.Context, string) error {
		if warmups.Add(1) == 2 {
			close(started)
			<-release
		}
		return nil
	}}
	if err := client.EnsureWarmContext(context.Background(), domain); err != nil {
		t.Fatal(err)
	}
	rejected := client.warmGeneration(domain)
	client.resetWarmIfGeneration(domain, rejected)
	if client.warmGeneration(domain) == rejected {
		t.Fatal("reset kept the rejected generation current until warmup completes")
	}
	done := make(chan error, 1)
	go func() { done <- client.EnsureWarmContext(context.Background(), domain) }()
	<-started
	client.resetWarmIfGeneration(domain, rejected)
	close(release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if warmups.Load() != 2 || !client.warmed[domain] {
		t.Fatalf("late rejection discarded replacement: warmups=%d warmed=%v", warmups.Load(), client.warmed[domain])
	}
}
