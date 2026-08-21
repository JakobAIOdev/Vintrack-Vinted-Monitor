package publicurl

import (
	"errors"
	"net"
	"net/url"
	"os"
	"strings"
)

var ErrNotConfigured = errors.New("public app URL is not configured")

type Health struct {
	OK     bool
	Origin string
	Source string
	Error  string
}

func Resolve() Health {
	configured := make([]struct {
		key   string
		value string
	}, 0, 3)
	for _, key := range []string{"APP_PUBLIC_URL", "AUTH_URL", "DASHBOARD_URL"} {
		if value := strings.TrimSpace(os.Getenv(key)); value != "" {
			configured = append(configured, struct {
				key   string
				value string
			}{key: key, value: value})
		}
	}
	if len(configured) == 0 {
		return Health{Error: ErrNotConfigured.Error()}
	}

	production := strings.EqualFold(os.Getenv("APP_ENV"), "production") ||
		strings.EqualFold(os.Getenv("NODE_ENV"), "production") ||
		strings.EqualFold(os.Getenv("ENVIRONMENT"), "production")
	firstOrigin, err := normalize(configured[0].value, production)
	if err != nil {
		return Health{Source: configured[0].key, Error: err.Error()}
	}
	for _, candidate := range configured[1:] {
		origin, candidateErr := normalize(candidate.value, production)
		if candidateErr != nil {
			return Health{Source: candidate.key, Error: candidateErr.Error()}
		}
		if origin != firstOrigin {
			return Health{Source: configured[0].key, Error: "public app URL settings disagree"}
		}
	}
	return Health{OK: true, Origin: firstOrigin, Source: configured[0].key}
}

func Link(path string) string {
	health := Resolve()
	if !health.OK {
		return ""
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	return health.Origin + path
}

func normalize(raw string, production bool) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed == nil || parsed.IsAbs() == false {
		return "", errors.New("public app URL must be an absolute HTTP(S) origin")
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return "", errors.New("public app URL must use HTTP or HTTPS")
	}
	if parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", errors.New("public app URL cannot contain credentials, query, or fragment")
	}
	if parsed.Path != "" && parsed.Path != "/" {
		return "", errors.New("public app URL must not contain a path")
	}
	if parsed.Hostname() == "" {
		return "", errors.New("public app URL must include a hostname")
	}
	if production {
		if parsed.Scheme != "https" {
			return "", errors.New("production public app URL must use HTTPS")
		}
		host := strings.ToLower(parsed.Hostname())
		ip := net.ParseIP(host)
		if host == "localhost" || strings.HasSuffix(host, ".local") || (ip != nil && (ip.IsLoopback() || ip.IsPrivate())) {
			return "", errors.New("production public app URL cannot be local")
		}
		for _, tunnelSuffix := range []string{".ngrok-free.app", ".ngrok-free.dev", ".ngrok.app", ".trycloudflare.com"} {
			if strings.HasSuffix(host, tunnelSuffix) {
				return "", errors.New("production public app URL cannot use a temporary tunnel")
			}
		}
	}
	parsed.Path = ""
	return strings.TrimRight(parsed.String(), "/"), nil
}
