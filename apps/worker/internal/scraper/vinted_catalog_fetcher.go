package scraper

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strconv"
	"time"

	"vintrack-worker/internal/model"

	http "github.com/bogdanfinn/fhttp"
)

type VintedCatalogFetcher struct{}

func (VintedCatalogFetcher) Name() string {
	return "live"
}

func (VintedCatalogFetcher) RequiresNetwork() bool {
	return true
}

func (VintedCatalogFetcher) FetchCatalog(ctx context.Context, client *Client, apiURL string, domain string) ([]model.VintedItem, int, error) {
	reqURL := apiURL + "&_=" + strconv.FormatInt(time.Now().UnixMilli(), 10)

	if client == nil {
		return nil, 0, fmt.Errorf("live catalog fetcher requires a client")
	}

	if err := client.EnsureWarmContext(ctx, domain); err != nil {
		return nil, statusCodeFromError(err), fmt.Errorf("warmup %s via %s: %w", domain, client.ProxyLabel(), err)
	}

	for redirects := 0; redirects < 3; redirects++ {
		currentDomain := hostFromURL(reqURL, domain)

		req, err := http.NewRequestWithContext(ctx, "GET", reqURL, nil)
		if err != nil {
			return nil, 0, err
		}
		req.Header = newAPIHeaders(currentDomain)

		resp, err := client.HttpClient.Do(req)
		if err != nil {
			client.FlushTrackedTraffic()
			return nil, 0, err
		}

		if resp.StatusCode >= 300 && resp.StatusCode < 400 {
			location := resp.Header.Get("Location")
			_, _ = io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
			client.FlushTrackedTraffic()
			if location == "" {
				return nil, resp.StatusCode, nil
			}

			nextURL, err := resolveRedirectURL(reqURL, location)
			if err != nil {
				return nil, 0, err
			}
			reqURL = nextURL
			continue
		}

		if resp.StatusCode != 200 {
			_, _ = io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
			client.FlushTrackedTraffic()
			return nil, resp.StatusCode, nil
		}

		limitedReader := io.LimitReader(resp.Body, maxAPIResponseBytes)
		var data model.VintedResponse
		if err := json.NewDecoder(limitedReader).Decode(&data); err != nil {
			resp.Body.Close()
			client.FlushTrackedTraffic()
			return nil, 0, fmt.Errorf("json decode: %w", err)
		}
		resp.Body.Close()
		client.FlushTrackedTraffic()
		return data.Items, 200, nil
	}

	return nil, 0, nil
}
