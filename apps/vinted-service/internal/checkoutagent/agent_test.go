package checkoutagent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"vintrack-vinted/internal/session"
	"vintrack-vinted/internal/vinted"
)

type timeoutError struct{}

func (timeoutError) Error() string   { return "secret-proxy-host timed out" }
func (timeoutError) Timeout() bool   { return true }
func (timeoutError) Temporary() bool { return true }

func TestCheckoutFailureReasonExposesOnlyKnownStageAndFixedClass(t *testing.T) {
	for _, tc := range []struct {
		stage string
		err   error
		want  string
	}{
		{"checkout_building", &vinted.UpstreamHTTPError{StatusCode: 403, Operation: "private-operation", Code: "secret-code", Message: "secret-response"}, "at checkout_building (Vinted HTTP 403)."},
		{"transaction_creating", &vinted.UpstreamHTTPError{StatusCode: 429, Message: "secret-response"}, "at transaction_creating (Vinted HTTP 429)."},
		{"transaction_creating", &vinted.UpstreamHTTPError{StatusCode: 307, Message: "secret-response"}, "at transaction_creating (Vinted HTTP 307)."},
		{"transaction_creating", &vinted.TransportError{Step: "buy conversation", Kind: "no_answer"}, "at transaction_creating (network: no answer)."},
		{"transaction_creating", &vinted.TransportError{Step: "buy conversation", Kind: "timeout"}, "at transaction_creating (network: timeout)."},
		{"transaction_creating", &vinted.TransportError{Step: "buy conversation", Kind: "proxy_unreachable", BeforeSend: true}, "at transaction_creating (network: connection failed, request not sent)."},
		{"transaction_creating", &vinted.TransportError{Step: "buy conversation", Kind: "proxy_refused_407", BeforeSend: true}, "at transaction_creating (network: proxy refused, request not sent)."},
		{"transaction_creating", &vinted.TransportError{Step: "buy conversation", Kind: "secret-kind"}, "at transaction_creating (network: no answer)."},
		{"checkout_building", &vinted.UpstreamHTTPError{StatusCode: 400, APIError: true, MessageCode: "validation_error", Message: "secret-response"}, "at checkout_building (Vinted HTTP 400, validation_error)."},
		{"checkout_building", &vinted.UpstreamHTTPError{StatusCode: 400, APIError: true, MessageCode: "Secret Prose!", Message: "secret-response"}, "at checkout_building (Vinted HTTP 400)."},
		{"checkout_building", &vinted.UpstreamHTTPError{StatusCode: 400, MessageCode: "secret_without_envelope"}, "at checkout_building (Vinted HTTP 400)."},
		{"transaction_creating", &vinted.UpstreamHTTPError{StatusCode: 403, APIError: true, MessageCode: "outdated_terms_and_conditions", Message: "secret-response"}, "accept its updated terms and conditions"},
		{"checkout_building", fmt.Errorf("secret-wrap: %w", timeoutError{}), "at checkout_building (network)."},
		{"checkout_building", errors.New("secret-token"), "at checkout_building (invalid response)."},
		{"secret-stage", errors.New("secret-token"), "at checkout (invalid response)."},
		{"checkout_updating", &checkpointError{errors.New("secret-coordinator-text")}, "at checkout_updating."},
	} {
		got := checkoutFailureReason(tc.stage, tc.err)
		if !strings.Contains(got, tc.want) || strings.Contains(strings.ToLower(got), "secret") || strings.Contains(got, "private-operation") {
			t.Fatalf("unsafe or unhelpful failure reason for %q: %s", tc.want, got)
		}
	}
	terms := &vinted.UpstreamHTTPError{StatusCode: 403, APIError: true, MessageCode: "outdated_terms_and_conditions"}
	if got := identityFailureReason(terms); !strings.Contains(got, "accept its updated terms and conditions") || !strings.Contains(got, "No checkout step was started") {
		t.Fatalf("outdated terms were not explained: %s", got)
	}
	got := identityFailureReason(fmt.Errorf("secret-wrap: %w", timeoutError{}))
	if !strings.Contains(got, "(network)") || !strings.Contains(got, "No checkout step was started") || strings.Contains(got, "secret") {
		t.Fatalf("unsafe or unhelpful identity reason: %s", got)
	}
}

