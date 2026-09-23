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
	"sync/atomic"
)

type PoolSnapshot struct {
	Proxies           []string
	State             string
	Mature            int
	Reason            string
	ReadyObservations int
	Version           uint64
}

type Manager struct {
	proxies           []string
	index             int
	state             string
	mature            int
	reason            string
	readyObservations int
	mu                sync.Mutex
	version           atomic.Uint64
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
	proxies, skipped := parseProxyLines(raw)
	if skipped > 0 {
		log.Printf("⚠ Skipped %d invalid proxy lines from user group", skipped)
	}
	return &Manager{proxies: proxies}
}

func parseProxyLines(raw string) ([]string, int) {
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
	return proxies, skipped
}

func (m *Manager) ReplaceFromString(raw string) bool {
	state := "recovering"
	if strings.TrimSpace(raw) != "" {
		state = "ready"
	}
	return m.ReplaceSnapshot(raw, state, 0, "", 0)
}

func (m *Manager) ReplaceSnapshot(raw string, state string, mature int, reason string, readyObservations int) bool {
	proxies, skipped := parseProxyLines(raw)
	if skipped > 0 {
		log.Printf("⚠ Skipped %d invalid proxy lines from server setting", skipped)
	}
	if state == "" {
		state = "recovering"
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	changed := strings.Join(m.proxies, "\n") != strings.Join(proxies, "\n") ||
		m.state != state || m.mature != mature || m.reason != reason ||
		m.readyObservations != readyObservations
	if !changed {
		return false
	}

	m.proxies = proxies
	m.index = 0
	m.state = state
	m.mature = mature
	m.reason = reason
	m.readyObservations = readyObservations
	m.version.Add(1)
	log.Printf("Reloaded %d valid proxies (state=%s, mature=%d)", len(proxies), state, mature)
	return true
}

func (m *Manager) Version() uint64 {
	return m.version.Load()
}

func (m *Manager) Count() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.proxies)
}

func (m *Manager) Snapshot() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]string(nil), m.proxies...)
}

func (m *Manager) PoolSnapshot() PoolSnapshot {
	m.mu.Lock()
	defer m.mu.Unlock()
	return PoolSnapshot{
		Proxies:           append([]string(nil), m.proxies...),
		State:             m.state,
		Mature:            m.mature,
		Reason:            m.reason,
		ReadyObservations: m.readyObservations,
		Version:           m.version.Load(),
	}
}

func (m *Manager) Next() string {
	return m.NextExcluding(nil)
}

func (m *Manager) NextExcluding(excluded map[string]bool) string {
	m.mu.Lock()
	defer m.mu.Unlock()

	if len(m.proxies) == 0 {
		return ""
	}

	for range m.proxies {
		proxy := m.proxies[m.index]
		m.index = (m.index + 1) % len(m.proxies)
		if !excluded[proxy] {
			return proxy
		}
	}

	return ""
}

func (m *Manager) CountAvailable(excluded map[string]bool) int {
	m.mu.Lock()
	defer m.mu.Unlock()

	count := 0
	for _, candidate := range m.proxies {
		if !excluded[candidate] {
			count++
		}
	}
	return count
}
