package scraper

import (
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	http "github.com/bogdanfinn/fhttp"
	tls_client "github.com/bogdanfinn/tls-client"
	"github.com/bogdanfinn/tls-client/profiles"
	"golang.org/x/net/proxy"
)

type clientFingerprint struct {
	name    string
	version string
	profile profiles.ClientProfile
}

func configuredClientFingerprint() clientFingerprint {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("TLS_PROFILE"))) {
	case "chrome_131":
		return clientFingerprint{name: "chrome_131", version: "131", profile: profiles.Chrome_131}
	case "chrome_133":
		return clientFingerprint{name: "chrome_133", version: "133", profile: profiles.Chrome_133}
	case "chrome_146":
		return clientFingerprint{name: "chrome_146", version: "146", profile: profiles.Chrome_146}
	default:
		return clientFingerprint{name: "chrome_146", version: "146", profile: profiles.Chrome_146}
	}
}

func configuredChromeUA() string {
	fingerprint := configuredClientFingerprint()
	return fmt.Sprintf("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/%s.0.0.0 Safari/537.36", fingerprint.version)
}

func acceptLanguageForDomain(domain string) string {
	switch {
	case strings.Contains(domain, "vinted.co.uk"):
		return "en-GB,en-US;q=0.9,en;q=0.8"
	case strings.Contains(domain, "vinted.ie"):
		return "en-IE,en;q=0.9"
	case strings.Contains(domain, "vinted.at"):
		return "de-AT,de;q=0.9,en;q=0.7"
	case strings.Contains(domain, "vinted.be"):
		return "fr-BE,fr;q=0.9,nl-BE;q=0.8,nl;q=0.7,en;q=0.6"
	case strings.Contains(domain, "vinted.lu"):
		return "fr-LU,fr;q=0.9,de;q=0.8,en;q=0.7"
	case strings.Contains(domain, "vinted.fr"):
		return "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7"
	case strings.Contains(domain, "vinted.es"):
		return "es-ES,es;q=0.9,en-US;q=0.8,en;q=0.7"
	case strings.Contains(domain, "vinted.it"):
		return "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7"
	case strings.Contains(domain, "vinted.nl"):
		return "nl-NL,nl;q=0.9,en-US;q=0.8,en;q=0.7"
	case strings.Contains(domain, "vinted.pl"):
		return "pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7"
	case strings.Contains(domain, "vinted.pt"):
		return "pt-PT,pt;q=0.9,en-US;q=0.8,en;q=0.7"
	case strings.Contains(domain, "vinted.cz"):
		return "cs-CZ,cs;q=0.9,en;q=0.7"
	case strings.Contains(domain, "vinted.sk"):
		return "sk-SK,sk;q=0.9,en;q=0.7"
	case strings.Contains(domain, "vinted.lt"):
		return "lt-LT,lt;q=0.9,en;q=0.7"
	case strings.Contains(domain, "vinted.se"):
		return "sv-SE,sv;q=0.9,en;q=0.7"
	case strings.Contains(domain, "vinted.dk"):
		return "da-DK,da;q=0.9,en;q=0.7"
	case strings.Contains(domain, "vinted.ro"):
		return "ro-RO,ro;q=0.9,en;q=0.7"
	case strings.Contains(domain, "vinted.hu"):
		return "hu-HU,hu;q=0.9,en;q=0.7"
	case strings.Contains(domain, "vinted.hr"):
		return "hr-HR,hr;q=0.9,en;q=0.7"
	case strings.Contains(domain, "vinted.fi"):
		return "fi-FI,fi;q=0.9,en;q=0.7"
	case strings.Contains(domain, "vinted.si"):
		return "sl-SI,sl;q=0.9,en;q=0.7"
	case strings.Contains(domain, "vinted.ee"):
		return "et-EE,et;q=0.9,en;q=0.7"
	case strings.Contains(domain, "vinted.lv"):
		return "lv-LV,lv;q=0.9,en;q=0.7"
	case strings.Contains(domain, "vinted.gr"):
		return "el-GR,el;q=0.9,en;q=0.7"
	default:
		return "de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7"
	}
}

func hostFromURL(rawURL string, fallback string) string {
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Host == "" {
		return fallback
	}
	return parsed.Host
}

