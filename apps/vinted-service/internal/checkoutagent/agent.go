// Package checkoutagent executes one explicitly claimed job on the member's
// network. It never invokes a browser or persists a Vinted session.
package checkoutagent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"vintrack-vinted/internal/session"
	"vintrack-vinted/internal/vinted"
)

var ErrSessionVerification = errors.New("verify the Vinted session and sync checkout context before restarting the agent")

// PairingMismatch is the coordinator's code for a pairing that no longer
// belongs to the linked account. Only a new pairing resolves it.
const PairingMismatch = "agent_pairing_mismatch"

// Fixed member-visible reasons. Upstream text never enters a job result.
const (
	reasonRejectedLocally      = "The agent rejected this job before contacting Vinted."
	reasonSessionRejected      = "Local Vinted session needs verification. No checkout mutation started."
	reasonNotStarted           = "Local checkout stopped before its first checkout request. No checkout step was started."
	reasonPaymentNotAuthorized = "Payment was not acknowledged by Vintrack; no payment request was sent."
	reasonPaymentUnknown       = "A payment request may already have been sent. Check Vinted; do not start it again."
	reasonTermsOutdated        = "Vinted asks this account to accept its updated terms and conditions before it can buy. Open Vinted and accept them there before using buy links again."
)

// reportTimeout bounds a result report that must outlive a stopped run.
const reportTimeout = 15 * time.Second

type Config struct {
	Server string `json:"server"`
	Token  string `json:"token"`
}
type Job struct {
	ID      string                    `json:"id"`
	Spec    session.CheckoutAgentSpec `json:"spec"`
	Session session.VintedSession     `json:"session"`
}
type API struct {
	Config Config
	HTTP   *http.Client
}

// CoordinatorError is a refusal by the coordinator. It carries only the HTTP
// status and an optional machine code, never response text.
type CoordinatorError struct {
	Status int
	Code   string
}

func (e *CoordinatorError) Error() string {
	return "coordinator refused the operation; check Account before retrying"
}

// checkpointError marks a failure to get a checkpoint acknowledged, as
// opposed to a failed Vinted request.
type checkpointError struct{ err error }

func (e *checkpointError) Error() string { return e.err.Error() }
func (e *checkpointError) Unwrap() error { return e.err }

func ValidateOrigin(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return errors.New("server must be an HTTPS origin")
	}
	if u.Scheme == "https" {
		return nil
	}
	ip := net.ParseIP(u.Hostname())
	if u.Scheme == "http" && (u.Hostname() == "localhost" || (ip != nil && ip.IsLoopback())) {
		return nil
	}
	return errors.New("HTTP is permitted only for loopback development servers")
}
func NewAPI(config Config) (*API, error) {
	if ValidateOrigin(config.Server) != nil {
		return nil, errors.New("invalid coordinator origin")
	}
	config.Server = strings.TrimSuffix(config.Server, "/")
	return &API{Config: config, HTTP: &http.Client{Timeout: 40 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}, nil
}

var coordinatorCodePattern = regexp.MustCompile(`^[A-Za-z_]{1,64}$`)

func (a *API) Call(ctx context.Context, path string, input, output interface{}) (int, error) {
	body, _ := json.Marshal(input)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, a.Config.Server+"/api/checkout-agent/"+path, bytes.NewReader(body))
	if err != nil {
		return 0, errors.New("could not create coordinator request")
	}
	req.Header.Set("Content-Type", "application/json")
	if a.Config.Token != "" {
		req.Header.Set("Authorization", "Bearer "+a.Config.Token)
	}
	response, err := a.HTTP.Do(req)
	if err != nil {
		return 0, errors.New("coordinator did not acknowledge the request; no automatic retry")
	}
	defer response.Body.Close()
	if response.StatusCode == 204 {
		return 204, nil
	}
	if response.StatusCode != 200 {
		refusal := &CoordinatorError{Status: response.StatusCode}
		var detail struct {
			Code string `json:"code"`
		}
		if json.NewDecoder(io.LimitReader(response.Body, 4*1024)).Decode(&detail) == nil && coordinatorCodePattern.MatchString(detail.Code) {
			refusal.Code = detail.Code
		}
		return response.StatusCode, refusal
	}
	if output != nil {
		decoder := json.NewDecoder(io.LimitReader(response.Body, 128*1024))
		if decoder.Decode(output) != nil {
			return response.StatusCode, errors.New("coordinator returned an invalid response")
		}
	}
	return response.StatusCode, nil
}
func (a *API) Pair(ctx context.Context, code string) error {
	var result struct {
		Token string `json:"token"`
	}
	_, err := a.Call(ctx, "pair", map[string]string{"code": code}, &result)
	if err != nil {
		return err
	}
	if len(result.Token) != 64 {
		return errors.New("invalid device credential")
	}
	a.Config.Token = result.Token
	return nil
}
func (a *API) Next(ctx context.Context) (*Job, int, error) {
	var job Job
	status, err := a.Call(ctx, "next", nil, &job)
	if err != nil || status == 204 {
		return nil, status, err
	}
	return &job, status, nil
}
func (a *API) Checkpoint(ctx context.Context, j *Job, link session.CheckoutLink, complete bool) error {
	var ack struct {
		Acknowledged bool `json:"acknowledged"`
	}
	body := map[string]interface{}{"job_id": j.ID, "link": link, "complete": complete}
	if link.RateLimited {
		// Lets the coordinator pause request checkout for this member.
		body["rate_limited"] = true
	}
	_, err := a.Call(ctx, "checkpoint", body, &ack)
	if err != nil {
		return err
	}
	if !ack.Acknowledged {
		return errors.New("checkpoint was not acknowledged")
	}
	return nil
}

