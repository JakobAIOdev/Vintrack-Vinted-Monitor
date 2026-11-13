package api

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"

	"vintrack-vinted/internal/checkoutagent"
	"vintrack-vinted/internal/session"
	"vintrack-vinted/internal/vinted"
)

type fakeAgentCheckout struct {
	paid          *int
	beforePayment func()
	paypal        bool
	// probeErr fails the identity probe; failAt fails the Vinted request that
	// follows the named checkpoint.
	probeErr error
	failAt   string
	failErr  error
}

func (f *fakeAgentCheckout) GetAccountInfo() (*vinted.AccountInfo, error) {
	if f.probeErr != nil {
		return nil, f.probeErr
	}
	return &vinted.AccountInfo{ID: 42}, nil
}
func (f *fakeAgentCheckout) PrepareCheckout(item, seller int64, save func(session.CheckoutLink) error, p ...vinted.CheckoutPreferences) (*session.CheckoutLink, error) {
	return f.execute(item, seller, save, false)
}
func (f *fakeAgentCheckout) ValidateCheckout(item, seller int64, save func(session.CheckoutLink) error, p vinted.CheckoutPreferences) (*session.CheckoutLink, error) {
	return f.execute(item, seller, save, true)
}
func (f *fakeAgentCheckout) execute(item, seller int64, save func(session.CheckoutLink) error, validate bool) (*session.CheckoutLink, error) {
	link := session.CheckoutLink{ItemID: item, SellerID: seller, Domain: "www.vinted.de", PreferencesKey: "home:card:auto:2:EUR:3000"}
	for _, stage := range []string{"transaction_creating", "checkout_building", "checkout_updating"} {
		link.Status = stage
		if stage == "checkout_building" {
			link.TransactionID = 9000 + item
		}
		if stage == "checkout_updating" {
			link.CheckoutURL = "https://www.vinted.de/checkout?purchase_id=synthetic-private"
		}
		if err := save(link); err != nil {
			if stage == "transaction_creating" {
				return nil, err
			}
			return &link, err
		}
		if stage == f.failAt {
			return &link, f.failErr
		}
	}
	if validate {
		link.Status = "payment_ready"
		return &link, save(link)
	}
	if f.beforePayment != nil {
		f.beforePayment()
	}
	link.Status = "payment_starting"
	if err := save(link); err != nil {
		return &link, err
	}
	*f.paid++
	if f.paypal {
		link.Status = "paypal_redirect_ready"
		if err := save(link); err != nil {
			return &link, err
		}
		link.PaymentURL = "https://www.paypal.com/checkoutnow?token=synthetic-handoff-only"
		return &link, nil
	}
	link.Status = "card_payment_confirmed"
	return &link, save(link)
}

const agentTestPreferences = `{"shipping":"home","payment":"card","autoCheckout":{"warningVersion":2,"currency":"EUR","maxTotalMinor":3000}}`

// The stored header deliberately holds more than a job may carry, in an order
// that differs from the delivery order.
const agentTestStoredCookies = "v_udt=synthetic-udt; refresh_token_web=must-not-leave-store; datadome=synthetic-dd; access_token_web=must-not-leave-store; _vinted_fr_session=synthetic-fr; unrelated=must-not-leave-store; anon_id=synthetic-anon"
const agentTestDeliveredCookies = "datadome=synthetic-dd; anon_id=synthetic-anon; _vinted_fr_session=synthetic-fr; v_udt=synthetic-udt"

type agentHarness struct {
	t       *testing.T
	db      *sql.DB
	redis   *redis.Client
	manager *session.Manager
	server  *Server
	origin  string
	agent   *checkoutagent.API
	sess    *session.VintedSession
	spec    session.CheckoutAgentSpec
	paid    int
}