func newWarmupHeaders(domain string) http.Header {
	return http.Header{
		"Upgrade-Insecure-Requests": {"1"},
		"User-Agent":                {configuredChromeUA()},
		"Accept":                    {"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7"},
		"Sec-Fetch-Site":            {"none"},
		"Sec-Fetch-Mode":            {"navigate"},
		"Sec-Fetch-User":            {"?1"},
		"Sec-Fetch-Dest":            {"document"},
		"Accept-Language":           {acceptLanguageForDomain(domain)},
		"Priority":                  {"u=0, i"},
		http.HeaderOrderKey: {
			"upgrade-insecure-requests",
			"user-agent",
			"accept",
			"sec-fetch-site",
			"sec-fetch-mode",
			"sec-fetch-user",
			"sec-fetch-dest",
			"accept-language",
			"priority",
		},
	}
}

func newAPIHeaders(domain string) http.Header {
	fingerprint := configuredClientFingerprint()
	return http.Header{
		"User-Agent":         {configuredChromeUA()},
		"Accept":             {"application/json, text/plain, */*"},
		"Accept-Language":    {acceptLanguageForDomain(domain)},
		"Cache-Control":      {"no-cache"},
		"Pragma":             {"no-cache"},
		"Sec-Ch-Ua":          {fmt.Sprintf(`"Google Chrome";v="%s", "Chromium";v="%s", "Not_A Brand";v="24"`, fingerprint.version, fingerprint.version)},
		"Sec-Ch-Ua-Mobile":   {"?0"},
		"Sec-Ch-Ua-Platform": {`"macOS"`},
		"Sec-Fetch-Dest":     {"empty"},
		"Sec-Fetch-Mode":     {"cors"},
		"Sec-Fetch-Site":     {"same-origin"},
		"X-Requested-With":   {"XMLHttpRequest"},
		"Referer":            {fmt.Sprintf("https://%s/", domain)},
	}
}

// newCatalogAPIHeaders binds the request to the regional marketplace. Without
// Locale and X-Anon-Id svc-catalogue falls back to the exit IP's country, so
// free proxies return foreign feeds priced in foreign currencies.
func newCatalogAPIHeaders(domain string, anonID string) http.Header {
	fingerprint := configuredClientFingerprint()
	headers := http.Header{
		"User-Agent":         {configuredChromeUA()},
		"Accept":             {"application/json, text/plain, */*"},
		"Accept-Language":    {acceptLanguageForDomain(domain)},
		"Origin":             {fmt.Sprintf("https://%s", domain)},
		"Referer":            {fmt.Sprintf("https://%s/", domain)},
		"Locale":             {strings.SplitN(acceptLanguageForDomain(domain), ",", 2)[0]},
		"Platform":           {"web"},
		"X-Next-App":         {"marketplace-web"},
		"Sec-Ch-Ua":          {fmt.Sprintf(`"Google Chrome";v="%s", "Chromium";v="%s", "Not_A Brand";v="24"`, fingerprint.version, fingerprint.version)},
		"Sec-Ch-Ua-Mobile":   {"?0"},
		"Sec-Ch-Ua-Platform": {`"macOS"`},
		"Sec-Fetch-Dest":     {"empty"},
		"Sec-Fetch-Mode":     {"cors"},
		"Sec-Fetch-Site":     {"same-site"},
		"Priority":           {"u=1, i"},
	}
	if anonID != "" {
		headers.Set("X-Anon-Id", anonID)
	}
	return headers
}

// catalogAnonID returns the anonymous session id Vinted issued during warmup.
func (c *Client) catalogAnonID(domain string) string {
	if c == nil || c.HttpClient == nil {
		return ""
	}
	target, err := url.Parse(fmt.Sprintf("https://%s/", catalogAPIHost(domain)))
	if err != nil {
		return ""
	}
	for _, cookie := range c.HttpClient.GetCookies(target) {
		if cookie.Name == "anon_id" {
			return strings.TrimSpace(cookie.Value)
		}
	}
	return ""
}

type Client struct {
	HttpClient      tls_client.HttpClient
	ProxyURL        string
	trafficRecorder func(txBytes int64, rxBytes int64)
	trackerMu       sync.Mutex
	lastTxBytes     int64
	lastRxBytes     int64
	warmedMu        sync.Mutex
	warmed          map[string]bool
	catalogReady    map[string]bool
}

func NewClient(proxyURL string, trafficRecorder func(txBytes int64, rxBytes int64)) (*Client, error) {
	return NewClientWithTimeout(proxyURL, trafficRecorder, 3*time.Second)
}

