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
	initialURL := apiURL + "&_=" + strconv.FormatInt(time.Now().UnixMilli(), 10)

	if client == nil {
		return nil, 0, fmt.Errorf("live catalog fetcher requires a client")
	}

	if err := client.EnsureWarmContext(ctx, domain); err != nil {
		return nil, statusCodeFromError(err), fmt.Errorf("warmup %s via %s: %w", domain, client.ProxyLabel(), err)
	}

	return fetchCatalogWith401Retry(
		func() error {
			client.ResetWarm(domain)
			if err := client.EnsureWarmContext(ctx, domain); err != nil {
				return fmt.Errorf("401 rewarm %s via %s: %w", domain, client.ProxyLabel(), err)
			}
			return nil
		},
		func() ([]model.VintedItem, int, error) {
			return fetchCatalogAttempt(ctx, client, initialURL, domain)
		},
	)
}

func fetchCatalogWith401Retry(
	rewarm func() error,
	attempt func() ([]model.VintedItem, int, error),
) ([]model.VintedItem, int, error) {
	items, status, err := attempt()
	if err != nil || status != 401 {
		return items, status, err
	}
	if err := rewarm(); err != nil {
		return nil, statusCodeFromError(err), err
	}
	return attempt()
}

func fetchCatalogAttempt(ctx context.Context, client *Client, initialURL string, domain string) ([]model.VintedItem, int, error) {
	reqURL := initialURL
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
			statusCode := resp.StatusCode
			_, _ = io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
			client.FlushTrackedTraffic()
			return nil, statusCode, nil
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
	return nil, 0, fmt.Errorf("catalog too many redirects for %s", domain)
}
