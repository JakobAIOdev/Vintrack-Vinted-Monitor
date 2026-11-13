package session

import (
	"database/sql"
	"strings"
	"testing"
)

const syntheticApprovalLink = "https://www.paypal.com/checkoutnow?token=synthetic-approval"

func handoffTestManager(t *testing.T) *Manager {
	t.Helper()
	m := checkoutTestManager(t)
	cipher, err := newTokenCipher("synthetic-test-encryption-key")
	if err != nil {
		t.Fatal(err)
	}
	m.cipher = cipher
	return m
}

func TestCheckoutPaymentHandoffIsEncryptedRepeatableAndScoped(t *testing.T) {
	m := handoffTestManager(t)
	sess := &VintedSession{UserID: "synthetic-user", VintedUserID: 42, Domain: "www.vinted.de", LinkedAt: "synthetic-link-generation"}
	if err := m.SaveCheckoutPaymentHandoff(sess, 123, syntheticApprovalLink); err != nil {
		t.Fatal(err)
	}
	keys, err := m.redis.Keys(m.ctx, "*").Result()
	if err != nil || len(keys) != 1 {
		t.Fatalf("handoff keys = %v err=%v", keys, err)
	}
	if strings.Contains(keys[0], "paypal") || strings.Contains(keys[0], "synthetic-approval") {
		t.Fatal("provider link entered a Redis key")
	}
	stored, err := m.redis.Get(m.ctx, keys[0]).Result()
	if err != nil || stored == "" || stored == syntheticApprovalLink || strings.Contains(stored, "paypal") || strings.Contains(stored, "synthetic-approval") {
		t.Fatal("provider link was stored in plaintext")
	}
	if plain, err := m.cipher.Decrypt(stored); err != nil || plain != syntheticApprovalLink {
		t.Fatal("stored handoff is not the encrypted link")
	}
	if ttl := m.redis.PTTL(m.ctx, keys[0]).Val(); ttl <= 0 || ttl > CheckoutPaymentHandoffTTL {
		t.Fatalf("unexpected handoff lifetime: %s", ttl)
	}
	if CheckoutPaymentHandoffTTL > CheckoutPreparationTTL {
		t.Fatal("a provider link must not outlive its checkout checkpoint")
	}
	for range 3 {
		if link, err := m.CheckoutPaymentHandoff(sess, 123); err != nil || link != syntheticApprovalLink {
			t.Fatalf("handoff not readable repeatedly: %q %v", link, err)
		}
	}
	if link, err := m.CheckoutPaymentHandoff(sess, 124); err != nil || link != "" {
		t.Fatal("handoff crossed the item boundary")
	}
	for name, change := range map[string]func(*VintedSession){
		"member":   func(s *VintedSession) { s.UserID = "another-member" },
		"account":  func(s *VintedSession) { s.VintedUserID = 99 },
		"domain":   func(s *VintedSession) { s.Domain = "www.vinted.fr" },
		"relinked": func(s *VintedSession) { s.LinkedAt = "relinked-generation" },
	} {
		other := *sess
		change(&other)
		if link, err := m.CheckoutPaymentHandoff(&other, 123); err != nil || link != "" {
			t.Fatalf("handoff crossed the %s boundary", name)
		}
	}
	// A second link for another item does not disturb the first one.
	if err := m.SaveCheckoutPaymentHandoff(sess, 124, syntheticApprovalLink+"-second"); err != nil {
		t.Fatal(err)
	}
	if link, _ := m.CheckoutPaymentHandoff(sess, 123); link != syntheticApprovalLink {
		t.Fatal("handoff for another item replaced this one")
	}
	if err := m.redis.Del(m.ctx, checkoutPaymentHandoffKey(sess, 123)).Err(); err != nil {
		t.Fatal(err)
	}
	if link, err := m.CheckoutPaymentHandoff(sess, 123); err != nil || link != "" {
		t.Fatal("expired handoff was still returned")
	}
}

