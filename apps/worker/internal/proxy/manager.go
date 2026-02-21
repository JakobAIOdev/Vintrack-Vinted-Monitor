package proxy

import (
	"bufio"
	"fmt"
	"log"
	"net/url"
	"os"
	"regexp"
	"strings"
	"sync"
)

type Manager struct {
	proxies []string
	index   int
	mu      sync.Mutex
}

var validProxySchemes = map[string]bool{
	"http": true, "https": true, "socks5": true, "socks4": true,
}

var hostPortRegex = regexp.MustCompile(`:\d{1,5}$`)

func validateProxy(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}

	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}

	if !validProxySchemes[u.Scheme] {
		return ""
	}

	host := u.Hostname()
	if host == "" {
		return ""
	}

	if !strings.Contains(host, ".") && !strings.Contains(host, ":") && host != "localhost" {
		return ""
	}

	if u.Port() == "" {
		return ""
	}

	return raw
}

func parseProxyLine(line string) string {
	line = strings.TrimSpace(line)
	if line == "" {
		return ""
	}

	if strings.HasPrefix(line, "http") || strings.HasPrefix(line, "socks") {
		return validateProxy(line)
	}

	// host:port:user:pass format
	parts := strings.Split(line, ":")
	if len(parts) >= 4 {
		n := len(parts)
		pass := parts[n-1]
		user := parts[n-2]
		port := parts[n-3]

		ipParts := parts[:n-3]
		ip := strings.Join(ipParts, ":")

		if strings.Contains(ip, ":") && !strings.HasPrefix(ip, "[") {
			ip = fmt.Sprintf("[%s]", ip)
		}

		formatted := fmt.Sprintf("http://%s:%s@%s:%s", user, pass, ip, port)
		return validateProxy(formatted)
	}

	// host:port format
	if len(parts) == 2 && hostPortRegex.MatchString(line) {
		return validateProxy("http://" + line)
	}

	return ""
}

func Load(filepath string) (*Manager, error) {
	file, err := os.Open(filepath)
	if err != nil {
		return nil, err
	}
	defer file.Close()

	var proxies []string
	var skipped int
	scanner := bufio.NewScanner(file)

	for scanner.Scan() {
		raw := scanner.Text()
		p := parseProxyLine(raw)
		if p != "" {
			proxies = append(proxies, p)
		} else if strings.TrimSpace(raw) != "" {
			skipped++
		}
	}

	if skipped > 0 {
		log.Printf("⚠ Skipped %d invalid proxy lines from file", skipped)
	}
	log.Printf("Loaded %d valid proxies from file", len(proxies))
	return &Manager{proxies: proxies}, nil
}

func FromString(raw string) *Manager {
	var proxies []string
	var skipped int
	for _, line := range strings.Split(raw, "\n") {
		p := parseProxyLine(line)
		if p != "" {
			proxies = append(proxies, p)
		} else if strings.TrimSpace(line) != "" {
			skipped++
		}
	}
	if skipped > 0 {
		log.Printf("⚠ Skipped %d invalid proxy lines from user group", skipped)
	}
	return &Manager{proxies: proxies}
}

func (m *Manager) Count() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.proxies)
}

func (m *Manager) Next() string {
	m.mu.Lock()
	defer m.mu.Unlock()

	if len(m.proxies) == 0 {
		return ""
	}

	proxy := m.proxies[m.index]
	m.index = (m.index + 1) % len(m.proxies)
	return proxy
}