// report delivers a result that must reach the coordinator even when the run
// was stopped meanwhile: a payment outcome or the end of a job. It only talks
// to the coordinator and never causes a Vinted request.
func (a *API) report(ctx context.Context, j *Job, link session.CheckoutLink, complete bool) error {
	detached, cancel := context.WithTimeout(context.WithoutCancel(ctx), reportTimeout)
	defer cancel()
	return a.Checkpoint(detached, j, link, complete)
}

type Executor interface {
	GetAccountInfo() (*vinted.AccountInfo, error)
	PrepareCheckout(int64, int64, func(session.CheckoutLink) error, ...vinted.CheckoutPreferences) (*session.CheckoutLink, error)
	ValidateCheckout(int64, int64, func(session.CheckoutLink) error, vinted.CheckoutPreferences) (*session.CheckoutLink, error)
}
type Factory func(*session.VintedSession) (Executor, error)

var domainPattern = regexp.MustCompile(`^www\.vinted\.(at|be|co\.uk|com|cz|de|dk|es|fi|fr|hr|hu|ie|it|lt|lu|nl|pl|pt|ro|se|sk)$`)
var jobIDPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

// contextCookies are the only cookies a job may carry: the checkout context
// the member chose to sync, the same four the server path uses.
var contextCookies = map[string]bool{"datadome": true, "anon_id": true, "_vinted_fr_session": true, "v_udt": true}

func ValidateJob(job *Job) (vinted.CheckoutPreferences, error) {
	var p vinted.CheckoutPreferences
	if job == nil || len(job.ID) != 64 || !domainPattern.MatchString(job.Spec.Domain) || job.Session.Domain != job.Spec.Domain || job.Session.VintedUserID != job.Spec.AccountID || job.Spec.AccountID <= 0 || job.Spec.ItemID <= 0 || job.Spec.SellerID <= 0 || job.Spec.SellerID == job.Spec.AccountID || job.Session.AccessToken == "" || job.Session.RefreshToken != "" || job.Session.CsrfToken == "" || job.Session.UserAgent == "" || json.Unmarshal(job.Spec.Preferences, &p) != nil || !p.Valid() {
		return p, errors.New("job account, session or preferences could not be verified")
	}
	if !jobIDPattern.MatchString(job.ID) || strings.ContainsAny(job.Session.CookieHeader+job.Session.AccessToken+job.Session.CsrfToken+job.Session.UserAgent, "\r\n") {
		return p, errors.New("invalid checkout session headers")
	}
	if !p.FullCheckoutEnabled(job.Spec.Domain) {
		return p, errors.New("request checkout requires Full checkout with automatic-payment consent and a spending limit")
	}
	cookies := (&http.Request{Header: http.Header{"Cookie": []string{job.Session.CookieHeader}}}).Cookies()
	hasContext := false
	for _, cookie := range cookies {
		if !contextCookies[cookie.Name] {
			return p, errors.New("unrelated browser cookies are forbidden")
		}
		if cookie.Name == "datadome" && cookie.Value != "" {
			hasContext = true
		}
	}
	if !hasContext {
		return p, errors.New("checkout context cookie is required")
	}
	return p, nil
}

