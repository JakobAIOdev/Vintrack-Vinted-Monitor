package api

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

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
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&req); err != nil || req.ItemID <= 0 || req.SellerID <= 0 || req.AccountID <= 0 || req.Domain == "" || !req.Preferences.Valid() {
		writeError(w, "valid item_id and seller_id are required", http.StatusBadRequest)
		return
	}
	if req.Preferences.AutoCheckout != nil && req.Domain != "www.vinted.de" && req.Domain != "www.vinted.at" && req.Domain != "www.vinted.be" {
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
	var sess *session.VintedSession
	var client *vinted.Client
	if req.BrowserPrepareOnly {
		// This is a local payment-intent claim. Browser checkout verifies its own
		// current account; no server TLS warmup, refresh or Vinted request belongs
		// on this path.
		var err error
		sess, err = s.sessions.Get(getUserID(r))
		if err != nil {
			writeError(w, "session fetch error", http.StatusInternalServerError)
			return
		}
		if sess == nil {
			writeError(w, "no linked Vinted account", http.StatusNotFound)
			return
		}
		s.canonicalizeSessionDomain(sess)
	} else {
		var ok bool
		sess, client, ok = s.getSessionAndClient(r, w)
		if !ok {
			return
		}
	}
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
		if cached.SellerID != req.SellerID {
			writeError(w, "checkout target changed", http.StatusConflict)
			return
		}
		if cached.CheckoutURL != "" {
			cached.PaymentURL = ""
			if req.Preferences.AutoCheckout != nil || strings.Contains(cached.PreferencesKey, ":auto:") {
				cached.AutoCheckoutReason = "This checkout was already attempted. Continue in Vinted; an automatic payment will not be repeated."
			}
			if cached.PreferencesKey != req.Preferences.Key() || cached.Status != "checkout_prepared" {
				cached.Status = "checkout_review_required"
			}
			writeJSON(w, http.StatusOK, cached)
		} else {
			writeJSON(w, http.StatusConflict, map[string]string{"code": "checkout_uncertain", "error": "A checkout was already attempted. Open the item in Vinted to continue; it will not be retried automatically."})
		}
		return
	}
	if req.Preferences.AutoCheckout != nil {
		reserved, reserveErr := s.sessions.ReserveAutoCheckout(sess, req.ItemID)
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
	link, err := client.PrepareCheckout(req.ItemID, req.SellerID, func(link session.CheckoutLink) error {
		return s.sessions.SaveCheckoutPreparation(sess, token, link)
	}, req.Preferences)
	s.persistIfRefreshed(sess, client)
	if err != nil {
		// Never return raw authenticated responses, request headers or tokens.
		code, message, status := "checkout_failed", "Vinted could not prepare checkout. Open the item in Vinted to continue.", http.StatusBadGateway
		var authErr *vinted.AuthError
		var challengeErr *vinted.DataDomeChallengeError
		if errors.As(err, &authErr) {
			code, message, status = "invalid_authentication_token", "Reconnect your Vinted account before preparing checkout.", http.StatusUnauthorized
		} else if errors.As(err, &challengeErr) {
			code, message, status = "vinted_security_check", "Open Vinted in your browser to complete its security check.", http.StatusConflict
		}
		writeJSON(w, status, map[string]string{"code": code, "error": message})
		return
	}
	historyLink := *link
	historyLink.PaymentURL = ""
	s.storeCheckoutLink(getUserID(r), sess, historyLink)
	writeJSON(w, http.StatusOK, link)
}
