package session

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

var ErrCheckoutProxyRequired = errors.New("select an owned checkout proxy group in Account")

// The caller never accepts a proxy URL from the browser. Resolve the member's
// saved selection and ownership together, and keep credentials inside the service.
func (m *Manager) CheckoutProxy(sess *VintedSession) (string, error) {
	if m.store == nil {
		return "", fmt.Errorf("checkout proxy storage unavailable")
	}
	ctx, cancel := context.WithTimeout(m.ctx, 3*time.Second)
	defer cancel()
	var proxies string
	err := m.store.db.QueryRowContext(ctx, `
		SELECT p.proxies FROM "User" u
		JOIN proxy_groups p ON p."userId" = u.id
		 AND p.id::text = u.checkout_preferences->>'proxyGroupId'
		WHERE u.id = $1 AND u.checkout_enabled
		 AND u.checkout_preferences->>'transport' = 'server'
		 AND u.checkout_preferences->>'accountId' = $2
		 AND u.checkout_preferences->>'domain' = $3
		 AND (p.bandwidth_limit_bytes IS NULL OR
		      p.bandwidth_rx_bytes + p.bandwidth_tx_bytes < p.bandwidth_limit_bytes)`,
		sess.UserID, fmt.Sprint(sess.VintedUserID), sess.Domain).Scan(&proxies)
	if err == sql.ErrNoRows {
		return "", ErrCheckoutProxyRequired
	}
	if err != nil {
		return "", fmt.Errorf("checkout proxy storage unavailable")
	}
	// Never rotate or skip an invalid first entry: changing network midway can
	// invalidate the session and makes ambiguous payment outcomes dangerous.
	for _, line := range strings.Split(proxies, "\n") {
		if line = strings.TrimSpace(line); line != "" {
			return line, nil
		}
	}
	return "", ErrCheckoutProxyRequired
}
