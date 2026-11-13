package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"

	"vintrack-vinted/internal/session"
	"vintrack-vinted/internal/vinted"
)

func (s *Server) handlePrepareCheckout(w http.ResponseWriter, r *http.Request) {
	if getUserID(r) == "" {
		writeError(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	var req struct {
		ItemID             int64                      `json:"item_id"`
		SellerID           int64                      `json:"seller_id"`
		AccountID          int64                      `json:"account_id"`
		Domain             string                     `json:"domain"`
		Preferences        vinted.CheckoutPreferences `json:"preferences"`
		BrowserPrepareOnly bool                       `json:"browser_prepare_only"`
		StopBeforePayment  bool                       `json:"stop_before_payment"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&req); err != nil || req.ItemID <= 0 || req.SellerID <= 0 || req.AccountID <= 0 || req.Domain == "" || !req.Preferences.Valid() {
		writeError(w, "valid item_id and seller_id are required", http.StatusBadRequest)
		return
	}
	if req.Preferences.AutoCheckout != nil && !vinted.AutoCheckoutAllowed(req.Domain, req.Preferences.Payment) {
		writeError(w, "auto-checkout is unavailable for this region", http.StatusBadRequest)
		return
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		writeError(w, "invalid checkout request", http.StatusBadRequest)
		return
	}
	if req.BrowserPrepareOnly && req.Preferences.AutoCheckout == nil {
		writeError(w, "browser authorization requires auto-checkout preferences", http.StatusBadRequest)
		return
	}
	if req.StopBeforePayment && req.BrowserPrepareOnly {
		writeError(w, "validation cannot authorize browser payment", http.StatusBadRequest)
		return
	}
	// Identity, checkpoints and cached results are local. Do not initialize a
	// Vinted client or warm up its session just to reopen an existing result.
	sess, err := s.sessions.Get(getUserID(r))
	if err != nil {
		writeError(w, "session fetch error", http.StatusInternalServerError)
		return
	}
	if sess == nil {
		writeError(w, "no linked Vinted account", http.StatusNotFound)
		return
	}
	s.canonicalizeSessionDomain(sess)
	if req.AccountID != sess.VintedUserID || req.Domain != sess.Domain {
		writeError(w, "linked Vinted account changed; reload checkout", http.StatusConflict)
		return
	}
	if req.SellerID == sess.VintedUserID {
		writeError(w, "you cannot buy your own item", http.StatusBadRequest)
		return
	}
	token, acquired, err := s.sessions.AcquireCheckoutPreparation(sess, req.ItemID)
	if err != nil {
		writeError(w, "checkout preparation unavailable", http.StatusServiceUnavailable)
		return
	}
	if !acquired {
		writeJSON(w, http.StatusConflict, map[string]string{"code": "checkout_in_progress", "error": "Checkout preparation is already running. Wait before opening it again."})
		return
	}
	defer s.sessions.ReleaseCheckoutPreparation(sess, req.ItemID, token)
	cached, err := s.sessions.GetCheckoutPreparation(sess, req.ItemID)
	if err != nil {
		writeError(w, "checkout preparation unavailable", http.StatusServiceUnavailable)
		return
	}
	if cached != nil {
		if cached.SellerID != 0 && cached.SellerID != req.SellerID {
			writeError(w, "checkout target changed", http.StatusConflict)
			return
		}
		if cached.CheckoutURL != "" {
			cached.PaymentURL = ""
			if cached.Status == "payment_starting" {
				cached.Status = "payment_outcome_unknown"
				cached.AutoCheckoutReason = "A payment request may already have been sent. Check Vinted; do not start it again."
			}
			if cached.Status == "paypal_redirect_ready" && !req.StopBeforePayment && !req.BrowserPrepareOnly {
				// The member finishes a started PayPal payment in PayPal. Hand
				// the same approval link back while it is held; this sends
				// nothing to Vinted and starts no second payment.
				handoff, handoffErr := s.sessions.CheckoutPaymentHandoff(sess, req.ItemID)
				if handoffErr != nil {
					// Do not report the link as gone while its store cannot be read.
					writeError(w, "checkout preparation unavailable", http.StatusServiceUnavailable)
					return
				}
				if validAgentPayPalURL(handoff) {
					cached.PaymentURL = handoff
					cached.AutoCheckoutReason = "A PayPal payment was already started for this item. Continue in PayPal to complete it; no second payment request was sent."
				} else {
					cached.Status = "checkout_review_required"
					cached.AutoCheckoutReason = "A PayPal payment was started for this item, but its PayPal link is no longer available. Finish or cancel it in Vinted; it will not be started again automatically."
				}
				writeJSON(w, http.StatusOK, cached)
				return
			}
			paymentOutcome := paymentOutcomeStatus(cached.Status)
			validationReady := req.StopBeforePayment && cached.Status == "payment_ready" && cached.PreferencesKey == req.Preferences.Key()
			if !paymentOutcome && !validationReady && (req.Preferences.AutoCheckout != nil || strings.Contains(cached.PreferencesKey, ":auto:")) {
				cached.AutoCheckoutReason = "This checkout was already attempted. Continue in Vinted; an automatic payment will not be repeated."
			}
			if !paymentOutcome && !validationReady && (cached.PreferencesKey != req.Preferences.Key() || cached.Status != "checkout_prepared") {
				cached.Status = "checkout_review_required"
			}
			writeJSON(w, http.StatusOK, cached)
		} else {
			writeJSON(w, http.StatusConflict, map[string]string{"code": "checkout_uncertain", "error": "A checkout was already attempted. Open the item in Vinted to continue; it will not be retried automatically."})
		}
		return
	}
	if !req.BrowserPrepareOnly {
		if !req.Preferences.FullCheckoutEnabled(req.Domain) {
			writeJSON(w, http.StatusConflict, map[string]string{"code": "FULL_CHECKOUT_REQUIRED", "error": "Request checkout requires Full checkout with explicit automatic-payment consent and a spending limit. Use the browser session method for normal Oneclick."})
			return
		}
		state := s.checkoutContextState(sess)
		// A chain started seconds before the token expires would stop half
		// way with a claimed item. Ask for a fresh session up front instead.
		if state == "ready" && accessTokenExpiresWithin(sess.AccessToken, 90*time.Second) {
			state = "reauth_required"
		}
		if state == "ready" {
			cooling, coolErr := s.sessions.CheckoutCooldownActive(sess)
			if coolErr != nil {
				state = "unavailable"
			} else if cooling {
				writeJSON(w, http.StatusTooManyRequests, map[string]string{"code": "vinted_rate_limited", "error": "Vinted limited checkout requests a moment ago. Wait a minute before using a buy link again. Nothing was sent for this item."})
				return
			}
		}
		if state != "ready" {
			code, message, status := "server_checkout_sync_required", "Sync server checkout context in Account before using experimental server checkout.", http.StatusConflict
			if state == "blocked" {
				code, message = "server_checkout_context_rejected", "Vinted blocked this request checkout session. Your browser may still work. Syncing again does not guarantee request access. You can select the browser session method in Account."
			} else if state == "reauth_required" {
				code, message = "server_checkout_reauth_required", "Sign in to Vinted again, then sync checkout context in Account."
			} else if state == "unavailable" {
				code, message, status = "server_checkout_unavailable", "Checkout session status is temporarily unavailable.", http.StatusServiceUnavailable
			}
			writeJSON(w, status, map[string]string{"code": code, "error": message})
			return
		}
	}
	var client *vinted.Client
	var checkoutProxy string
	if !req.BrowserPrepareOnly {
		if !s.checkoutDevDirect {
			checkoutProxy, err = s.sessions.CheckoutProxy(sess)
			if err != nil {
				status, code := http.StatusServiceUnavailable, "checkout_proxy_unavailable"
				if errors.Is(err, session.ErrCheckoutProxyRequired) {
					status, code = http.StatusConflict, "checkout_proxy_required"
				}
				writeJSON(w, status, map[string]string{"code": code, "error": "Select an available proxy group you own in Account before using request checkout."})
				return
			}
		}
		// Do not use getSessionAndClient: it warms up and may refresh over the
		// shared server network before returning. Checkout must stay on its proxy.
		current, sessionErr := s.sessions.Get(sess.UserID)
		if sessionErr != nil || current == nil || current.VintedUserID != sess.VintedUserID || current.Domain != sess.Domain || current.LinkedAt != sess.LinkedAt {
			writeError(w, "linked Vinted account changed or unavailable; reload checkout", http.StatusConflict)
			return
		}
		preferencesJSON, _ := json.Marshal(req.Preferences)
		authorized, authErr := s.sessions.CheckoutPaymentAuthorized(sess, preferencesJSON, "server")
		if authErr != nil || !authorized {
			writeJSON(w, http.StatusConflict, map[string]string{"code": "FULL_CHECKOUT_REQUIRED", "error": "Enable and save Full checkout with payment consent and a spending limit before using request checkout."})
			return
		}
		newCheckoutClient := s.newCheckoutClient
		if newCheckoutClient == nil && s.checkoutDevDirect {
			newCheckoutClient = func(clientSession *session.VintedSession, _ string) (*vinted.Client, error) {
				return vinted.NewClient(clientSession)
			}
		}
		if newCheckoutClient == nil {
			newCheckoutClient = vinted.NewCheckoutClient
		}
		client, err = newCheckoutClient(sessionForServerSideClient(sess), checkoutProxy)
		if err != nil {
			writeJSON(w, http.StatusConflict, map[string]string{"code": "checkout_proxy_invalid", "error": "Update the first proxy in your checkout proxy group before continuing."})
			return
		}
		if err = client.WarmUp(); err != nil {
			payload, status := checkoutFailureResponse(err)
			if vinted.ContextRejected(err) {
				_ = s.sessions.BlockCheckoutContext(sess)
			}
			writeJSON(w, status, payload)
			return
		}
	}
	if req.Preferences.AutoCheckout != nil && !req.StopBeforePayment {
		transport := "server"
		if req.BrowserPrepareOnly {
			transport = "browser"
		}
		preferencesJSON, _ := json.Marshal(req.Preferences)
		authorized, authErr := s.sessions.CheckoutPaymentAuthorized(sess, preferencesJSON, transport)
		if authErr != nil {
			writeError(w, "payment authorization unavailable", http.StatusServiceUnavailable)
			return
		}
		if !authorized {
			writeJSON(w, http.StatusConflict, map[string]string{"code": "checkout_settings_changed", "error": "Checkout settings or payment consent changed. Reload the buy link."})
			return
		}
		reserved, reserveErr := s.sessions.ReserveAutoCheckout(sess, req.ItemID, token)
		if reserveErr != nil {
			writeError(w, "payment authorization unavailable", http.StatusServiceUnavailable)
			return
		}
		if !reserved {
			writeJSON(w, http.StatusConflict, map[string]string{"code": "payment_already_attempted", "error": "Auto-checkout was already attempted for this item. Check Vinted; it will not be repeated automatically."})
			return
		}
		if req.BrowserPrepareOnly {
			writeJSON(w, http.StatusOK, map[string]bool{"browser_payment_authorized": true})
			return
		}
	}
	save := func(link session.CheckoutLink) error {
		if r.Context().Err() != nil && !paymentOutcomeStatus(link.Status) && link.Status != "paypal_redirect_ready" {
			return errors.New("checkout request ended; no further checkout step started")
		}
		switch link.Status {
		case "transaction_creating", "checkout_building", "checkout_updating", "checkout_selecting_preferences", "payment_starting":
			current, err := s.sessions.Get(sess.UserID)
			if err != nil || current == nil || current.VintedUserID != sess.VintedUserID || current.Domain != sess.Domain || current.LinkedAt != sess.LinkedAt {
				return errors.New("linked account changed or unavailable; no further checkout step sent")
			}
		}
		if link.Status == "payment_starting" {
			if !s.checkoutDevDirect {
				currentProxy, proxyErr := s.sessions.CheckoutProxy(sess)
				if proxyErr != nil || currentProxy != checkoutProxy {
					return errors.New("checkout proxy changed or unavailable; no payment sent")
				}
			}
			preferencesJSON, _ := json.Marshal(req.Preferences)
			authorized, authErr := s.sessions.CheckoutPaymentAuthorized(sess, preferencesJSON, "server")
			if authErr != nil || !authorized {
				return errors.New("payment settings changed or authorization unavailable; no payment sent")
			}
		}
		terminal := paymentOutcomeStatus(link.Status) || link.Status == "paypal_redirect_ready"
		if terminal && req.Preferences.AutoCheckout != nil && !req.StopBeforePayment {
			// Preserve the actual outcome even if Redis disappeared after
			// payment. The durable owner token still fences this attempt.
			if err := s.sessions.SaveAutoCheckoutResult(sess, token, link); err != nil {
				return err
			}
			_ = s.sessions.SaveCheckoutPreparation(sess, token, link)
			return nil
		}
		if err := s.sessions.SaveCheckoutPreparation(sess, token, link); err != nil {
			return err
		}
		if req.Preferences.AutoCheckout != nil && !req.StopBeforePayment {
			return s.sessions.SaveAutoCheckoutResult(sess, token, link)
		}
		return nil
	}
	var link *session.CheckoutLink
	if req.StopBeforePayment {
		link, err = client.ValidateCheckout(req.ItemID, req.SellerID, save, req.Preferences)
	} else {
		link, err = client.PrepareCheckout(req.ItemID, req.SellerID, save, req.Preferences)
	}
	// The refresh token is deliberately withheld from a server-side client;
	// that must not look like a session change, and a failed checkout must
	// not mark the session healthy.
	clientSession := sessionForServerSideClient(sess)
	if err != nil && link != nil && (paymentOutcomeStatus(link.Status) || link.Status == "paypal_redirect_ready") {
		// The payment request was answered; only its checkpoint could not be
		// written. Report what happened instead of a preparation failure. A
		// later reopen finds payment_starting and reports an unknown outcome.
		log.Printf("[checkout] payment outcome checkpoint failed after the payment request; outcome returned once")
		err = nil
	}
	if err != nil {
		s.persistSessionIfChanged(clientSession, client.GetSession(), false)
		payload, status := checkoutFailureResponse(err)
		if payload["failed_step"] == "unknown" && link != nil {
			payload["failed_step"] = checkoutStepForStatus(link.Status)
		}
		if link != nil && link.Status == "payment_starting" && payload["code"] == "checkout_failed" {
			// The payment checkpoint was refused, so the request was never sent.
			payload["code"] = "checkout_stopped_before_payment"
			payload["error"] = "Checkout stopped before payment because your settings, proxy or session changed, or the request ended. No payment was sent. Review the checkout in Vinted."
		}
		contextRejected := vinted.ContextRejected(err)
		if contextRejected {
			_ = s.sessions.BlockCheckoutContext(sess)
			_ = s.sessions.BlockCheckoutContext(client.GetSession())
		}
		rateLimited := vinted.UpstreamStatus(err) == http.StatusTooManyRequests
		if rateLimited {
			_ = s.sessions.StartCheckoutCooldown(sess)
		}
		upstreamStatus := vinted.UpstreamStatus(err)
		var authFailure *vinted.AuthError
		tokenRejected := errors.As(err, &authFailure) || upstreamStatus == http.StatusUnauthorized
		if tokenRejected {
			// Never offer a token again that Vinted just rejected: the next
			// buy link is answered locally until the browser syncs a new one.
			s.markCheckoutSessionNeedsSync(sess)
		}
		if checkoutAttemptReleasable(link, err) {
			// Bounded: a refusal must not be repeated against Vinted by
			// tapping the link again and again. After a rejected token, a
			// rejected context or an explicit 403 the attempt is released but
			// another tap is not invited.
			if allowed, allowErr := s.sessions.AllowCheckoutRelease(sess, req.ItemID); allowErr == nil && allowed &&
				s.sessions.ReleaseCheckoutAttempt(sess, req.ItemID, token) == nil &&
				!contextRejected && !tokenRejected && upstreamStatus != http.StatusForbidden {
				payload["retryable"] = true
				if rateLimited {
					payload["error"] = fmt.Sprint(payload["error"]) + " Nothing was started for this item; wait a minute before using the buy link again."
				} else {
					payload["error"] = fmt.Sprint(payload["error"]) + " Nothing was started for this item, so the buy link can be used again."
				}
			}
		}
		writeJSON(w, status, payload)
		return
	}
	s.persistIfRefreshed(clientSession, client)
	if link.RateLimited {
		// A rate limit on a later step pauses request checkout just like one
		// on the first step, although this run still reports its own result.
		_ = s.sessions.StartCheckoutCooldown(sess)
	}
	if link.ServerContextRejected {
		_ = s.sessions.BlockCheckoutContext(sess)
		_ = s.sessions.BlockCheckoutContext(client.GetSession())
	}
	if link.Status == "paypal_redirect_ready" && link.PaymentURL != "" {
		if !validAgentPayPalURL(link.PaymentURL) {
			link.PaymentURL = ""
		} else if s.sessions.SaveCheckoutPaymentHandoff(sess, req.ItemID, link.PaymentURL) != nil {
			log.Printf("[checkout] PayPal approval link could not be kept for reopening")
		}
	}
	historyLink := *link
	historyLink.PaymentURL = ""
	s.storeCheckoutLink(getUserID(r), sess, historyLink)
	writeJSON(w, http.StatusOK, link)
}

func (s *Server) markCheckoutSessionNeedsSync(sess *session.VintedSession) {
	if sess == nil || !sess.BrowserLinked {
		return
	}
	updated := *sess
	updated.Status = "needs_browser_sync"
	updated.InvalidReason = "browser_session_validation_failed"
	updated.LastCheck = time.Now().UTC().Format(time.RFC3339)
	if _, err := s.sessions.StoreIfCurrent(*sess, updated); err != nil {
		log.Printf("[checkout] could not mark the rejected session for a browser sync")
	}
}

// Vinted created nothing when no request was sent at all, when the proxy
// connection failed before sending, or when Vinted answered the first request
// of the chain with an explicit 4xx refusal. Timeouts, resets, redirects and
// 5xx stay claimed: their effect is unknown.
func checkoutAttemptReleasable(link *session.CheckoutLink, err error) bool {
	if err == nil {
		return false
	}
	if link == nil {
		return true
	}
	if link.Status != "transaction_creating" || link.TransactionID != 0 {
		return false
	}
	// A dead or misconfigured proxy fails before any byte reaches Vinted.
	var transport *vinted.TransportError
	if errors.As(err, &transport) {
		return transport.BeforeSend
	}
	upstream := vinted.UpstreamStatus(err)
	return upstream >= 400 && upstream < 500
}

func checkoutStepForStatus(status string) string {
	switch status {
	case "transaction_creating":
		return "transaction"
	case "checkout_building":
		return "build"
	case "checkout_updating", "checkout_selecting_preferences":
		return "update"
	default:
		return "unknown"
	}
}

// Keep diagnostics useful without exposing upstream response text or IDs.
func checkoutFailureResponse(err error) (map[string]interface{}, int) {
	code, message, status := "checkout_failed", "Vinted could not prepare checkout. Open the item in Vinted to continue.", http.StatusBadGateway
	upstream := vinted.UpstreamStatus(err)
	var auth *vinted.AuthError
	var challenge *vinted.DataDomeChallengeError
	var transport *vinted.TransportError
	switch {
	case errors.As(err, &auth):
		code, message, status = "invalid_authentication_token", "Reconnect your Vinted account before preparing checkout.", http.StatusUnauthorized
	case errors.As(err, &transport):
		code, message = "checkout_network_failed", "Your checkout proxy or the network did not answer. Check the proxy group in Account, and check Vinted before trying this item again."
		switch {
		case transport.Kind == "proxy_refused_407":
			code, message = "checkout_proxy_auth_failed", "Your checkout proxy rejected its username or password. Update the first proxy in your checkout proxy group."
		case transport.Kind == "proxy_refused_402":
			code, message = "checkout_proxy_unpaid", "Your proxy provider answered \"payment required\": the plan behind the first proxy in your checkout proxy group has no balance or has expired. Top it up or select another proxy group."
		case strings.HasPrefix(transport.Kind, "proxy_refused"):
			code, message = "checkout_proxy_refused", "Your checkout proxy refused to open the connection to Vinted. Check that the first proxy in your checkout proxy group is active and allows this site."
		case transport.Kind == "proxy_unreachable":
			code, message = "checkout_proxy_unreachable", "Your checkout proxy could not be reached. Check that the first proxy in your checkout proxy group is online."
		case transport.Kind == "proxy_address_not_public":
			code, message = "checkout_proxy_invalid", "Your checkout proxy resolves to a private or reserved address, which is not allowed. Update the first proxy in your checkout proxy group."
		}
	case upstream >= 300 && upstream < 400:
		code, message = "vinted_redirected", "Vinted redirected the checkout request instead of answering it. Open the item in Vinted to continue."
	case errors.As(err, &challenge):
		code, message, status = "vinted_security_check", "Vinted requires a security check for request checkout. Open Vinted in your browser; if no check appears there, request checkout is still unavailable. You can select the browser session method in Account.", http.StatusConflict
	case upstream == http.StatusUnauthorized:
		code, message, status = "invalid_authentication_token", "Reconnect your Vinted account before preparing checkout.", http.StatusUnauthorized
	case upstream == http.StatusForbidden:
		code, message, status = "vinted_checkout_rejected", "Vinted rejected this checkout request. Continue in Vinted; do not repeatedly start checkout.", http.StatusConflict
	case upstream == http.StatusTooManyRequests:
		code, message, status = "vinted_rate_limited", "Vinted is limiting requests. Wait before continuing in Vinted.", http.StatusTooManyRequests
	case upstream >= 500:
		code, message = "vinted_unavailable", "Vinted is temporarily unavailable. Check Vinted before starting checkout again."
	}
	// Known account-level refusals from Vinted's own error enum get a message
	// the member can act on. The enum value is fixed text, never upstream prose.
	var refusal *vinted.UpstreamHTTPError
	if errors.As(err, &refusal) && refusal.APIError {
		switch refusal.MessageCode {
		case "outdated_terms_and_conditions":
			code, message, status = "vinted_terms_outdated", "Vinted asks this account to accept its updated terms and conditions before it can buy. Open Vinted, accept them there, then use the buy link again.", http.StatusConflict
		}
	}
	payload := map[string]interface{}{"code": code, "error": message, "failed_step": vinted.CheckoutFailureStep(err)}
	if upstream >= 400 && upstream <= 599 {
		payload["upstream_status"] = upstream
	}
	return payload, status
}

// Completed and uncertain payments remain factual outcomes even if the user's
// saved preferences have since changed. Reopening must never resend payment.
func paymentOutcomeStatus(status string) bool {
	switch status {
	case "card_payment_confirmed", "card_payment_pending", "card_payment_failed", "payment_outcome_unknown", "card_authentication_required":
		return true
	default:
		return false
	}
}
