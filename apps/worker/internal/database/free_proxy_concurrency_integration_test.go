package database

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"os"
	"testing"
	"time"

	"github.com/lib/pq"
)

// Use an isolated schema rather than temporary tables so two sessions can
// exercise real row contention without touching application data.
func freeProxyConcurrentTestStore(t *testing.T) *Store {
	t.Helper()
	databaseURL := os.Getenv("FREE_PROXY_STORE_INTEGRATION_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("FREE_PROXY_STORE_INTEGRATION_DATABASE_URL is not set")
	}
	parsed, err := url.Parse(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	schema := fmt.Sprintf("proxy_concurrency_%d", time.Now().UnixNano())
	admin, err := sql.Open("postgres", databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { admin.Close() })
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := admin.ExecContext(ctx, `CREATE SCHEMA `+pq.QuoteIdentifier(schema)); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if _, err := admin.ExecContext(cleanupCtx, `DROP SCHEMA `+pq.QuoteIdentifier(schema)+` CASCADE`); err != nil {
			t.Errorf("drop isolated schema: %v", err)
		}
	})
	query := parsed.Query()
	query.Set("search_path", schema)
	parsed.RawQuery = query.Encode()
	db, err := sql.Open("postgres", parsed.String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	db.SetMaxOpenConns(2)
	if _, err := db.ExecContext(ctx, `
		CREATE TABLE free_proxies (
			id SERIAL PRIMARY KEY, proxy_url TEXT UNIQUE NOT NULL,
			status TEXT NOT NULL DEFAULT 'active', quarantined_until TIMESTAMP,
			check_claimed_until TIMESTAMP, last_checked_at TIMESTAMP,
			last_success_at TIMESTAMP, last_error TEXT, last_error_code TEXT,
			last_error_stage TEXT, updated_at TIMESTAMP DEFAULT NOW()
		);
		CREATE TABLE free_proxy_health (
			id SERIAL PRIMARY KEY, proxy_id INTEGER REFERENCES free_proxies(id),
			region TEXT, status TEXT DEFAULT 'active', success_streak INTEGER DEFAULT 2,
			failure_streak INTEGER DEFAULT 0, score INTEGER DEFAULT 70,
			latency_ms INTEGER, last_status_code INTEGER, last_checked_at TIMESTAMP,
			last_success_at TIMESTAMP DEFAULT NOW(), next_check_at TIMESTAMP,
			last_error TEXT, last_error_code TEXT, last_error_stage TEXT,
			updated_at TIMESTAMP DEFAULT NOW()
		);
		INSERT INTO free_proxies (proxy_url) VALUES ('http://contended.invalid:80');
		INSERT INTO free_proxy_health (proxy_id, region) SELECT id, 'uk' FROM free_proxies;`); err != nil {
		t.Fatal(err)
	}
	return &Store{db: db}
}

func TestFreeProxyBackgroundWritesSkipLockedRows(t *testing.T) {
	for _, operation := range []string{"canary", "runtime"} {
		for _, lockedTable := range []string{"free_proxies", "free_proxy_health"} {
			if operation == "canary" && lockedTable == "free_proxy_health" {
				continue // The canary reserves the global proxy, not regional health.
			}
			t.Run(operation+"/"+lockedTable, func(t *testing.T) {
				store := freeProxyConcurrentTestStore(t)
				ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				tx, err := store.db.BeginTx(ctx, nil)
				if err != nil {
					t.Fatal(err)
				}
				defer tx.Rollback()
				if _, err := tx.ExecContext(ctx, `SELECT id FROM `+pq.QuoteIdentifier(lockedTable)+` FOR UPDATE`); err != nil {
					t.Fatal(err)
				}
				tryCtx, cancelTry := context.WithTimeout(ctx, 500*time.Millisecond)
				defer cancelTry()
				const proxyURL = "http://contended.invalid:80"
				if operation == "canary" {
					_, claimed, err := store.TryClaimActiveFreeProxyForCanaryContext(tryCtx, proxyURL, "uk", time.Minute)
					if err != nil || claimed {
						t.Fatalf("contended canary claim = %t, %v; want skipped without timeout", claimed, err)
					}
				} else if err := store.TouchFreeProxyRuntimeSuccessContext(tryCtx, proxyURL, "uk", 123); err != nil {
					t.Fatalf("contended sampled runtime write must skip without timeout: %v", err)
				}
				if err := tx.Rollback(); err != nil {
					t.Fatal(err)
				}
				if operation == "canary" {
					until, claimed, err := store.TryClaimActiveFreeProxyForCanaryContext(ctx, proxyURL, "uk", time.Minute)
					if err != nil || !claimed {
						t.Fatalf("unlocked proxy not claimable: %t, %v", claimed, err)
					}
					if _, duplicate, err := store.TryClaimActiveFreeProxyForCanaryContext(ctx, proxyURL, "uk", time.Minute); err != nil || duplicate {
						t.Fatalf("duplicate claim = %t, %v", duplicate, err)
					}
					if err := store.ReleaseFreeProxyCanaryClaimContext(ctx, proxyURL, until); err != nil {
						t.Fatal(err)
					}
				} else {
					if err := store.TouchFreeProxyRuntimeSuccessContext(ctx, proxyURL, "uk", 123); err != nil {
						t.Fatal(err)
					}
					var latency int
					if err := store.db.QueryRowContext(ctx, `SELECT latency_ms FROM free_proxy_health`).Scan(&latency); err != nil || latency != 123 {
						t.Fatalf("unlocked runtime write: latency=%d err=%v", latency, err)
					}
				}
			})
		}
	}
}
