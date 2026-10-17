package api

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"os/exec"
	"strconv"
	"strings"
	"testing"
	"time"
	"vintrack-vinted/internal/session"
	"vintrack-vinted/internal/vinted"
)

func newSessionTestManager(t *testing.T) *session.Manager {
	t.Helper()
	binary, err := exec.LookPath("redis-server")
	if err != nil {
		t.Skip("isolated Redis required")
	}
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := l.Addr().(*net.TCPAddr).Port
	l.Close()
	ctx, cancel := context.WithCancel(context.Background())
	cmd := exec.CommandContext(ctx, binary, "--bind", "127.0.0.1", "--port", strconv.Itoa(port), "--save", "", "--appendonly", "no", "--dir", t.TempDir())
	if err := cmd.Start(); err != nil {
		cancel()
		t.Fatal(err)
	}
	t.Cleanup(func() { cancel(); cmd.Wait() })
	addr := net.JoinHostPort("127.0.0.1", strconv.Itoa(port))
	deadline := time.Now().Add(2 * time.Second)
	for {
		c, e := net.DialTimeout("tcp", addr, 50*time.Millisecond)
		if e == nil {
			c.Close()
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("isolated Redis startup failed")
		}
		time.Sleep(10 * time.Millisecond)
	}
	m, err := session.NewManager(addr, "", "", "")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = m.Close() })
	return m
}
func TestNewSessionCredentialsDiscardPreviousBrowserContext(t *testing.T) {
	m := newSessionTestManager(t)
	old := session.VintedSession{UserID: "synthetic-member", VintedUserID: 42, Domain: "www.vinted.de", AccessToken: "synthetic-old-access", CsrfToken: "synthetic-old-csrf", AnonID: "synthetic-old-anon", CookieHeader: "synthetic_context=old", BrowserLinked: true}
	if err := m.Store(old); err != nil {
		t.Fatal(err)
	}
	s := Server{sessions: m}
	updated, err := s.buildLinkedSession(old.UserID, linkRequest{AccessToken: "synthetic-new-account-access", UserAgent: "synthetic-new-browser", Domain: old.Domain})
	if err != nil {
		t.Fatal(err)
	}
	if updated.CsrfToken != "" || updated.AnonID != "" || updated.CookieHeader != "" {
		t.Fatal("old browser context crossed into new credentials")
	}
	if updated.UserAgent != "synthetic-new-browser" {
		t.Fatal("incoming browser identity lost")
	}

}
func TestManualCredentialsChooseServerRefreshOwnership(t *testing.T) {
	m := newSessionTestManager(t)
	old := session.VintedSession{UserID: "synthetic-member", Domain: "www.vinted.de", AccessToken: "synthetic-old", BrowserLinked: true}
	if err := m.Store(old); err != nil {
		t.Fatal(err)
	}
	s := Server{sessions: m}
	updated, err := s.buildLinkedSession(old.UserID, linkRequest{AccessToken: "synthetic-new", RefreshToken: "synthetic-refresh", Domain: old.Domain})
	if err != nil {
		t.Fatal(err)
	}
	if !serverSideTokenRefreshAllowed(updated) || updated.BrowserLinked {
		t.Fatal("manual refresh credentials retained browser refresh ownership")
	}

}

func TestRepeatedBrowserSyncPreservesOnlyMatchingContext(t *testing.T) {
	m := newSessionTestManager(t)
	old := session.VintedSession{UserID: "synthetic-member", Domain: "www.vinted.de", AccessToken: "synthetic-access", CsrfToken: "synthetic-csrf", AnonID: "synthetic-anon", CookieHeader: "synthetic_context=same", UserAgent: "synthetic-agent", BrowserLinked: true}
	if err := m.Store(old); err != nil {
		t.Fatal(err)
	}
	s := Server{sessions: m}
	updated, err := s.buildLinkedSession(old.UserID, linkRequest{AccessToken: old.AccessToken, Domain: old.Domain, browserLinked: true})
	if err != nil || updated.CsrfToken != old.CsrfToken || updated.CookieHeader != old.CookieHeader || !updated.BrowserLinked {
		t.Fatalf("same browser context lost: %v", err)
	}
	changed, err := s.buildLinkedSession(old.UserID, linkRequest{AccessToken: old.AccessToken, Domain: "www.vinted.fr", browserLinked: true})
	if err != nil || changed.CsrfToken != "" || changed.CookieHeader != "" || !changed.BrowserLinked {
		t.Fatalf("old region context reused: %v", err)
	}
}

