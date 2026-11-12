package api

import (
	"context"
	"fmt"
	"log"
	"regexp"
	"strconv"
	"strings"
	"time"

	"vintrack-vinted/internal/session"
	"vintrack-vinted/internal/vinted"
)

var automationPricePattern = regexp.MustCompile(`^([0-9]{1,5})(?:\.([0-9]{1,2}))? ([A-Z]{3})$`)
var automationPlaceholderPattern = regexp.MustCompile(`\{([^{}]*)\}`)

func automaticOfferPrice(c session.AutomationCandidate) (string, string, bool) {
	match := automationPricePattern.FindStringSubmatch(c.Price)
	if match == nil || c.DiscountPercent < 1 || c.DiscountPercent > 50 || c.MaxPriceMinor <= 0 || c.MaxPriceMinor > 1000000 {
		return "", "", false
	}
	whole, _ := strconv.ParseInt(match[1], 10, 64)
	fraction, _ := strconv.ParseInt((match[2] + "00")[:2], 10, 64)
	minor := whole*100 + fraction
	if minor <= 0 || minor > c.MaxPriceMinor {
		return "", "", false
	}
	discounted := (minor*int64(100-c.DiscountPercent) + 50) / 100
	if discounted <= 0 || discounted >= minor {
		return "", "", false
	}
	return fmt.Sprintf("%d.%02d", discounted/100, discounted%100), match[3], true
}

// automationRegionCurrency is the currency a monitor region's listings are
// priced in. An offer in any other currency belongs to a different marketplace.
func automationRegionCurrency(region string) string {
	currencies := map[string]string{"uk": "GBP", "pl": "PLN", "cz": "CZK", "se": "SEK", "dk": "DKK", "ro": "RON", "hu": "HUF", "us": "USD"}
	if currency := currencies[region]; currency != "" {
		return currency
	}
	return "EUR"
}

func automaticMessage(c session.AutomationCandidate) (string, bool) {
	template := strings.TrimSpace(c.Template)
	if template == "" || len(template) > 1000 {
		return "", false
	}
	price, currency := c.Price, ""
	if parts := strings.Fields(c.Price); len(parts) == 2 {
		price, currency = parts[0], parts[1]
	}
	values := map[string]string{"title": c.Title, "price": price, "currency": currency, "seller": c.Seller, "url": c.URL, "monitor": c.MonitorName}
	valid := !strings.ContainsAny(automationPlaceholderPattern.ReplaceAllString(template, ""), "{}")
	message := automationPlaceholderPattern.ReplaceAllStringFunc(template, func(token string) string {
		value, ok := values[token[1:len(token)-1]]
		if !ok {
			valid = false
		}
		return value
	})
	message = strings.TrimSpace(message)
	return message, valid && message != "" && len(message) <= 2000
}

// StartAccountAutomations uses the worker's persisted matches, so it is independent
// of notification channel configuration and never runs inside a scraper request.
func (s *Server) StartAccountAutomations(ctx context.Context) {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			queueCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
			if err := s.sessions.ExpireAutomationClaims(queueCtx); err != nil {
				cancel()
				log.Print("[automations] claim recovery unavailable")
				continue
			}
			candidates, err := s.sessions.AutomationCandidates(queueCtx)
			cancel()
			if err != nil {
				log.Print("[automations] match queue unavailable")
				continue
			}
			for _, c := range candidates {
				if ctx.Err() != nil {
					return
				}
				actionCtx, actionCancel := context.WithTimeout(ctx, time.Minute)
				s.runAccountAutomation(actionCtx, c)
				actionCancel()
			}
		}
	}
}

func (s *Server) runAccountAutomation(ctx context.Context, c session.AutomationCandidate) {
	id, err := s.sessions.ClaimAutomation(ctx, c)
	if err != nil {
		log.Print("[automations] durable claim unavailable")
		return
	}
	if id == 0 {
		return
	}
	status, reason := "skipped", "settings_unavailable"
	defer func() {
		// Persist even during shutdown. Failure leaves a non-replayable sending claim.
		finishCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := s.sessions.FinishAutomation(finishCtx, id, status, reason); err != nil {
			log.Print("[automations] attempt outcome could not be saved")
		}
	}()
	feature := "auto_offers"
	if c.Kind == "message" {
		feature = "auto_messages"
	} else if c.Kind != "offer" {
		return
	}
	access, err := s.sessions.FeatureAccess(c.UserID, feature)
	if err != nil || !access.Allowed {
		reason = "feature_unavailable"
		return
	}
	domain, supported := vinted.DomainForRegion(c.Region)
	if !supported || normalizeVintedDomain(domain) != normalizeVintedDomain(c.Domain) {
		reason = "region_mismatch"
		return
	}
	var price, currency, message string
	var valid bool
	if c.Kind == "offer" {
		price, currency, valid = automaticOfferPrice(c)
	} else {
		message, valid = automaticMessage(c)
	}
	if !valid {
		reason = "invalid_price_or_template"
		return
	}
	if c.Kind == "offer" {
		if currency != automationRegionCurrency(c.Region) {
			reason = "currency_mismatch"
			return
		}
	}
	sess, err := s.sessions.Get(c.UserID)
	if err != nil || sess == nil || sess.VintedUserID != c.AccountID || normalizeVintedDomain(sess.Domain) != normalizeVintedDomain(c.Domain) || sess.Status != "active" {
		reason = "linked_account_unavailable"
		return
	}
	if c.SellerID <= 0 || c.ItemID <= 0 || c.SellerID == sess.VintedUserID {
		reason = "invalid_target"
		return
	}
	// Refresh through the existing lock and storage path, before any mutation.
	var client *vinted.Client
	if serverSideTokenRefreshAllowed(sess) && accessTokenExpiresWithin(sess.AccessToken, proactiveRefreshWindow) {
		sess, client, err = s.refreshSessionWithLock(c.UserID, sess)
	} else {
		client, err = vinted.NewClient(sessionForServerSideClient(sess))
	}
	if err != nil || client == nil {
		reason = "session_refresh_required"
		return
	}
	if sess.VintedUserID != c.AccountID || normalizeVintedDomain(sess.Domain) != normalizeVintedDomain(c.Domain) {
		reason = "linked_account_unavailable"
		return
	}
	if err := client.WarmUp(); err != nil {
		reason = "session_refresh_required"
		return
	}
	s.persistSessionIfChanged(sess, client.GetSession(), false)
	enabled, err := s.sessions.AutomationStillEnabled(ctx, c)
	access, accessErr := s.sessions.FeatureAccess(c.UserID, feature)
	if err != nil || !enabled || accessErr != nil || !access.Allowed {
		reason = "settings_unavailable"
		return
	}
	if ctx.Err() != nil || time.Since(c.FoundAt) > 2*time.Minute {
		reason = "match_expired"
		return
	}
	status, reason = "uncertain", "upstream_outcome_unverified"
	// Automatic mutations have no refresh/retry wrapper: a lost response must
	// never produce a second message or offer.
	if c.Kind == "offer" {
		err = client.SendAutomaticOffer(c.ItemID, c.SellerID, price, currency)
	} else {
		err = client.SendAutomaticMessage(c.ItemID, c.SellerID, message)
	}
	s.persistSessionIfChanged(sess, client.GetSession(), err == nil)
	if err == nil {
		status, reason = "sent", ""
	}
}
