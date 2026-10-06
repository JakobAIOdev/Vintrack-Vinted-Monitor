package session

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"testing"
	"time"
)

func TestCheckoutModuleAccessAgainstPostgres(t *testing.T) {
	databaseURL := os.Getenv("CHECKOUT_MODULE_INTEGRATION_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("CHECKOUT_MODULE_INTEGRATION_DATABASE_URL is not set")
	}
	db, err := sql.Open("postgres", databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	userID := fmt.Sprintf("checkout-module-test-%d", time.Now().UnixNano())
	if _, err := db.ExecContext(ctx, `INSERT INTO "User" (id, role, checkout_risk_version, checkout_risk_accepted_at) VALUES ($1, 'admin', 1, NOW())`, userID); err != nil {
		t.Fatal(err)
	}
	defer db.Exec(`DELETE FROM "User" WHERE id = $1`, userID)
	store := &persistentStore{db: db}
	accepted, err := store.CheckoutConsentAccepted(ctx, userID)
	if err != nil || !accepted {
		t.Fatalf("synthetic risk consent: accepted=%v err=%v", accepted, err)
	}
	access, err := store.FeatureAccess(ctx, userID, "checkout_links")
	if err != nil {
		t.Fatal(err)
	}
	if access.Allowed {
		t.Fatal("default-off account permitted checkout despite accepted risk warning")
	}
	if access.Reason != "user_disabled" {
		t.Skip("administrator policy already denies checkout")
	}
	for _, enabled := range []bool{true, false, true, false} {
		if _, err := db.ExecContext(ctx, `UPDATE "User" SET checkout_enabled = $2 WHERE id = $1`, userID, enabled); err != nil {
			t.Fatal(err)
		}
		access, err := store.FeatureAccess(ctx, userID, "checkout_links")
		if err != nil {
			t.Fatal(err)
		}
		if access.Allowed != enabled {
			t.Fatalf("switch %v: access=%+v", enabled, access)
		}
		if !enabled && access.Reason != "user_disabled" {
			t.Fatalf("wrong denial: %+v", access)
		}
		parent, err := store.FeatureAccess(ctx, userID, "vinted_account")
		if err != nil || !parent.Allowed {
			t.Fatalf("module switch changed linked-account access: %+v %v", parent, err)
		}
	}
}