type fakeAccountSessionClient struct {
	session           *session.VintedSession
	initialErr        error
	retryErr          error
	refreshErr        error
	checks, refreshes int
}

func (c *fakeAccountSessionClient) GetSession() *session.VintedSession { return c.session }
func (c *fakeAccountSessionClient) RefreshAccessToken() error          { c.refreshes++; return c.refreshErr }
func (c *fakeAccountSessionClient) GetAccountInfo() (*vinted.AccountInfo, error) {
	c.checks++
	if c.checks == 1 {
		return nil, c.initialErr
	}
	if c.retryErr != nil {
		return nil, c.retryErr
	}
	return &vinted.AccountInfo{ID: 42, Login: "synthetic-buyer"}, nil
}

func TestAccountInfoRefreshOnlyForDefinitiveAuthenticationFailure(t *testing.T) {
	for _, tc := range []struct {
		name        string
		err         error
		browser     bool
		wantRefresh bool
	}{
		{"expired", &vinted.AuthError{StatusCode: 401}, false, true},
		{"explicit invalid token", &vinted.AuthError{StatusCode: 403}, false, true},
		{"unauthorized", &vinted.UpstreamHTTPError{StatusCode: 401}, false, true},
		{"forbidden", &vinted.UpstreamHTTPError{StatusCode: 403}, false, false},
		{"rate limit", &vinted.UpstreamHTTPError{StatusCode: 429}, false, false},
		{"unavailable", &vinted.UpstreamHTTPError{StatusCode: 503}, false, false},
		{"challenge", &vinted.DataDomeChallengeError{StatusCode: 403}, false, false},
		{"malformed", errors.New("invalid response"), false, false},
		{"browser ownership", &vinted.AuthError{StatusCode: 401}, true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := &fakeAccountSessionClient{session: &session.VintedSession{RefreshToken: "synthetic-refresh", BrowserLinked: tc.browser}, initialErr: tc.err}
			info, err := accountInfoWithRefresh(c)
			if tc.wantRefresh {
				if err != nil || info == nil || c.refreshes != 1 || c.checks != 2 {
					t.Fatalf("expected one refresh and check: %v", err)
				}
			} else if err == nil || c.refreshes != 0 || c.checks != 1 {
				t.Fatal("unexpected refresh or retry")
			}
		})
	}
}

func TestAccountInfoDoesNotRepeatFailedRefreshOrFailedRecheck(t *testing.T) {
	for _, failRefresh := range []bool{false, true} {
		c := &fakeAccountSessionClient{session: &session.VintedSession{RefreshToken: "synthetic-refresh"}, initialErr: &vinted.AuthError{StatusCode: 401}, retryErr: &vinted.AuthError{StatusCode: 401}}
		if failRefresh {
			c.refreshErr = &vinted.UpstreamHTTPError{StatusCode: 429}
		}
		if _, err := accountInfoWithRefresh(c); err == nil || c.refreshes != 1 {
			t.Fatal("failed refresh validation was accepted or repeated")
		}
		wantChecks := 2
		if failRefresh {
			wantChecks = 1
		}
		if c.checks != wantChecks {
			t.Fatal("unexpected account recheck")
		}
	}
}

func TestBrowserRefreshOwnershipCannotBeSetThroughLinkJSON(t *testing.T) {
	var req linkRequest
	if err := json.NewDecoder(strings.NewReader(`{"browserLinked":true,"browser_linked":true,"access_token":"synthetic-access"}`)).Decode(&req); err != nil {
		t.Fatal(err)
	}
	if req.browserLinked {
		t.Fatal("untrusted JSON changed internal refresh ownership")
	}
}