// newAgentHarness runs the real coordinator handlers over HTTP against a
// disposable PostgreSQL database and an isolated Redis. Everything in it is
// synthetic; no Vinted or payment host is ever contacted.
func newAgentHarness(t *testing.T) *agentHarness {
	t.Helper()
	databaseURL := os.Getenv("CHECKOUT_AGENT_INTEGRATION_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("requires disposable checkout agent database")
	}
	parsed, err := url.Parse(databaseURL)
	if err != nil || !strings.HasPrefix(parsed.Path, "/vintrack_checkout_test") {
		t.Fatal("requires a disposable vintrack_checkout_test database")
	}
	binary, err := exec.LookPath("redis-server")
	if err != nil {
		t.Skip("redis-server required for isolated checkout agent test")
	}
	db, err := sql.Open("postgres", databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	reset := func() {
		_, _ = db.Exec(`DELETE FROM "User" WHERE id='synthetic-user';DELETE FROM checkout_payment_attempts WHERE vinted_user_id=42;`)
	}
	reset()
	t.Cleanup(reset)
	_, err = db.Exec(`INSERT INTO "User"(id,role,checkout_enabled,checkout_risk_version,checkout_risk_accepted_at,checkout_preferences)VALUES('synthetic-user','free',true,1,NOW(),'{"accountId":42,"domain":"www.vinted.de","transport":"agent","preferences":` + agentTestPreferences + `}');
 INSERT INTO feature_policies(feature,enabled,free_enabled,premium_enabled,admin_enabled,updated_at)VALUES('checkout_links',true,true,true,true,NOW()),('vinted_account',true,true,true,true,NOW())ON CONFLICT(feature)DO UPDATE SET enabled=true,free_enabled=true;`)
	if err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	_ = listener.Close()
	ctx, cancel := context.WithCancel(context.Background())
	command := exec.CommandContext(ctx, binary, "--bind", "127.0.0.1", "--port", strconv.Itoa(port), "--save", "", "--appendonly", "no", "--dir", t.TempDir())
	if err := command.Start(); err != nil {
		cancel()
		t.Fatal(err)
	}
	t.Cleanup(func() { cancel(); _ = command.Wait() })
	addr := net.JoinHostPort("127.0.0.1", strconv.Itoa(port))
	deadline := time.Now().Add(2 * time.Second)
	for {
		conn, err := net.DialTimeout("tcp", addr, 50*time.Millisecond)
		if err == nil {
			_ = conn.Close()
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("isolated Redis did not start")
		}
		time.Sleep(10 * time.Millisecond)
	}
	manager, err := session.NewManager(addr, "", databaseURL, "synthetic-test-encryption-key")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = manager.Close() })
	client := redis.NewClient(&redis.Options{Addr: addr})
	t.Cleanup(func() { _ = client.Close() })
	stored := session.VintedSession{UserID: "synthetic-user", AccessToken: "synthetic-never-live", VintedUserID: 42, Domain: "www.vinted.de", LinkedAt: "synthetic", Status: "active", BrowserLinked: true,
		UserAgent: "synthetic-browser", CsrfToken: "synthetic-csrf", CookieHeader: agentTestStoredCookies}
	if err := manager.Store(stored); err != nil {
		t.Fatal(err)
	}
	sess, err := manager.Get("synthetic-user")
	if err != nil || sess == nil {
		t.Fatal("synthetic session missing")
	}
	server := &Server{sessions: manager}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/checkout-agent/pair", server.handleAgentPair)
	mux.HandleFunc("POST /api/checkout-agent/next", server.handleAgentNext)
	mux.HandleFunc("POST /api/checkout-agent/checkpoint", server.handleAgentCheckpoint)
	upstream := httptest.NewServer(mux)
	t.Cleanup(upstream.Close)
	h := &agentHarness{t: t, db: db, redis: client, manager: manager, server: server, origin: upstream.URL, sess: sess,
		spec: session.CheckoutAgentSpec{MonitorID: 17, AccountID: 42, SellerID: 456, Domain: "www.vinted.de", Preferences: json.RawMessage(agentTestPreferences)}}
	h.agent = h.pair()
	return h
}

// pair issues a pairing code, pairs a new device with it and marks it online.
func (h *agentHarness) pair() *checkoutagent.API {
	h.t.Helper()
	code, err := h.manager.CreateAgentPairCode(h.sess)
	if err != nil {
		h.t.Fatal(err)
	}
	agent, err := checkoutagent.NewAPI(checkoutagent.Config{Server: h.origin})
	if err != nil {
		h.t.Fatal(err)
	}
	if err := agent.Pair(context.Background(), code); err != nil {
		h.t.Fatal(err)
	}
	if _, _, err := h.manager.ExchangeAgentPairCode(code); err == nil {
		h.t.Fatal("pairing code was reusable")
	}
	h.touch()
	return agent
}
func (h *agentHarness) device() *session.CheckoutAgentDevice {
	h.t.Helper()
	device, err := h.manager.AgentForUser(h.sess.UserID)
	if err != nil || device == nil {
		h.t.Fatal("device missing")
	}
	return device
}
func (h *agentHarness) touch() {
	h.t.Helper()
	if err := h.manager.TouchAgent(h.device()); err != nil {
		h.t.Fatal(err)
	}
}
func (h *agentHarness) exec(query string, args ...interface{}) {
	h.t.Helper()
	if _, err := h.db.Exec(query, args...); err != nil {
		h.t.Fatal(err)
	}
}
func (h *agentHarness) enqueueRaw(item int64, validate bool) *httptest.ResponseRecorder {
	h.t.Helper()
	spec := h.spec
	spec.ItemID = item
	spec.StopBeforePayment = validate
	body, _ := json.Marshal(spec)
	req := httptest.NewRequest("POST", "/api/items/checkout/agent", bytes.NewReader(body))
	req.Header.Set("X-User-ID", h.sess.UserID)
	w := httptest.NewRecorder()
	h.server.handleEnqueueAgentCheckout(w, req)
	return w
}
func (h *agentHarness) enqueue(item int64, validate bool) string {
	h.t.Helper()
	w := h.enqueueRaw(item, validate)
	if w.Code != 202 {
		h.t.Fatalf("enqueue status %d: %s", w.Code, w.Body.String())
	}
	var data map[string]string
	_ = json.Unmarshal(w.Body.Bytes(), &data)
	if len(data["job_id"]) != 64 || data["status"] != "agent_queued" {
		h.t.Fatalf("unexpected enqueue answer: %s", w.Body.String())
	}
	return data["job_id"]
}
func (h *agentHarness) next() *checkoutagent.Job {
	h.t.Helper()
	job, status, err := h.agent.Next(context.Background())
	if err != nil || status != 200 || job == nil {
		h.t.Fatalf("claim status %d: %v", status, err)
	}
	if job.Session.RefreshToken != "" || strings.Contains(job.Session.CookieHeader, "must-not-leave-store") {
		h.t.Fatal("refresh cookie escaped checkout scope")
	}
	if job.Session.CookieHeader != agentTestDeliveredCookies {
		h.t.Fatalf("delivered cookies are not the four allowlisted context cookies: %q", job.Session.CookieHeader)
	}
	return job
}
func (h *agentHarness) run(job *checkoutagent.Job, fake *fakeAgentCheckout) error {
	h.t.Helper()
	if fake.paid == nil {
		fake.paid = &h.paid
	}
	return h.agent.Execute(context.Background(), job, func(*session.VintedSession) (checkoutagent.Executor, error) { return fake, nil })
}
func (h *agentHarness) checkpoint(job *checkoutagent.Job, status string, complete bool, mutate ...func(*session.CheckoutLink)) error {
	link := session.CheckoutLink{ItemID: job.Spec.ItemID, SellerID: job.Spec.SellerID, Domain: job.Spec.Domain, Status: status}
	for _, change := range mutate {
		change(&link)
	}
	return h.agent.Checkpoint(context.Background(), job, link, complete)
}
func (h *agentHarness) stored(id string) *session.CheckoutAgentJob {
	h.t.Helper()
	job, err := h.manager.GetAgentJob(h.sess.UserID, id)
	if err != nil || job == nil {
		h.t.Fatalf("job %s missing: %v", id, err)
	}
	return job
}

