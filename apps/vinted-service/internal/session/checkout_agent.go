package session

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

// Agent credentials are separate from browser-link credentials and cannot access
// general member APIs. Vinted credentials are never persisted by the agent.
type CheckoutAgentDevice struct {
	ID        string `json:"id"`
	UserID    string `json:"-"`
	AccountID int64  `json:"account_id"`
	Domain    string `json:"domain"`
	LinkedAt  string `json:"-"`
	// online is decided by the database clock when the row is read.
	online bool
}
type CheckoutAgentSpec struct {
	MonitorID         int64           `json:"monitor_id,omitempty"`
	ItemID            int64           `json:"item_id"`
	SellerID          int64           `json:"seller_id"`
	AccountID         int64           `json:"account_id"`
	Domain            string          `json:"domain"`
	Preferences       json.RawMessage `json:"preferences"`
	StopBeforePayment bool            `json:"stop_before_payment"`
}
type CheckoutAgentJob struct {
	ID       string            `json:"id"`
	UserID   string            `json:"-"`
	DeviceID string            `json:"-"`
	State    string            `json:"state"`
	Spec     CheckoutAgentSpec `json:"-"`
	Result   *CheckoutLink     `json:"result,omitempty"`
	// Age (since queueing) and Idle (since the last checkpoint) are measured on
	// the database clock when the row is read. The stored timestamps carry no
	// time zone and must not be compared with the service clock.
	Age  time.Duration `json:"-"`
	Idle time.Duration `json:"-"`
	// NeverStarted is written only by the coordinator: the job ended before
	// any transaction checkpoint was acknowledged for it.
	NeverStarted bool `json:"-"`
}

// agentJobResult is the encrypted result document. The marker lives beside
// the checkout fields so a device-supplied checkpoint can never set it.
type agentJobResult struct {
	CheckoutLink
	NeverStarted bool `json:"never_started,omitempty"`
}

// AgentOnlineWindow is how recently a device must have polled or checkpointed
// to count as online. A long poll lasts 15 seconds and a failed poll waits 10.
const AgentOnlineWindow = 30 * time.Second

const agentPairCodeTTL = 5 * time.Minute

func AgentSecret() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}
func agentHash(raw string) string {
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:])
}
func (d *CheckoutAgentDevice) Matches(s *VintedSession) bool {
	return s != nil && d.UserID == s.UserID && d.AccountID == s.VintedUserID && d.Domain == s.Domain && d.LinkedAt == s.LinkedAt
}
func (d *CheckoutAgentDevice) Online() bool {
	return d.online
}
func agentPairCodeKey(hash string) string { return "vinted:agent-pair:" + hash }
func agentPairUserKey(user string) string { return "vinted:agent-pair-user:" + user }

