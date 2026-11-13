package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"vintrack-vinted/internal/session"
)

func TestCheckoutContextRequiresConsentAndOnlyAllowlistedCookies(t *testing.T) {
	valid := func() *browserCheckoutContext {
		return &browserCheckoutContext{ConsentVersion: 1, Cookies: map[string]string{"datadome": "synthetic-dd", "anon_id": "synthetic-anon"}, CSRFToken: "synthetic-csrf"}
	}
	for _, change := range []func(*browserCheckoutContext){
		func(c *browserCheckoutContext) { c.ConsentVersion = 0 },
		func(c *browserCheckoutContext) { c.CSRFToken = "" },
		func(c *browserCheckoutContext) { c.CSRFToken = "synthetic\r\ninjection" },
		func(c *browserCheckoutContext) { c.Cookies["refresh_token_web"] = "synthetic-refresh" },
		func(c *browserCheckoutContext) { c.Cookies["access_token_web"] = "synthetic-access" },
		func(c *browserCheckoutContext) { c.Cookies["unrelated"] = "synthetic" },
		func(c *browserCheckoutContext) { delete(c.Cookies, "datadome") },
		func(c *browserCheckoutContext) { c.Cookies["datadome"] = "synthetic; injected=value" },
		func(c *browserCheckoutContext) { c.Cookies["datadome"] = strings.Repeat("x", 8193) },
	} {
		context := valid()
		change(context)
		if context.validate("synthetic-agent") == nil {
			t.Fatal("unsafe checkout context accepted")
		}
	}
	if valid().validate("") == nil {
		t.Fatal("browser identity missing")
	}
	context := valid()
	if err := context.validate("synthetic-agent"); err != nil {
		t.Fatal(err)
	}
	sess := &session.VintedSession{AccessToken: "synthetic-existing-access", RefreshToken: "", UserAgent: "synthetic-agent"}
	context.apply(sess)
	if sess.CookieHeader != "datadome=synthetic-dd; anon_id=synthetic-anon" || sess.CsrfToken != "synthetic-csrf" || sess.AnonID != "synthetic-anon" || sess.WarmedAt == "" {
		t.Fatal("checkout context was not transferred into existing encrypted fields")
	}
	if sess.AccessToken != "synthetic-existing-access" || sess.RefreshToken != "" {
		t.Fatal("context replaced authentication credentials")
	}
}

func TestServerCheckoutRequiresContextBeforeAnyUpstreamMutation(t *testing.T) {
	manager := checkoutTestManager(t)
	server := &Server{sessions: manager}
	sess, err := manager.Get("synthetic-user")
	if err != nil {
		t.Fatal(err)
	}
	sess.Status = "active"
	if err := manager.Store(*sess); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/items/checkout/prepare", strings.NewReader(`{"item_id":123,"seller_id":456,"account_id":42,"domain":"www.vinted.de","stop_before_payment":true,"preferences":{"shipping":"home","payment":"card","autoCheckout":{"warningVersion":2,"currency":"EUR","maxTotalMinor":3000}}}`))
	req.Header.Set("X-User-ID", "synthetic-user")
	recorder := httptest.NewRecorder()
	server.handlePrepareCheckout(recorder, req)
	if recorder.Code != http.StatusConflict || !strings.Contains(recorder.Body.String(), "server_checkout_sync_required") {
		t.Fatal("missing native context did not stop before upstream requests")
	}
}

func TestCheckoutSessionCookiesRequireExpandedConsent(t *testing.T) {
	context := &browserCheckoutContext{
		ConsentVersion: 1, CSRFToken: "synthetic-csrf",
		Cookies: map[string]string{"datadome": "synthetic-dd", "anon_id": "synthetic-anon", "_vinted_fr_session": "synthetic-session", "v_udt": "synthetic-device"},
	}
	if context.validate("synthetic-browser") == nil {
		t.Fatal("legacy consent allowed additional session cookies")
	}
	context.ConsentVersion = 2
	if err := context.validate("synthetic-browser"); err != nil {
		t.Fatal(err)
	}
	sess := &session.VintedSession{AccessToken: "synthetic-access"}
	context.apply(sess)
	for name, expected := range context.Cookies {
		if extractCookieValue(sess.CookieHeader, name) != expected {
			t.Fatalf("lost consented checkout cookie %s", name)
		}
	}
	context.Cookies["refresh_token_web"] = "synthetic-refresh"
	if context.validate("synthetic-browser") == nil {
		t.Fatal("expanded consent allowed refresh credentials")
	}
	delete(context.Cookies, "refresh_token_web")
	context.ConsentVersion = 3
	if context.validate("synthetic-browser") == nil {
		t.Fatal("unknown consent version accepted")
	}
}

func TestCheckoutContextReadinessIsLocalAndRejectsBlockedContexts(t *testing.T) {
	manager := checkoutTestManager(t)
	server := &Server{sessions: manager}
	sess := &session.VintedSession{UserID: "synthetic-user", VintedUserID: 42, Domain: "www.vinted.de", Status: "active", UserAgent: "synthetic-browser", CsrfToken: "synthetic-csrf", CookieHeader: "datadome=synthetic"}
	if state := server.checkoutContextState(sess); state != "ready" {
		t.Fatal(state)
	}
	if err := manager.BlockCheckoutContext(sess); err != nil {
		t.Fatal(err)
	}
	if state := server.checkoutContextState(sess); state != "blocked" {
		t.Fatal(state)
	}
	sess.CookieHeader = "datadome=renewed"
	if state := server.checkoutContextState(sess); state != "ready" {
		t.Fatal(state)
	}
	sess.Status = "needs_browser_reauth"
	if state := server.checkoutContextState(sess); state != "reauth_required" {
		t.Fatal(state)
	}
}

func TestReadyServerContextCannotUseSharedIPWithoutOwnedProxy(t *testing.T) {
	manager := checkoutTestManager(t)
	sess, _ := manager.Get("synthetic-user")
	sess.Status = "active"
	sess.UserAgent = "synthetic-browser"
	sess.CsrfToken = "synthetic-csrf"
	sess.CookieHeader = "datadome=synthetic"
	if err := manager.Store(*sess); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/api/items/checkout/prepare", strings.NewReader(`{"item_id":123,"seller_id":456,"account_id":42,"domain":"www.vinted.de","preferences":{"shipping":"home","payment":"card","autoCheckout":{"warningVersion":2,"currency":"EUR","maxTotalMinor":3000}}}`))
	request.Header.Set("X-User-ID", sess.UserID)
	response := httptest.NewRecorder()
	(&Server{sessions: manager}).handlePrepareCheckout(response, request)
	if response.Code != http.StatusServiceUnavailable || !strings.Contains(response.Body.String(), "checkout_proxy_unavailable") {
		t.Fatal("ready context permitted unproxied checkout")
	}
	if cached, err := manager.GetCheckoutPreparation(sess, 123); err != nil || cached != nil {
		t.Fatal("a checkout mutation was checkpointed without a proxy")
	}
}
