package session

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

// Preparations are scoped to the linked Vinted identity as well as the member.
// Switching accounts must never reuse another account's checkout.
func checkoutPreparationKey(sess *VintedSession, itemID int64) string {
	return fmt.Sprintf("vinted:checkout-prepare:%s:%d:%s:%s:%d", sess.UserID, sess.VintedUserID, sess.Domain, sess.LinkedAt, itemID)
}

const CheckoutPreparationTTL = 10 * time.Minute
const checkoutPreparationLockTTL = 2 * time.Minute

// Shared by browser and service. Relinking, cache expiry and a different browser
// must not automatically replay an uncertain payment for the same identity/item.
func autoCheckoutAttemptKey(sess *VintedSession, itemID int64) string {
	return fmt.Sprintf("vinted:auto-checkout-attempt:%s:%d:%s:%d", sess.UserID, sess.VintedUserID, sess.Domain, itemID)
}

func (m *Manager) ReserveAutoCheckout(sess *VintedSession, itemID int64, owners ...string) (bool, error) {
	key := autoCheckoutAttemptKey(sess, itemID)
	if m.store == nil || !m.checkoutClaimsReady.Load() {
		return false, fmt.Errorf("durable payment storage unavailable")
	}
	if len(owners) != 1 || owners[0] == "" {
		return false, fmt.Errorf("payment claim owner is required")
	}
	// Preserve pre-migration claims before issuing a durable claim. Redis
	// failure is ambiguous, so it must fail closed as well.
	claimed, err := m.redis.SetNX(m.ctx, key, time.Now().UTC().Format(time.RFC3339), 0).Result()
	if err != nil {
		return false, err
	}
	if !claimed {
		// An older service may have issued this claim during a rolling
		// update. Preserve it durably as soon as it is observed.
		_, err := m.store.reserveAutoCheckout(m.ctx, sess, itemID, "legacy-redis-claim")
		return false, err
	}
	reserved, err := m.store.reserveAutoCheckout(m.ctx, sess, itemID, owners[0])
	if err != nil {
		// Nothing was claimed durably and nothing was sent. Do not leave a
		// Redis marker that would turn this item into a permanent legacy claim.
		_ = m.redis.Del(m.ctx, key).Err()
	}
	return reserved, err
}

// ReleaseCheckoutAttempt forgets an attempt for which Vinted demonstrably
// created nothing: no request was sent, or Vinted answered the very first
// request with an explicit refusal. Only the request that owns the claim and
// the preparation lock can release it, and nothing at or after a payment
// checkpoint is ever released. The member may then use the buy link again.
func (m *Manager) ReleaseCheckoutAttempt(sess *VintedSession, itemID int64, owner string) error {
	if owner == "" {
		return fmt.Errorf("checkout claim owner is required")
	}
	if m.store != nil {
		released, err := m.store.releaseAutoCheckout(m.ctx, sess, itemID, owner)
		if err != nil {
			return err
		}
		if released {
			if err := m.redis.Del(m.ctx, autoCheckoutAttemptKey(sess, itemID)).Err(); err != nil {
				return err
			}
		}
	}
	const script = `
if redis.call("get", KEYS[1] .. ":lock") ~= ARGV[1] then return 0 end
return redis.call("del", KEYS[1])
`
	return m.redis.Eval(m.ctx, script, []string{checkoutPreparationKey(sess, itemID)}, owner).Err()
}

const checkoutReleaseWindow = 10 * time.Minute
const maxCheckoutReleases = 2

// CheckoutCooldown is how long request checkout pauses for a member after
// Vinted rate-limited one of their checkout requests.
const CheckoutCooldown = time.Minute

// AllowCheckoutRelease bounds how often a refused attempt for one item may be
// released, so a refusal cannot be repeated against Vinted by tapping again.
func (m *Manager) AllowCheckoutRelease(sess *VintedSession, itemID int64) (bool, error) {
	key := fmt.Sprintf("vinted:checkout-release:%s:%d:%s:%d", sess.UserID, sess.VintedUserID, sess.Domain, itemID)
	count, err := m.redis.Incr(m.ctx, key).Result()
	if err != nil {
		return false, err
	}
	if count == 1 {
		if err := m.redis.Expire(m.ctx, key, checkoutReleaseWindow).Err(); err != nil {
			return false, err
		}
	}
	return count <= maxCheckoutReleases, nil
}

func checkoutCooldownKey(sess *VintedSession) string {
	return fmt.Sprintf("vinted:checkout-cooldown:%s:%d:%s", sess.UserID, sess.VintedUserID, sess.Domain)
}

func (m *Manager) StartCheckoutCooldown(sess *VintedSession) error {
	return m.redis.Set(m.ctx, checkoutCooldownKey(sess), "rate-limited", CheckoutCooldown).Err()
}

// CheckoutCooldownActive fails closed: when Redis cannot answer, no new
// request checkout is started.
func (m *Manager) CheckoutCooldownActive(sess *VintedSession) (bool, error) {
	count, err := m.redis.Exists(m.ctx, checkoutCooldownKey(sess)).Result()
	return count != 0, err
}

func (m *Manager) AcquireCheckoutPreparation(sess *VintedSession, itemID int64) (string, bool, error) {
	token, err := m.newBrowserSyncCode()
	if err != nil {
		return "", false, err
	}
	ok, err := m.redis.SetNX(m.ctx, checkoutPreparationKey(sess, itemID)+":lock", token, checkoutPreparationLockTTL).Result()
	return token, ok, err
}

func (m *Manager) GetCheckoutPreparation(sess *VintedSession, itemID int64) (*CheckoutLink, error) {
	data, err := m.redis.Get(m.ctx, checkoutPreparationKey(sess, itemID)).Bytes()
	if err != nil && err != redis.Nil {
		return nil, err
	}
	if m.store != nil {
		// PostgreSQL is authoritative for payment attempts. A stale Redis
		// payment_starting checkpoint must not hide a confirmed durable result.
		link, storeErr := m.store.getAutoCheckoutResult(m.ctx, sess, itemID)
		if storeErr != nil || link != nil {
			return link, storeErr
		}
	}
	if err == redis.Nil {
		return nil, nil
	}
	var link CheckoutLink
	if err := json.Unmarshal(data, &link); err != nil {
		return nil, err
	}
	return &link, nil
}

func (m *Manager) SaveCheckoutPreparation(sess *VintedSession, token string, link CheckoutLink) error {
	data, err := json.Marshal(link)
	if err != nil {
		return err
	}
	const script = `
if redis.call("get", KEYS[1] .. ":lock") ~= ARGV[1] then return 0 end
redis.call("set", KEYS[1], ARGV[2], "PX", ARGV[3])
redis.call("pexpire", KEYS[1] .. ":lock", ARGV[4])
return 1
`
	key := checkoutPreparationKey(sess, link.ItemID)
	saved, err := m.redis.Eval(m.ctx, script, []string{key}, token, data, CheckoutPreparationTTL.Milliseconds(), checkoutPreparationLockTTL.Milliseconds()).Int()
	if err != nil {
		return err
	}
	if saved != 1 {
		return fmt.Errorf("checkout preparation lock expired")
	}
	return nil
}

func (m *Manager) ReleaseCheckoutPreparation(sess *VintedSession, itemID int64, token string) error {
	const script = `
if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) end
return 0
`
	return m.redis.Eval(m.ctx, script, []string{checkoutPreparationKey(sess, itemID) + ":lock"}, token).Err()
}
