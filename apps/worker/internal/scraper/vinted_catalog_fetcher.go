package scraper

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strings"

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
	if client == nil {
		return nil, 0, fmt.Errorf("live catalog fetcher requires a client")
	}

	if err := client.EnsureWarmContext(ctx, domain); err != nil {
		return nil, statusCodeFromError(err), fmt.Errorf("warmup %s via %s: %w", domain, client.ProxyLabel(), err)
	}

	return fetchCatalogWithSessionRetry(
		func() error {
			client.ResetWarm(domain)
			if err := client.EnsureWarmContext(ctx, domain); err != nil {
				return fmt.Errorf("session rewarm %s via %s: %w", domain, client.ProxyLabel(), err)
			}
			return nil
		},
		func() ([]model.VintedItem, int, error) {
			return fetchCatalogAttempt(ctx, client, apiURL, domain)
		},
	)
}

func fetchCatalogWithSessionRetry(
	rewarm func() error,
	attempt func() ([]model.VintedItem, int, error),
) ([]model.VintedItem, int, error) {
	items, status, err := attempt()
	if err != nil || (status != 401 && status != 403) {
		return items, status, err
	}
	if err := rewarm(); err != nil {
		return nil, statusCodeFromError(err), err
	}
	return attempt()
}

func fetchCatalogAttempt(ctx context.Context, client *Client, initialURL string, domain string) ([]model.VintedItem, int, error) {
	if !client.CatalogReady(domain) {
		return nil, 0, fmt.Errorf("catalog cookie session unavailable for %s", domain)
	}

	reqURL := initialURL
	for redirects := 0; redirects < 3; redirects++ {
		req, err := http.NewRequestWithContext(ctx, "GET", reqURL, nil)
		if err != nil {
			return nil, 0, err
		}
		req.Header = newCatalogAPIHeaders(domain, client.catalogAnonID(domain))

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
		normalizeCatalogItems(data.Items)
		if err := validateCatalogCurrency(domain, data.Items); err != nil {
			return nil, 200, err
		}
		return data.Items, 200, nil
	}
	return nil, 0, fmt.Errorf("catalog too many redirects for %s", domain)
}

func validateCatalogCurrency(domain string, items []model.VintedItem) error {
	expected := model.DomainCurrency(domain)
	if expected == "" {
		return nil
	}
	for _, item := range items {
		currency := strings.ToUpper(strings.TrimSpace(item.Price.Currency))
		if currency != "" && currency != expected {
			return fmt.Errorf("catalog currency mismatch for %s: got %s, want %s", domain, currency, expected)
		}
		if item.TotalItemPrice != nil {
			currency = strings.ToUpper(strings.TrimSpace(item.TotalItemPrice.Currency))
			if currency != "" && currency != expected {
				return fmt.Errorf("catalog total currency mismatch for %s: got %s, want %s", domain, currency, expected)
			}
		}
	}
	return nil
}

func normalizeCatalogItems(items []model.VintedItem) {
	for index := range items {
		item := &items[index]
		if item.BrandTitle == "" {
			item.BrandTitle = item.ItemBox.FirstLine
		}
		if item.SizeTitle != "" && item.Condition != "" {
			continue
		}

		separator := strings.LastIndex(item.ItemBox.SecondLine, " · ")
		if separator < 0 {
			continue
		}
		if item.SizeTitle == "" {
			item.SizeTitle = strings.TrimSpace(item.ItemBox.SecondLine[:separator])
		}
		if item.Condition == "" {
			item.Condition = strings.TrimSpace(item.ItemBox.SecondLine[separator+len(" · "):])
		}
	}
}
