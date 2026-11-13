package session

import (
	"strings"
	"testing"
	"time"
)

func TestAllowCheckoutReleaseIsBoundedPerItem(t *testing.T) {
	m := checkoutTestManager(t)
	sess := &VintedSession{UserID: "synthetic-user", VintedUserID: 42, Domain: "www.vinted.de", LinkedAt: "synthetic-link-generation"}
	for attempt, want := range []bool{true, true, false, false, false} {
		allowed, err := m.AllowCheckoutRelease(sess, 123)
		if err != nil || allowed != want {
			t.Fatalf("release %d: allowed=%v err=%v, want %v", attempt+1, allowed, err, want)
		}
	}
	keys, err := m.redis.Keys(m.ctx, "vinted:checkout-release:*").Result()
	if err != nil || len(keys) != 1 {
		t.Fatalf("release counters = %v err=%v", keys, err)
	}
	if ttl := m.redis.PTTL(m.ctx, keys[0]).Val(); ttl <= 0 || ttl > checkoutReleaseWindow {
		t.Fatalf("release counter must expire within its window: %s", ttl)
	}
	// Another item, member or Vinted identity has its own allowance.
	if allowed, err := m.AllowCheckoutRelease(sess, 124); err != nil || !allowed {
		t.Fatal("release bound crossed the item boundary")
	}
	for name, change := range map[string]func(*VintedSession){
		"member":  func(s *VintedSession) { s.UserID = "another-member" },
		"account": func(s *VintedSession) { s.VintedUserID = 99 },
		"domain":  func(s *VintedSession) { s.Domain = "www.vinted.fr" },
	} {
		other := *sess
		change(&other)
		if allowed, err := m.AllowCheckoutRelease(&other, 123); err != nil || !allowed {
			t.Fatalf("release bound crossed the %s boundary", name)
		}
	}
	// Relinking the same account does not reset the allowance.
	relinked := *sess
	relinked.LinkedAt = "relinked-generation"
	if allowed, err := m.AllowCheckoutRelease(&relinked, 123); err != nil || allowed {
		t.Fatal("relinking reset the release bound")
	}
	// The allowance comes back only after the window.
	if err := m.redis.Del(m.ctx, keys[0]).Err(); err != nil {
		t.Fatal(err)
	}
	if allowed, err := m.AllowCheckoutRelease(sess, 123); err != nil || !allowed {
		t.Fatal("release was not allowed again after the window")
	}
}