type agentJobView struct {
	State  string `json:"state"`
	Result *struct {
		Status     string `json:"status"`
		Reason     string `json:"auto_checkout_reason"`
		PaymentURL string `json:"payment_url"`
	} `json:"result"`
	Notification *struct {
		Status string `json:"status"`
	} `json:"notification"`
}

func (h *agentHarness) view(id string) agentJobView {
	h.t.Helper()
	req := httptest.NewRequest("GET", "/api/checkout-agent/jobs/"+id, nil)
	req.Header.Set("X-User-ID", h.sess.UserID)
	req.SetPathValue("id", id)
	w := httptest.NewRecorder()
	h.server.handleAgentJobStatus(w, req)
	var view agentJobView
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &view) != nil {
		h.t.Fatalf("job status %d: %s", w.Code, w.Body.String())
	}
	return view
}
func (h *agentHarness) paymentClaims(item int64) int {
	h.t.Helper()
	var count int
	if err := h.db.QueryRow(`SELECT COUNT(*) FROM checkout_payment_attempts WHERE vinted_user_id=42 AND item_id=$1`, item).Scan(&count); err != nil {
		h.t.Fatal(err)
	}
	return count
}
func refusalStatus(err error) int {
	var refusal *checkoutagent.CoordinatorError
	if errors.As(err, &refusal) {
		return refusal.Status
	}
	return 0
}