// One pairing code per member: creating a code invalidates the previous one.
func (m *Manager) CreateAgentPairCode(s *VintedSession) (string, error) {
	if m.store == nil {
		return "", errors.New("agent storage unavailable")
	}
	code, err := AgentSecret()
	if err != nil {
		return "", err
	}
	binding := CheckoutAgentDevice{UserID: s.UserID, AccountID: s.VintedUserID, Domain: s.Domain, LinkedAt: s.LinkedAt}
	// These fields are server-side only, so encode explicitly instead of the public DTO.
	body, _ := json.Marshal(map[string]interface{}{"user": binding.UserID, "account": binding.AccountID, "domain": binding.Domain, "linked": binding.LinkedAt})
	const script = `
local previous = redis.call("get", KEYS[1])
if previous then redis.call("del", ARGV[1] .. previous) end
redis.call("set", ARGV[1] .. ARGV[2], ARGV[3], "PX", ARGV[4])
redis.call("set", KEYS[1], ARGV[2], "PX", ARGV[4])
return 1
`
	err = m.redis.Eval(m.ctx, script, []string{agentPairUserKey(s.UserID)}, agentPairCodeKey(""), agentHash(code), string(body), agentPairCodeTTL.Milliseconds()).Err()
	if err != nil {
		return "", errors.New("agent pairing unavailable")
	}
	return code, nil
}
func (m *Manager) ExchangeAgentPairCode(code string) (*CheckoutAgentDevice, string, error) {
	if m.store == nil || len(code) != 64 {
		return nil, "", errors.New("invalid or expired pairing code")
	}
	hash := agentHash(code)
	body, err := m.redis.GetDel(m.ctx, agentPairCodeKey(hash)).Bytes()
	if err != nil {
		return nil, "", errors.New("invalid or expired pairing code")
	}
	var binding struct {
		User    string `json:"user"`
		Account int64  `json:"account"`
		Domain  string `json:"domain"`
		Linked  string `json:"linked"`
	}
	if json.Unmarshal(body, &binding) != nil {
		return nil, "", errors.New("invalid pairing code")
	}
	// Only the member's current code pairs a device. A code that was replaced
	// or withdrawn by a revoke is refused even if its own key still existed.
	const current = `
if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) end
return 0
`
	if owned, err := m.redis.Eval(m.ctx, current, []string{agentPairUserKey(binding.User)}, hash).Int(); err != nil || owned != 1 {
		return nil, "", errors.New("invalid or expired pairing code")
	}
	sess, err := m.Get(binding.User)
	if err != nil || sess == nil || sess.VintedUserID != binding.Account || sess.Domain != binding.Domain || sess.LinkedAt != binding.Linked {
		return nil, "", errors.New("linked account changed")
	}
	access, err := m.FeatureAccess(binding.User, "checkout_links")
	if err != nil || !access.Allowed {
		return nil, "", errors.New("checkout unavailable")
	}
	accepted, err := m.CheckoutConsentAccepted(binding.User)
	if err != nil || !accepted {
		return nil, "", errors.New("checkout consent required")
	}
	token, err := AgentSecret()
	if err != nil {
		return nil, "", err
	}
	id, err := AgentSecret()
	if err != nil {
		return nil, "", err
	}
	_, err = m.store.db.ExecContext(m.ctx, `INSERT INTO checkout_agent_devices(user_id,id,token_hash,vinted_user_id,domain,linked_at,expires_at)
 VALUES($1,$2,$3,$4,$5,$6,NOW()+INTERVAL '30 days') ON CONFLICT(user_id) DO UPDATE SET id=$2,token_hash=$3,vinted_user_id=$4,domain=$5,linked_at=$6,expires_at=NOW()+INTERVAL '30 days',last_seen_at=NULL`, binding.User, id, agentHash(token), binding.Account, binding.Domain, binding.Linked)
	if err != nil {
		return nil, "", errors.New("agent pairing unavailable")
	}
	return &CheckoutAgentDevice{ID: id, UserID: binding.User, AccountID: binding.Account, Domain: binding.Domain, LinkedAt: binding.Linked}, token, nil
}

// LOCALTIMESTAMP uses the same session time zone that filled the column, so
// the comparison holds for any database time zone.
var agentDeviceColumns = fmt.Sprintf(`id,user_id,vinted_user_id,domain,linked_at,COALESCE(last_seen_at > LOCALTIMESTAMP - INTERVAL '%d seconds',FALSE)`, int(AgentOnlineWindow/time.Second))

func scanAgent(row *sql.Row) (*CheckoutAgentDevice, error) {
	var d CheckoutAgentDevice
	err := row.Scan(&d.ID, &d.UserID, &d.AccountID, &d.Domain, &d.LinkedAt, &d.online)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return &d, err
}
func (m *Manager) AgentForUser(user string) (*CheckoutAgentDevice, error) {
	if m.store == nil {
		return nil, errors.New("agent storage unavailable")
	}
	return scanAgent(m.store.db.QueryRowContext(m.ctx, `SELECT `+agentDeviceColumns+` FROM checkout_agent_devices WHERE user_id=$1 AND expires_at>NOW()`, user))
}
func (m *Manager) AuthenticateAgent(token string) (*CheckoutAgentDevice, error) {
	if m.store == nil || len(token) != 64 {
		return nil, errors.New("invalid agent authorization")
	}
	return scanAgent(m.store.db.QueryRowContext(m.ctx, `SELECT `+agentDeviceColumns+` FROM checkout_agent_devices WHERE token_hash=$1 AND expires_at>NOW()`, agentHash(token)))
}
func (m *Manager) TouchAgent(d *CheckoutAgentDevice) error {
	result, err := m.store.db.ExecContext(m.ctx, `UPDATE checkout_agent_devices SET last_seen_at=NOW() WHERE id=$1`, d.ID)
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err != nil || n != 1 {
		return errors.New("agent revoked")
	}
	return nil
}