func NewClientWithTimeout(proxyURL string, trafficRecorder func(txBytes int64, rxBytes int64), requestTimeout time.Duration) (*Client, error) {
	if requestTimeout <= 0 {
		requestTimeout = 3 * time.Second
	}
	timeoutMs := max(1, int(requestTimeout.Milliseconds()))
	options := []tls_client.HttpClientOption{
		tls_client.WithTimeoutMilliseconds(timeoutMs),
		tls_client.WithClientProfile(configuredClientFingerprint().profile),
		tls_client.WithNotFollowRedirects(),
		tls_client.WithCookieJar(tls_client.NewCookieJar()),
		tls_client.WithBandwidthTracker(),
	}

	if proxyURL != "" {
		options = append(options, proxyClientOptions(proxyURL)...)
	}

	httpClient, err := tls_client.NewHttpClient(tls_client.NewNoopLogger(), options...)
	if err != nil {
		return nil, err
	}

	return &Client{
		HttpClient: httpClient, ProxyURL: proxyURL, trafficRecorder: trafficRecorder,
		warmed: make(map[string]bool), catalogReady: make(map[string]bool),
	}, nil
}

func NewSellerClient(proxyURL string, trafficRecorder func(txBytes int64, rxBytes int64)) (*Client, error) {
	options := []tls_client.HttpClientOption{
		tls_client.WithTimeoutSeconds(10),
		tls_client.WithClientProfile(configuredClientFingerprint().profile),
		tls_client.WithNotFollowRedirects(),
		tls_client.WithCookieJar(tls_client.NewCookieJar()),
		tls_client.WithBandwidthTracker(),
	}

	if proxyURL != "" {
		options = append(options, proxyClientOptions(proxyURL)...)
	}

	httpClient, err := tls_client.NewHttpClient(tls_client.NewNoopLogger(), options...)
	if err != nil {
		return nil, err
	}

	return &Client{
		HttpClient: httpClient, ProxyURL: proxyURL, trafficRecorder: trafficRecorder,
		warmed: make(map[string]bool), catalogReady: make(map[string]bool),
	}, nil
}

func proxyClientOptions(proxyURL string) []tls_client.HttpClientOption {
	parsed, err := url.Parse(proxyURL)
	if err != nil {
		return []tls_client.HttpClientOption{tls_client.WithProxyUrl(proxyURL)}
	}
	if parsed.Scheme == "socks5" || parsed.Scheme == "socks5h" {
		return []tls_client.HttpClientOption{
			tls_client.WithProxyDialerFactory(contextAwareSOCKS5Dialer(proxyURL)),
		}
	}
	if parsed.Scheme == "socks4" || parsed.Scheme == "socks4a" {
		return []tls_client.HttpClientOption{
			tls_client.WithProxyDialerFactory(contextAwareSOCKS4Dialer(proxyURL)),
		}
	}
	return []tls_client.HttpClientOption{tls_client.WithProxyUrl(proxyURL)}
}

func contextAwareSOCKS5Dialer(proxyURL string) tls_client.ProxyDialerFactory {
	return func(_ string, timeout time.Duration, localAddr *net.TCPAddr, _ http.Header, _ tls_client.Logger) (proxy.ContextDialer, error) {
		parsed, err := url.Parse(proxyURL)
		if err != nil {
			return nil, err
		}
		if parsed.Host == "" {
			return nil, fmt.Errorf("invalid SOCKS5 proxy URL %q", proxyURL)
		}

		var auth *proxy.Auth
		if parsed.User != nil {
			password, _ := parsed.User.Password()
			auth = &proxy.Auth{User: parsed.User.Username(), Password: password}
		}

		forward := &net.Dialer{Timeout: timeout, LocalAddr: localAddr}
		dialer, err := proxy.SOCKS5("tcp", parsed.Host, auth, forward)
		if err != nil {
			return nil, err
		}
		contextDialer, ok := dialer.(proxy.ContextDialer)
		if !ok {
			return nil, fmt.Errorf("SOCKS5 dialer for %q does not support contexts", proxyURL)
		}
		return timeoutProxyDialer{dialer: contextDialer, timeout: timeout}, nil
	}
}

type timeoutProxyDialer struct {
	dialer  proxy.ContextDialer
	timeout time.Duration
}

func contextAwareSOCKS4Dialer(proxyURL string) tls_client.ProxyDialerFactory {
	return func(_ string, timeout time.Duration, localAddr *net.TCPAddr, _ http.Header, _ tls_client.Logger) (proxy.ContextDialer, error) {
		parsed, err := url.Parse(proxyURL)
		if err != nil {
			return nil, err
		}
		if parsed.Host == "" {
			return nil, fmt.Errorf("invalid SOCKS4 proxy URL %q", proxyURL)
		}
		user := ""
		if parsed.User != nil {
			user = parsed.User.Username()
		}
		return socks4ContextDialer{
			proxyAddress: parsed.Host,
			user:         user,
			dialer:       net.Dialer{Timeout: timeout, LocalAddr: localAddr},
			timeout:      timeout,
		}, nil
	}
}

