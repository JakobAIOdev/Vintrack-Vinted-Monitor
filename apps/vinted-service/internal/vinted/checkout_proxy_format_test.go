package vinted

import (
	"net/url"
	"strings"
	"testing"
)

func TestCheckoutProxyAcceptsTheLineFormatsOfProxyGroups(t *testing.T) {
	for _, tc := range []struct {
		line, scheme, host, user, password string
	}{
		{"http://synthetic-user:synthetic-pass@proxy.example.com:8080", "http", "proxy.example.com:8080", "synthetic-user", "synthetic-pass"},
		{"socks5://synthetic-user:synthetic-pass@proxy.example.com:1080", "socks5", "proxy.example.com:1080", "synthetic-user", "synthetic-pass"},
		{"proxy.example.com:8080:synthetic-user:synthetic-pass", "http", "proxy.example.com:8080", "synthetic-user", "synthetic-pass"},
		{"  proxy.example.com:8080:user-country-de_session-abc:p@ss/w%rd \r", "http", "proxy.example.com:8080", "user-country-de_session-abc", "p@ss/w%rd"},
		{"8.8.8.8:3128:synthetic-user:synthetic-pass", "http", "8.8.8.8:3128", "synthetic-user", "synthetic-pass"},
		{"2606:4700:4700::1111:3128:synthetic-user:synthetic-pass", "http", "[2606:4700:4700::1111]:3128", "synthetic-user", "synthetic-pass"},
		{"proxy.example.com:8080", "http", "proxy.example.com:8080", "", ""},
	} {
		normalized, err := checkoutProxyURL(tc.line)
		if err != nil {
			t.Fatalf("proxy line format rejected: %q", tc.line)
		}
		u, err := url.Parse(normalized)
		if err != nil {
			t.Fatal("normalized proxy is not a URL")
		}
		password, _ := u.User.Password()
		if u.Scheme != tc.scheme || u.Host != tc.host || u.User.Username() != tc.user || password != tc.password {
			t.Fatalf("proxy line %q normalized to scheme=%s host=%s", tc.line, u.Scheme, u.Host)
		}
	}
}

func TestCheckoutProxyBareFormatsStillFailClosed(t *testing.T) {
	for _, line := range []string{
		"", "proxy.example.com", "proxy.example.com:notaport:user:pass", "proxy.example.com:0:user:pass",
		"127.0.0.1:8080:user:pass", "10.0.0.5:8080:user:pass", "192.168.1.10:3128", "localhost:8080:user:pass",
		"proxy.internal:8080:user:pass", "::1:8080:user:pass", "proxy.example.com:8080:user", "ftp://proxy.example.com:21",
	} {
		if normalized, err := checkoutProxyURL(line); err == nil {
			t.Fatalf("unsafe or malformed proxy line accepted: %q", line)
		} else if strings.Contains(err.Error(), "user") || strings.Contains(err.Error(), "pass") || normalized != "" {
			t.Fatal("proxy error exposes the proxy line")
		}
	}
}

func TestTransportErrorKeepsOnlyAFixedClass(t *testing.T) {
	for _, tc := range []struct {
		text, kind string
		before     bool
	}{
		{"Proxy responded with non 200 code: 407 Proxy Authentication Required", "proxy_refused_407", true},
		{"Proxy responded with non 200 code: 403 Forbidden", "proxy_refused_403", true},
		{"dial tcp: checkout proxy must resolve to a public address", "proxy_address_not_public", true},
		{"read tcp synthetic-user:synthetic-pass@proxy.example.com: connection reset by peer", "no_answer", false},
	} {
		got := newTransportError("buy conversation", errString(tc.text))
		if got.Kind != tc.kind || got.BeforeSend != tc.before {
			t.Fatalf("%q classified as %s before=%v", tc.text, got.Kind, got.BeforeSend)
		}
		if strings.Contains(got.Error(), "synthetic") || strings.Contains(got.Kind, "synthetic") {
			t.Fatal("transport error kept proxy details")
		}
	}
}

type errString string

func (e errString) Error() string { return string(e) }