func TestLocalCheckoutAgentCoordinatorAgainstPostgres(t *testing.T) {
	h := newAgentHarness(t)
	var storedToken string
	if err := h.db.QueryRow(`SELECT token_hash FROM checkout_agent_devices WHERE user_id='synthetic-user'`).Scan(&storedToken); err != nil || storedToken == h.agent.Config.Token {
		t.Fatal("device token not hashed")
	}
	for _, validate := range []bool{false, true} {
		ordinary := h.spec
		ordinary.ItemID = 999
		ordinary.StopBeforePayment = validate
		ordinary.Preferences = json.RawMessage(`{"shipping":"home","payment":"card"}`)
		body, _ := json.Marshal(ordinary)
		request := httptest.NewRequest(http.MethodPost, "/api/items/checkout/agent", bytes.NewReader(body))
		request.Header.Set("X-User-ID", h.sess.UserID)
		response := httptest.NewRecorder()
		h.server.handleEnqueueAgentCheckout(response, request)
		if response.Code != http.StatusConflict || !strings.Contains(response.Body.String(), "FULL_CHECKOUT_REQUIRED") {
			t.Fatal("agent accepted a preparation-only checkout")
		}
		if job, err := h.manager.ExistingAgentJob(h.sess, ordinary.ItemID); err != nil || job != nil {
			t.Fatal("preparation-only checkout created an agent job")
		}
	}
	firstID := h.enqueue(123, false)
	if again := h.enqueue(123, false); again != firstID {
		t.Fatal("reopened buy link created a duplicate job")
	}
	// The attempt is recorded before the job can be claimed.
	if marker, err := h.manager.GetCheckoutPreparation(h.sess, 123); err != nil || marker == nil || marker.Status != "agent_queued" {
		t.Fatal("queued job has no preparation record")
	}
	job := h.next()
	if err := h.run(job, &fakeAgentCheckout{}); err != nil {
		t.Fatal(err)
	}
	if h.paid != 1 {
		t.Fatal("expected one simulated payment")
	}
	result := h.stored(job.ID)
	if result.State != "complete" || result.Result.Status != "card_payment_confirmed" {
		t.Fatal("result not retained")
	}
	if foreign, err := h.manager.GetAgentJob("another-member", job.ID); err != nil || foreign != nil {
		t.Fatal("job crossed member boundary")
	}
	if again := h.enqueue(123, false); again != firstID {
		t.Fatal("a paid job was replaced")
	}
	replayCtx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	if replay, _, _ := h.agent.Next(replayCtx); replay != nil {
		t.Fatal("claimed job was redelivered")
	}
	h.enqueue(124, true)
	job = h.next()
	if err := h.checkpoint(job, "payment_starting", false); refusalStatus(err) != 403 {
		t.Fatal("validation authorized a payment request")
	}
	if err := h.run(job, &fakeAgentCheckout{}); err != nil {
		t.Fatal(err)
	}
	if h.paid != 1 || h.paymentClaims(124) != 0 {
		t.Fatal("validation sent payment")
	}
	h.enqueue(126, false)
	crashed := h.next()
	if claimed, err := h.manager.ReserveAutoCheckout(h.sess, 126, "another-owner"); err != nil || claimed {
		t.Fatal("agent crash lost the shared payment claim")
	}
	h.exec(`UPDATE checkout_agent_jobs SET updated_at=NOW()-INTERVAL '100 seconds' WHERE id=$1`, crashed.ID)
	if view := h.view(crashed.ID); view.State != "interrupted" || view.Notification != nil {
		t.Fatal("crashed job was not reported as interrupted")
	}
	h.spec.Preferences = json.RawMessage(`{"shipping":"home","payment":"paypal","autoCheckout":{"warningVersion":1,"currency":"EUR","maxTotalMinor":3000}}`)
	h.exec(`UPDATE "User" SET checkout_preferences=jsonb_set(checkout_preferences,'{preferences}',$1::jsonb) WHERE id='synthetic-user'`, string(h.spec.Preferences))
	h.enqueue(127, false)
	job = h.next()
	if err := h.run(job, &fakeAgentCheckout{paypal: true}); err != nil {
		t.Fatal(err)
	}
	if persisted := h.stored(job.ID); persisted.Result.PaymentURL != "" || persisted.Result.Status != "paypal_redirect_ready" {
		t.Fatal("provider redirect was persisted in durable job state")
	}
	history, err := h.manager.GetCheckoutLinks(h.sess.UserID)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range history {
		if entry.PaymentURL != "" {
			t.Fatal("provider token leaked into checkout history")
		}
	}
	// The member must be able to open the approval link more than once.
	for range 3 {
		view := h.view(job.ID)
		if view.State != "complete" || view.Result.Status != "paypal_redirect_ready" || !strings.Contains(view.Result.PaymentURL, "synthetic-handoff-only") {
			t.Fatal("provider handoff was not readable again")
		}
	}
	handoffKey := "vinted:agent-payment:" + h.sess.UserID + ":" + job.ID
	raw, err := h.redis.Get(context.Background(), handoffKey).Result()
	if err != nil || strings.Contains(raw, "paypal") || strings.Contains(raw, "synthetic-handoff-only") {
		t.Fatal("provider handoff is not encrypted and member scoped")
	}
	if ttl := h.redis.TTL(context.Background(), handoffKey).Val(); ttl <= 9*time.Minute || ttl > session.CheckoutPaymentHandoffTTL {
		t.Fatalf("provider handoff lifetime %s differs from the server path", ttl)
	}
	// Once the handoff is gone the member is sent to Vinted, never to a second payment.
	if err := h.redis.Del(context.Background(), handoffKey).Err(); err != nil {
		t.Fatal(err)
	}
	if view := h.view(job.ID); view.State != "complete" || view.Result.Status != "checkout_review_required" || view.Result.PaymentURL != "" ||
		!strings.Contains(view.Result.Reason, "PayPal link is no longer available") || view.Notification == nil || view.Notification.Status != "paypal_redirect_ready" {
		t.Fatalf("expired provider handoff was misreported: %+v", view)
	}
	if h.paid != 2 {
		t.Fatal("unexpected number of simulated payments")
	}
	if err := h.manager.RevokeAgent(h.sess.UserID); err != nil {
		t.Fatal(err)
	}
	_, status, err := h.agent.Next(context.Background())
	if err == nil || status != 401 {
		t.Fatal("revoked device retained checkout access")
	}
	if errors.Is(err, context.Canceled) {
		t.Fatal("unexpected context cancellation")
	}
}

