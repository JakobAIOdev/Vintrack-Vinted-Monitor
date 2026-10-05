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
	if err == redis.Nil {
		return nil, nil
	}
	if err != nil {
		return nil, err
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
