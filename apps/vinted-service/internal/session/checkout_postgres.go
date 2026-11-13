package session

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

// One claim per Vinted identity/item, across members, regions and transports.
// Claims are never expired or deleted by relinking or clearing Redis.
func (s *persistentStore) reserveAutoCheckout(ctx context.Context, sess *VintedSession, itemID int64, owner string) (bool, error) {
	result, err := s.db.ExecContext(ctx, `
		INSERT INTO checkout_payment_attempts (vinted_user_id, item_id, owner_token)
		VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, sess.VintedUserID, itemID, owner)
	if err != nil {
		return false, fmt.Errorf("durable payment claim unavailable")
	}
	count, err := result.RowsAffected()
	return count == 1 && err == nil, err
}

// Only a claim that never got past its first checkpoint can be removed, and
// only by its owner. A stored checkout URL or any later status stays forever.
func (s *persistentStore) releaseAutoCheckout(ctx context.Context, sess *VintedSession, itemID int64, owner string) (bool, error) {
	link, err := s.getAutoCheckoutResult(ctx, sess, itemID)
	if err != nil {
		return false, err
	}
	if link == nil {
		return false, nil
	}
	if link.CheckoutURL != "" || link.TransactionID != 0 ||
		(link.Status != "payment_authorization_reserved" && link.Status != "transaction_creating") {
		return false, fmt.Errorf("checkout claim is past its first step")
	}
	result, err := s.db.ExecContext(ctx, `
		DELETE FROM checkout_payment_attempts
		WHERE vinted_user_id = $1 AND item_id = $2 AND owner_token = $3`, sess.VintedUserID, itemID, owner)
	if err != nil {
		return false, fmt.Errorf("durable payment claim unavailable")
	}
	count, err := result.RowsAffected()
	return count == 1 && err == nil, err
}

func (s *persistentStore) saveAutoCheckoutResult(ctx context.Context, sess *VintedSession, owner string, link CheckoutLink) error {
	link.PaymentURL = ""
	data, err := json.Marshal(link)
	if err != nil {
		return fmt.Errorf("payment checkpoint encoding failed")
	}
	encrypted, err := s.cipher.Encrypt(string(data))
	if err != nil {
		return fmt.Errorf("payment checkpoint encryption failed")
	}
	result, err := s.db.ExecContext(ctx, `
		UPDATE checkout_payment_attempts SET result_ciphertext = $4, updated_at = NOW()
		WHERE vinted_user_id = $1 AND item_id = $2 AND owner_token = $3`, sess.VintedUserID, link.ItemID, owner, encrypted)
	if err != nil {
		return fmt.Errorf("durable payment checkpoint unavailable")
	}
	count, err := result.RowsAffected()
	if err != nil || count != 1 {
		return fmt.Errorf("payment checkpoint owner changed")
	}
	return nil
}

func (s *persistentStore) getAutoCheckoutResult(ctx context.Context, sess *VintedSession, itemID int64) (*CheckoutLink, error) {
	var encrypted sql.NullString
	err := s.db.QueryRowContext(ctx, `SELECT result_ciphertext FROM checkout_payment_attempts
		WHERE vinted_user_id = $1 AND item_id = $2`, sess.VintedUserID, itemID).Scan(&encrypted)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("durable payment state unavailable")
	}
	if !encrypted.Valid || encrypted.String == "" {
		return &CheckoutLink{ItemID: itemID, Status: "payment_authorization_reserved"}, nil
	}
	data, err := s.cipher.Decrypt(encrypted.String)
	if err != nil {
		return nil, fmt.Errorf("durable payment state unreadable")
	}
	var link CheckoutLink
	if err := json.Unmarshal([]byte(data), &link); err != nil || link.ItemID != itemID {
		return nil, fmt.Errorf("durable payment state invalid")
	}
	link.PaymentURL = ""
	return &link, nil
}

func (m *Manager) SaveAutoCheckoutResult(sess *VintedSession, owner string, link CheckoutLink) error {
	if m.store == nil {
		return fmt.Errorf("durable payment storage unavailable")
	}
	return m.store.saveAutoCheckoutResult(m.ctx, sess, owner, link)
}

func (m *Manager) DurableCheckoutAvailable() bool {
	if m.store == nil || !m.checkoutClaimsReady.Load() {
		return false
	}
	var present bool
	// A deployment missing the migration must not advertise automatic payment.
	err := m.store.db.QueryRowContext(m.ctx, `SELECT to_regclass('checkout_payment_attempts') IS NOT NULL`).Scan(&present)
	return err == nil && present
}

func (m *Manager) migrateCheckoutPaymentClaims() error {
	m.checkoutClaimsReady.Store(false)
	if m.store == nil {
		return fmt.Errorf("payment storage unavailable")
	}
	var present bool
	if err := m.store.db.QueryRowContext(m.ctx, `SELECT to_regclass('checkout_payment_attempts') IS NOT NULL`).Scan(&present); err != nil || !present {
		return fmt.Errorf("payment storage migration required")
	}
	var cursor uint64
	for {
		keys, next, err := m.redis.Scan(m.ctx, cursor, "vinted:auto-checkout-attempt:*", 512).Result()
		if err != nil {
			return fmt.Errorf("legacy payment claim scan unavailable")
		}
		for _, key := range keys {
			parts := strings.Split(key, ":")
			if len(parts) < 6 {
				return fmt.Errorf("legacy payment claim key invalid")
			}
			accountID, accountErr := strconv.ParseInt(parts[len(parts)-3], 10, 64)
			itemID, itemErr := strconv.ParseInt(parts[len(parts)-1], 10, 64)
			if accountErr != nil || itemErr != nil || accountID <= 0 || itemID <= 0 {
				return fmt.Errorf("legacy payment claim identity invalid")
			}
			if _, err := m.store.reserveAutoCheckout(m.ctx, &VintedSession{VintedUserID: accountID}, itemID, "legacy-redis-claim"); err != nil {
				return err
			}
		}
		cursor = next
		if cursor == 0 {
			break
		}
	}
	m.checkoutClaimsReady.Store(true)
	return nil
}

// Re-read payment consent and saved choices immediately before claiming and
// again before dispatch. A disabled module or changed limit must stop payment.
func (m *Manager) CheckoutPaymentAuthorized(sess *VintedSession, preferences []byte, transport string) (bool, error) {
	if m.store == nil {
		return false, fmt.Errorf("payment authorization storage unavailable")
	}
	access, err := m.FeatureAccess(sess.UserID, "checkout_links")
	if err != nil || !access.Allowed {
		return false, err
	}
	var authorized bool
	err = m.store.db.QueryRowContext(m.ctx, `
		SELECT COALESCE(checkout_enabled AND checkout_risk_version = $2
		AND checkout_risk_accepted_at IS NOT NULL
		AND checkout_preferences->>'accountId' = $3
		AND checkout_preferences->>'domain' = $4
		AND COALESCE(checkout_preferences->>'transport', 'browser') = $5
		AND checkout_preferences->'preferences' = $6::jsonb, FALSE)
		FROM "User" WHERE id = $1`, sess.UserID, checkoutRiskWarningVersion,
		fmt.Sprint(sess.VintedUserID), sess.Domain, transport, string(preferences)).Scan(&authorized)
	if err == sql.ErrNoRows {
		return false, nil
	}
	return authorized && err == nil, err
}
