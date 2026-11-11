package api

import (
	"testing"
	"time"

	"vintrack-vinted/internal/session"
)

func keepAliveSession(userID string) session.VintedSession {
	return session.VintedSession{
		UserID: userID, VintedUserID: 42, Domain: "www.vinted.de",
		AccessToken: "synthetic-access-" + userID, Status: "active",
		LinkedAt: "2026-01-01T00:00:00Z", BrowserLinked: true,
	}
}

func TestKeepAliveDoesNotOverwriteSessionSyncedDuringValidation(t *testing.T) {
	m := newSessionTestManager(t)
	if err := m.Store(keepAliveSession("member")); err != nil {
		t.Fatal(err)
	}

	m.RunKeepAlive(func(sess *session.VintedSession) session.KeepAliveOutcome {
		// The extension delivers a new token while this check is running.
		synced := keepAliveSession("member")
		synced.AccessToken = "synthetic-access-synced"
		if err := m.Store(synced); err != nil {
			t.Fatal(err)
		}
		return session.KeepAliveRejected
	}, time.Millisecond)

	got, err := m.Get("member")
	if err != nil || got == nil {
		t.Fatalf("Get = %v, %v", got, err)
	}
	if got.AccessToken != "synthetic-access-synced" || got.Status != "active" {
		t.Fatalf("stale keep-alive result replaced the synced session: token=%q status=%q", got.AccessToken, got.Status)
	}
}

func TestKeepAliveDoesNotResurrectUnlinkedSession(t *testing.T) {
	m := newSessionTestManager(t)
	if err := m.Store(keepAliveSession("member")); err != nil {
		t.Fatal(err)
	}

	m.RunKeepAlive(func(sess *session.VintedSession) session.KeepAliveOutcome {
		if err := m.Delete("member"); err != nil {
			t.Fatal(err)
		}
		return session.KeepAliveValid
	}, time.Millisecond)

	if got, err := m.Get("member"); err != nil || got != nil {
		t.Fatalf("unlinked session came back: %v, %v", got, err)
	}
}

func TestKeepAliveRetriesOnlyTransientFailures(t *testing.T) {
	tests := []struct {
		name         string
		outcome      session.KeepAliveOutcome
		wantCalls    int
		wantStatus   string
		wantUnsynced bool
	}{
		{name: "valid", outcome: session.KeepAliveValid, wantCalls: 1, wantStatus: "active"},
		{name: "transient", outcome: session.KeepAliveTransient, wantCalls: 3, wantStatus: "degraded"},
		{name: "rejected", outcome: session.KeepAliveRejected, wantCalls: 1, wantStatus: "degraded"},
		{name: "rate limited", outcome: session.KeepAliveDeferred, wantCalls: 1, wantStatus: "active", wantUnsynced: true},
		{name: "needs browser", outcome: session.KeepAliveNeedsBrowserSync, wantCalls: 1, wantStatus: "needs_browser_sync"},
		{name: "stored by validator", outcome: session.KeepAliveStored, wantCalls: 1, wantStatus: "active", wantUnsynced: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			m := newSessionTestManager(t)
			if err := m.Store(keepAliveSession("member")); err != nil {
				t.Fatal(err)
			}
			calls := 0
			m.RunKeepAlive(func(*session.VintedSession) session.KeepAliveOutcome {
				calls++
				return tt.outcome
			}, time.Millisecond)

			got, err := m.Get("member")
			if err != nil || got == nil {
				t.Fatalf("Get = %v, %v", got, err)
			}
			if calls != tt.wantCalls || got.Status != tt.wantStatus {
				t.Fatalf("calls=%d status=%q, want calls=%d status=%q", calls, got.Status, tt.wantCalls, tt.wantStatus)
			}
			if tt.wantUnsynced && got.LastCheck != "" {
				t.Fatalf("session was rewritten: last_check=%q", got.LastCheck)
			}
		})
	}
}

func TestKeepAliveSkipsSessionsWaitingForBrowserSync(t *testing.T) {
	m := newSessionTestManager(t)
	waiting := keepAliveSession("member")
	waiting.Status = "needs_browser_sync"
	if err := m.Store(waiting); err != nil {
		t.Fatal(err)
	}
	m.RunKeepAlive(func(*session.VintedSession) session.KeepAliveOutcome {
		t.Fatal("a session that needs a browser sync was sent to Vinted")
		return session.KeepAliveValid
	}, time.Millisecond)
}

func TestKeepAliveValidatorLeavesExpiredBrowserSessionToTheExtension(t *testing.T) {
	// header.payload.signature with exp far in the past: {"exp":1}
	expired := "eyJhbGciOiJub25lIn0.eyJleHAiOjF9.synthetic"
	if !accessTokenExpired(expired) {
		t.Fatal("fixture token is not recognised as expired")
	}
	server := NewServer(nil, "")

	browserLinked := keepAliveSession("member")
	browserLinked.AccessToken = expired
	browserLinked.RefreshToken = "synthetic-refresh"
	if got := server.ValidateSessionForKeepAlive(&browserLinked); got != session.KeepAliveNeedsBrowserSync {
		t.Fatalf("browser-linked expired session outcome = %v, want needs browser sync", got)
	}

	manual := keepAliveSession("member")
	manual.AccessToken = expired
	manual.BrowserLinked = false
	if got := server.ValidateSessionForKeepAlive(&manual); got != session.KeepAliveRejected {
		t.Fatalf("expired session without refresh token outcome = %v, want rejected", got)
	}
}