func TestCheckoutPaymentHandoffFailsClosed(t *testing.T) {
	m := handoffTestManager(t)
	sess := &VintedSession{UserID: "synthetic-user", VintedUserID: 42, Domain: "www.vinted.de", LinkedAt: "synthetic-link-generation"}
	if err := m.SaveCheckoutPaymentHandoff(sess, 123, ""); err == nil {
		t.Fatal("empty handoff accepted")
	}
	if err := m.SaveCheckoutPaymentHandoff(sess, 123, "   "); err == nil {
		t.Fatal("blank handoff accepted")
	}
	if keys, _ := m.redis.Keys(m.ctx, "*").Result(); len(keys) != 0 {
		t.Fatalf("rejected handoff left state behind: %v", keys)
	}
	// A value written with another key, or not encrypted at all, is unreadable
	// rather than handed out.
	for _, corrupt := range []string{syntheticApprovalLink, "not-base64-!!", "c3ludGhldGlj"} {
		if err := m.redis.Set(m.ctx, checkoutPaymentHandoffKey(sess, 123), corrupt, CheckoutPaymentHandoffTTL).Err(); err != nil {
			t.Fatal(err)
		}
		if link, err := m.CheckoutPaymentHandoff(sess, 123); err == nil || link != "" {
			t.Fatalf("unreadable handoff returned %q", link)
		}
	}
	other, err := newTokenCipher("another-synthetic-key")
	if err != nil {
		t.Fatal(err)
	}
	foreign, _ := other.Encrypt(syntheticApprovalLink)
	if err := m.redis.Set(m.ctx, checkoutPaymentHandoffKey(sess, 123), foreign, CheckoutPaymentHandoffTTL).Err(); err != nil {
		t.Fatal(err)
	}
	if link, err := m.CheckoutPaymentHandoff(sess, 123); err == nil || link != "" {
		t.Fatal("handoff encrypted with another key was accepted")
	}
	// Without an encryption key nothing is stored and nothing is returned.
	m.cipher = nil
	if err := m.SaveCheckoutPaymentHandoff(sess, 125, syntheticApprovalLink); err == nil {
		t.Fatal("handoff stored without encryption")
	}
	if link, err := m.CheckoutPaymentHandoff(sess, 123); err != nil || link != "" {
		t.Fatal("handoff returned without a cipher")
	}
	if exists := m.redis.Exists(m.ctx, checkoutPaymentHandoffKey(sess, 125)).Val(); exists != 0 {
		t.Fatal("handoff written without encryption")
	}
}