func TestCoordinatorOriginAndRedirectsDoNotLeakDeviceCredential(t *testing.T) {
	for _, raw := range []string{"http://example.com", "https://user:secret@example.com", "https://example.com/path", "https://example.com/?token=x", "https://example.com/#x", "file:///tmp/server"} {
		if ValidateOrigin(raw) == nil {
			t.Fatal("unsafe coordinator origin accepted")
		}
	}
	for _, raw := range []string{"https://vintrack.example.test", "http://127.0.0.1:3000", "http://[::1]:3000", "http://localhost:3000"} {
		if ValidateOrigin(raw) != nil {
			t.Fatal("valid coordinator origin rejected")
		}
	}
	followed := false
	destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { followed = true }))
	defer destination.Close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, destination.URL, 302) }))
	defer server.Close()
	api, _ := NewAPI(Config{Server: server.URL, Token: strings.Repeat("a", 64)})
	if _, _, err := api.Next(context.Background()); err == nil || followed {
		t.Fatal("agent followed a redirect carrying its device credential")
	}
}

func validJob() *Job {
	return &Job{ID: strings.Repeat("a", 64), Spec: session.CheckoutAgentSpec{ItemID: 123, SellerID: 456, AccountID: 42, Domain: "www.vinted.de", Preferences: json.RawMessage(`{"shipping":"home","payment":"card","autoCheckout":{"warningVersion":2,"currency":"EUR","maxTotalMinor":3000}}`)}, Session: session.VintedSession{VintedUserID: 42, Domain: "www.vinted.de", AccessToken: "synthetic", CookieHeader: "datadome=synthetic", CsrfToken: "synthetic", UserAgent: "synthetic"}}
}

func TestJobRejectsUntrustedDomainsIdentityAndRefreshCredentials(t *testing.T) {
	if _, err := ValidateJob(validJob()); err != nil {
		t.Fatal(err)
	}
	for _, mutate := range []func(*Job){func(j *Job) { j.Spec.Domain = "www.vinted.de.attacker.test" }, func(j *Job) { j.Session.Domain = "www.vinted.fr" }, func(j *Job) { j.Session.VintedUserID = 99 }, func(j *Job) { j.Session.RefreshToken = "not-allowed" }, func(j *Job) { j.Spec.SellerID = 42 }, func(j *Job) { j.Session.CsrfToken = "" }, func(j *Job) { j.Spec.Preferences = json.RawMessage(`{"shipping":"home","payment":"card"}`) }, func(j *Job) {
		j.Spec.Preferences = json.RawMessage(`{"shipping":"home","payment":"card"}`)
		j.Spec.StopBeforePayment = true
	}} {
		j := validJob()
		mutate(j)
		if _, err := ValidateJob(j); err == nil {
			t.Fatal("invalid job was accepted")
		}
	}
}

func TestJobAcceptsOnlyTheFourSyncedContextCookies(t *testing.T) {
	j := validJob()
	j.Session.CookieHeader = "datadome=synthetic-dd; anon_id=synthetic-anon; _vinted_fr_session=synthetic-session; v_udt=synthetic-udt"
	if _, err := ValidateJob(j); err != nil {
		t.Fatalf("the four synced context cookies were rejected: %v", err)
	}
	for _, header := range []string{
		j.Session.CookieHeader + "; refresh_token_web=synthetic-refresh",
		j.Session.CookieHeader + "; access_token_web=synthetic-access",
		j.Session.CookieHeader + "; unrelated=synthetic",
		"anon_id=synthetic-anon; _vinted_fr_session=synthetic-session; v_udt=synthetic-udt",
	} {
		j := validJob()
		j.Session.CookieHeader = header
		if _, err := ValidateJob(j); err == nil {
			t.Fatalf("job with cookie header %q was accepted", header)
		}
	}
}

type recordedCheckpoint struct {
	Link     session.CheckoutLink
	Complete bool
}

// fakeCoordinator records acknowledged checkpoints and can refuse some.
type fakeCoordinator struct {
	mu       sync.Mutex
	accepted []recordedCheckpoint
	refuse   func(link session.CheckoutLink, complete bool) int
	server   *httptest.Server
}