// sessionRejected reports a denial of the session itself: an authentication
// failure, a 401 answer, a security challenge or an edge 403. A 403 carrying
// Vinted's API error envelope refuses one item or asks the member for an
// action, exactly as on the server path. Timeouts, rate limits and server
// errors say nothing about the session.
func sessionRejected(err error) bool {
	if err == nil || termsOutdated(err) {
		// Outdated terms are the member's to accept in Vinted. The session and
		// its checkout context are fine.
		return false
	}
	var auth *vinted.AuthError
	status := vinted.UpstreamStatus(err)
	return status == http.StatusUnauthorized || errors.As(err, &auth) || vinted.ContextRejected(err)
}

// paymentRequestAnswered reports a status that exists only after the payment
// request was sent.
func paymentRequestAnswered(status string) bool {
	switch status {
	case "card_payment_confirmed", "card_payment_pending", "card_payment_failed", "card_authentication_required", "payment_outcome_unknown", "paypal_redirect_ready":
		return true
	}
	return false
}

// rejectLocally closes a job the agent refuses before any Vinted request, so
// the member sees a result instead of a job that silently stalls.
func (a *API) rejectLocally(ctx context.Context, j *Job) {
	if j == nil || !jobIDPattern.MatchString(j.ID) {
		return
	}
	_ = a.report(ctx, j, session.CheckoutLink{ItemID: j.Spec.ItemID, SellerID: j.Spec.SellerID, Domain: j.Spec.Domain, Status: "checkout_review_required", AutoCheckoutReason: reasonRejectedLocally}, true)
}
func (a *API) Execute(ctx context.Context, j *Job, factory Factory) error {
	preferences, err := ValidateJob(j)
	if err != nil {
		a.rejectLocally(ctx, j)
		return err
	}
	client, err := factory(&j.Session)
	if err != nil {
		a.rejectLocally(ctx, j)
		return errors.New("could not initialize local checkout client")
	}
	base := session.CheckoutLink{ItemID: j.Spec.ItemID, SellerID: j.Spec.SellerID, Domain: j.Spec.Domain, PreferencesKey: preferences.Key()}
	// The first checkpoint proves that the scoped device is still authorized.
	// It has its own label so a stall in the identity probe is not mistaken
	// for a stall in the first checkout request.
	started := base
	started.Status = "agent_started"
	if err := a.Checkpoint(ctx, j, started, false); err != nil {
		return err
	}
	info, err := client.GetAccountInfo()
	if err != nil || info == nil || info.ID != j.Spec.AccountID {
		stopped := base
		stopped.Status = "checkout_review_required"
		if err == nil || sessionRejected(err) {
			// A different account, a denial or a security challenge. Stop here;
			// nothing is retried and no other profile or route is tried.
			stopped.AutoCheckoutReason = reasonSessionRejected
			stopped.ServerContextRejected = true
			_ = a.report(ctx, j, stopped, true)
			return ErrSessionVerification
		}
		// A timeout, rate limit or server error says nothing about the session.
		stopped.AutoCheckoutReason = identityFailureReason(err)
		stopped.RateLimited = vinted.UpstreamStatus(err) == http.StatusTooManyRequests
		_ = a.report(ctx, j, stopped, true)
		return errors.New("could not verify the Vinted session for this job; no checkout step was started")
	}
	save := func(link session.CheckoutLink) error {
		var err error
		switch {
		case paymentRequestAnswered(link.Status):
			// The payment request was already answered. Its outcome is reported
			// even if the agent is being stopped.
			err = a.report(ctx, j, link, false)
		case ctx.Err() != nil:
			err = errors.New("agent stopped before the next checkout step")
		default:
			err = a.Checkpoint(ctx, j, link, false)
		}
		if err != nil {
			return &checkpointError{err}
		}
		return nil
	}
	var link *session.CheckoutLink
	if j.Spec.StopBeforePayment {
		link, err = client.ValidateCheckout(j.Spec.ItemID, j.Spec.SellerID, save, preferences)
	} else {
		link, err = client.PrepareCheckout(j.Spec.ItemID, j.Spec.SellerID, save, preferences)
	}
	if err != nil {
		rejected := sessionRejected(err)
		answered := false
		var unacknowledged *checkpointError
		switch {
		case link == nil:
			// The checkout chain returns no link only before its first request.
			stopped := base
			stopped.Status = "checkout_review_required"
			stopped.AutoCheckoutReason = reasonNotStarted
			link = &stopped
		case paymentRequestAnswered(link.Status):
			// The payment request was answered and only a later checkpoint
			// failed. The outcome and its reason stand as the client set them.
			answered = true
			rejected = link.ServerContextRejected
		case link.Status == "payment_starting" && errors.As(err, &unacknowledged):
			// The payment request is sent only after this checkpoint is
			// acknowledged, so a refusal means that nothing was sent.
			link.Status = "checkout_review_required"
			link.AutoCheckoutReason = reasonPaymentNotAuthorized
		case link.Status == "payment_starting":
			link.Status = "payment_outcome_unknown"
			link.AutoCheckoutReason = reasonPaymentUnknown
			answered = true
		default:
			link.AutoCheckoutReason = checkoutFailureReason(link.Status, err)
		}
		link.ServerContextRejected = rejected
		reportErr := a.report(ctx, j, *link, true)
		if rejected {
			return ErrSessionVerification
		}
		if answered {
			if reportErr != nil {
				return errors.New("a payment request was sent but its result could not be reported; check Vinted and do not start it again")
			}
			return nil
		}
		return errors.New("local checkout stopped; check Vinted before continuing")
	}
	if link == nil {
		return errors.New("local checkout returned no result")
	}
	if err := a.report(ctx, j, *link, true); err != nil {
		return err
	}
	if link.ServerContextRejected {
		return ErrSessionVerification
	}
	return nil
}
func DefaultFactory(s *session.VintedSession) (Executor, error) { return vinted.NewClient(s) }