type socks4ContextDialer struct {
	proxyAddress string
	user         string
	dialer       net.Dialer
	timeout      time.Duration
}

func (d socks4ContextDialer) DialContext(ctx context.Context, network string, address string) (net.Conn, error) {
	if d.timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, d.timeout)
		defer cancel()
	}
	conn, err := d.dialer.DialContext(ctx, "tcp", d.proxyAddress)
	if err != nil {
		return nil, err
	}
	success := false
	defer func() {
		if !success {
			conn.Close()
		}
	}()
	if deadline, ok := ctx.Deadline(); ok {
		if err := conn.SetDeadline(deadline); err != nil {
			return nil, err
		}
	}

	host, portText, err := net.SplitHostPort(address)
	if err != nil {
		return nil, err
	}
	port, err := strconv.Atoi(portText)
	if err != nil || port < 1 || port > 65535 {
		return nil, fmt.Errorf("invalid SOCKS4 target port %q", portText)
	}
	request := []byte{4, 1, 0, 0, 0, 0, 0, 1}
	binary.BigEndian.PutUint16(request[2:4], uint16(port))
	if ip := net.ParseIP(host).To4(); ip != nil {
		copy(request[4:8], ip)
	} else {
		request = append(request, []byte(d.user)...)
		request = append(request, 0)
		request = append(request, []byte(host)...)
		request = append(request, 0)
	}
	if net.ParseIP(host).To4() != nil {
		request = append(request, []byte(d.user)...)
		request = append(request, 0)
	}
	if _, err := conn.Write(request); err != nil {
		return nil, err
	}
	response := make([]byte, 8)
	if _, err := io.ReadFull(conn, response); err != nil {
		return nil, err
	}
	if response[1] != 90 {
		return nil, fmt.Errorf("SOCKS4 proxy rejected connection with code %d", response[1])
	}
	if err := conn.SetDeadline(time.Time{}); err != nil {
		return nil, err
	}
	success = true
	return conn, nil
}

func (d timeoutProxyDialer) DialContext(ctx context.Context, network string, address string) (net.Conn, error) {
	if d.timeout <= 0 {
		return d.dialer.DialContext(ctx, network, address)
	}
	dialCtx, cancel := context.WithTimeout(ctx, d.timeout)
	defer cancel()
	return d.dialer.DialContext(dialCtx, network, address)
}

func (c *Client) ProxyLabel() string {
	if c == nil || c.ProxyURL == "" {
		return "direct"
	}

	parsed, err := url.Parse(c.ProxyURL)
	if err != nil || parsed.Host == "" {
		return c.ProxyURL
	}

	return parsed.Scheme + "://" + parsed.Host
}

func (c *Client) WarmUp() error {
	return c.WarmUpRegionContext(context.Background(), "www.vinted.de")
}

func (c *Client) WarmUpRegion(domain string) error {
	return c.WarmUpRegionContext(context.Background(), domain)
}

func (c *Client) WarmUpRegionContext(ctx context.Context, domain string) error {
	// The regional help page establishes the anonymous cookie session without
	// downloading the substantially larger marketplace homepage. Fall back only
	// when that route is unsupported; retrying transport or access failures via
	// the homepage would merely double the public-proxy budget.
	err := c.warmUpRegionURLContext(ctx, domain, fmt.Sprintf("https://%s/help", domain))
	if err == nil {
		return nil
	}
	if !shouldFallbackCatalogWarmup(err) {
		return err
	}
	return c.warmUpRegionURLContext(ctx, domain, fmt.Sprintf("https://%s/", domain))
}

func shouldFallbackCatalogWarmup(err error) bool {
	status := statusCodeFromError(err)
	return status == 404 || status == 410
}