func newFakeCoordinator(t *testing.T) (*fakeCoordinator, *API) {
	t.Helper()
	c := &fakeCoordinator{}
	c.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/checkout-agent/checkpoint" {
			http.Error(w, `{"error":"not found"}`, 404)
			return
		}
		var req struct {
			JobID    string               `json:"job_id"`
			Link     session.CheckoutLink `json:"link"`
			Complete bool                 `json:"complete"`
		}
		if json.NewDecoder(r.Body).Decode(&req) != nil {
			http.Error(w, `{"error":"bad"}`, 400)
			return
		}
		c.mu.Lock()
		defer c.mu.Unlock()
		if c.refuse != nil {
			if status := c.refuse(req.Link, req.Complete); status != 0 {
				w.WriteHeader(status)
				_, _ = w.Write([]byte(`{"error":"secret-coordinator-text"}`))
				return
			}
		}
		c.accepted = append(c.accepted, recordedCheckpoint{req.Link, req.Complete})
		_, _ = w.Write([]byte(`{"acknowledged":true}`))
	}))
	t.Cleanup(c.server.Close)
	api, err := NewAPI(Config{Server: c.server.URL, Token: strings.Repeat("a", 64)})
	if err != nil {
		t.Fatal(err)
	}
	return c, api
}

func (c *fakeCoordinator) checkpoints() []recordedCheckpoint {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]recordedCheckpoint(nil), c.accepted...)
}

func (c *fakeCoordinator) last(t *testing.T) recordedCheckpoint {
	t.Helper()
	all := c.checkpoints()
	if len(all) == 0 {
		t.Fatal("no checkpoint reached the coordinator")
	}
	return all[len(all)-1]
}

type fakeExecutor struct {
	info    *vinted.AccountInfo
	infoErr error
	run     func(link session.CheckoutLink, save func(session.CheckoutLink) error) (*session.CheckoutLink, error)
	probes  int
}

func (f *fakeExecutor) GetAccountInfo() (*vinted.AccountInfo, error) {
	f.probes++
	return f.info, f.infoErr
}
func (f *fakeExecutor) PrepareCheckout(item, seller int64, save func(session.CheckoutLink) error, p ...vinted.CheckoutPreferences) (*session.CheckoutLink, error) {
	return f.run(session.CheckoutLink{ItemID: item, SellerID: seller, Domain: "www.vinted.de"}, save)
}
func (f *fakeExecutor) ValidateCheckout(item, seller int64, save func(session.CheckoutLink) error, p vinted.CheckoutPreferences) (*session.CheckoutLink, error) {
	return f.run(session.CheckoutLink{ItemID: item, SellerID: seller, Domain: "www.vinted.de"}, save)
}

func factoryFor(executor *fakeExecutor) Factory {
	return func(*session.VintedSession) (Executor, error) { return executor, nil }
}

// cardCheckout mimics the checkpoint order of the real checkout chain: every
// step is saved before it runs and the payment follows its own checkpoint.
func cardCheckout(paid *int, afterPaymentStart func()) func(session.CheckoutLink, func(session.CheckoutLink) error) (*session.CheckoutLink, error) {
	return func(link session.CheckoutLink, save func(session.CheckoutLink) error) (*session.CheckoutLink, error) {
		link.Status = "transaction_creating"
		if err := save(link); err != nil {
			return nil, err
		}
		link.TransactionID = 77
		for _, stage := range []string{"checkout_building", "checkout_updating"} {
			link.Status = stage
			if stage == "checkout_updating" {
				link.CheckoutURL = "https://www.vinted.de/checkout?purchase_id=synthetic"
			}
			if err := save(link); err != nil {
				return &link, err
			}
		}
		link.Status = "payment_starting"
		link.AutoCheckoutReason = "A payment was started. Check Vinted before trying again."
		if err := save(link); err != nil {
			return &link, err
		}
		*paid++
		if afterPaymentStart != nil {
			afterPaymentStart()
		}
		link.Status = "card_payment_confirmed"
		link.AutoCheckoutReason = "Vinted confirmed the synthetic payment."
		return &link, save(link)
	}
}

