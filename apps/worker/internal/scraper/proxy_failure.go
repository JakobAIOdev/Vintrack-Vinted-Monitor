package scraper

import (
	"context"
	"errors"
	"strings"
	"time"
)

const (
	proxyErrorVintedAccessDenied    = "vinted_access_denied"
	proxyErrorAuthenticationFailed  = "proxy_auth_failed"
	proxyErrorVintedRateLimited     = "vinted_rate_limited"
	proxyErrorVintedSessionRejected = "vinted_session_rejected"
	proxyErrorTimeout               = "proxy_timeout"
	proxyErrorNetwork               = "proxy_network_error"
	proxyErrorInvalidResponse       = "invalid_response"
	proxyErrorVintedServer          = "vinted_server_error"
	proxyErrorHTTP                  = "catalog_http_error"
	proxyErrorNoValidProxies        = "no_valid_proxies"
	proxyErrorPoolWaiting           = "proxy_pool_waiting"
)

const (
	vintedAccessDeniedQuarantine    = 10 * time.Minute
	proxyAuthFailedQuarantine       = 30 * time.Minute
	vintedRateLimitedQuarantine     = time.Minute
	vintedSessionRejectedQuarantine = 2 * time.Minute
	proxyNetworkQuarantine          = 30 * time.Second
	vintedServerCooldown            = 10 * time.Second
)

type proxyFailurePolicy struct {
	code               string
	cooldown           time.Duration
	quarantine         time.Duration
	replaceClient      bool
	resetWarmupSession bool
}

func failurePolicy(status int, err error, failures int) proxyFailurePolicy {
	if status == 0 && isProxyAuthenticationError(err) {
		status = 407
	}
	switch status {
	case 401:
		return proxyFailurePolicy{
			code: proxyErrorVintedSessionRejected, cooldown: vintedSessionRejectedQuarantine,
			quarantine: vintedSessionRejectedQuarantine, replaceClient: true, resetWarmupSession: true,
		}
	case 403:
		return proxyFailurePolicy{
			code: proxyErrorVintedAccessDenied, cooldown: vintedAccessDeniedQuarantine,
			quarantine: vintedAccessDeniedQuarantine, replaceClient: true, resetWarmupSession: true,
		}
	case 407:
		return proxyFailurePolicy{
			code: proxyErrorAuthenticationFailed, cooldown: proxyAuthFailedQuarantine,
			quarantine: proxyAuthFailedQuarantine, replaceClient: true, resetWarmupSession: true,
		}
	case 429:
		return proxyFailurePolicy{
			code: proxyErrorVintedRateLimited, cooldown: vintedRateLimitedQuarantine,
			quarantine: vintedRateLimitedQuarantine, replaceClient: true, resetWarmupSession: true,
		}
	}

	if status >= 500 && status <= 599 {
		return proxyFailurePolicy{code: proxyErrorVintedServer, cooldown: vintedServerCooldown}
	}

	if err != nil {
		code := proxyErrorNetwork
		if errors.Is(err, context.DeadlineExceeded) {
			code = proxyErrorTimeout
		} else if strings.Contains(strings.ToLower(err.Error()), "json decode") {
			code = proxyErrorInvalidResponse
		}
		if failures >= 2 && code != proxyErrorInvalidResponse {
			return proxyFailurePolicy{
				code: code, cooldown: proxyNetworkQuarantine,
				quarantine: proxyNetworkQuarantine, replaceClient: true,
			}
		}
		return proxyFailurePolicy{code: code, cooldown: 5 * time.Second}
	}

	return proxyFailurePolicy{code: proxyErrorHTTP, cooldown: 2 * time.Second}
}

func catalogFailureCode(status int, err error) string {
	return failurePolicy(status, err, 1).code
}

func isProxyAuthenticationError(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "proxy responded with non 200 code: 407") ||
		strings.Contains(message, "proxy authentication required")
}
