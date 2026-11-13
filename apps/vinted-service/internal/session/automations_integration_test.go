package session

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"os"
	"sync"
	"testing"
	"time"
)

// Always runs in a temporary schema on an explicitly supplied test database.
func automationTestManager(t *testing.T) *Manager {
	t.Helper()
	dsn := os.Getenv("AUTOMATION_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("AUTOMATION_TEST_DATABASE_URL is not set")
	}
	admin, err := sql.Open("postgres", dsn)
	if err != nil {
		t.Fatal(err)
	}
	schema := fmt.Sprintf("automation_test_%d", time.Now().UnixNano())
	if _, err = admin.Exec(`CREATE SCHEMA ` + schema); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { admin.Exec(`DROP SCHEMA ` + schema + ` CASCADE`); admin.Close() })
	parsed, err := url.Parse(dsn)
	if err != nil {
		t.Fatal(err)
	}
	query := parsed.Query()
	query.Set("search_path", schema)
	parsed.RawQuery = query.Encode()
	db, err := sql.Open("postgres", parsed.String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	fixture := `
 CREATE TABLE "User" (id TEXT PRIMARY KEY, role TEXT DEFAULT 'admin', banned_at TIMESTAMP, checkout_enabled BOOLEAN DEFAULT false);
 CREATE TABLE feature_policies(feature TEXT PRIMARY KEY, enabled BOOLEAN, free_enabled BOOLEAN, premium_enabled BOOLEAN, admin_enabled BOOLEAN, revision INTEGER, updated_at TIMESTAMP);
 CREATE TABLE monitors (id INTEGER PRIMARY KEY, "userId" TEXT, name TEXT, region TEXT, status TEXT);
 CREATE TABLE items (id BIGINT, monitor_id INTEGER, title TEXT, price TEXT, seller_id BIGINT, seller_login TEXT, url TEXT, found_at TIMESTAMP, PRIMARY KEY(id,monitor_id));
 CREATE TABLE monitor_item_detections (monitor_id INTEGER,item_id BIGINT,created_at TIMESTAMP);
 CREATE TABLE vinted_sessions (user_id TEXT,vinted_user_id BIGINT,domain TEXT,status TEXT);
 CREATE TABLE seller_bans ("userId" TEXT,seller_id BIGINT);`
	if _, err = db.Exec(fixture); err != nil {
		t.Fatal(err)
	}
	migration, err := os.ReadFile("../../../control-center/prisma/migrations/20261011120000_add_account_automations/migration.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(string(migration)); err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`
 INSERT INTO "User" (id) VALUES ('synthetic-member');
 INSERT INTO monitors VALUES(1,'synthetic-member','Jackets','de','active'),(2,'synthetic-member','Coats','de','active');
 INSERT INTO vinted_sessions VALUES('synthetic-member',100,'www.vinted.de','active');
 INSERT INTO monitor_account_automations (monitor_id,kind,account_id,domain,enabled_at,enabled) VALUES(1,'offer',100,'www.vinted.de',NOW()-INTERVAL '10 seconds',true),(2,'offer',100,'www.vinted.de',NOW()-INTERVAL '10 seconds',true);
 INSERT INTO items VALUES(200,1,'Jacket','25.00 EUR',300,'seller','https://example.invalid',NOW()),(200,2,'Jacket','25.00 EUR',300,'seller','https://example.invalid',NOW());
 INSERT INTO monitor_item_detections VALUES(1,200,NOW()),(2,200,NOW());`)
	if err != nil {
		t.Fatal(err)
	}
	return &Manager{store: &persistentStore{db: db}, ctx: context.Background()}
}

func TestAutomationCandidatesOnlyUseEligibleNewMatches(t *testing.T) {
	m := automationTestManager(t)
	ctx := context.Background()
	candidates, err := m.AutomationCandidates(ctx)
	if err != nil || len(candidates) != 2 {
		t.Fatalf("candidates=%d err=%v", len(candidates), err)
	}
	for _, mutation := range []string{
		`UPDATE monitor_account_automations SET enabled=false`,
		`UPDATE monitors SET status='paused'`,
		`UPDATE vinted_sessions SET vinted_user_id=999`,
		`UPDATE vinted_sessions SET domain='www.vinted.fr'`,
		`UPDATE vinted_sessions SET status='needs_browser_sync'`,
		`UPDATE items SET found_at=NOW()-INTERVAL '3 minutes'`,
		`UPDATE monitor_account_automations SET enabled_at=NOW()+INTERVAL '1 minute'`,
		`INSERT INTO seller_bans VALUES('synthetic-member',300)`,
		`UPDATE items SET seller_id=100`,
		`DELETE FROM monitor_item_detections`,
	} {
		other := automationTestManager(t)
		if _, err = other.store.db.Exec(mutation); err != nil {
			t.Fatal(err)
		}
		got, err := other.AutomationCandidates(ctx)
		if err != nil || len(got) != 0 {
			t.Fatalf("%s: candidates=%d err=%v", mutation, len(got), err)
		}
	}
}

func TestAutomationClaimsDeduplicateAcrossMonitorsAndReplicas(t *testing.T) {
	m := automationTestManager(t)
	ctx := context.Background()
	candidates, err := m.AutomationCandidates(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	ids := make(chan int64, 12)
	errs := make(chan error, 12)
	for n := 0; n < 12; n++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			id, err := m.ClaimAutomation(ctx, candidates[n%2])
			ids <- id
			errs <- err
		}(n)
	}
	wg.Wait()
	close(ids)
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	var claimed int
	var id int64
	for value := range ids {
		if value > 0 {
			claimed++
			id = value
		}
	}
	if claimed != 1 {
		t.Fatalf("claimed %d times", claimed)
	}
	if err = m.FinishAutomation(ctx, id, "uncertain", "upstream_outcome_unverified"); err != nil {
		t.Fatal(err)
	}
	m.store.db.Exec(`UPDATE account_automation_attempts SET created_at=NOW()-INTERVAL '1 day', completed_at=NOW()-INTERVAL '1 day'`)
	if id, err = m.ClaimAutomation(ctx, candidates[1]); err != nil || id != 0 {
		t.Fatalf("uncertain replay id=%d err=%v", id, err)
	}
}

func TestAutomationClaimsEnforceCooldownAndDailyBudget(t *testing.T) {
	for _, tc := range []struct {
		name    string
		fixture string
		allowed bool
	}{
		{
			name:    "recent action blocks both modules",
			fixture: `INSERT INTO account_automation_attempts(user_id,account_id,domain,item_id,monitor_id,kind,status,created_at,completed_at) VALUES('synthetic-member',100,'www.vinted.de',999,1,'message','sent',NOW()-INTERVAL '10 seconds',NOW())`,
		},
		{
			name:    "six seconds after completion allows another action",
			fixture: `INSERT INTO account_automation_attempts(user_id,account_id,domain,item_id,monitor_id,kind,status,created_at,completed_at) VALUES('synthetic-member',100,'www.vinted.de',999,1,'message','sent',NOW()-INTERVAL '10 seconds',NOW()-INTERVAL '6 seconds')`,
			allowed: true,
		},
		{
			name:    "unverified outcome still pauses the account",
			fixture: `INSERT INTO account_automation_attempts(user_id,account_id,domain,item_id,monitor_id,kind,status,created_at) VALUES('synthetic-member',100,'www.vinted.de',999,1,'message','uncertain',NOW()-INTERVAL '2 minutes')`,
		},
		{
			name:    "499 attempts permits the 500th",
			fixture: `INSERT INTO account_automation_attempts(user_id,account_id,domain,item_id,monitor_id,kind,status,created_at,completed_at) SELECT 'synthetic-member',100,'www.vinted.de',1000+n,1,'offer','sent',date_trunc('day',NOW() AT TIME ZONE 'UTC'),NOW()-INTERVAL '1 minute' FROM generate_series(1,499)n`,
			allowed: true,
		},
		{
			name:    "500 attempts blocks the 501st",
			fixture: `INSERT INTO account_automation_attempts(user_id,account_id,domain,item_id,monitor_id,kind,status,created_at,completed_at) SELECT 'synthetic-member',100,'www.vinted.de',1000+n,1,'offer','sent',date_trunc('day',NOW() AT TIME ZONE 'UTC'),NOW()-INTERVAL '1 minute' FROM generate_series(1,500)n`,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m := automationTestManager(t)
			ctx := context.Background()
			candidates, err := m.AutomationCandidates(ctx)
			if err != nil || len(candidates) != 2 {
				t.Fatalf("initial candidates=%d err=%v", len(candidates), err)
			}
			if _, err = m.store.db.Exec(tc.fixture); err != nil {
				t.Fatal(err)
			}
			eligible, err := m.AutomationCandidates(ctx)
			if err != nil || (len(eligible) > 0) != tc.allowed {
				t.Fatalf("eligible=%d allowed=%v err=%v", len(eligible), tc.allowed, err)
			}
			if id, err := m.ClaimAutomation(ctx, candidates[0]); err != nil || (id > 0) != tc.allowed {
				t.Fatalf("claim id=%d allowed=%v err=%v", id, tc.allowed, err)
			}
		})
	}
}

func TestAutomationClaimRejectsChangedSettingsAndRecoveryNeverReplays(t *testing.T) {
	m := automationTestManager(t)
	ctx := context.Background()
	candidates, err := m.AutomationCandidates(ctx)
	if err != nil {
		t.Fatal(err)
	}
	m.store.db.Exec(`UPDATE monitor_account_automations SET revision=revision+1`)
	if id, err := m.ClaimAutomation(ctx, candidates[0]); err != nil || id != 0 {
		t.Fatalf("stale settings claim=%d err=%v", id, err)
	}
	candidates, err = m.AutomationCandidates(ctx)
	if err != nil {
		t.Fatal(err)
	}
	id, err := m.ClaimAutomation(ctx, candidates[0])
	if err != nil || id == 0 {
		t.Fatalf("claim=%d err=%v", id, err)
	}
	m.store.db.Exec(`UPDATE account_automation_attempts SET created_at=NOW()-INTERVAL '6 minutes'`)
	if err = m.ExpireAutomationClaims(ctx); err != nil {
		t.Fatal(err)
	}
	var status string
	m.store.db.QueryRow(`SELECT status FROM account_automation_attempts WHERE id=$1`, id).Scan(&status)
	if status != "uncertain" {
		t.Fatalf("recovered status=%s", status)
	}
	if id, err = m.ClaimAutomation(ctx, candidates[0]); err != nil || id != 0 {
		t.Fatalf("interrupted replay id=%d err=%v", id, err)
	}
}

func TestAutomaticFeaturePoliciesRequireManualAndAccountAccess(t *testing.T) {
	m := automationTestManager(t)
	ctx := context.Background()
	_, err := m.store.db.Exec(`INSERT INTO feature_policies(feature,enabled,free_enabled,premium_enabled,admin_enabled) VALUES ('vinted_account',true,true,true,true),('offers',true,true,true,true),('chats',true,true,true,true)`)
	if err != nil {
		t.Fatal(err)
	}
	for _, feature := range []string{"auto_offers", "auto_messages"} {
		access, err := m.FeatureAccess("synthetic-member", feature)
		if err != nil || !access.Allowed {
			t.Fatalf("%s: %+v %v", feature, access, err)
		}
		parent := "offers"
		if feature == "auto_messages" {
			parent = "chats"
		}
		if _, err = m.store.db.Exec(`UPDATE feature_policies SET enabled=false WHERE feature=$1`, parent); err != nil {
			t.Fatal(err)
		}
		access, err = m.FeatureAccess("synthetic-member", feature)
		if err != nil || access.Allowed || access.Dependency != parent {
			t.Fatalf("parent %s: %+v %v", parent, access, err)
		}
		m.store.db.Exec(`UPDATE feature_policies SET enabled=true WHERE feature=$1`, parent)
	}
	m.store.db.Exec(`UPDATE feature_policies SET enabled=false WHERE feature='auto_offers'`)
	if access, err := m.FeatureAccess("synthetic-member", "offers"); err != nil || !access.Allowed {
		t.Fatalf("manual offers unexpectedly denied: %+v %v", access, err)
	}
	candidates, err := m.AutomationCandidates(ctx)
	if err != nil || len(candidates) == 0 {
		t.Fatal(err)
	}
	ready, err := m.AutomationStillEnabled(ctx, candidates[0])
	if err != nil || !ready {
		t.Fatalf("ready=%v err=%v", ready, err)
	}
	m.store.db.Exec(`UPDATE monitor_account_automations SET enabled=false`)
	ready, err = m.AutomationStillEnabled(ctx, candidates[0])
	if err != nil || ready {
		t.Fatalf("disabled after warmup ready=%v err=%v", ready, err)
	}
}

func TestSessionIdentityChangesDisarmModulesBeforeRelinking(t *testing.T) {
	for _, mutation := range []string{`UPDATE vinted_sessions SET vinted_user_id=999`, `UPDATE vinted_sessions SET domain='www.vinted.fr'`, `DELETE FROM vinted_sessions`} {
		m := automationTestManager(t)
		if _, err := m.store.db.Exec(mutation); err != nil {
			t.Fatal(err)
		}
		var enabled int
		if err := m.store.db.QueryRow(`SELECT COUNT(*) FROM monitor_account_automations WHERE enabled`).Scan(&enabled); err != nil || enabled != 0 {
			t.Fatalf("%s: enabled=%d err=%v", mutation, enabled, err)
		}
	}
}

func TestThrottledAccountDoesNotCrowdOutOtherMembers(t *testing.T) {
	m := automationTestManager(t)
	_, err := m.store.db.Exec(`
 INSERT INTO account_automation_attempts(user_id,account_id,domain,item_id,monitor_id,kind,status) VALUES('synthetic-member',100,'www.vinted.de',999,1,'message','sending');
 INSERT INTO "User"(id) VALUES('other-member');
 INSERT INTO monitors VALUES(3,'other-member','Coats','de','active');
 INSERT INTO vinted_sessions VALUES('other-member',400,'www.vinted.de','active');
 INSERT INTO monitor_account_automations (monitor_id,kind,account_id,domain,enabled_at,enabled) VALUES(3,'message',400,'www.vinted.de',NOW()-INTERVAL '10 seconds',true);
 INSERT INTO items VALUES(500,3,'Jacket','25.00 EUR',300,'seller','https://example.invalid',NOW());
 INSERT INTO monitor_item_detections VALUES(3,500,NOW());`)
	if err != nil {
		t.Fatal(err)
	}
	candidates, err := m.AutomationCandidates(context.Background())
	if err != nil || len(candidates) != 1 || candidates[0].UserID != "other-member" {
		t.Fatalf("candidates=%+v err=%v", candidates, err)
	}
}

func TestBannedMemberCannotClaimAutomation(t *testing.T) {
	m := automationTestManager(t)
	candidates, err := m.AutomationCandidates(m.ctx)
	if err != nil || len(candidates) == 0 {
		t.Fatalf("candidates: %v, %v", candidates, err)
	}
	if _, err := m.store.db.Exec(`UPDATE "User" SET banned_at = NOW() WHERE id = 'synthetic-member'`); err != nil {
		t.Fatal(err)
	}
	allowed, err := m.UserAllowed("synthetic-member")
	if err != nil || allowed {
		t.Fatalf("banned member allowed: %v, %v", allowed, err)
	}
	remaining, err := m.AutomationCandidates(m.ctx)
	if err != nil || len(remaining) != 0 {
		t.Fatalf("banned candidates: %v, %v", remaining, err)
	}
	id, err := m.ClaimAutomation(m.ctx, candidates[0])
	if err != nil || id != 0 {
		t.Fatalf("claimed stale candidate: %v, %v", id, err)
	}
	if _, err := m.store.db.Exec(`UPDATE "User" SET banned_at = NULL WHERE id = 'synthetic-member'`); err != nil {
		t.Fatal(err)
	}
	allowed, err = m.UserAllowed("synthetic-member")
	if err != nil || !allowed {
		t.Fatalf("unbanned member denied: %v, %v", allowed, err)
	}
}