func TestCheckoutCooldownCoversEveryItemOfTheMemberAndExpires(t *testing.T) {
	m := checkoutTestManager(t)
	sess := &VintedSession{UserID: "synthetic-user", VintedUserID: 42, Domain: "www.vinted.de", LinkedAt: "synthetic-link-generation", AccessToken: "synthetic-access", CookieHeader: "datadome=synthetic"}
	if cooling, err := m.CheckoutCooldownActive(sess); err != nil || cooling {
		t.Fatal("cooldown active before any rate limit")
	}
	if err := m.StartCheckoutCooldown(sess); err != nil {
		t.Fatal(err)
	}
	// Token rotation, a renewed context or relinking do not end the pause.
	for name, change := range map[string]func(*VintedSession){
		"same":     func(*VintedSession) {},
		"token":    func(s *VintedSession) { s.AccessToken = "synthetic-rotated" },
		"context":  func(s *VintedSession) { s.CookieHeader = "datadome=synthetic-renewed" },
		"relinked": func(s *VintedSession) { s.LinkedAt = "relinked-generation" },
	} {
		other := *sess
		change(&other)
		if cooling, err := m.CheckoutCooldownActive(&other); err != nil || !cooling {
			t.Fatalf("cooldown lost on %s", name)
		}
	}
	for name, change := range map[string]func(*VintedSession){
		"member":  func(s *VintedSession) { s.UserID = "another-member" },
		"account": func(s *VintedSession) { s.VintedUserID = 99 },
		"domain":  func(s *VintedSession) { s.Domain = "www.vinted.fr" },
	} {
		other := *sess
		change(&other)
		if cooling, err := m.CheckoutCooldownActive(&other); err != nil || cooling {
			t.Fatalf("cooldown crossed the %s boundary", name)
		}
	}
	if CheckoutCooldown != time.Minute {
		t.Fatalf("cooldown = %s, want one minute", CheckoutCooldown)
	}
	if ttl := m.redis.PTTL(m.ctx, checkoutCooldownKey(sess)).Val(); ttl <= 0 || ttl > CheckoutCooldown {
		t.Fatalf("cooldown must expire by itself: %s", ttl)
	}
	// A second rate limit restarts the pause instead of stacking it.
	if err := m.redis.PExpire(m.ctx, checkoutCooldownKey(sess), time.Second).Err(); err != nil {
		t.Fatal(err)
	}
	if err := m.StartCheckoutCooldown(sess); err != nil {
		t.Fatal(err)
	}
	if ttl := m.redis.PTTL(m.ctx, checkoutCooldownKey(sess)).Val(); ttl <= time.Second || ttl > CheckoutCooldown {
		t.Fatalf("repeated rate limit did not restart the pause: %s", ttl)
	}
	if err := m.redis.Del(m.ctx, checkoutCooldownKey(sess)).Err(); err != nil {
		t.Fatal(err)
	}
	if cooling, err := m.CheckoutCooldownActive(sess); err != nil || cooling {
		t.Fatal("cooldown outlived its key")
	}
	// Fails closed: without Redis no new request checkout may start.
	_ = m.redis.Close()
	if _, err := m.CheckoutCooldownActive(sess); err == nil {
		t.Fatal("cooldown check did not report unavailable storage")
	}
	if allowed, err := m.AllowCheckoutRelease(sess, 123); err == nil || allowed {
		t.Fatal("release allowed without storage")
	}
}

func TestCheckoutContextBlockFollowsTheSyncedBrowserContext(t *testing.T) {
	m := checkoutTestManager(t)
	sess := &VintedSession{UserID: "synthetic-user", VintedUserID: 42, Domain: "www.vinted.de", AccessToken: "synthetic-access", CookieHeader: "datadome=synthetic", CsrfToken: "synthetic-csrf", UserAgent: "synthetic-browser", LinkedAt: "synthetic-link-generation"}
	if err := m.BlockCheckoutContext(sess); err != nil {
		t.Fatal(err)
	}
	keys, _ := m.redis.Keys(m.ctx, "*").Result()
	for _, key := range keys {
		for _, secret := range []string{sess.AccessToken, "datadome", sess.CsrfToken, sess.UserAgent} {
			if strings.Contains(key, secret) {
				t.Fatalf("session material entered a Redis key: %q", key)
			}
		}
		if ttl := m.redis.PTTL(m.ctx, key).Val(); ttl <= 0 || ttl > 24*time.Hour {
			t.Fatalf("context block must expire: %s", ttl)
		}
	}
	for name, tc := range map[string]struct {
		change  func(*VintedSession)
		blocked bool
	}{
		"token rotation": {func(s *VintedSession) { s.AccessToken = "synthetic-rotated" }, true},
		"refresh token":  {func(s *VintedSession) { s.RefreshToken = "synthetic-refresh" }, true},
		"relinked":       {func(s *VintedSession) { s.LinkedAt = "relinked-generation" }, true},
		"new cookies":    {func(s *VintedSession) { s.CookieHeader = "datadome=synthetic-renewed" }, false},
		"new csrf":       {func(s *VintedSession) { s.CsrfToken = "synthetic-renewed" }, false},
		"new browser":    {func(s *VintedSession) { s.UserAgent = "synthetic-other-browser" }, false},
		"other member":   {func(s *VintedSession) { s.UserID = "another-member" }, false},
		"other account":  {func(s *VintedSession) { s.VintedUserID = 99 }, false},
		"other domain":   {func(s *VintedSession) { s.Domain = "www.vinted.fr" }, false},
	} {
		other := *sess
		tc.change(&other)
		if blocked, err := m.CheckoutContextBlocked(&other); err != nil || blocked != tc.blocked {
			t.Fatalf("%s: blocked=%v err=%v, want %v", name, blocked, err, tc.blocked)
		}
	}
}
