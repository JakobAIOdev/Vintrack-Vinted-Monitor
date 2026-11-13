package session

import (
	"fmt"

	"github.com/redis/go-redis/v9"
)

// CheckoutPaymentHandoffTTL bounds how long a started provider approval link
// can be handed back to the member who started it.
const CheckoutPaymentHandoffTTL = CheckoutPreparationTTL

func checkoutPaymentHandoffKey(sess *VintedSession, itemID int64) string {
	return checkoutPreparationKey(sess, itemID) + ":payment-handoff"
}

// A provider approval link lets the member finish a payment that was already
// started once. It is kept encrypted, short-lived and scoped to the member,
// linked identity and item; it never enters durable results or history.
// Returning it again sends no request to Vinted and starts no second payment.
func (m *Manager) SaveCheckoutPaymentHandoff(sess *VintedSession, itemID int64, raw string) error {
	if m.cipher == nil || raw == "" {
		return fmt.Errorf("payment handoff storage unavailable")
	}
	encrypted, err := m.cipher.Encrypt(raw)
	if err != nil || encrypted == "" {
		return fmt.Errorf("payment handoff encryption failed")
	}
	return m.redis.Set(m.ctx, checkoutPaymentHandoffKey(sess, itemID), encrypted, CheckoutPaymentHandoffTTL).Err()
}

// CheckoutPaymentHandoff returns "" when no link is available any more.
func (m *Manager) CheckoutPaymentHandoff(sess *VintedSession, itemID int64) (string, error) {
	if m.cipher == nil {
		return "", nil
	}
	encrypted, err := m.redis.Get(m.ctx, checkoutPaymentHandoffKey(sess, itemID)).Result()
	if err == redis.Nil {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("payment handoff unavailable")
	}
	raw, err := m.cipher.Decrypt(encrypted)
	if err != nil {
		return "", fmt.Errorf("payment handoff unreadable")
	}
	return raw, nil
}
