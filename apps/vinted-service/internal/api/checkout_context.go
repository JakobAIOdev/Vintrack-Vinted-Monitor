package api

import (
	"fmt"
	"strings"
	"time"

	"vintrack-vinted/internal/session"
)

// Deliberately excludes the browser refresh credential and all unrelated
// cookies. The handoff is optional and requires a separate user consent; once
// granted, the extension repeats it when the browser renews its access token,
// until the member turns that off.
type browserCheckoutContext struct {
	ConsentVersion int               `json:"consent_version"`
	Cookies        map[string]string `json:"cookies"`
	CSRFToken      string            `json:"csrf_token"`
}

func (c *browserCheckoutContext) validate(userAgent string) error {
	if c == nil {
		return nil
	}
	if (c.ConsentVersion != 1 && c.ConsentVersion != 2) || strings.TrimSpace(userAgent) == "" || len(userAgent) > 2048 || strings.ContainsAny(userAgent, "\r\n") ||
		!checkoutContextValue(c.CSRFToken, 8192) || !checkoutContextValue(c.Cookies["datadome"], 8192) {
		return fmt.Errorf("valid checkout context and explicit context consent are required")
	}
	for name, value := range c.Cookies {
		allowed := name == "datadome" || name == "anon_id" ||
			(c.ConsentVersion == 2 && (name == "_vinted_fr_session" || name == "v_udt"))
		if !allowed || !checkoutContextValue(value, 8192) {
			return fmt.Errorf("unsupported checkout context cookie")
		}
	}
	return nil
}

func checkoutContextValue(value string, limit int) bool {
	if value == "" || len(value) > limit {
		return false
	}
	for _, character := range value {
		if character <= 32 || character >= 127 || character == ';' || character == ',' {
			return false
		}
	}
	return true
}

func (c *browserCheckoutContext) apply(sess *session.VintedSession) {
	if c == nil {
		return
	}
	parts := make([]string, 0, 4)
	for _, name := range []string{"datadome", "anon_id", "_vinted_fr_session", "v_udt"} {
		if value := c.Cookies[name]; value != "" {
			parts = append(parts, name+"="+value)
		}
	}
	sess.CookieHeader = strings.Join(parts, "; ")
	sess.CsrfToken = c.CSRFToken
	sess.AnonID = c.Cookies["anon_id"]
	sess.WarmedAt = time.Now().UTC().Format(time.RFC3339)
}

func hasCheckoutContext(sess *session.VintedSession) bool {
	return sess != nil && sess.UserAgent != "" && sess.CsrfToken != "" && extractCookieValue(sess.CookieHeader, "datadome") != ""
}

func (s *Server) checkoutContextState(sess *session.VintedSession) string {
	if accessTokenExpired(sess.AccessToken) || sess.Status == "needs_browser_sync" || sess.Status == "needs_browser_reauth" || sess.Status == "missing_refresh_token" {
		return "reauth_required"
	}
	if !hasCheckoutContext(sess) {
		return "missing_context"
	}
	blocked, err := s.sessions.CheckoutContextBlocked(sess)
	if err != nil {
		return "unavailable"
	}
	if blocked {
		return "blocked"
	}
	return "ready"
}
