package database

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"
)

func TestCloseProxyIncidentsClosesOnlyListedMonitorsAgainstPostgres(t *testing.T) {
	databaseURL := os.Getenv("ALERT_OUTBOX_INTEGRATION_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("ALERT_OUTBOX_INTEGRATION_DATABASE_URL is not set")
	}
	store, err := NewStore(databaseURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	userID := fmt.Sprintf("proxy-incident-batch-%d", time.Now().UnixNano())
	if _, err := store.db.ExecContext(ctx, `
		INSERT INTO "User" (id, email, role) VALUES ($1, $2, 'free')`,
		userID, userID+"@example.test"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = store.db.Exec(`DELETE FROM "User" WHERE id = $1`, userID)
	})

	monitorIDs := make([]int, 3)
	for index := range monitorIDs {
		if err := store.db.QueryRowContext(ctx, `
			INSERT INTO monitors ("userId", name, query, status, region, proxy_source)
			VALUES ($1, 'Batch close', 'boots', 'active', 'de', 'free')
			RETURNING id`, userID).Scan(&monitorIDs[index]); err != nil {
			t.Fatal(err)
		}
		if err := store.OpenOrUpdateProxyIncident(ctx, monitorIDs[index], "www.vinted.de", "free", time.Now().Add(time.Minute)); err != nil {
			t.Fatal(err)
		}
	}

	if err := store.CloseProxyIncidents(ctx, nil, "monitor_stopped"); err != nil {
		t.Fatalf("empty batch: %v", err)
	}
	if err := store.CloseProxyIncidents(ctx, monitorIDs[:2], "monitor_stopped"); err != nil {
		t.Fatal(err)
	}

	for index, monitorID := range monitorIDs {
		var open bool
		var reason *string
		if err := store.db.QueryRowContext(ctx, `
			SELECT recovered_at IS NULL, end_reason FROM monitor_proxy_incidents
			WHERE monitor_id = $1`, monitorID).Scan(&open, &reason); err != nil {
			t.Fatal(err)
		}
		wantOpen := index == 2
		if open != wantOpen {
			t.Fatalf("monitor %d incident open = %v, want %v", index, open, wantOpen)
		}
		if !wantOpen && (reason == nil || *reason != "monitor_stopped") {
			t.Fatalf("monitor %d end reason = %v, want monitor_stopped", index, reason)
		}
	}
}
