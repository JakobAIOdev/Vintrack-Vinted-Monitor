package database

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"testing"
	"time"
)

func TestFreeProxyHandshakeFailureNeedsCorroborationBeforeGlobalQuarantine(t *testing.T) {
	databaseURL := os.Getenv("FREE_PROXY_STORE_INTEGRATION_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("FREE_PROXY_STORE_INTEGRATION_DATABASE_URL is not set")
	}
	db, err := sql.Open("postgres", databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	store := &Store{db: db}
	for index, tc := range []struct {
		name        string
		code        string
		status      int
		freshOther  bool
		failedOther bool
		otherCode   string
		wantGlobal  bool
	}{
		{name: "regional SOCKS error with fresh successful traffic", code: "proxy_handshake", freshOther: true},
		{name: "first SOCKS error without corroboration", code: "proxy_handshake"},
		{name: "corroborated SOCKS errors", code: "proxy_handshake", failedOther: true, otherCode: "proxy_handshake", wantGlobal: true},
		{name: "mixed corroborated transport errors", code: "proxy_handshake", failedOther: true, otherCode: "timeout", wantGlobal: true},
		{name: "fresh success outweighs two regional failures", code: "proxy_handshake", freshOther: true, failedOther: true, otherCode: "timeout"},
		{name: "explicit proxy authentication rejection", code: "proxy_handshake", status: 407, freshOther: true, wantGlobal: true},
		{name: "invalid proxy configuration", code: "invalid_config", freshOther: true, wantGlobal: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			proxyURL := fmt.Sprintf("socks5://198.18.11.10:%d", 18100+index)
			defer db.ExecContext(context.Background(), `DELETE FROM free_proxies WHERE proxy_url=$1`, proxyURL)
			if _, err := store.UpsertFreeProxiesContext(ctx, []FreeProxyRecord{{
				ProxyURL: proxyURL, Protocol: "socks5", Host: "198.18.11.10", Port: 18100 + index, Source: "test-transport",
			}}); err != nil {
				t.Fatal(err)
			}
			if _, err := db.ExecContext(ctx, `
				INSERT INTO free_proxy_health (proxy_id, region, status, success_streak, success_count,
					failure_streak, last_success_at, next_check_at, candidate_window_token)
				SELECT fp.id, r.region, 'active', 3, 3, 0, NOW(), NOW() + INTERVAL '10 minutes',
					FLOOR(EXTRACT(EPOCH FROM NOW()) / 3600)::bigint
				FROM free_proxies fp CROSS JOIN (VALUES ('sqlskerr'), ('sqlskgood'), ('sqlskbad')) r(region)
				WHERE fp.proxy_url=$1`, proxyURL); err != nil {
				t.Fatal(err)
			}
			if _, err := db.ExecContext(ctx, `UPDATE free_proxies SET status='active', success_count=9,
				last_success_at=NOW() WHERE proxy_url=$1`, proxyURL); err != nil {
				t.Fatal(err)
			}
			if !tc.freshOther {
				if _, err := db.ExecContext(ctx, `UPDATE free_proxy_health SET last_success_at=NOW()-INTERVAL '1 hour'
					WHERE proxy_id=(SELECT id FROM free_proxies WHERE proxy_url=$1) AND region<>'sqlskerr'`, proxyURL); err != nil {
					t.Fatal(err)
				}
			}
			if tc.failedOther {
				if _, err := db.ExecContext(ctx, `UPDATE free_proxy_health SET status='cooldown', success_streak=0,
					failure_streak=1, last_failure_at=NOW()-INTERVAL '1 minute', last_error_code=$2
					WHERE proxy_id=(SELECT id FROM free_proxies WHERE proxy_url=$1) AND region='sqlskbad'`, proxyURL, tc.otherCode); err != nil {
					t.Fatal(err)
				}
			}
			if err := store.RecordFreeProxyFailureStageContext(ctx, proxyURL, "sqlskerr", tc.status,
				"socks connect tcp: unknown error network unreachable", tc.code, "warmup", 3, 30); err != nil {
				t.Fatal(err)
			}
			var quarantined bool
			var status string
			var streak int
			if err := db.QueryRowContext(ctx, `SELECT COALESCE(fp.quarantined_until>NOW(),false), fph.status, fph.success_streak
				FROM free_proxies fp JOIN free_proxy_health fph ON fph.proxy_id=fp.id
				WHERE fp.proxy_url=$1 AND fph.region='sqlskerr'`, proxyURL).Scan(&quarantined, &status, &streak); err != nil {
				t.Fatal(err)
			}
			if quarantined != tc.wantGlobal {
				t.Fatalf("global quarantine=%v, want %v", quarantined, tc.wantGlobal)
			}
			if status != "cooldown" || streak != 0 {
				t.Fatalf("failed region=%s/streak %d, want cooldown/0", status, streak)
			}
			if tc.freshOther && !tc.wantGlobal {
				active, err := store.GetActiveFreeProxiesContext(ctx, "sqlskgood", 10)
				if err != nil || len(active) != 1 {
					t.Fatalf("healthy regional capacity=%d, err=%v, want 1", len(active), err)
				}
			}
		})
	}
}
