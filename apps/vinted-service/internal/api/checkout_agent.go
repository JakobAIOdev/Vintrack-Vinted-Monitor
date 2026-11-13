package api

import (
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"vintrack-vinted/internal/session"
	"vintrack-vinted/internal/vinted"
)

// agentQueueAge is how long a queued job may wait for its device. Delivery,
// the status view and job replacement share this one limit.
const agentQueueAge = 2 * time.Minute

// agentStaleAfter is how long a claimed job may go without a checkpoint
// before it is reported as stopped.
const agentStaleAfter = 90 * time.Second

// agentPairingMismatch tells the device that its pairing no longer belongs to
// the linked account. It is the only refusal that needs a new pairing.
const agentPairingMismatch = "agent_pairing_mismatch"

const agentPaymentUnknownReason = "A payment request may already have been sent. Check Vinted; do not start it again."

var agentTokenPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

func decodeAgentBody(w http.ResponseWriter, r *http.Request, target interface{}) bool {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64*1024))
	decoder.DisallowUnknownFields()
	if decoder.Decode(target) != nil || decoder.Decode(&struct{}{}) != io.EOF {
		writeError(w, "invalid agent request", 400)
		return false
	}
	return true
}
func (s *Server) handleAgentPairCode(w http.ResponseWriter, r *http.Request) {
	user := getUserID(r)
	if user == "" {
		writeError(w, "unauthorized", 401)
		return
	}
	if !s.requireFeature(w, user, "checkout_links") || !s.requireCheckoutConsent(w, user) {
		return
	}
	sess, err := s.sessions.Get(user)
	if err != nil || sess == nil {
		writeError(w, "link your Vinted account first", 409)
		return
	}
	code, err := s.sessions.CreateAgentPairCode(sess)
	if err != nil {
		writeError(w, "agent pairing unavailable; check database migrations", 503)
		return
	}
	writeJSON(w, 200, map[string]interface{}{"code": code, "expiresInSeconds": 300})
}
func (s *Server) handleAgentPair(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Code string `json:"code"`
	}
	if !decodeAgentBody(w, r, &req) {
		return
	}
	device, token, err := s.sessions.ExchangeAgentPairCode(req.Code)
	if err != nil || device == nil {
		writeError(w, "pairing code is invalid, expired, or account access changed", 401)
		return
	}
	writeJSON(w, 200, map[string]interface{}{"token": token, "accountId": device.AccountID, "domain": device.Domain})
}
func (s *Server) handleAgentStatus(w http.ResponseWriter, r *http.Request) {
	user := getUserID(r)
	if user == "" {
		writeError(w, "unauthorized", 401)
		return
	}
	device, err := s.sessions.AgentForUser(user)
	if err != nil {
		writeJSON(w, 200, map[string]interface{}{"available": false, "paired": false, "online": false})
		return
	}
	sess, err := s.sessions.Get(user)
	paired := err == nil && device != nil && device.Matches(sess)
	writeJSON(w, 200, map[string]interface{}{"available": true, "paired": paired, "online": paired && device.Online()})
}
func (s *Server) handleAgentRevoke(w http.ResponseWriter, r *http.Request) {
	user := getUserID(r)
	if user == "" {
		writeError(w, "unauthorized", 401)
		return
	}
	if s.sessions.RevokeAgent(user) != nil {
		writeError(w, "agent revoke unavailable", 503)
		return
	}
	writeJSON(w, 200, map[string]bool{"revoked": true})
}