// RevokeAgent removes the device and withdraws any outstanding pairing code.
func (m *Manager) RevokeAgent(user string) error {
	if m.store == nil {
		return errors.New("agent storage unavailable")
	}
	_, err := m.store.db.ExecContext(m.ctx, `DELETE FROM checkout_agent_devices WHERE user_id=$1`, user)
	const script = `
local previous = redis.call("get", KEYS[1])
if previous then redis.call("del", ARGV[1] .. previous) end
return redis.call("del", KEYS[1])
`
	if codeErr := m.redis.Eval(m.ctx, script, []string{agentPairUserKey(user)}, agentPairCodeKey("")).Err(); err == nil && codeErr != nil {
		err = errors.New("pairing code could not be withdrawn")
	}
	return err
}
func (m *Manager) decodeAgentJob(row *sql.Row) (*CheckoutAgentJob, error) {
	var j CheckoutAgentJob
	var request string
	var result sql.NullString
	var age, idle float64
	err := row.Scan(&j.ID, &j.UserID, &j.DeviceID, &j.State, &request, &result, &age, &idle)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, errors.New("agent job storage unavailable")
	}
	j.Age = time.Duration(age * float64(time.Second))
	j.Idle = time.Duration(idle * float64(time.Second))
	plain, err := m.store.cipher.Decrypt(request)
	if err != nil || json.Unmarshal([]byte(plain), &j.Spec) != nil {
		return nil, errors.New("agent job unreadable")
	}
	if result.Valid {
		plain, err = m.store.cipher.Decrypt(result.String)
		if err != nil {
			return nil, errors.New("agent result unreadable")
		}
		var stored agentJobResult
		if json.Unmarshal([]byte(plain), &stored) != nil {
			return nil, errors.New("agent result unreadable")
		}
		j.Result = &stored.CheckoutLink
		j.NeverStarted = stored.NeverStarted
	}
	return &j, nil
}

// Ages are computed by PostgreSQL: the columns are timestamps without a time
// zone, so reading them into the service clock is wrong outside UTC.
const agentJobColumns = `id,user_id,device_id,state,request_ciphertext,result_ciphertext,
 EXTRACT(EPOCH FROM (LOCALTIMESTAMP-created_at))::float8,EXTRACT(EPOCH FROM (LOCALTIMESTAMP-updated_at))::float8`

