package scraper

import (
	http "github.com/bogdanfinn/fhttp"
	tls_client "github.com/bogdanfinn/tls-client"
	"github.com/bogdanfinn/tls-client/profiles"
)

// Common browser headers shared across all requests.
var browserHeaders = http.Header{
	"user-agent":                {"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"},
	"accept":                    {"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7"},
	"accept-language":           {"de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7"},
	"sec-ch-ua":                 {`"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"`},
	"sec-ch-ua-mobile":          {"?0"},
	"sec-ch-ua-platform":        {`"macOS"`},
	"sec-fetch-dest":            {"document"},
	"sec-fetch-mode":            {"navigate"},
	"sec-fetch-site":            {"same-origin"},
	"sec-fetch-user":            {"?1"},
	"upgrade-insecure-requests": {"1"},
}

// API request headers for Vinted catalog endpoint.
var apiHeaders = http.Header{
	"user-agent":       {"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"},
	"accept":           {"application/json, text/plain, */*"},
	"accept-language":  {"de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7"},
	"x-requested-with": {"XMLHttpRequest"},
	"referer":          {"https://www.vinted.de/"},
}

// Client wraps a TLS HTTP client with Cloudflare friendly fingerprinting.
type Client struct {
	HttpClient tls_client.HttpClient
}

// Uses WithNotFollowRedirects so Cloudflare cookie handshake works correctly.
func NewClient(proxyURL string) (*Client, error) {
	options := []tls_client.HttpClientOption{
		tls_client.WithTimeoutSeconds(15),
		tls_client.WithClientProfile(profiles.Chrome_120),
		tls_client.WithNotFollowRedirects(),
		tls_client.WithCookieJar(tls_client.NewCookieJar()),
	}

	if proxyURL != "" {
		options = append(options, tls_client.WithProxyUrl(proxyURL))
	}

	httpClient, err := tls_client.NewHttpClient(tls_client.NewNoopLogger(), options...)
	if err != nil {
		return nil, err
	}

	return &Client{HttpClient: httpClient}, nil
}

func (c *Client) WarmUp() error {
	req, _ := http.NewRequest("GET", "https://www.vinted.de/", nil)
	req.Header = browserHeaders

	resp, err := c.HttpClient.Do(req)
	if err != nil {
		return err
	}
	resp.Body.Close()
	return nil
}
