package scraper

import (
	"fmt"

	http "github.com/bogdanfinn/fhttp"
	tls_client "github.com/bogdanfinn/tls-client"
	"github.com/bogdanfinn/tls-client/profiles"
)

const chromeUA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
const iosUA = "Vinted/24.19.0 (iPhone; iOS 15.6; Scale/2.00)"

func newWarmupHeaders() http.Header {
	return http.Header{
		"User-Agent": {iosUA},
		"Accept":     {"*/*"},
	}
}

func newPageHeaders(domain string) http.Header {
	return http.Header{
		"Authority":                 {domain},
		"User-Agent":                {chromeUA},
		"Accept":                    {"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7"},
		"Accept-Language":           {"de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7"},
		"Cache-Control":             {"no-cache"},
		"Pragma":                    {"no-cache"},
		"Sec-Ch-Ua":                 {`"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"`},
		"Sec-Ch-Ua-Mobile":          {"?0"},
		"Sec-Ch-Ua-Platform":        {`"macOS"`},
		"Sec-Fetch-Dest":            {"document"},
		"Sec-Fetch-Mode":            {"navigate"},
		"Sec-Fetch-Site":            {"same-origin"},
		"Sec-Fetch-User":            {"?1"},
		"Upgrade-Insecure-Requests": {"1"},
	}
}

func newAPIHeaders(domain string) http.Header {
	return http.Header{
		"User-Agent":      {iosUA},
		"Accept":          {"*/*"},
		"Accept-Language": {"de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7"},
		"Cache-Control":   {"no-cache"},
		"Pragma":          {"no-cache"},
	}
}

type Client struct {
	HttpClient tls_client.HttpClient
}

func NewClient(proxyURL string, profile profiles.ClientProfile) (*Client, error) {
	timeout := 3
	if profile.GetClientHelloId().Client == "Chrome" {
		timeout = 10
	}

	options := []tls_client.HttpClientOption{
		tls_client.WithTimeoutSeconds(timeout),
		tls_client.WithClientProfile(profile),
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
	return c.WarmUpRegion("www.vinted.de")
}

func (c *Client) WarmUpRegion(domain string) error {
	req, _ := http.NewRequest("GET", fmt.Sprintf("https://%s/", domain), nil)
	req.Header = newWarmupHeaders()

	resp, err := c.HttpClient.Do(req)
	if err != nil {
		return err
	}
	resp.Body.Close()
	return nil
}

func (c *Client) WarmUpRegionHTML(domain string) error {
	req, _ := http.NewRequest("GET", fmt.Sprintf("https://%s/", domain), nil)
	req.Header = http.Header{
		"User-Agent": {chromeUA},
		"Accept":     {"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"},
	}

	resp, err := c.HttpClient.Do(req)
	if err != nil {
		return err
	}
	resp.Body.Close()
	return nil
}