func (m *Manager) GetAgentJob(user, id string) (*CheckoutAgentJob, error) {
	if m.store == nil {
		return nil, errors.New("agent storage unavailable")
	}
	return m.decodeAgentJob(m.store.db.QueryRowContext(m.ctx, `SELECT `+agentJobColumns+` FROM checkout_agent_jobs WHERE user_id=$1 AND id=$2`, user, id))
}
func agentScope(s *VintedSession, item int64) string {
	return agentHash(fmt.Sprintf("%d:%s:%s:%d", s.VintedUserID, s.Domain, s.LinkedAt, item))
}
func (m *Manager) ExistingAgentJob(s *VintedSession, item int64) (*CheckoutAgentJob, error) {
	if m.store == nil {
		return nil, errors.New("agent storage unavailable")
	}
	return m.decodeAgentJob(m.store.db.QueryRowContext(m.ctx, `SELECT `+agentJobColumns+` FROM checkout_agent_jobs WHERE user_id=$1 AND scope_key=$2`, s.UserID, agentScope(s, item)))
}
func (m *Manager) EnqueueAgentJob(s *VintedSession, d *CheckoutAgentDevice, spec CheckoutAgentSpec) (*CheckoutAgentJob, error) {
	data, _ := json.Marshal(spec)
	encrypted, err := m.store.cipher.Encrypt(string(data))
	if err != nil {
		return nil, err
	}
	id, err := AgentSecret()
	if err != nil {
		return nil, err
	}
	var inserted string
	err = m.store.db.QueryRowContext(m.ctx, `INSERT INTO checkout_agent_jobs(id,user_id,device_id,scope_key,request_ciphertext)VALUES($1,$2,$3,$4,$5)ON CONFLICT(user_id,scope_key)DO NOTHING RETURNING id`, id, s.UserID, d.ID, agentScope(s, spec.ItemID), encrypted).Scan(&inserted)
	if err == sql.ErrNoRows {
		// The item already has a job. Report that one; nothing new was queued.
		return m.ExistingAgentJob(s, spec.ItemID)
	}
	if err != nil {
		return nil, errors.New("agent queue unavailable")
	}
	// The row is durable from here on, so the caller always learns its id.
	// Wake the outbound long poll. PostgreSQL remains authoritative if Redis restarts.
	_ = m.redis.LPush(m.ctx, "vinted:agent-wake:"+d.ID, "job").Err()
	_ = m.redis.Expire(m.ctx, "vinted:agent-wake:"+d.ID, time.Minute).Err()
	return &CheckoutAgentJob{ID: inserted, UserID: s.UserID, DeviceID: d.ID, State: "pending", Spec: spec}, nil
}

// AgentJobReplaceable reports whether a job provably never reached Vinted and
// may therefore make room for a new job for the same item: it was never
// delivered (still queued past the queue age, or queued for a device that is
// no longer the member's device), or the coordinator closed it before any
// transaction checkpoint and it carries no transaction or checkout.
func AgentJobReplaceable(j *CheckoutAgentJob, current *CheckoutAgentDevice, queueAge time.Duration) bool {
	if j == nil {
		return false
	}
	switch j.State {
	case "pending":
		return j.Age > queueAge || (current != nil && j.DeviceID != current.ID)
	case "complete":
		return j.NeverStarted && j.Result != nil && j.Result.TransactionID == 0 && j.Result.CheckoutURL == ""
	}
	return false
}