func TestLocalCheckoutAgentPaymentBoundaryAgainstPostgres(t *testing.T) {
	h := newAgentHarness(t)
	checkoutURL := func(link *session.CheckoutLink) {
		link.TransactionID = 77
		link.CheckoutURL = "https://www.vinted.de/checkout?purchase_id=synthetic-private"
	}
	// A refused payment start means that no payment request was sent.
	h.enqueue(201, false)
	job := h.next()
	err := h.run(job, &fakeAgentCheckout{beforePayment: func() {
		h.exec(`UPDATE "User" SET checkout_enabled=false WHERE id='synthetic-user'`)
	}})
	h.exec(`UPDATE "User" SET checkout_enabled=true WHERE id='synthetic-user'`)
	if err == nil || errors.Is(err, checkoutagent.ErrSessionVerification) || h.paid != 0 {
		t.Fatal("revoked payment settings did not stop payment")
	}
	refused := h.stored(job.ID)
	if refused.State != "complete" || refused.Result.Status != "checkout_review_required" || refused.Result.AutoCheckoutReason != "Payment was not acknowledged by Vintrack; no payment request was sent." || refused.Result.CheckoutURL == "" {
		t.Fatalf("refused payment start was misreported: %+v", refused.Result)
	}
	if view := h.view(job.ID); view.State != "complete" || view.Result.Status != "checkout_review_required" {
		t.Fatalf("refused payment start was shown as %+v", view.Result)
	}

	// An outcome is accepted only after an acknowledged payment start.
	h.enqueue(202, false)
	job = h.next()
	for _, complete := range []bool{true, false} {
		if err := h.checkpoint(job, "card_payment_confirmed", complete, checkoutURL); refusalStatus(err) != 409 {
			t.Fatalf("payment outcome without a payment start was accepted: %v", err)
		}
	}
	if untouched := h.stored(job.ID); untouched.State != "claimed" || untouched.Result != nil {
		t.Fatal("a refused outcome changed the job")
	}
	for _, status := range []string{"agent_started", "transaction_creating", "checkout_building", "checkout_updating"} {
		if err := h.checkpoint(job, status, false, checkoutURL); err != nil {
			t.Fatalf("%s: %v", status, err)
		}
	}
	if err := h.checkpoint(job, "card_payment_confirmed", false, checkoutURL); refusalStatus(err) != 409 {
		t.Fatal("payment outcome skipped the payment start")
	}
	if err := h.checkpoint(job, "payment_starting", false, checkoutURL); err != nil {
		t.Fatal(err)
	}
	if err := h.checkpoint(job, "payment_starting", false, checkoutURL); refusalStatus(err) != 409 {
		t.Fatal("payment authorization was acknowledged twice")
	}
	if err := h.checkpoint(job, "checkout_review_required", true, checkoutURL); refusalStatus(err) != 409 {
		t.Fatal("a job moved backwards after its payment start")
	}
	// The device died after the acknowledged payment start: not an interruption.
	if view := h.view(job.ID); view.State != "claimed" {
		t.Fatalf("a live job was reported as %s", view.State)
	}
	h.exec(`UPDATE checkout_agent_jobs SET updated_at=NOW()-INTERVAL '100 seconds' WHERE id=$1`, job.ID)
	view := h.view(job.ID)
	if view.State != "complete" || view.Result.Status != "payment_outcome_unknown" ||
		view.Result.Reason != "A payment request may already have been sent. Check Vinted; do not start it again." ||
		view.Notification == nil || view.Notification.Status != "payment_outcome_unknown" {
		t.Fatalf("stale job after payment start was misreported: %+v", view)
	}
	if again := h.enqueue(202, false); again != job.ID {
		t.Fatal("a job that may have paid was replaced")
	}
	if claimed, err := h.manager.ReserveAutoCheckout(h.sess, 202, "another-owner"); err != nil || claimed {
		t.Fatal("the payment claim of an uncertain payment was released")
	}
	// A late outcome from the device is still recorded.
	if err := h.checkpoint(job, "card_payment_confirmed", true, checkoutURL); err != nil {
		t.Fatal(err)
	}
	if view := h.view(job.ID); view.State != "complete" || view.Result.Status != "card_payment_confirmed" {
		t.Fatalf("late outcome was not recorded: %+v", view)
	}
	if h.paid != 0 {
		t.Fatal("a payment was simulated without an acknowledged start")
	}
}

func TestLocalCheckoutAgentRejectionsKeepTheAgentPollingAgainstPostgres(t *testing.T) {
	h := newAgentHarness(t)
	poll := func() (*checkoutagent.Job, int, error) {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		return h.agent.Next(ctx)
	}
	// An expired job is closed on the job, not answered as an agent error.
	expired := h.enqueue(301, false)
	h.exec(`UPDATE checkout_agent_jobs SET created_at=NOW()-INTERVAL '3 minutes' WHERE id=$1`, expired)
	if job, status, err := poll(); job != nil || status != 204 || err != nil {
		t.Fatalf("expired job answered %d: %v", status, err)
	}
	closed := h.stored(expired)
	if closed.State != "complete" || !closed.NeverStarted || closed.Result.Status != "checkout_review_required" || closed.Result.AutoCheckoutReason != "queued checkout expired; no payment started" {
		t.Fatalf("expired job was not closed: %+v", closed)
	}
	if h.paymentClaims(301) != 0 {
		t.Fatal("an undelivered job took a payment claim")
	}
	// Changed settings reject the job; the agent polls on.
	changed := h.enqueue(302, false)
	h.exec(`UPDATE "User" SET checkout_preferences=jsonb_set(checkout_preferences,'{preferences,autoCheckout,maxTotalMinor}','2500') WHERE id='synthetic-user'`)
	if job, status, err := poll(); job != nil || status != 204 || err != nil {
		t.Fatalf("settings change answered %d: %v", status, err)
	}
	h.exec(`UPDATE "User" SET checkout_preferences=jsonb_set(checkout_preferences,'{preferences,autoCheckout,maxTotalMinor}','3000') WHERE id='synthetic-user'`)
	if closed := h.stored(changed); closed.State != "complete" || !closed.NeverStarted || closed.Result.AutoCheckoutReason != "saved checkout settings changed; no payment started" {
		t.Fatalf("rejected job was not closed: %+v", closed)
	}
	// The same agent still receives the next job.
	h.enqueue(303, false)
	if job := h.next(); job.Spec.ItemID != 303 {
		t.Fatal("agent did not receive the next job after rejections")
	}
	// A session storage failure is temporary: 503, never 401 or 409.
	cacheKey := "vinted:session:" + h.sess.UserID
	cached, err := h.redis.Get(context.Background(), cacheKey).Result()
	if err != nil {
		t.Fatal(err)
	}
	if err := h.redis.Set(context.Background(), cacheKey, "{", time.Hour).Err(); err != nil {
		t.Fatal(err)
	}
	_, status, err := poll()
	if err := h.redis.Set(context.Background(), cacheKey, cached, time.Hour).Err(); err != nil {
		t.Fatal(err)
	}
	if status != 503 || refusalStatus(err) != 503 {
		t.Fatalf("session storage failure answered %d", status)
	}
	h.enqueue(304, false)
	if job := h.next(); job.Spec.ItemID != 304 {
		t.Fatal("agent did not recover after a storage failure")
	}
	// Only a pairing that no longer matches the linked account ends the agent.
	relinked := *h.sess
	relinked.LinkedAt = "synthetic-relinked"
	if err := h.manager.Store(relinked); err != nil {
		t.Fatal(err)
	}
	_, status, err = poll()
	var refusal *checkoutagent.CoordinatorError
	if status != 409 || !errors.As(err, &refusal) || refusal.Code != checkoutagent.PairingMismatch {
		t.Fatalf("pairing mismatch answered %d: %v", status, err)
	}
}