// Only a missing or unknown credential answers 401, and only a pairing that no
// longer matches the linked account answers 409. A storage failure answers
// 503 so a running agent waits instead of giving up its pairing.
func (s *Server) authenticateAgent(w http.ResponseWriter, r *http.Request) (*session.CheckoutAgentDevice, *session.VintedSession, bool) {
	token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !ok || !agentTokenPattern.MatchString(token) {
		writeError(w, "agent authorization required", 401)
		return nil, nil, false
	}
	device, err := s.sessions.AuthenticateAgent(token)
	if err != nil {
		writeError(w, "agent authorization storage unavailable", 503)
		return nil, nil, false
	}
	if device == nil {
		writeError(w, "agent authorization expired or revoked", 401)
		return nil, nil, false
	}
	sess, err := s.sessions.Get(device.UserID)
	if err != nil {
		writeError(w, "account session storage unavailable", 503)
		return nil, nil, false
	}
	if !device.Matches(sess) {
		writeJSON(w, 409, map[string]string{"code": agentPairingMismatch, "error": "linked account changed; pair the agent again"})
		return nil, nil, false
	}
	return device, sess, true
}
func (s *Server) handleEnqueueAgentCheckout(w http.ResponseWriter, r *http.Request) {
	var spec session.CheckoutAgentSpec
	if !decodeAgentBody(w, r, &spec) {
		return
	}
	user := getUserID(r)
	if user == "" {
		writeError(w, "unauthorized", 401)
		return
	}
	if !s.requireFeature(w, user, "checkout_links") || !s.requireCheckoutConsent(w, user) {
		return
	}
	sess, err := s.sessions.Get(user)
	if err != nil || sess == nil || spec.AccountID != sess.VintedUserID || spec.Domain != sess.Domain || spec.ItemID <= 0 || spec.SellerID <= 0 || spec.SellerID == sess.VintedUserID {
		writeError(w, "checkout target or linked account changed", 409)
		return
	}
	var preferences vinted.CheckoutPreferences
	if json.Unmarshal(spec.Preferences, &preferences) != nil || !preferences.Valid() {
		writeError(w, "invalid checkout preferences", 400)
		return
	}
	// The pause after a Vinted rate limit covers every request transport.
	if cooling, coolErr := s.sessions.CheckoutCooldownActive(sess); coolErr != nil {
		writeError(w, "checkout preparation unavailable", http.StatusServiceUnavailable)
		return
	} else if cooling {
		writeJSON(w, http.StatusTooManyRequests, map[string]string{"code": "vinted_rate_limited", "error": "Vinted limited checkout requests a moment ago. Wait a minute before using a buy link again. Nothing was sent for this item."})
		return
	}
	if !preferences.FullCheckoutEnabled(spec.Domain) {
		writeJSON(w, http.StatusConflict, map[string]string{"code": "FULL_CHECKOUT_REQUIRED", "error": "Request checkout requires Full checkout with explicit automatic-payment consent and a spending limit."})
		return
	}
	authorized, err := s.sessions.CheckoutPaymentAuthorized(sess, spec.Preferences, "agent")
	if err != nil || !authorized {
		writeError(w, "saved agent checkout settings changed or are unavailable", 409)
		return
	}
	existing, err := s.sessions.ExistingAgentJob(sess, spec.ItemID)
	if err != nil {
		writeError(w, "agent storage unavailable", 503)
		return
	}
	device, err := s.sessions.AgentForUser(user)
	if err != nil || device == nil || !device.Matches(sess) {
		device = nil
	}
	queued := func(job *session.CheckoutAgentJob) {
		writeJSON(w, 202, map[string]string{"job_id": job.ID, "status": "agent_queued"})
	}
	// A job that may have reached Vinted is the answer for its item forever.
	// Only a job that provably never did can make room for a new one.
	if existing != nil && !session.AgentJobReplaceable(existing, device, agentQueueAge) {
		queued(existing)
		return
	}
	if device == nil || !device.Online() {
		writeError(w, "start your paired checkout agent before opening a buy link", 409)
		return
	}
	blocked, blockedErr := s.sessions.CheckoutContextBlocked(agentContextSession(sess, device))
	if blockedErr != nil || blocked {
		writeError(w, "sync fresh local checkout context before restarting the agent", 409)
		return
	}
	if !hasCheckoutContext(sess) || accessTokenExpired(sess.AccessToken) {
		writeError(w, "sync fresh checkout session context in Account first", 409)
		return
	}
	lock, acquired, err := s.sessions.AcquireCheckoutPreparation(sess, spec.ItemID)
	if err != nil || !acquired {
		writeError(w, "checkout is already running or its lock is unavailable", 409)
		return
	}
	defer s.sessions.ReleaseCheckoutPreparation(sess, spec.ItemID, lock)
	// Decide on the job as it is now that no other enqueue can run.
	existing, err = s.sessions.ExistingAgentJob(sess, spec.ItemID)
	if err != nil {
		writeError(w, "agent storage unavailable", 503)
		return
	}
	cached, err := s.sessions.GetCheckoutPreparation(sess, spec.ItemID)
	if err != nil {
		writeError(w, "checkout history unavailable", 503)
		return
	}
	// "agent_queued" is this handler's own marker. Under the preparation lock
	// it belongs to the replaceable job or to a queue attempt that never
	// inserted a job. Any other record is a real earlier attempt, including a
	// payment claim taken when a job was delivered.
	if cached != nil && cached.Status != "agent_queued" {
		if existing != nil {
			queued(existing)
			return
		}
		writeError(w, "a checkout was already attempted; check Vinted before continuing", 409)
		return
	}
	if existing != nil {
		replaced, err := s.sessions.ReplaceAgentJob(sess, device, existing, agentQueueAge)
		if err != nil {
			writeError(w, "agent queue unavailable", 503)
			return
		}
		if !replaced {
			queued(existing)
			return
		}
	}
	// Record the attempt before the job can be claimed. Once the job exists
	// this handler only answers with its id, never with an error.
	if err := s.sessions.SaveCheckoutPreparation(sess, lock, session.CheckoutLink{ItemID: spec.ItemID, SellerID: spec.SellerID, Status: "agent_queued", PreferencesKey: preferences.Key()}); err != nil {
		writeError(w, "agent queue unavailable; nothing was queued", 503)
		return
	}
	job, err := s.sessions.EnqueueAgentJob(sess, device, spec)
	if err != nil || job == nil {
		// Nothing was queued, so the marker must not block the next tap. It is
		// removed only while this request still holds the preparation lock.
		_ = s.sessions.ReleaseCheckoutAttempt(sess, spec.ItemID, lock)
		writeError(w, "agent queue unavailable; nothing was queued", 503)
		return
	}
	queued(job)
}
func (s *Server) handleAgentNext(w http.ResponseWriter, r *http.Request) {
	device, sess, ok := s.authenticateAgent(w, r)
	if !ok {
		return
	}
	if !s.requireFeature(w, device.UserID, "checkout_links") || !s.requireCheckoutConsent(w, device.UserID) {
		return
	}
	if s.sessions.TouchAgent(device) != nil {
		writeError(w, "agent unavailable", 503)
		return
	}
	// The poll carries no input. Reading its small body to the end lets the
	// server notice a dropped connection and cancel the request context, so an
	// abandoned long poll stops instead of claiming a job for nobody.
	_, _ = io.Copy(io.Discard, http.MaxBytesReader(w, r.Body, 64*1024))
	job, err := s.sessions.ClaimAgentJob(r.Context(), device)
	if err != nil {
		writeError(w, "agent queue unavailable", 503)
		return
	}
	if job == nil {
		w.WriteHeader(204)
		return
	}
	// A rejection concerns this one job. It is stored on the job, which was
	// never delivered, and the device simply polls again.
	reject := func(message string) {
		_ = s.sessions.CloseUnstartedAgentJob(device, job, session.CheckoutLink{ItemID: job.Spec.ItemID, SellerID: job.Spec.SellerID, Domain: job.Spec.Domain, Status: "checkout_review_required", AutoCheckoutReason: message})
		w.WriteHeader(204)
	}
	if job.Age > agentQueueAge {
		reject("queued checkout expired; no payment started")
		return
	}
	currentDevice, authErr := s.sessions.AuthenticateAgent(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
	if authErr != nil {
		reject("agent authorization could not be verified; no checkout started")
		return
	}
	if currentDevice == nil || currentDevice.ID != device.ID {
		_ = s.sessions.CloseUnstartedAgentJob(device, job, session.CheckoutLink{ItemID: job.Spec.ItemID, SellerID: job.Spec.SellerID, Domain: job.Spec.Domain, Status: "checkout_review_required", AutoCheckoutReason: "agent was revoked; no checkout started"})
		writeError(w, "agent authorization expired or revoked", 401)
		return
	}
	// Reload credentials after the long poll. Never send a stale or other-account session.
	sess, err = s.sessions.Get(device.UserID)
	if err != nil || !device.Matches(sess) || !hasCheckoutContext(sess) || accessTokenExpired(sess.AccessToken) {
		reject("fresh account session context is required")
		return
	}
	authorized, err := s.sessions.CheckoutPaymentAuthorized(sess, job.Spec.Preferences, "agent")
	if err != nil || !authorized {
		reject("saved checkout settings changed; no payment started")
		return
	}
	var preferences vinted.CheckoutPreferences
	if json.Unmarshal(job.Spec.Preferences, &preferences) != nil || !preferences.Valid() {
		reject("invalid saved checkout preferences")
		return
	}
	if !preferences.FullCheckoutEnabled(job.Spec.Domain) {
		reject("request checkout requires Full checkout; no checkout started")
		return
	}
	if preferences.AutoCheckout != nil && !job.Spec.StopBeforePayment {
		claimed, err := s.sessions.ReserveAutoCheckout(sess, job.Spec.ItemID, job.ID)
		if err != nil || !claimed {
			reject("payment was already attempted or durable authorization is unavailable")
			return
		}
	}
	// Only checkout-scoped values leave the existing encrypted session store.
	ephemeral := session.VintedSession{VintedUserID: sess.VintedUserID, Domain: sess.Domain, AccessToken: sess.AccessToken, UserAgent: sess.UserAgent, CsrfToken: sess.CsrfToken, AnonID: extractCookieValue(sess.CookieHeader, "anon_id"), CookieHeader: agentCookieHeader(sess.CookieHeader), BrowserLinked: true, WarmedAt: sess.WarmedAt}
	writeJSON(w, 200, map[string]interface{}{"id": job.ID, "spec": job.Spec, "session": ephemeral})
}

// agentCookieHeader delivers the same four allowlisted cookies as the server
// path, in the order browserCheckoutContext.apply stores them, and nothing
// else from the stored cookie header.
func agentCookieHeader(stored string) string {
	parts := make([]string, 0, 4)
	for _, name := range []string{"datadome", "anon_id", "_vinted_fr_session", "v_udt"} {
		if value := extractCookieValue(stored, name); value != "" {
			parts = append(parts, name+"="+value)
		}
	}
	return strings.Join(parts, "; ")
}
func validAgentCheckoutURL(raw, domain string) bool {
	u, err := url.Parse(raw)
	return err == nil && u.Scheme == "https" && u.Host == domain && u.User == nil && u.Path == "/checkout" && u.Fragment == ""
}
func validAgentPayPalURL(raw string) bool {
	u, err := url.Parse(raw)
	return err == nil && u.Scheme == "https" && (u.Host == "www.paypal.com" || u.Host == "paypal.com") && u.User == nil && u.Fragment == "" && (u.Path == "/checkoutnow" || u.Path == "/webscr" || u.Path == "/cgi-bin/webscr")
}

const (
	// agentRankStarted precedes the first Vinted request of any kind.
	agentRankStarted = iota + 1
	// agentRankTransaction precedes the first checkout mutation.
	agentRankTransaction
	agentRankBuilding
	agentRankUpdating
	agentRankPrepared
	// agentRankPaymentStarting precedes the payment request.
	agentRankPaymentStarting
	agentRankOutcome
)

func agentCheckpointRank(status string) int {
	switch status {
	case "agent_started":
		return agentRankStarted
	case "transaction_creating":
		return agentRankTransaction
	case "checkout_building":
		return agentRankBuilding
	case "checkout_updating", "checkout_selecting_preferences":
		return agentRankUpdating
	case "checkout_prepared", "checkout_review_required", "payment_ready":
		return agentRankPrepared
	case "payment_starting":
		return agentRankPaymentStarting
	case "card_payment_confirmed", "card_payment_pending", "card_payment_failed", "card_authentication_required", "payment_outcome_unknown", "paypal_redirect_ready":
		return agentRankOutcome
	}
	return 0
}
func (s *Server) handleAgentCheckpoint(w http.ResponseWriter, r *http.Request) {
	device, sess, ok := s.authenticateAgent(w, r)
	if !ok {
		return
	}
	var req struct {
		JobID    string               `json:"job_id"`
		Link     session.CheckoutLink `json:"link"`
		Complete bool                 `json:"complete"`
		// RateLimited reports a 429 from Vinted on the device.
		RateLimited bool `json:"rate_limited"`
	}
	if !decodeAgentBody(w, r, &req) {
		return
	}
	if req.RateLimited {
		_ = s.sessions.StartCheckoutCooldown(sess)
	}
	// A device that is busy with a job is online. Liveness is not a safety
	// property, so a failed stamp never refuses a checkpoint.
	_ = s.sessions.TouchAgent(device)
	job, err := s.sessions.GetAgentJob(device.UserID, req.JobID)
	if err != nil || job == nil || job.DeviceID != device.ID || job.State != "claimed" {
		writeError(w, "agent job is unavailable or already finished", 409)
		return
	}
	rank := agentCheckpointRank(req.Link.Status)
	if req.Link.ItemID != job.Spec.ItemID || req.Link.SellerID != job.Spec.SellerID || req.Link.Domain != job.Spec.Domain || rank == 0 || (req.Link.CheckoutURL != "" && !validAgentCheckoutURL(req.Link.CheckoutURL, job.Spec.Domain)) {
		writeError(w, "invalid agent checkpoint", 400)
		return
	}
	previous := 0
	if job.Result != nil {
		previous = agentCheckpointRank(job.Result.Status)
	}
	if rank < previous {
		writeError(w, "agent checkpoint cannot move backwards", 409)
		return
	}
	var preferences vinted.CheckoutPreferences
	_ = json.Unmarshal(job.Spec.Preferences, &preferences)
	req.Link.PreferencesKey = preferences.Key()
	if rank >= agentRankPaymentStarting && (job.Spec.StopBeforePayment || preferences.AutoCheckout == nil) {
		writeError(w, "payment is forbidden for this checkout", 403)
		return
	}
	// A payment outcome exists only after an acknowledged payment start.
	if rank == agentRankOutcome && previous < agentRankPaymentStarting {
		writeError(w, "payment outcome without an acknowledged payment start", 409)
		return
	}
	if req.Link.Status == "payment_starting" {
		if previous >= agentRankPaymentStarting {
			writeError(w, "payment authorization was already consumed", 409)
			return
		}
		authorized, err := s.sessions.CheckoutPaymentAuthorized(sess, job.Spec.Preferences, "agent")
		if err != nil || !authorized {
			writeError(w, "payment settings changed; no payment is authorized", 409)
			return
		}
	}
	if req.Link.PaymentURL != "" && (!req.Complete || job.Spec.StopBeforePayment || preferences.Payment != "paypal" || req.Link.Status != "paypal_redirect_ready" || !validAgentPayPalURL(req.Link.PaymentURL)) {
		writeError(w, "invalid provider handoff", 400)
		return
	}
	if preferences.AutoCheckout != nil && !job.Spec.StopBeforePayment {
		if err := s.sessions.SaveAutoCheckoutResult(sess, job.ID, req.Link); err != nil {
			writeError(w, "durable payment checkpoint unavailable", 503)
			return
		}
	}
	if req.Link.PaymentURL != "" {
		if s.sessions.SetAgentPaymentHandoff(job, req.Link.PaymentURL) != nil {
			writeError(w, "provider handoff unavailable; check Vinted", 503)
			return
		}
	}
	if req.Link.ServerContextRejected {
		_ = s.sessions.BlockCheckoutContext(agentContextSession(sess, device))
	}
	// The device ended the job before a transaction checkpoint was ever
	// acknowledged, so no checkout mutation can have been sent for it.
	unstarted := req.Complete && previous < agentRankTransaction && req.Link.Status == "checkout_review_required" && req.Link.TransactionID == 0 && req.Link.CheckoutURL == ""
	if unstarted {
		err = s.sessions.CloseUnstartedAgentJob(device, job, req.Link)
	} else {
		err = s.sessions.SaveAgentJob(device, job, &req.Link, req.Complete)
	}
	if err != nil {
		writeError(w, "agent checkpoint unavailable", 503)
		return
	}
	if req.Complete && req.Link.CheckoutURL != "" {
		history := req.Link
		history.PaymentURL = ""
		s.storeCheckoutLink(device.UserID, sess, history)
	}
	writeJSON(w, 200, map[string]bool{"acknowledged": true})
}
func (s *Server) handleAgentJobStatus(w http.ResponseWriter, r *http.Request) {
	user := getUserID(r)
	if user == "" {
		writeError(w, "unauthorized", 401)
		return
	}
	job, err := s.sessions.GetAgentJob(user, r.PathValue("id"))
	if err != nil {
		writeError(w, "agent job unavailable", 503)
		return
	}
	if job == nil {
		writeError(w, "agent job not found", 404)
		return
	}
	state := job.State
	if state == "pending" && job.Age > agentQueueAge {
		state = "expired"
	}
	if state == "claimed" && job.Idle > agentStaleAfter {
		state = "interrupted"
		// From the payment checkpoint on, the device may have sent the payment
		// request. That is an outcome the member must see, not an interruption.
		if job.Result != nil && agentCheckpointRank(job.Result.Status) >= agentRankPaymentStarting {
			state = "complete"
		}
	}
	if state == "complete" && job.Result != nil && job.Result.Status == "payment_starting" {
		job.Result.Status = "payment_outcome_unknown"
		job.Result.AutoCheckoutReason = agentPaymentUnknownReason
	}
	// The notification reports what happened, not whether a link is still held.
	notifiedStatus := ""
	if job.Result != nil {
		notifiedStatus = job.Result.Status
	}
	if state == "complete" && job.Result != nil && job.Result.Status == "paypal_redirect_ready" {
		// The member finishes a started PayPal payment in PayPal. Hand the same
		// approval link back while it is held; this starts no second payment.
		handoff, err := s.sessions.AgentPaymentHandoff(job)
		if err != nil {
			// Do not report the link as gone while its store cannot be read.
			writeError(w, "agent job unavailable", 503)
			return
		}
		if validAgentPayPalURL(handoff) {
			job.Result.PaymentURL = handoff
		} else {
			job.Result.Status = "checkout_review_required"
			job.Result.AutoCheckoutReason = "A PayPal payment was started for this item, but its PayPal link is no longer available. Finish or cancel it in Vinted; it will not be started again automatically."
		}
	}
	var notice interface{}
	if state == "complete" && job.Result != nil && !job.Spec.StopBeforePayment && job.Spec.MonitorID > 0 {
		var preferences vinted.CheckoutPreferences
		_ = json.Unmarshal(job.Spec.Preferences, &preferences)
		method := "oneclick"
		if preferences.AutoCheckout != nil {
			method = "full_checkout"
		}
		notice = map[string]interface{}{"itemId": job.Spec.ItemID, "monitorId": job.Spec.MonitorID, "transactionId": job.Result.TransactionID, "purchaseId": job.Result.PurchaseID, "domain": job.Spec.Domain, "status": notifiedStatus, "method": method, "payment": preferences.Payment}
	}
	writeJSON(w, 200, map[string]interface{}{"state": state, "result": job.Result, "stopped_before_payment": job.Spec.StopBeforePayment, "notification": notice})
}

func agentContextSession(sess *session.VintedSession, device *session.CheckoutAgentDevice) *session.VintedSession {
	copy := *sess
	copy.UserID += ":agent:" + device.ID
	return &copy
}
