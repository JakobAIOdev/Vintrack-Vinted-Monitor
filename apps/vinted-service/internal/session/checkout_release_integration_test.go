package session

import (
	"database/sql"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Requires an explicitly disposable database, never the application database.
// Works on an empty database (the claims table is created and dropped here) and
// on a migrated one (only the synthetic identities below are touched).
func TestReleaseCheckoutAttemptAgainstPostgres(t *testing.T) {
	databaseURL := os.Getenv("CHECKOUT_PAYMENT_INTEGRATION_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("CHECKOUT_PAYMENT_INTEGRATION_DATABASE_URL is not set")
	}
	u, err := url.Parse(databaseURL)
	if err != nil || !strings.HasPrefix(strings.TrimPrefix(u.Path, "/"), "vintrack_checkout_test") {
		t.Fatal("integration test requires a disposable vintrack_checkout_test database")
	}
	db, err := sql.Open("postgres", databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var present bool
	if err := db.QueryRow(`SELECT to_regclass('checkout_payment_attempts') IS NOT NULL`).Scan(&present); err != nil {
		t.Fatal(err)
	}
	if !present {
		migration, err := os.ReadFile(filepath.Join("..", "..", "..", "control-center", "prisma", "migrations", "20261019190000_durable_checkout_payment_attempts", "migration.sql"))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec(string(migration)); err != nil {
			t.Fatal(err)
		}
		defer db.Exec(`DROP TABLE checkout_payment_attempts`)
	}
	const account, otherAccount = int64(990042), int64(990043)
	clean := func() {
		_, _ = db.Exec(`DELETE FROM checkout_payment_attempts WHERE vinted_user_id IN ($1, $2)`, account, otherAccount)
	}
	clean()
	defer clean()

	m := handoffTestManager(t)
	m.store = &persistentStore{db: db, cipher: m.cipher}
	if err := m.migrateCheckoutPaymentClaims(); err != nil {
		t.Fatal(err)
	}
	sess := &VintedSession{UserID: "synthetic-release-member", VintedUserID: account, Domain: "www.vinted.de", LinkedAt: "synthetic-link-generation"}

	durable := func(itemID int64) (owner string, exists bool) {
		t.Helper()
		err := db.QueryRow(`SELECT owner_token FROM checkout_payment_attempts WHERE vinted_user_id = $1 AND item_id = $2`, account, itemID).Scan(&owner)
		if err == sql.ErrNoRows {
			return "", false
		}
		if err != nil {
			t.Fatal(err)
		}
		return owner, true
	}
	marker := func(itemID int64) bool {
		t.Helper()
		return m.redis.Exists(m.ctx, autoCheckoutAttemptKey(sess, itemID)).Val() == 1
	}
	// claim mirrors the request handler: one token owns the preparation lock,
	// the durable claim and every checkpoint.
	claim := func(itemID int64, checkpoint *CheckoutLink) string {
		t.Helper()
		token, acquired, err := m.AcquireCheckoutPreparation(sess, itemID)
		if err != nil || !acquired {
			t.Fatalf("item %d: preparation lock unavailable", itemID)
		}
		if reserved, err := m.ReserveAutoCheckout(sess, itemID, token); err != nil || !reserved {
			t.Fatalf("item %d: claim unavailable: %v", itemID, err)
		}
		if checkpoint != nil {
			checkpoint.ItemID = itemID
			if err := m.SaveCheckoutPreparation(sess, token, *checkpoint); err != nil {
				t.Fatal(err)
			}
			if err := m.SaveAutoCheckoutResult(sess, token, *checkpoint); err != nil {
				t.Fatal(err)
			}
		}
		return token
	}

	t.Run("first checkpoint is released by its owner and claimable again", func(t *testing.T) {
		for index, checkpoint := range []*CheckoutLink{
			nil, // reserved only: payment_authorization_reserved
			{SellerID: 456, Domain: sess.Domain, Status: "transaction_creating", PreferencesKey: "home:card:auto:2:EUR:3000"},
		} {
			itemID := int64(1000 + index)
			token := claim(itemID, checkpoint)
			if err := m.ReleaseCheckoutAttempt(sess, itemID, token); err != nil {
				t.Fatalf("owner could not release a first-step claim: %v", err)
			}
			if _, exists := durable(itemID); exists || marker(itemID) {
				t.Fatal("released claim left a durable row or Redis marker behind")
			}
			if cached, err := m.GetCheckoutPreparation(sess, itemID); err != nil || cached != nil {
				t.Fatalf("released claim left a checkpoint behind: %#v %v", cached, err)
			}
			if err := m.ReleaseCheckoutPreparation(sess, itemID, token); err != nil {
				t.Fatal(err)
			}
			next := claim(itemID, nil)
			if owner, exists := durable(itemID); !exists || owner != next || next == token {
				t.Fatal("released item could not be claimed again by a new request")
			}
		}
	})

	t.Run("another owner cannot release", func(t *testing.T) {
		const itemID = 1100
		token := claim(itemID, &CheckoutLink{SellerID: 456, Status: "transaction_creating"})
		for _, intruder := range []string{"another-owner", "legacy-redis-claim", token + "x"} {
			_ = m.ReleaseCheckoutAttempt(sess, itemID, intruder)
			if owner, exists := durable(itemID); !exists || owner != token || !marker(itemID) {
				t.Fatalf("%q released a claim it does not own", intruder)
			}
			if cached, err := m.GetCheckoutPreparation(sess, itemID); err != nil || cached == nil || cached.Status != "transaction_creating" {
				t.Fatal("another owner removed the checkpoint")
			}
		}
		if err := m.ReleaseCheckoutAttempt(sess, itemID, ""); err == nil {
			t.Fatal("release without an owner was accepted")
		}
		if reserved, err := m.ReserveAutoCheckout(sess, itemID, "second-request"); err != nil || reserved {
			t.Fatal("claim became available after a foreign release attempt")
		}
		// The same item under another Vinted identity is an unrelated claim.
		other := *sess
		other.VintedUserID = otherAccount
		if reserved, err := m.ReserveAutoCheckout(&other, itemID, "other-identity-owner"); err != nil || !reserved {
			t.Fatal("unrelated identity could not claim")
		}
		if err := m.ReleaseCheckoutAttempt(sess, itemID, token); err != nil {
			t.Fatal(err)
		}
		var remaining int
		if err := db.QueryRow(`SELECT COUNT(*) FROM checkout_payment_attempts WHERE vinted_user_id = $1 AND item_id = $2`, otherAccount, itemID).Scan(&remaining); err != nil || remaining != 1 {
			t.Fatal("release removed another identity's claim")
		}
	})

	t.Run("anything past the first checkpoint is never released", func(t *testing.T) {
		checkoutURL := "https://www.vinted.de/checkout?purchase_id=synthetic"
		for index, checkpoint := range []CheckoutLink{
			{Status: "transaction_creating", TransactionID: 77},
			{Status: "transaction_creating", CheckoutURL: checkoutURL},
			{Status: "payment_authorization_reserved", TransactionID: 77},
			{Status: "checkout_building", TransactionID: 77},
			{Status: "checkout_building"},
			{Status: "checkout_updating", TransactionID: 77, CheckoutURL: checkoutURL},
			{Status: "checkout_selecting_preferences", TransactionID: 77, CheckoutURL: checkoutURL},
			{Status: "checkout_prepared", TransactionID: 77, CheckoutURL: checkoutURL},
			{Status: "checkout_review_required", TransactionID: 77, CheckoutURL: checkoutURL},
			{Status: "payment_ready", TransactionID: 77, CheckoutURL: checkoutURL},
			{Status: "payment_starting", TransactionID: 77, CheckoutURL: checkoutURL},
			{Status: "payment_starting"},
			{Status: "payment_outcome_unknown", TransactionID: 77, CheckoutURL: checkoutURL},
			{Status: "payment_outcome_unknown"},
			{Status: "card_payment_confirmed", TransactionID: 77, CheckoutURL: checkoutURL},
			{Status: "card_payment_pending", TransactionID: 77, CheckoutURL: checkoutURL},
			{Status: "card_payment_failed", TransactionID: 77, CheckoutURL: checkoutURL},
			{Status: "card_authentication_required", TransactionID: 77, CheckoutURL: checkoutURL},
			{Status: "paypal_redirect_ready", TransactionID: 77, CheckoutURL: checkoutURL},
			{Status: ""},
		} {
			itemID := int64(1200 + index)
			checkpoint.SellerID = 456
			token := claim(itemID, &checkpoint)
			if err := m.ReleaseCheckoutAttempt(sess, itemID, token); err == nil {
				t.Fatalf("%+v: release reported success", checkpoint)
			}
			if owner, exists := durable(itemID); !exists || owner != token || !marker(itemID) {
				t.Fatalf("%+v: claim was released", checkpoint)
			}
			cached, err := m.GetCheckoutPreparation(sess, itemID)
			if err != nil || cached == nil || cached.Status != checkpoint.Status || cached.TransactionID != checkpoint.TransactionID || cached.CheckoutURL != checkpoint.CheckoutURL {
				t.Fatalf("%+v: stored outcome changed: %#v %v", checkpoint, cached, err)
			}
			if err := m.ReleaseCheckoutPreparation(sess, itemID, token); err != nil {
				t.Fatal(err)
			}
			if reserved, err := m.ReserveAutoCheckout(sess, itemID, "second-request"); err != nil || reserved {
				t.Fatalf("%+v: item could be claimed again", checkpoint)
			}
		}
	})

	t.Run("unreadable durable state is never released", func(t *testing.T) {
		const itemID = 1300
		token := claim(itemID, nil)
		if _, err := db.Exec(`UPDATE checkout_payment_attempts SET result_ciphertext = 'synthetic-unreadable' WHERE vinted_user_id = $1 AND item_id = $2`, account, itemID); err != nil {
			t.Fatal(err)
		}
		if err := m.ReleaseCheckoutAttempt(sess, itemID, token); err == nil {
			t.Fatal("release reported success for unreadable state")
		}
		if _, exists := durable(itemID); !exists || !marker(itemID) {
			t.Fatal("claim with unreadable state was released")
		}
	})

	t.Run("release survives Redis loss without widening", func(t *testing.T) {
		const first, later = 1400, 1401
		firstToken := claim(first, &CheckoutLink{SellerID: 456, Status: "transaction_creating"})
		laterToken := claim(later, &CheckoutLink{SellerID: 456, Status: "payment_starting", TransactionID: 77})
		if err := m.redis.FlushDB(m.ctx).Err(); err != nil {
			t.Fatal(err)
		}
		if err := m.ReleaseCheckoutAttempt(sess, first, firstToken); err != nil {
			t.Fatal(err)
		}
		if _, exists := durable(first); exists {
			t.Fatal("first-step claim was not released after cache loss")
		}
		if err := m.ReleaseCheckoutAttempt(sess, later, laterToken); err == nil {
			t.Fatal("payment-stage claim released after cache loss")
		}
		if _, exists := durable(later); !exists {
			t.Fatal("payment-stage claim was deleted")
		}
		if reserved, err := m.ReserveAutoCheckout(sess, later, "second-request"); err != nil || reserved {
			t.Fatal("payment-stage claim became available after cache loss")
		}
	})
}