func TestLocalCheckoutAgentIdentityProbeAgainstPostgres(t *testing.T) {
	h := newAgentHarness(t)
	// A probe that got no usable answer is not a rejected session.
	h.enqueue(351, false)
	job := h.next()
	err := h.run(job, &fakeAgentCheckout{probeErr: &vinted.UpstreamHTTPError{StatusCode: 503, Message: "synthetic-private"}})
	if err == nil || errors.Is(err, checkoutagent.ErrSessionVerification) {
		t.Fatalf("a temporary probe failure must not stop the agent: %v", err)
	}
	stopped := h.stored(job.ID)
	if stopped.State != "complete" || stopped.Result.ServerContextRejected || !strings.Contains(stopped.Result.AutoCheckoutReason, "(Vinted HTTP 503)") || strings.Contains(stopped.Result.AutoCheckoutReason, "synthetic-private") {
		t.Fatalf("probe failure was misreported: %+v", stopped.Result)
	}
	if blocked, err := h.manager.CheckoutContextBlocked(agentContextSession(h.sess, h.device())); err != nil || blocked {
		t.Fatal("a temporary probe failure blocked the checkout context")
	}
	h.enqueue(352, false)
	job = h.next()
	// A denial is a rejection: the context is blocked and nothing is retried.
	if err := h.run(job, &fakeAgentCheckout{probeErr: &vinted.UpstreamHTTPError{StatusCode: 403}}); !errors.Is(err, checkoutagent.ErrSessionVerification) {
		t.Fatalf("a denied session must stop the agent: %v", err)
	}
	if rejected := h.stored(job.ID); rejected.State != "complete" || !rejected.Result.ServerContextRejected {
		t.Fatalf("session denial was not recorded: %+v", rejected.Result)
	}
	if w := h.enqueueRaw(353, false); w.Code != 409 || !strings.Contains(w.Body.String(), "sync fresh local checkout context") {
		t.Fatalf("a rejected context still accepted a job: %d", w.Code)
	}
	if h.paid != 0 {
		t.Fatal("a payment was simulated after a failed identity probe")
	}
}