// ReplaceAgentJob deletes a replaceable job. The statement re-checks the
// state it was read in and refuses whenever a durable payment claim exists
// for the item, so a job that may have paid is never removed.
func (m *Manager) ReplaceAgentJob(s *VintedSession, current *CheckoutAgentDevice, j *CheckoutAgentJob, queueAge time.Duration) (bool, error) {
	if m.store == nil {
		return false, errors.New("agent storage unavailable")
	}
	if current == nil || !AgentJobReplaceable(j, current, queueAge) {
		return false, nil
	}
	result, err := m.store.db.ExecContext(m.ctx, `DELETE FROM checkout_agent_jobs j WHERE j.id=$1 AND j.user_id=$2 AND j.state=$3
 AND (j.state='complete' OR j.device_id<>$4 OR j.created_at < LOCALTIMESTAMP - make_interval(secs => $5::float8))
 AND NOT EXISTS (SELECT 1 FROM checkout_payment_attempts a WHERE a.vinted_user_id=$6 AND a.item_id=$7)`,
		j.ID, s.UserID, j.State, current.ID, queueAge.Seconds(), s.VintedUserID, j.Spec.ItemID)
	if err != nil {
		return false, errors.New("agent queue unavailable")
	}
	count, err := result.RowsAffected()
	return count == 1 && err == nil, err
}
func (m *Manager) ClaimAgentJob(ctx context.Context, d *CheckoutAgentDevice) (*CheckoutAgentJob, error) {
	// Claim once, with no lease/redelivery: a crash can otherwise repeat payment.
	claim := func() (*CheckoutAgentJob, error) {
		return m.decodeAgentJob(m.store.db.QueryRowContext(ctx, `UPDATE checkout_agent_jobs SET state='claimed',claimed_at=NOW(),updated_at=NOW()
 WHERE id=(SELECT id FROM checkout_agent_jobs WHERE device_id=$1 AND state='pending' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
 AND state='pending' RETURNING `+agentJobColumns, d.ID))
	}
	j, err := claim()
	if err != nil || j != nil {
		return j, err
	}
	wake := "vinted:agent-wake:" + d.ID
	popped, popErr := m.redis.BLPop(ctx, 15*time.Second, wake).Result()
	if ctx.Err() != nil {
		// The poll was abandoned while it waited. A cancelled context does not
		// interrupt the blocking pop, so hand a consumed wake-up back to the
		// device's next poll instead of losing it.
		if popErr == nil && len(popped) == 2 {
			_ = m.redis.LPush(m.ctx, wake, popped[1]).Err()
			_ = m.redis.Expire(m.ctx, wake, time.Minute).Err()
		}
		return nil, ctx.Err()
	}
	return claim()
}
func (m *Manager) saveAgentJob(d *CheckoutAgentDevice, j *CheckoutAgentJob, link *CheckoutLink, complete, neverStarted bool) error {
	var result interface{}
	if link != nil {
		stored := agentJobResult{CheckoutLink: *link, NeverStarted: neverStarted}
		stored.PaymentURL = ""
		data, _ := json.Marshal(stored)
		encrypted, err := m.store.cipher.Encrypt(string(data))
		if err != nil {
			return err
		}
		result = encrypted
	}
	state := "claimed"
	if complete {
		state = "complete"
	}
	updated, err := m.store.db.ExecContext(m.ctx, `UPDATE checkout_agent_jobs SET result_ciphertext=$4,state=$5,updated_at=NOW() WHERE id=$1 AND user_id=$2 AND device_id=$3 AND state='claimed'`, j.ID, d.UserID, d.ID, result, state)
	if err != nil {
		return errors.New("agent checkpoint unavailable")
	}
	count, err := updated.RowsAffected()
	if err != nil || count != 1 {
		return errors.New("agent checkpoint owner changed")
	}
	return nil
}
func (m *Manager) SaveAgentJob(d *CheckoutAgentDevice, j *CheckoutAgentJob, link *CheckoutLink, complete bool) error {
	return m.saveAgentJob(d, j, link, complete, false)
}

// CloseUnstartedAgentJob completes a job that ended before any transaction
// checkpoint was acknowledged. Only the coordinator decides that.
func (m *Manager) CloseUnstartedAgentJob(d *CheckoutAgentDevice, j *CheckoutAgentJob, link CheckoutLink) error {
	return m.saveAgentJob(d, j, &link, true, true)
}

func agentPaymentHandoffKey(j *CheckoutAgentJob) string {
	return "vinted:agent-payment:" + j.UserID + ":" + j.ID
}

// A provider redirect lets the member finish a payment that was started once.
// It is an encrypted, short-lived handoff scoped to the member and job, never a
// durable job result: it cannot be read from PostgreSQL or job history. Reading
// it again sends nothing to Vinted and starts no second payment.
func (m *Manager) SetAgentPaymentHandoff(j *CheckoutAgentJob, raw string) error {
	encrypted, err := m.store.cipher.Encrypt(raw)
	if err != nil {
		return err
	}
	return m.redis.Set(m.ctx, agentPaymentHandoffKey(j), encrypted, CheckoutPaymentHandoffTTL).Err()
}

// AgentPaymentHandoff returns "" when no link is held any more.
func (m *Manager) AgentPaymentHandoff(j *CheckoutAgentJob) (string, error) {
	encrypted, err := m.redis.Get(m.ctx, agentPaymentHandoffKey(j)).Result()
	if err == redis.Nil {
		return "", nil
	}
	if err != nil {
		return "", errors.New("payment handoff unavailable")
	}
	raw, err := m.store.cipher.Decrypt(encrypted)
	if err != nil {
		// An unreadable handoff is as good as gone; the member continues in Vinted.
		return "", nil
	}
	return raw, nil
}
