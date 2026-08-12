// Package httpclient provides the shared outbound HTTP transport used by the
// notification providers.
//
// Every alert delivery worker targets one of two hosts (discord.com or
// api.telegram.org). http.DefaultTransport caps idle connections at two per
// host, so once ALERT_DELIVERY_WORKERS goes above two almost every alert pays a
// fresh TCP and TLS handshake. On a small host those handshakes are CPU bound
// and add hundreds of milliseconds to a delivery that should take tens.
package httpclient

import (
	"io"
	"net"
	"net/http"
	"time"
)

var notifierTransport = newNotifierTransport()

func newNotifierTransport() *http.Transport {
	dialer := &net.Dialer{
		Timeout:   3 * time.Second,
		KeepAlive: 30 * time.Second,
	}
	return &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		DialContext:           dialer.DialContext,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          128,
		MaxIdleConnsPerHost:   64,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   4 * time.Second,
		ExpectContinueTimeout: time.Second,
	}
}

// New returns a notification client bound to the shared transport.
//
// Callers must drain a response body before closing it. A body that is closed
// without being read leaves the connection unusable for keep-alive, which
// silently defeats the pooling this package exists to provide.
func New(timeout time.Duration) *http.Client {
	return &http.Client{Timeout: timeout, Transport: notifierTransport}
}

// DrainAndClose reads and discards the remainder of a response body so the
// underlying connection can return to the idle pool, then closes it. Use it for
// fire-and-forget requests whose body is otherwise ignored.
func DrainAndClose(body io.ReadCloser) {
	if body == nil {
		return
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(body, 64*1024))
	_ = body.Close()
}