func TestLocalCheckoutAgentJobReplacementAgainstPostgres(t *testing.T) {
	h := newAgentHarness(t)
	gone := func(id string) {
		t.Helper()
		if job, err := h.manager.GetAgentJob(h.sess.UserID, id); err != nil || job != nil {
			t.Fatalf("replaced job %s still exists", id)
		}
	}
	// A queued job inside its queue age is the answer for its item.
	first := h.enqueue(401, false)
	if again := h.enqueue(401, false); again != first {
		t.Fatal("a live queued job was replaced")
	}
	// Queued past the queue age and never delivered: replaceable.
	h.exec(`UPDATE checkout_agent_jobs SET created_at=NOW()-INTERVAL '3 minutes' WHERE id=$1`, first)
	second := h.enqueue(401, false)
	if second == first {
		t.Fatal("an expired, undelivered job blocked its item")
	}
	gone(first)
	// Closed by the coordinator before delivery: replaceable.
	h.exec(`UPDATE checkout_agent_jobs SET created_at=NOW()-INTERVAL '3 minutes' WHERE id=$1`, second)
	if job, status, err := h.agent.Next(context.Background()); job != nil || status != 204 || err != nil {
		t.Fatalf("expired job answered %d: %v", status, err)
	}
	third := h.enqueue(401, false)
	if third == second {
		t.Fatal("a job rejected before delivery blocked its item")
	}
	gone(second)
	// A failed first checkout request may have reached Vinted: never replaceable.
	job := h.next()
	if job.ID != third {
		t.Fatal("unexpected job delivered")
	}
	if err := h.run(job, &fakeAgentCheckout{failAt: "transaction_creating", failErr: &vinted.TransportError{Step: "buy conversation", Kind: "timeout"}}); err == nil {
		t.Fatal("failed transaction was reported as success")
	}
	failed := h.stored(third)
	if failed.State != "complete" || failed.NeverStarted || failed.Result.Status != "transaction_creating" || !strings.Contains(failed.Result.AutoCheckoutReason, "at transaction_creating (network: timeout).") {
		t.Fatalf("failed transaction was misreported: %+v", failed)
	}
	if again := h.enqueue(401, false); again != third {
		t.Fatal("a job that may have reached Vinted was replaced")
	}
	if claimed, err := h.manager.ReserveAutoCheckout(h.sess, 401, "another-owner"); err != nil || claimed {
		t.Fatal("the payment claim of a started checkout was released")
	}
	// A delivered job that is still running is never replaced.
	running := h.enqueue(405, false)
	h.next()
	if again := h.enqueue(405, false); again != running {
		t.Fatal("a running job was replaced")
	}
	// A validation job takes no payment claim. Ended before any transaction
	// checkpoint, it makes room for the real buy.
	validation := h.enqueue(403, true)
	job = h.next()
	if err := h.run(job, &fakeAgentCheckout{probeErr: &vinted.UpstreamHTTPError{StatusCode: 503}}); err == nil {
		t.Fatal("failed probe was reported as success")
	}
	if stopped := h.stored(validation); stopped.State != "complete" || !stopped.NeverStarted {
		t.Fatalf("job stopped before its transaction was not marked: %+v", stopped)
	}
	if buy := h.enqueue(403, false); buy == validation {
		t.Fatal("a validation job that never started blocked the buy")
	}
	gone(validation)
	// A buy job holds its payment claim from delivery on and stays, even when
	// it stopped before any transaction checkpoint.
	claimedJob := h.enqueue(404, false)
	job = h.next()
	if job.ID == claimedJob {
		t.Fatal("jobs are delivered oldest first")
	}
	_ = h.run(job, &fakeAgentCheckout{})
	job = h.next()
	if job.ID != claimedJob {
		t.Fatal("unexpected job delivered")
	}
	if err := h.run(job, &fakeAgentCheckout{probeErr: &vinted.UpstreamHTTPError{StatusCode: 503}}); err == nil {
		t.Fatal("failed probe was reported as success")
	}
	if h.paymentClaims(404) != 1 {
		t.Fatal("delivered buy job has no payment claim")
	}
	if again := h.enqueue(404, false); again != claimedJob {
		t.Fatal("a job holding a payment claim was replaced")
	}
	// A leftover queue marker without a job does not block the item.
	lock, acquired, err := h.manager.AcquireCheckoutPreparation(h.sess, 406)
	if err != nil || !acquired {
		t.Fatal("preparation lock unavailable")
	}
	if err := h.manager.SaveCheckoutPreparation(h.sess, lock, session.CheckoutLink{ItemID: 406, SellerID: 456, Status: "agent_queued"}); err != nil {
		t.Fatal(err)
	}
	_ = h.manager.ReleaseCheckoutPreparation(h.sess, 406, lock)
	h.enqueue(406, false)
	// A real earlier attempt through another transport does.
	lock, acquired, err = h.manager.AcquireCheckoutPreparation(h.sess, 407)
	if err != nil || !acquired {
		t.Fatal("preparation lock unavailable")
	}
	if err := h.manager.SaveCheckoutPreparation(h.sess, lock, session.CheckoutLink{ItemID: 407, SellerID: 456, Status: "checkout_prepared"}); err != nil {
		t.Fatal(err)
	}
	_ = h.manager.ReleaseCheckoutPreparation(h.sess, 407, lock)
	if w := h.enqueueRaw(407, false); w.Code != 409 || !strings.Contains(w.Body.String(), "already attempted") {
		t.Fatalf("an earlier attempt was ignored: %d", w.Code)
	}
	// Re-pairing replaces the device. A job queued for the old device can never
	// be claimed and must not block its item.
	orphan := h.enqueue(402, false)
	old := h.agent
	h.agent = h.pair()
	if _, status, err := old.Next(context.Background()); err == nil || status != 401 {
		t.Fatal("replaced device retained checkout access")
	}
	adopted := h.enqueue(402, false)
	if adopted == orphan {
		t.Fatal("a job queued for a replaced device blocked its item")
	}
	gone(orphan)
	// Jobs still queued for the replaced device are not delivered to the new one.
	if job := h.next(); job.ID != adopted {
		t.Fatal("new device did not receive the re-queued job")
	}
	if h.paid != 1 {
		t.Fatalf("unexpected number of simulated payments: %d", h.paid)
	}
}

func TestLocalCheckoutAgentPairingCodesAgainstPostgres(t *testing.T) {
	h := newAgentHarness(t)
	// One valid code per member: a new code invalidates the previous one.
	first, err := h.manager.CreateAgentPairCode(h.sess)
	if err != nil {
		t.Fatal(err)
	}
	second, err := h.manager.CreateAgentPairCode(h.sess)
	if err != nil {
		t.Fatal(err)
	}
	if device, _, err := h.manager.ExchangeAgentPairCode(first); err == nil || device != nil {
		t.Fatal("a replaced pairing code still paired a device")
	}
	device, token, err := h.manager.ExchangeAgentPairCode(second)
	if err != nil || device == nil || len(token) != 64 {
		t.Fatal("the current pairing code did not pair")
	}
	if device, _, err := h.manager.ExchangeAgentPairCode(second); err == nil || device != nil {
		t.Fatal("pairing code was reusable")
	}
	// Revoking withdraws an outstanding code together with the device.
	outstanding, err := h.manager.CreateAgentPairCode(h.sess)
	if err != nil {
		t.Fatal(err)
	}
	if err := h.manager.RevokeAgent(h.sess.UserID); err != nil {
		t.Fatal(err)
	}
	if device, _, err := h.manager.ExchangeAgentPairCode(outstanding); err == nil || device != nil {
		t.Fatal("a pairing code survived the revoke")
	}
	if device, err := h.manager.AgentForUser(h.sess.UserID); err != nil || device != nil {
		t.Fatal("revoke left a device behind")
	}
	if keys, err := h.redis.Keys(context.Background(), "vinted:agent-pair*").Result(); err != nil || len(keys) != 0 {
		t.Fatalf("pairing code material was left in Redis: %v", keys)
	}
}

