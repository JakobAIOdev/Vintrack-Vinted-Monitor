package vinted

import (
	"fmt"
	"net"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"syscall"
	"time"

	tls_client "github.com/bogdanfinn/tls-client"
	"vintrack-vinted/internal/session"
)

// NewCheckoutClient has no direct-network fallback. The same TLS client,
// cookie jar and proxy are retained for preparation and optional payment.
func NewCheckoutClient(sess *session.VintedSession, proxyURL string) (*Client, error) {
	proxy, err := checkoutProxyURL(proxyURL)
	if err != nil {
		return nil, err
	}
	client, err := newClient(sess, checkoutProxyOptions(proxy, net.Dialer{Timeout: 15 * time.Second, Control: publicProxyConnection}))
	if err != nil {
		return nil, fmt.Errorf("checkout proxy client unavailable")
	}
	return client, nil
}

func checkoutProxyOptions(proxy string, dialer net.Dialer) []tls_client.HttpClientOption {
	return []tls_client.HttpClientOption{tls_client.WithProxyUrl(proxy), tls_client.WithDialer(dialer)}
}

func checkoutProxyURL(raw string) (string, error) {
	invalid := fmt.Errorf("invalid checkout proxy; update the first proxy in your group")
	raw = strings.TrimSpace(raw)
	u, err := url.Parse(normalizeCheckoutProxyLine(raw))
	if err != nil || u == nil || (u.Scheme != "http" && u.Scheme != "https" && u.Scheme != "socks4" && u.Scheme != "socks5") ||
		u.Opaque != "" || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return "", invalid
	}
	port, err := strconv.Atoi(u.Port())
	host := strings.TrimSuffix(strings.ToLower(u.Hostname()), ".")
	if err != nil || port < 1 || port > 65535 || host == "" || strings.ContainsAny(raw, "\r\n\t\\") {
		return "", invalid
	}
	if ip, err := netip.ParseAddr(host); err == nil {
		if !publicProxyIP(ip) {
			return "", invalid
		}
	} else if !strings.Contains(host, ".") || strings.HasSuffix(host, ".localhost") || strings.HasSuffix(host, ".local") || strings.HasSuffix(host, ".internal") || strings.HasSuffix(host, ".home.arpa") {
		return "", invalid
	}
	return u.String(), nil
}

// Proxy groups accept the same line formats everywhere in Vintrack: a URL,
// host:port:user:pass, or host:port. The bare formats mean an HTTP proxy. The
// result still has to pass every check in checkoutProxyURL.
func normalizeCheckoutProxyLine(raw string) string {
	line := strings.TrimSpace(raw)
	if strings.Contains(line, "://") {
		return line
	}
	parts := strings.Split(line, ":")
	switch {
	case len(parts) >= 4:
		n := len(parts)
		host := strings.Join(parts[:n-3], ":")
		if strings.Contains(host, ":") && !strings.HasPrefix(host, "[") {
			host = "[" + host + "]"
		}
		return (&url.URL{Scheme: "http", User: url.UserPassword(parts[n-2], parts[n-1]), Host: host + ":" + parts[n-3]}).String()
	case len(parts) == 2:
		return "http://" + line
	default:
		return line
	}
}

// net.Dialer invokes Control after resolving DNS and before connecting. Check
// every actual destination, including DNS changes, rather than trusting syntax.
func publicProxyConnection(_, address string, _ syscall.RawConn) error {
	host, _, err := net.SplitHostPort(address)
	if err == nil {
		if ip, parseErr := netip.ParseAddr(host); parseErr == nil && publicProxyIP(ip) {
			return nil
		}
	}
	return fmt.Errorf("checkout proxy must resolve to a public address")
}

func publicProxyIP(ip netip.Addr) bool {
	ip = ip.Unmap()
	if !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.Zone() != "" {
		return false
	}
	if ip.Is6() && !netip.MustParsePrefix("2000::/3").Contains(ip) {
		return false
	}
	for _, block := range []string{"0.0.0.0/8", "100.64.0.0/10", "192.0.0.0/24", "192.0.2.0/24", "192.88.99.0/24", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "240.0.0.0/4", "2001::/23", "2001:db8::/32", "2002::/16", "3fff::/20"} {
		if netip.MustParsePrefix(block).Contains(ip) {
			return false
		}
	}
	return true
}
