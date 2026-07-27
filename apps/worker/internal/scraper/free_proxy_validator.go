package scraper

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strings"
	"time"

	"vintrack-worker/internal/model"
)

type FreeProxyValidationResult struct {
	LatencyMs        int
	WarmupLatencyMs  int
	CatalogLatencyMs int
	StatusCode       int
	ErrorCode        string
}

func ValidateFreeProxy(ctx context.Context, proxyURL string, region string, maxLatencyMs int) (FreeProxyValidationResult, error) {
	if maxLatencyMs <= 0 {
		maxLatencyMs = 2500
	}
	requestTimeout := freeProxyRequestTimeout(ctx, maxLatencyMs)
	client, err := NewClientWithTimeout(proxyURL, nil, requestTimeout)
	if err != nil {
		return FreeProxyValidationResult{ErrorCode: "invalid_config"}, err
	}

	domain := model.RegionDomain(region)
	warmupStartedAt := time.Now()
	if err := client.EnsureWarmContext(ctx, domain); err != nil {
		warmupLatencyMs := int(time.Since(warmupStartedAt).Milliseconds())
		statusCode := statusCodeFromError(err)
		return FreeProxyValidationResult{
			LatencyMs:       warmupLatencyMs,
			WarmupLatencyMs: warmupLatencyMs,
			StatusCode:      statusCode,
			ErrorCode:       ClassifyFreeProxyFailure(err, statusCode),
		}, err
	}
	warmupLatencyMs := int(time.Since(warmupStartedAt).Milliseconds())

	monitor := model.Monitor{Region: region}
	catalogStartedAt := time.Now()
	items, status, err := VintedCatalogFetcher{}.FetchCatalog(ctx, client, BuildVintedURL(monitor), domain)
	_ = items
	catalogLatencyMs := int(time.Since(catalogStartedAt).Milliseconds())
	result := FreeProxyValidationResult{
		LatencyMs:        catalogLatencyMs,
		WarmupLatencyMs:  warmupLatencyMs,
		CatalogLatencyMs: catalogLatencyMs,
		StatusCode:       status,
	}
	if err != nil {
		result.ErrorCode = ClassifyFreeProxyFailure(err, status)
		return result, err
	}
	if status != 200 {
		result.ErrorCode = ClassifyFreeProxyFailure(nil, status)
		return result, fmt.Errorf("catalog returned %d", status)
	}
	if catalogLatencyMs > maxLatencyMs {
		result.ErrorCode = "latency"
		return result, fmt.Errorf("catalog latency %dms exceeds %dms", catalogLatencyMs, maxLatencyMs)
	}
	return result, nil
}

func ClassifyFreeProxyFailure(err error, statusCode int) string {
	switch statusCode {
	case 401:
		return "vinted_401"
	case 403:
		return "vinted_403"
	case 407:
		return "proxy_handshake"
	case 429:
		return "vinted_429"
	}
	if statusCode >= 500 {
		return "upstream_5xx"
	}
	if errors.Is(err, context.Canceled) {
		return "canceled"
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "timeout"
	}
	var networkError net.Error
	if errors.As(err, &networkError) && networkError.Timeout() {
		return "timeout"
	}

	message := strings.ToLower(fmt.Sprint(err))
	switch {
	case strings.Contains(message, "json decode"):
		return "decode"
	case strings.Contains(message, "x509"),
		strings.Contains(message, "tls"),
		strings.Contains(message, "certificate"):
		return "tls"
	case strings.Contains(message, "socks"),
		strings.Contains(message, "proxyconnect"),
		strings.Contains(message, "proxy connect"),
		strings.Contains(message, "handshake"):
		return "proxy_handshake"
	case strings.Contains(message, "timeout"),
		strings.Contains(message, "deadline exceeded"):
		return "timeout"
	case strings.Contains(message, "dial"),
		strings.Contains(message, "connect"),
		strings.Contains(message, "connection refused"),
		strings.Contains(message, "no route"),
		strings.Contains(message, "network is unreachable"),
		strings.Contains(message, "unexpected eof"):
		return "connect"
	default:
		return "transport"
	}
}

func freeProxyRequestTimeout(ctx context.Context, maxLatencyMs int) time.Duration {
	if maxLatencyMs <= 0 {
		maxLatencyMs = 2500
	}
	timeout := time.Duration(maxLatencyMs) * time.Millisecond
	if timeout < 500*time.Millisecond {
		timeout = 500 * time.Millisecond
	}
	if timeout > 5*time.Second {
		timeout = 5 * time.Second
	}
	if deadline, ok := ctx.Deadline(); ok {
		remaining := time.Until(deadline)
		if remaining < timeout {
			timeout = remaining
		}
	}
	if timeout < time.Millisecond {
		return time.Millisecond
	}
	return timeout
}