// These cases hold for any database time zone: ages and the online window are
// computed by PostgreSQL, never by comparing stored timestamps with this clock.
func TestLocalCheckoutAgentClockAndLivenessAgainstPostgres(t *testing.T) {
	h := newAgentHarness(t)
	var zone string
	if err := h.db.QueryRow(`SHOW timezone`).Scan(&zone); err != nil {
		t.Fatal(err)
	}
	t.Logf("database time zone: %s", zone)
	seen := func(interval string) {
		t.Helper()
		h.exec(`UPDATE checkout_agent_devices SET last_seen_at=NOW()-$1::interval WHERE user_id='synthetic-user'`, interval)
	}
	if !h.device().Online() {
		t.Fatal("a device that just polled is offline")
	}
	seen("20 seconds")
	if !h.device().Online() {
		t.Fatal("a device seen 20 seconds ago is offline")
	}
	seen("31 seconds")
	if h.device().Online() {
		t.Fatal("a device silent for 31 seconds is online")
	}
	if w := h.enqueueRaw(501, false); w.Code != 409 || !strings.Contains(w.Body.String(), "start your paired checkout agent") {
		t.Fatalf("a job was queued for an offline device: %d", w.Code)
	}
	if job, err := h.manager.ExistingAgentJob(h.sess, 501); err != nil || job != nil {
		t.Fatal("an offline device received a job")
	}
	h.touch()
	queued := h.enqueue(501, false)
	fresh := h.stored(queued)
	if fresh.Age < 0 || fresh.Age > 30*time.Second || fresh.Idle < 0 || fresh.Idle > 30*time.Second {
		t.Fatalf("a new job has age %s and idle time %s", fresh.Age, fresh.Idle)
	}
	if view := h.view(queued); view.State != "pending" {
		t.Fatalf("a new job is %s", view.State)
	}
	h.exec(`UPDATE checkout_agent_jobs SET created_at=NOW()-INTERVAL '100 seconds' WHERE id=$1`, queued)
	if view := h.view(queued); view.State != "pending" {
		t.Fatalf("a job queued for 100 seconds is %s", view.State)
	}
	h.exec(`UPDATE checkout_agent_jobs SET created_at=NOW()-INTERVAL '121 seconds' WHERE id=$1`, queued)
	if view := h.view(queued); view.State != "expired" {
		t.Fatalf("a job queued for 121 seconds is %s", view.State)
	}
	h.exec(`UPDATE checkout_agent_jobs SET created_at=NOW() WHERE id=$1`, queued)
	job := h.next()
	// A device that is busy with a job stays online through its checkpoints.
	seen("5 minutes")
	if err := h.checkpoint(job, "agent_started", false); err != nil {
		t.Fatal(err)
	}
	if !h.device().Online() {
		t.Fatal("a checkpoint did not refresh the device's liveness")
	}
	h.exec(`UPDATE checkout_agent_jobs SET updated_at=NOW()-INTERVAL '80 seconds' WHERE id=$1`, job.ID)
	if view := h.view(job.ID); view.State != "claimed" {
		t.Fatalf("a job idle for 80 seconds is %s", view.State)
	}
	h.exec(`UPDATE checkout_agent_jobs SET updated_at=NOW()-INTERVAL '91 seconds' WHERE id=$1`, job.ID)
	if view := h.view(job.ID); view.State != "interrupted" {
		t.Fatalf("a job idle for 91 seconds is %s", view.State)
	}

	// An abandoned long poll must not swallow the wake-up of the live one.
	// Earlier jobs were claimed without waiting, so their wake-ups are still
	// queued; start from an empty list so that both polls really wait.
	if err := h.redis.Del(context.Background(), "vinted:agent-wake:"+h.device().ID).Err(); err != nil {
		t.Fatal(err)
	}
	abandoned, abandon := context.WithCancel(context.Background())
	abandonedDone := make(chan *checkoutagent.Job, 1)
	go func() {
		job, _, _ := h.agent.Next(abandoned)
		abandonedDone <- job
	}()
	time.Sleep(300 * time.Millisecond)
	abandon()
	type delivery struct {
		job    *checkoutagent.Job
		status int
		err    error
	}
	live := make(chan delivery, 1)
	go func() {
		job, status, err := h.agent.Next(context.Background())
		live <- delivery{job, status, err}
	}()
	time.Sleep(300 * time.Millisecond)
	woken := h.enqueue(502, false)
	select {
	case got := <-live:
		if got.err != nil || got.status != 200 || got.job == nil || got.job.ID != woken {
			t.Fatalf("live poll answered %d: %v", got.status, got.err)
		}
	case <-time.After(8 * time.Second):
		t.Fatal("the wake-up was consumed by an abandoned poll")
	}
	if job := <-abandonedDone; job != nil {
		t.Fatal("an abandoned poll received a job")
	}
}
