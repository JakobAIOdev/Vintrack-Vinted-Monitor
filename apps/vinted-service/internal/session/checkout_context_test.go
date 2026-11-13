package session

import "testing"

func TestRejectedCheckoutContextRequiresRenewedContext(t *testing.T) {
	m := checkoutTestManager(t)
	sess := &VintedSession{UserID: "synthetic", VintedUserID: 42, Domain: "www.vinted.de", AccessToken: "token", CookieHeader: "datadome=context", CsrfToken: "csrf", UserAgent: "browser"}
	if err := m.BlockCheckoutContext(sess); err != nil {
		t.Fatal(err)
	}
	if blocked, err := m.CheckoutContextBlocked(sess); err != nil || !blocked {
		t.Fatal("rejected context was not blocked")
	}
	for _, renew := range []func(*VintedSession){
		func(s *VintedSession) { s.CookieHeader = "datadome=renewed" },
		func(s *VintedSession) { s.CsrfToken = "renewed" },
		func(s *VintedSession) { s.UserID = "another-member" },
	} {
		other := *sess
		renew(&other)
		if blocked, err := m.CheckoutContextBlocked(&other); err != nil || blocked {
			t.Fatal("fresh context reused a rejected context marker")
		}
	}
	// A renewed access token keeps the synced cookies and CSRF token, so it
	// keeps the rejection of that context as well.
	rotated := *sess
	rotated.AccessToken = "renewed"
	if blocked, err := m.CheckoutContextBlocked(&rotated); err != nil || !blocked {
		t.Fatal("token rotation lifted the rejection of an unchanged context")
	}
}
