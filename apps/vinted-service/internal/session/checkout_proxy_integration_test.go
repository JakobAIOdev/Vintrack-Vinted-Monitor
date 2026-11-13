package session

import (
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"
)

func TestCheckoutProxyOwnershipAndSettingsAgainstPostgres(t *testing.T) {
	databaseURL := os.Getenv("CHECKOUT_PROXY_INTEGRATION_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("CHECKOUT_PROXY_INTEGRATION_DATABASE_URL is not set")
	}
	u, err := url.Parse(databaseURL)
	if err != nil || !strings.HasPrefix(u.Path, "/vintrack_checkout_test") {
		t.Fatal("requires a disposable checkout test database")
	}
	db, err := sql.Open("postgres", databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	member := fmt.Sprintf("checkout-proxy-test-%d", time.Now().UnixNano())
	foreign := member + "-foreign"
	for _, id := range []string{member, foreign} {
		if _, err := db.Exec(`INSERT INTO "User" (id, checkout_enabled) VALUES ($1, true)`, id); err != nil {
			t.Fatal(err)
		}
		defer db.Exec(`DELETE FROM "User" WHERE id=$1`, id)
	}
	var group int
	if err := db.QueryRow(`INSERT INTO proxy_groups ("userId", name, proxies) VALUES ($1, 'Synthetic checkout', 'http://synthetic:private@proxy.example.com:8080') RETURNING id`, member).Scan(&group); err != nil {
		t.Fatal(err)
	}
	m := checkoutTestManager(t)
	m.store = &persistentStore{db: db}
	sess := &VintedSession{UserID: member, VintedUserID: 42, Domain: "www.vinted.de"}
	settings := fmt.Sprintf(`{"accountId":42,"domain":"www.vinted.de","transport":"server","proxyGroupId":%d}`, group)
	for _, id := range []string{member, foreign} {
		if _, err := db.Exec(`UPDATE "User" SET checkout_preferences=$2::jsonb WHERE id=$1`, id, settings); err != nil {
			t.Fatal(err)
		}
	}
	proxy, err := m.CheckoutProxy(sess)
	if err != nil || proxy != "http://synthetic:private@proxy.example.com:8080" {
		t.Fatal("owned saved proxy unavailable")
	}
	other := *sess
	other.UserID = foreign
	if _, err := m.CheckoutProxy(&other); !errors.Is(err, ErrCheckoutProxyRequired) {
		t.Fatal("foreign proxy ownership was not enforced")
	}
	for _, change := range []func(*VintedSession){func(s *VintedSession) { s.VintedUserID = 43 }, func(s *VintedSession) { s.Domain = "www.vinted.fr" }} {
		changed := *sess
		change(&changed)
		if _, err := m.CheckoutProxy(&changed); !errors.Is(err, ErrCheckoutProxyRequired) {
			t.Fatal("proxy selection survived linked identity change")
		}
	}
	for _, query := range []string{
		`UPDATE "User" SET checkout_enabled=false WHERE id=$1`,
		`UPDATE "User" SET checkout_enabled=true, checkout_preferences=jsonb_set(checkout_preferences, '{transport}', '"browser"') WHERE id=$1`,
		`UPDATE "User" SET checkout_preferences=jsonb_set(checkout_preferences, '{transport}', '"server"') WHERE id=$1`,
	} {
		if _, err := db.Exec(query, member); err != nil {
			t.Fatal(err)
		}
		_, err := m.CheckoutProxy(sess)
		if strings.Contains(query, "'{transport}', '\"server\"'") {
			if err != nil {
				t.Fatal("request mode did not recover")
			}
		} else if !errors.Is(err, ErrCheckoutProxyRequired) {
			t.Fatal("disabled or browser checkout used a proxy")
		}
	}
	if _, err := db.Exec(`UPDATE proxy_groups SET bandwidth_limit_bytes=1, bandwidth_rx_bytes=1 WHERE id=$1`, group); err != nil {
		t.Fatal(err)
	}
	if _, err := m.CheckoutProxy(sess); !errors.Is(err, ErrCheckoutProxyRequired) {
		t.Fatal("exhausted proxy group accepted")
	}
	if _, err := db.Exec(`DELETE FROM proxy_groups WHERE id=$1`, group); err != nil {
		t.Fatal(err)
	}
	if _, err := m.CheckoutProxy(sess); !errors.Is(err, ErrCheckoutProxyRequired) {
		t.Fatal("deleted group silently fell back to server networking")
	}
}