func TestIdentityProbeFailureIsOnlyARejectionWhenVintedDeniedTheSession(t *testing.T) {
	for _, tc := range []struct {
		name     string
		info     *vinted.AccountInfo
		err      error
		rejected bool
		class    string
	}{
		{"timeout", nil, fmt.Errorf("account validation request: %w", timeoutError{}), false, "(network)"},
		{"transport", nil, &vinted.TransportError{Step: "account validation", Kind: "timeout"}, false, "(network: timeout)"},
		{"outdated terms", nil, &vinted.UpstreamHTTPError{StatusCode: 403, APIError: true, MessageCode: "outdated_terms_and_conditions", Message: "secret-response"}, false, "accept its updated terms and conditions"},
		{"server error", nil, &vinted.UpstreamHTTPError{StatusCode: 503, Message: "secret-response"}, false, "(Vinted HTTP 503)"},
		{"rate limit", nil, &vinted.UpstreamHTTPError{StatusCode: 429, Message: "secret-response"}, false, "(Vinted HTTP 429)"},
		{"unusable answer", nil, errors.New("secret-response is invalid"), false, "(invalid response)"},
		{"unauthorized", nil, &vinted.UpstreamHTTPError{StatusCode: 401}, true, ""},
		{"edge forbidden", nil, &vinted.UpstreamHTTPError{StatusCode: 403}, true, ""},
		// Vinted's application refused this request; the session itself is fine.
		{"api forbidden", nil, &vinted.UpstreamHTTPError{StatusCode: 403, APIError: true}, false, "(Vinted HTTP 403)"},
		{"auth error", nil, &vinted.AuthError{Step: "account validation", StatusCode: 401, Message: "secret-response"}, true, ""},
		{"security challenge", nil, &vinted.DataDomeChallengeError{Step: "account validation", StatusCode: 429, CaptchaURL: "https://example.test/secret-response"}, true, ""},
		{"other account", &vinted.AccountInfo{ID: 99}, nil, true, ""},
		{"no account", nil, nil, true, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			coordinator, api := newFakeCoordinator(t)
			executor := &fakeExecutor{info: tc.info, infoErr: tc.err, run: func(session.CheckoutLink, func(session.CheckoutLink) error) (*session.CheckoutLink, error) {
				t.Fatal("checkout ran after a failed identity probe")
				return nil, nil
			}}
			err := api.Execute(context.Background(), validJob(), factoryFor(executor))
			if err == nil || errors.Is(err, ErrSessionVerification) != tc.rejected {
				t.Fatalf("wrong error for the run loop: %v", err)
			}
			if executor.probes != 1 {
				t.Fatalf("identity probe ran %d times; it is never repeated", executor.probes)
			}
			all := coordinator.checkpoints()
			if len(all) != 2 || all[0].Link.Status != "agent_started" || all[0].Complete {
				t.Fatalf("unexpected checkpoints: %+v", all)
			}
			final := all[1]
			if !final.Complete || final.Link.Status != "checkout_review_required" || final.Link.ServerContextRejected != tc.rejected {
				t.Fatalf("unexpected final checkpoint: %+v", final)
			}
			reason := final.Link.AutoCheckoutReason
			if strings.Contains(reason, "secret") || (tc.rejected && reason != reasonSessionRejected) ||
				(!tc.rejected && (!strings.Contains(reason, tc.class) || !strings.Contains(reason, "No checkout step was started"))) {
				t.Fatalf("unexpected reason: %s", reason)
			}
		})
	}
}

func TestSuccessfulRunLabelsThePreProbeCheckpoint(t *testing.T) {
	coordinator, api := newFakeCoordinator(t)
	paid := 0
	err := api.Execute(context.Background(), validJob(), factoryFor(&fakeExecutor{info: &vinted.AccountInfo{ID: 42}, run: cardCheckout(&paid, nil)}))
	if err != nil || paid != 1 {
		t.Fatalf("run failed: %v, paid %d", err, paid)
	}
	var statuses []string
	for index, checkpoint := range coordinator.checkpoints() {
		statuses = append(statuses, checkpoint.Link.Status)
		if index > 0 && checkpoint.Link.Status == "transaction_creating" && statuses[index-1] == "transaction_creating" {
			t.Fatal("two consecutive transaction_creating checkpoints")
		}
	}
	want := "agent_started,transaction_creating,checkout_building,checkout_updating,payment_starting,card_payment_confirmed,card_payment_confirmed"
	if strings.Join(statuses, ",") != want {
		t.Fatalf("unexpected checkpoint order: %v", statuses)
	}
	if final := coordinator.last(t); !final.Complete || final.Link.AutoCheckoutReason != "Vinted confirmed the synthetic payment." {
		t.Fatalf("unexpected final checkpoint: %+v", final)
	}
}

func TestRefusedPaymentStartIsReportedAsNotSent(t *testing.T) {
	coordinator, api := newFakeCoordinator(t)
	coordinator.refuse = func(link session.CheckoutLink, complete bool) int {
		if link.Status == "payment_starting" {
			return 409
		}
		return 0
	}
	paid := 0
	err := api.Execute(context.Background(), validJob(), factoryFor(&fakeExecutor{info: &vinted.AccountInfo{ID: 42}, run: cardCheckout(&paid, nil)}))
	if err == nil || errors.Is(err, ErrSessionVerification) || paid != 0 {
		t.Fatalf("refused payment start: err %v, paid %d", err, paid)
	}
	final := coordinator.last(t)
	if !final.Complete || final.Link.Status != "checkout_review_required" || final.Link.AutoCheckoutReason != "Payment was not acknowledged by Vintrack; no payment request was sent." {
		t.Fatalf("refused payment start was misreported: %+v", final)
	}
	if final.Link.CheckoutURL == "" || final.Link.ServerContextRejected {
		t.Fatalf("the built checkout must stay reachable for the member: %+v", final)
	}
}