func (c *Client) warmUpRegionURLContext(ctx context.Context, domain string, initialURL string) error {
	currentURL := initialURL

	for redirects := 0; redirects < 3; redirects++ {
		currentDomain := hostFromURL(currentURL, domain)

		req, err := http.NewRequestWithContext(ctx, "GET", currentURL, nil)
		if err != nil {
			return err
		}
		req.Header = newWarmupHeaders(currentDomain)

		resp, err := c.HttpClient.Do(req)
		if err != nil {
			c.FlushTrackedTraffic()
			return err
		}

		if resp.StatusCode >= 300 && resp.StatusCode < 400 {
			location := resp.Header.Get("Location")
			_, _ = io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
			c.FlushTrackedTraffic()
			if location == "" {
				return fmt.Errorf("warmup redirect without location for %s", currentDomain)
			}

			nextURL, err := resolveRedirectURL(currentURL, location)
			if err != nil {
				return fmt.Errorf("warmup redirect resolve: %w", err)
			}
			currentURL = nextURL
			continue
		}

		if resp.StatusCode != 200 {
			_, _ = io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
			c.FlushTrackedTraffic()
			return &httpStatusError{
				operation:  fmt.Sprintf("warmup %s", currentDomain),
				statusCode: resp.StatusCode,
			}
		}

		// Catalogue GETs now use the browser's cookie session directly. Closing
		// the large help response after its headers avoids spending the proxy
		// budget on obsolete CSRF/anonymous metadata embedded deep in the body.
		resp.Body.Close()
		c.FlushTrackedTraffic()
		c.synchronizeCatalogCookies(domain)
		c.warmedMu.Lock()
		c.catalogReady[domain] = true
		c.warmedMu.Unlock()
		return nil
	}

	return fmt.Errorf("warmup too many redirects for %s", domain)
}

// synchronizeCatalogCookies mirrors the anonymous browser session from the
// marketplace host to its catalogue API host. Vinted currently sets several
// bootstrap cookies as host-only cookies on www, while the browser catalogue
// request is sent to api.<region>. Without this explicit hand-off tls-client's
// standards-compliant jar sends no cookies to the API host and UK rejects the
// otherwise valid public request with 403.
func (c *Client) synchronizeCatalogCookies(domain string) {
	if c == nil || c.HttpClient == nil {
		return
	}
	sourceURL, err := url.Parse(fmt.Sprintf("https://%s/", domain))
	if err != nil {
		return
	}
	targetHost := catalogAPIHost(domain)
	if targetHost == domain {
		return
	}
	targetURL, err := url.Parse(fmt.Sprintf("https://%s/", targetHost))
	if err != nil {
		return
	}
	cookies := c.HttpClient.GetCookies(sourceURL)
	if len(cookies) == 0 {
		return
	}
	c.HttpClient.SetCookies(targetURL, cookies)
}

func (c *Client) EnsureWarm(domain string) error {
	return c.EnsureWarmContext(context.Background(), domain)
}

func (c *Client) EnsureWarmContext(ctx context.Context, domain string) error {
	c.warmedMu.Lock()
	if c.warmed[domain] {
		c.warmedMu.Unlock()
		return nil
	}
	c.warmedMu.Unlock()

	if err := c.WarmUpRegionContext(ctx, domain); err != nil {
		return err
	}

	c.warmedMu.Lock()
	c.warmed[domain] = true
	c.warmedMu.Unlock()
	return nil
}

func (c *Client) ResetWarm(domain string) {
	c.warmedMu.Lock()
	delete(c.warmed, domain)
	delete(c.catalogReady, domain)
	c.warmedMu.Unlock()
}

func (c *Client) CatalogReady(domain string) bool {
	c.warmedMu.Lock()
	defer c.warmedMu.Unlock()
	return c.catalogReady[domain]
}

// Close releases the client's pooled connections.
//
// A discarded client keeps its TCP and TLS connections alive until the
// transport's idle timeout, and an HTTP/2 connection also keeps a read-loop
// goroutine running. With proxies churning, unclosed clients accumulate into a
// steady population of dead-but-open sockets.
func (c *Client) Close() {
	if c == nil || c.HttpClient == nil {
		return
	}
	c.HttpClient.CloseIdleConnections()
}

func (c *Client) RecordTraffic(txBytes int64, rxBytes int64) {
	if c == nil || c.trafficRecorder == nil {
		return
	}
	if txBytes <= 0 && rxBytes <= 0 {
		return
	}
	c.trafficRecorder(txBytes, rxBytes)
}

func (c *Client) FlushTrackedTraffic() {
	if c == nil || c.HttpClient == nil {
		return
	}

	c.trackerMu.Lock()
	defer c.trackerMu.Unlock()

	tracker := c.HttpClient.GetBandwidthTracker()
	if tracker == nil {
		return
	}

	currentTx := tracker.GetWriteBytes()
	currentRx := tracker.GetReadBytes()
	deltaTx := currentTx - c.lastTxBytes
	deltaRx := currentRx - c.lastRxBytes
	c.lastTxBytes = currentTx
	c.lastRxBytes = currentRx

	c.RecordTraffic(deltaTx, deltaRx)
}
