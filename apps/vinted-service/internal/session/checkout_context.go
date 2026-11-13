package session

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"time"
)

func checkoutContextBlockKey(sess *VintedSession) string {
	// A renewed context gets a different key. Never put cookie/token values in
	// a key, diagnostic, response or log.
	// The access token is not part of the context: its rotation keeps the
	// synced context and must therefore keep a rejection of that context.
	digest := sha256.Sum256([]byte(sess.CookieHeader + "\x00" + sess.CsrfToken + "\x00" + sess.UserAgent))
	return fmt.Sprintf("vinted:checkout-context-block:%s:%d:%s:%s", sess.UserID, sess.VintedUserID, sess.Domain, hex.EncodeToString(digest[:]))
}

func (m *Manager) CheckoutContextBlocked(sess *VintedSession) (bool, error) {
	count, err := m.redis.Exists(m.ctx, checkoutContextBlockKey(sess)).Result()
	return count != 0, err
}

func (m *Manager) BlockCheckoutContext(sess *VintedSession) error {
	return m.redis.Set(m.ctx, checkoutContextBlockKey(sess), "rejected", 24*time.Hour).Err()
}