func TestKnownPaymentOutcomeKeepsItsReasonWhenOnlyItsCheckpointFailed(t *testing.T) {
	coordinator, api := newFakeCoordinator(t)
	coordinator.refuse = func(link session.CheckoutLink, complete bool) int {
		if link.Status == "card_payment_confirmed" && !complete {
			return 503
		}
		return 0
	}
	paid := 0
	err := api.Execute(context.Background(), validJob(), factoryFor(&fakeExecutor{info: &vinted.AccountInfo{ID: 42}, run: cardCheckout(&paid, nil)}))
	if err != nil || paid != 1 {
		t.Fatalf("a reported outcome is not a failed run: err %v, paid %d", err, paid)
	}
	final := coordinator.last(t)
	if !final.Complete || final.Link.Status != "card_payment_confirmed" || final.Link.AutoCheckoutReason != "Vinted confirmed the synthetic payment." {
		t.Fatalf("a confirmed payment was overwritten: %+v", final)
	}
}

func TestOutcomeAndCompletionAreDeliveredAfterTheRunWasStopped(t *testing.T) {
	coordinator, api := newFakeCoordinator(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	paid := 0
	err := api.Execute(ctx, validJob(), factoryFor(&fakeExecutor{info: &vinted.AccountInfo{ID: 42}, run: cardCheckout(&paid, cancel)}))
	if err != nil || paid != 1 {
		t.Fatalf("stopped after payment: err %v, paid %d", err, paid)
	}
	all := coordinator.checkpoints()
	if len(all) < 2 {
		t.Fatalf("missing checkpoints: %+v", all)
	}
	outcome, final := all[len(all)-2], all[len(all)-1]
	if outcome.Complete || outcome.Link.Status != "card_payment_confirmed" || !final.Complete || final.Link.Status != "card_payment_confirmed" {
		t.Fatalf("payment outcome was lost when the agent stopped: %+v", all)
	}
}

func TestStoppingBeforePaymentSendsNoPaymentAndNoFurtherStep(t *testing.T) {
	coordinator, api := newFakeCoordinator(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	coordinator.refuse = func(link session.CheckoutLink, complete bool) int {
		if link.Status == "checkout_building" {
			cancel() // The member stops the agent while a step is in flight.
		}
		return 0
	}
	paid := 0
	err := api.Execute(ctx, validJob(), factoryFor(&fakeExecutor{info: &vinted.AccountInfo{ID: 42}, run: cardCheckout(&paid, nil)}))
	if err == nil || paid != 0 {
		t.Fatalf("stopped before payment: err %v, paid %d", err, paid)
	}
	for _, checkpoint := range coordinator.checkpoints() {
		if checkpoint.Link.Status == "payment_starting" || paymentRequestAnswered(checkpoint.Link.Status) {
			t.Fatalf("a payment checkpoint was sent after the stop: %+v", checkpoint)
		}
	}
	final := coordinator.last(t)
	if !final.Complete || strings.Contains(final.Link.AutoCheckoutReason, "secret") {
		t.Fatalf("the stopped job was not closed: %+v", final)
	}
}

func TestLocallyRejectedJobReportsOneCompleteCheckpoint(t *testing.T) {
	for _, tc := range []struct {
		name    string
		mutate  func(*Job)
		factory Factory
	}{
		{"validation", func(j *Job) { j.Session.CookieHeader += "; unrelated=synthetic" }, factoryFor(&fakeExecutor{})},
		{"client init", func(*Job) {}, func(*session.VintedSession) (Executor, error) { return nil, errors.New("secret-init-failure") }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			coordinator, api := newFakeCoordinator(t)
			job := validJob()
			tc.mutate(job)
			err := api.Execute(context.Background(), job, tc.factory)
			if err == nil || errors.Is(err, ErrSessionVerification) || strings.Contains(err.Error(), "secret") {
				t.Fatalf("unexpected error: %v", err)
			}
			all := coordinator.checkpoints()
			if len(all) != 1 || !all[0].Complete || all[0].Link.Status != "checkout_review_required" ||
				all[0].Link.AutoCheckoutReason != "The agent rejected this job before contacting Vinted." ||
				all[0].Link.ItemID != 123 || all[0].Link.SellerID != 456 || all[0].Link.Domain != "www.vinted.de" || all[0].Link.ServerContextRejected {
				t.Fatalf("unexpected checkpoints: %+v", all)
			}
		})
	}
	// A job without a usable id cannot be reported at all.
	coordinator, api := newFakeCoordinator(t)
	job := validJob()
	job.ID = "not-a-job-id"
	if err := api.Execute(context.Background(), job, factoryFor(&fakeExecutor{})); err == nil || len(coordinator.checkpoints()) != 0 {
		t.Fatal("a job without a valid id was reported")
	}
}

func TestCheckoutFailureBeforeFirstRequestAndSessionDenialAreClassified(t *testing.T) {
	coordinator, api := newFakeCoordinator(t)
	// The chain returns no link only before its first Vinted request.
	err := api.Execute(context.Background(), validJob(), factoryFor(&fakeExecutor{info: &vinted.AccountInfo{ID: 42}, run: func(session.CheckoutLink, func(session.CheckoutLink) error) (*session.CheckoutLink, error) {
		return nil, errors.New("secret-target")
	}}))
	final := coordinator.last(t)
	if err == nil || !final.Complete || final.Link.Status != "checkout_review_required" || final.Link.AutoCheckoutReason != reasonNotStarted || final.Link.ServerContextRejected {
		t.Fatalf("unexpected result: %v %+v", err, final)
	}
	coordinator, api = newFakeCoordinator(t)
	err = api.Execute(context.Background(), validJob(), factoryFor(&fakeExecutor{info: &vinted.AccountInfo{ID: 42}, run: func(link session.CheckoutLink, save func(session.CheckoutLink) error) (*session.CheckoutLink, error) {
		link.Status = "transaction_creating"
		if err := save(link); err != nil {
			return nil, err
		}
		return &link, &vinted.DataDomeChallengeError{Step: "buy conversation", StatusCode: 403, CaptchaURL: "https://example.test/secret"}
	}}))
	final = coordinator.last(t)
	if !errors.Is(err, ErrSessionVerification) || !final.Complete || !final.Link.ServerContextRejected || final.Link.Status != "transaction_creating" ||
		!strings.Contains(final.Link.AutoCheckoutReason, "at transaction_creating (Vinted HTTP 403).") || strings.Contains(final.Link.AutoCheckoutReason, "secret") {
		t.Fatalf("a security challenge must stop the agent: %v %+v", err, final)
	}
}

func TestCoordinatorRefusalCarriesOnlyStatusAndCode(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(409)
		_, _ = w.Write([]byte(`{"code":"agent_pairing_mismatch","error":"secret-coordinator-text"}`))
	}))
	defer server.Close()
	api, _ := NewAPI(Config{Server: server.URL, Token: strings.Repeat("a", 64)})
	_, status, err := api.Next(context.Background())
	var refusal *CoordinatorError
	if status != 409 || !errors.As(err, &refusal) || refusal.Code != PairingMismatch || refusal.Status != 409 || strings.Contains(err.Error(), "secret") {
		t.Fatalf("unexpected refusal: %d %v", status, err)
	}
}

func TestOutdatedTermsStopTheJobWithoutRejectingTheSession(t *testing.T) {
	coordinator, api := newFakeCoordinator(t)
	err := api.Execute(context.Background(), validJob(), factoryFor(&fakeExecutor{info: &vinted.AccountInfo{ID: 42}, run: func(link session.CheckoutLink, save func(session.CheckoutLink) error) (*session.CheckoutLink, error) {
		link.Status = "transaction_creating"
		if err := save(link); err != nil {
			return nil, err
		}
		return &link, &vinted.UpstreamHTTPError{Operation: "buy conversation", StatusCode: 403, APIError: true, MessageCode: "outdated_terms_and_conditions", Message: "secret-response"}
	}}))
	final := coordinator.last(t)
	if err == nil || errors.Is(err, ErrSessionVerification) || !final.Complete || final.Link.ServerContextRejected ||
		!strings.Contains(final.Link.AutoCheckoutReason, "accept its updated terms and conditions") || strings.Contains(final.Link.AutoCheckoutReason, "secret") {
		t.Fatalf("outdated terms were treated as a rejected session: %v %+v", err, final)
	}
}
