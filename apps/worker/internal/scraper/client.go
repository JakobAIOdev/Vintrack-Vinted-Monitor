package scraper

import (
	http "github.com/bogdanfinn/fhttp"
	tls_client "github.com/bogdanfinn/tls-client"
	"github.com/bogdanfinn/tls-client/profiles"
)

func newWarmupHeaders() http.Header {
	return http.Header{
		"User-Agent": {"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"},
		"Accept":     {"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"},
	}
}

func newPageHeaders() http.Header {
	return http.Header{
		"Authority":                 {"www.vinted.de"},
		"User-Agent":                {"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"},
		"Accept":                    {"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7"},
		"Accept-Language":           {"de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7"},
		"Cache-Control":             {"max-age=0"},
		"Sec-Ch-Ua":                 {`"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"`},
		"Sec-Ch-Ua-Mobile":          {"?0"},
		"Sec-Ch-Ua-Platform":        {`"macOS"`},
		"Sec-Fetch-Dest":            {"document"},
		"Sec-Fetch-Mode":            {"navigate"},
		"Sec-Fetch-Site":            {"same-origin"},
		"Sec-Fetch-User":            {"?1"},
		"Upgrade-Insecure-Requests": {"1"},
	}
}

func newAPIHeaders() http.Header {
	return http.Header{
		"User-Agent":       {"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"},
		"Accept":           {"application/json, text/plain, */*"},
		"X-Requested-With": {"XMLHttpRequest"},
		"Referer":          {"https://www.vinted.de/"},
	}
}

type Client struct {
	HttpClient tls_client.HttpClient
}

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
	req.Header = newWarmupHeaders()

	resp, err := c.HttpClient.Do(req)
	if err != nil {
		return err
	}
	resp.Body.Close()
	return nil
}
