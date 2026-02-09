package proxy

import (
	"bufio"
	"fmt"
	"os"
	"strings"
	"sync"
)

type Manager struct {
	proxies []string
	index   int
	mu      sync.Mutex
}

func Load(filepath string) (*Manager, error) {
	file, err := os.Open(filepath)
	if err != nil {
		return nil, err
	}
	defer file.Close()

	var proxies []string
	scanner := bufio.NewScanner(file)

	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}

		if strings.HasPrefix(line, "http") {
			proxies = append(proxies, line)
			continue
		}

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

			formattedProxy := fmt.Sprintf("http://%s:%s@%s:%s", user, pass, ip, port)
			proxies = append(proxies, formattedProxy)
		} else {
			proxies = append(proxies, "http://"+line)
		}
	}

	fmt.Printf("Loaded %d proxies\n", len(proxies))
	return &Manager{proxies: proxies}, nil
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