func TestReleaseCheckoutAttemptWithoutStoreOnlyClearsTheOwnersPreparation(t *testing.T) {
	m := handoffTestManager(t)
	sess := &VintedSession{UserID: "synthetic-user", VintedUserID: 42, Domain: "www.vinted.de", LinkedAt: "synthetic-link-generation"}
	link := CheckoutLink{ItemID: 123, SellerID: 456, Status: "transaction_creating"}
	token, acquired, err := m.AcquireCheckoutPreparation(sess, 123)
	if err != nil || !acquired {
		t.Fatal("could not acquire the preparation lock")
	}
	if err := m.SaveCheckoutPreparation(sess, token, link); err != nil {
		t.Fatal(err)
	}
	present := func() bool {
		t.Helper()
		cached, err := m.GetCheckoutPreparation(sess, 123)
		if err != nil {
			t.Fatal(err)
		}
		return cached != nil
	}
	if err := m.ReleaseCheckoutAttempt(sess, 123, ""); err == nil {
		t.Fatal("release without an owner was accepted")
	}
	if !present() {
		t.Fatal("release without an owner removed the checkpoint")
	}
	if err := m.ReleaseCheckoutAttempt(sess, 123, "another-owner"); err != nil {
		t.Fatal(err)
	}
	if !present() {
		t.Fatal("another owner removed the checkpoint")
	}
	// Scoped like the checkpoint itself: another item or link generation is untouched.
	relinked := *sess
	relinked.LinkedAt = "relinked-generation"
	if err := m.ReleaseCheckoutAttempt(&relinked, 123, token); err != nil {
		t.Fatal(err)
	}
	if err := m.ReleaseCheckoutAttempt(sess, 124, token); err != nil {
		t.Fatal(err)
	}
	if !present() {
		t.Fatal("release crossed the item or link boundary")
	}
	if err := m.ReleaseCheckoutAttempt(sess, 123, token); err != nil {
		t.Fatal(err)
	}
	if present() {
		t.Fatal("the owner could not release its own first-step checkpoint")
	}
	// The lock itself stays with the request until it finishes.
	if _, acquired, err := m.AcquireCheckoutPreparation(sess, 123); err != nil || acquired {
		t.Fatal("releasing the attempt also released the running request's lock")
	}
	if err := m.ReleaseCheckoutPreparation(sess, 123, token); err != nil {
		t.Fatal(err)
	}

	// Once the request no longer holds the lock, its token releases nothing.
	token, acquired, err = m.AcquireCheckoutPreparation(sess, 123)
	if err != nil || !acquired {
		t.Fatal("item could not be prepared again after release")
	}
	if err := m.SaveCheckoutPreparation(sess, token, link); err != nil {
		t.Fatal(err)
	}
	if err := m.ReleaseCheckoutPreparation(sess, 123, token); err != nil {
		t.Fatal(err)
	}
	if err := m.ReleaseCheckoutAttempt(sess, 123, token); err != nil {
		t.Fatal(err)
	}
	if !present() {
		t.Fatal("a request without the lock removed the checkpoint")
	}
	next, acquired, err := m.AcquireCheckoutPreparation(sess, 123)
	if err != nil || !acquired {
		t.Fatal(err)
	}
	if err := m.ReleaseCheckoutAttempt(sess, 123, token); err != nil {
		t.Fatal(err)
	}
	if !present() {
		t.Fatal("a previous owner removed the next owner's checkpoint")
	}
	if err := m.ReleaseCheckoutAttempt(sess, 123, next); err != nil || present() {
		t.Fatal("the current owner could not release")
	}
}

// A closed pool fails every statement without contacting any server.
func TestReserveAutoCheckoutLeavesNoRedisMarkerWhenTheDurableClaimFails(t *testing.T) {
	m := handoffTestManager(t)
	db, err := sql.Open("postgres", "postgres://synthetic@127.0.0.1:1/vintrack_checkout_test_closed?sslmode=disable")
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	m.store = &persistentStore{db: db, cipher: m.cipher}
	m.checkoutClaimsReady.Store(true)
	sess := &VintedSession{UserID: "synthetic-user", VintedUserID: 42, Domain: "www.vinted.de", LinkedAt: "synthetic-link-generation"}
	for range 2 {
		if reserved, err := m.ReserveAutoCheckout(sess, 123, "synthetic-owner"); err == nil || reserved {
			t.Fatal("payment claimed without durable storage")
		}
		if exists := m.redis.Exists(m.ctx, autoCheckoutAttemptKey(sess, 123)).Val(); exists != 0 {
			t.Fatal("a failed durable claim left a permanent Redis marker")
		}
	}
	if err := m.ReleaseCheckoutAttempt(sess, 123, "synthetic-owner"); err == nil {
		t.Fatal("release reported success while durable storage was unavailable")
	}
	// A marker issued by an earlier service version is preserved, not deleted.
	if err := m.redis.Set(m.ctx, autoCheckoutAttemptKey(sess, 124), "synthetic-legacy", 0).Err(); err != nil {
		t.Fatal(err)
	}
	if reserved, err := m.ReserveAutoCheckout(sess, 124, "synthetic-owner"); err == nil || reserved {
		t.Fatal("legacy claim was ignored")
	}
	if exists := m.redis.Exists(m.ctx, autoCheckoutAttemptKey(sess, 124)).Val(); exists != 1 {
		t.Fatal("an existing legacy claim marker was deleted")
	}
}
