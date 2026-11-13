package session

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
)

// Requires an explicitly disposable database, never the application database.
func TestDurableCheckoutClaimsAndRecoveryAgainstPostgres(t *testing.T) {
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
	migration, err := os.ReadFile(filepath.Join("..", "..", "..", "control-center", "prisma", "migrations", "20261019190000_durable_checkout_payment_attempts", "migration.sql"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(string(migration)); err != nil {
		t.Fatal(err)
	}
	defer db.Exec(`DROP TABLE checkout_payment_attempts`)
	cipher, err := newTokenCipher("synthetic-test-encryption-key")
	if err != nil {
		t.Fatal(err)
	}
	m := checkoutTestManager(t)
	m.store = &persistentStore{db: db, cipher: cipher}
	if err := m.redis.Set(m.ctx, "vinted:auto-checkout-attempt:legacy-member:42:www.vinted.de:122", "synthetic", 0).Err(); err != nil {
		t.Fatal(err)
	}
	if err := m.migrateCheckoutPaymentClaims(); err != nil {
		t.Fatal(err)
	}
	sess := &VintedSession{UserID: "synthetic-member", VintedUserID: 42, Domain: "www.vinted.de", LinkedAt: "first"}
	if !m.DurableCheckoutAvailable() {
		t.Fatal("migrated durable storage is unavailable")
	}
	// Independent members and regions sharing the same Vinted identity still
	// compete for one claim. This also exercises concurrent PostgreSQL inserts.
	var won atomic.Int32
	var wg sync.WaitGroup
	for index := range 8 {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			other := *sess
			other.UserID = fmt.Sprintf("synthetic-member-%d", index)
			if index%2 == 1 {
				other.Domain = "www.vinted.fr"
			}
			if acquired, err := m.ReserveAutoCheckout(&other, 123, fmt.Sprintf("owner-%d", index)); err != nil {
				t.Error(err)
			} else if acquired {
				won.Add(1)
			}
		}(index)
	}
	wg.Wait()
	if won.Load() != 1 {
		t.Fatalf("payment claim owners = %d, want 1", won.Load())
	}
	if err := m.redis.FlushDB(m.ctx).Err(); err != nil {
		t.Fatal(err)
	}
	if acquired, err := m.ReserveAutoCheckout(sess, 122, "legacy-replay"); err != nil || acquired {
		t.Fatal("legacy payment claim was lost during migration")
	}
	sess.LinkedAt = "relinked"
	if acquired, err := m.ReserveAutoCheckout(sess, 123, "new-owner"); err != nil || acquired {
		t.Fatal("Redis loss and relinking allowed duplicate payment")
	}
	if acquired, err := m.ReserveAutoCheckout(sess, 124, "result-owner"); err != nil || !acquired {
		t.Fatal("different item could not be claimed")
	}
	link := CheckoutLink{ItemID: 124, SellerID: 456, Domain: sess.Domain, Status: "card_payment_confirmed", CheckoutURL: "https://www.vinted.de/checkout?purchase_id=synthetic-private-state", PaymentURL: "https://www.paypal.com/checkoutnow?token=never-persist", PreferencesKey: "home:card:auto:2:EUR:3000"}
	if err := m.SaveAutoCheckoutResult(sess, "wrong-owner", link); err == nil {
		t.Fatal("another owner overwrote a payment checkpoint")
	}
	if err := m.SaveAutoCheckoutResult(sess, "result-owner", link); err != nil {
		t.Fatal(err)
	}
	stale := link
	stale.Status = "payment_starting"
	data, _ := json.Marshal(stale)
	if err := m.redis.Set(m.ctx, checkoutPreparationKey(sess, 124), data, CheckoutPreparationTTL).Err(); err != nil {
		t.Fatal(err)
	}
	if result, err := m.GetCheckoutPreparation(sess, 124); err != nil || result == nil || result.Status != "card_payment_confirmed" {
		t.Fatal("stale Redis checkpoint hid the confirmed durable payment")
	}
	var encrypted string
	if err := db.QueryRow(`SELECT result_ciphertext FROM checkout_payment_attempts WHERE item_id=124`).Scan(&encrypted); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(encrypted, "synthetic-private-state") || strings.Contains(encrypted, "never-persist") {
		t.Fatal("plaintext checkout state persisted")
	}
	plain, err := cipher.Decrypt(encrypted)
	if err != nil || strings.Contains(plain, "never-persist") {
		t.Fatal("payment redirect persisted")
	}
	if err := m.redis.FlushDB(m.ctx).Err(); err != nil {
		t.Fatal(err)
	}
	recovered, err := m.GetCheckoutPreparation(sess, 124)
	if err != nil || recovered == nil || recovered.Status != "card_payment_confirmed" || recovered.PaymentURL != "" {
		t.Fatal("payment outcome was lost after cache loss")
	}
	if _, err := db.Exec(`CREATE TABLE "User" (
		id TEXT PRIMARY KEY, role TEXT, checkout_enabled BOOLEAN,
		checkout_risk_version INTEGER, checkout_risk_accepted_at TIMESTAMP,
		checkout_preferences JSONB);
		CREATE TABLE feature_policies (feature TEXT PRIMARY KEY, enabled BOOLEAN,
		free_enabled BOOLEAN, premium_enabled BOOLEAN, admin_enabled BOOLEAN);
		INSERT INTO feature_policies VALUES ('checkout_links',true,true,true,true), ('vinted_account',true,true,true,true);
		INSERT INTO "User" VALUES ('synthetic-member','premium',true,1,NOW(),
		'{"accountId":42,"domain":"www.vinted.de","transport":"server","preferences":{"shipping":"home","payment":"card","autoCheckout":{"warningVersion":2,"currency":"EUR","maxTotalMinor":3000}}}');`); err != nil {
		t.Fatal(err)
	}
	defer db.Exec(`DROP TABLE "User", feature_policies`)
	if _, err := db.Exec(`ALTER TABLE "User" ADD COLUMN banned_at TIMESTAMP`); err != nil {
		t.Fatal(err)
	}
	preferences := []byte(`{"shipping":"home","payment":"card","autoCheckout":{"warningVersion":2,"currency":"EUR","maxTotalMinor":3000}}`)
	if allowed, err := m.CheckoutPaymentAuthorized(sess, preferences, "server"); err != nil || !allowed {
		t.Fatal("matching saved consent was not authorized")
	}
	if allowed, err := m.CheckoutPaymentAuthorized(sess, preferences, "browser"); err != nil || allowed {
		t.Fatal("a different transport reused payment consent")
	}
	for _, mutation := range []string{
		`UPDATE "User" SET checkout_enabled=false`,
		`UPDATE "User" SET checkout_risk_accepted_at=NULL`,
		`UPDATE "User" SET checkout_preferences=jsonb_set(checkout_preferences,'{preferences,autoCheckout,maxTotalMinor}','1000')`,
		`UPDATE "User" SET checkout_preferences=jsonb_set(checkout_preferences,'{accountId}','99')`,
		`UPDATE feature_policies SET premium_enabled=false WHERE feature='checkout_links'`,
	} {
		tx, err := db.Begin()
		if err != nil {
			t.Fatal(err)
		}
		// Use committed changes because authorization uses the pool, just as a
		// concurrent member/admin settings update does in the real service.
		if _, err := tx.Exec(mutation); err != nil {
			_ = tx.Rollback()
			t.Fatal(err)
		}
		if err := tx.Commit(); err != nil {
			t.Fatal(err)
		}
		if allowed, err := m.CheckoutPaymentAuthorized(sess, preferences, "server"); err != nil || allowed {
			t.Fatal("changed consent/settings allowed payment")
		}
		if _, err := db.Exec(`UPDATE "User" SET checkout_enabled=true, checkout_risk_accepted_at=NOW(),
			checkout_preferences='{"accountId":42,"domain":"www.vinted.de","transport":"server","preferences":{"shipping":"home","payment":"card","autoCheckout":{"warningVersion":2,"currency":"EUR","maxTotalMinor":3000}}}';
			UPDATE feature_policies SET premium_enabled=true;`); err != nil {
			t.Fatal(err)
		}
	}
	other := *sess
	other.VintedUserID++
	if acquired, err := m.ReserveAutoCheckout(&other, 124, "other-account-owner"); err != nil || !acquired {
		t.Fatal("unrelated Vinted identity was blocked")
	}
	if _, err := db.Exec(`DROP TABLE checkout_payment_attempts`); err != nil {
		t.Fatal(err)
	}
	if acquired, err := m.ReserveAutoCheckout(sess, 125, "database-failure-owner"); err == nil || acquired {
		t.Fatal("missing payment storage did not fail closed")
	}
}