// vintedEnumPattern admits only Vinted's error enum values, never prose.
var vintedEnumPattern = regexp.MustCompile(`^[a-z0-9_.-]{1,64}$`)

// termsOutdated reports Vinted's own refusal code for an account that has not
// accepted the current terms and conditions.
func termsOutdated(err error) bool {
	var upstream *vinted.UpstreamHTTPError
	return errors.As(err, &upstream) && upstream.APIError && upstream.MessageCode == "outdated_terms_and_conditions"
}

// transportClass turns the fixed transport kind into a member-readable label.
func transportClass(transport *vinted.TransportError) string {
	label := "no answer"
	switch {
	case transport.Kind == "timeout":
		label = "timeout"
	case transport.Kind == "proxy_unreachable":
		label = "connection failed"
	case transport.Kind == "proxy_address_not_public":
		label = "address not allowed"
	case strings.HasPrefix(transport.Kind, "proxy_refused"):
		label = "proxy refused"
	}
	if transport.BeforeSend {
		label += ", request not sent"
	}
	return " (network: " + label + ")"
}

// failureClass names a failure with a fixed label taken from typed errors
// only. It never reads an error's text.
func failureClass(err error) string {
	var unacknowledged *checkpointError
	var transport *vinted.TransportError
	var network net.Error
	var upstream *vinted.UpstreamHTTPError
	switch status := vinted.UpstreamStatus(err); {
	case errors.As(err, &unacknowledged):
		// Not a Vinted failure: the coordinator did not acknowledge a step.
		return ""
	case errors.As(err, &transport):
		return transportClass(transport)
	case errors.As(err, &network):
		return " (network)"
	case status >= 300 && status <= 599:
		if errors.As(err, &upstream) && upstream.APIError && vintedEnumPattern.MatchString(upstream.MessageCode) {
			return fmt.Sprintf(" (Vinted HTTP %d, %s)", status, upstream.MessageCode)
		}
		return fmt.Sprintf(" (Vinted HTTP %d)", status)
	default:
		return " (invalid response)"
	}
}

// Keep upstream response bodies and error strings out of member-visible results.
func checkoutFailureReason(stage string, err error) string {
	if termsOutdated(err) {
		return reasonTermsOutdated + " No automatic retry will run."
	}
	switch stage {
	case "transaction_creating", "checkout_building", "checkout_updating", "checkout_selecting_preferences", "payment_starting":
	default:
		stage = "checkout"
	}
	return fmt.Sprintf("Local checkout stopped at %s%s. Check Vinted before continuing; no automatic retry will run.", stage, failureClass(err))
}

func identityFailureReason(err error) string {
	if termsOutdated(err) {
		return reasonTermsOutdated + " No checkout step was started."
	}
	return fmt.Sprintf("The agent could not verify the Vinted session from this computer%s. No checkout step was started.", failureClass(err))
}
