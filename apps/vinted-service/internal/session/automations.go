package session

import (
	"context"
	"database/sql"
	"fmt"
	"time"
)

// Shared account-level backstops across monitors and service replicas.
const (
	automationDailyAttemptLimit     = 500
	automationActionIntervalSeconds = 5
)

// Automatic actions only consume fresh, persisted matches that passed worker filters.
// The durable claim is intentionally never retried after an uncertain outcome.
type AutomationCandidate struct {
	MonitorID       int
	UserID          string
	AccountID       int64
	Domain          string
	Kind            string
	Revision        int
	DiscountPercent int
	MaxPriceMinor   int64
	Template        string
	ItemID          int64
	SellerID        int64
	Title           string
	Price           string
	Seller          string
	URL             string
	MonitorName     string
	Region          string
	FoundAt         time.Time
}

func (m *Manager) AutomationCandidates(ctx context.Context) ([]AutomationCandidate, error) {
	if m.store == nil {
		return nil, nil
	}
	rows, err := m.store.db.QueryContext(ctx, `
        SELECT a.monitor_id, m."userId", a.account_id, a.domain, a.kind, a.revision,
               a.discount_percent, a.max_price_minor, a.message_template,
               i.id, i.seller_id, COALESCE(i.title,''), COALESCE(i.price,''),
               COALESCE(i.seller_login,''), COALESCE(i.url,''), m.name, m.region, i.found_at
        FROM monitor_account_automations a
        JOIN monitors m ON m.id = a.monitor_id
        JOIN "User" member ON member.id = m."userId" AND member.banned_at IS NULL
        JOIN items i ON i.monitor_id = m.id
        JOIN monitor_item_detections d ON d.monitor_id = m.id AND d.item_id = i.id
        JOIN vinted_sessions s ON s.user_id = m."userId" AND s.vinted_user_id = a.account_id AND s.domain = a.domain
        WHERE a.enabled AND m.status = 'active' AND s.status = 'active'
          AND i.found_at > a.enabled_at AND d.created_at > a.enabled_at
          AND i.found_at > NOW() - INTERVAL '2 minutes'
          AND i.seller_id > 0 AND i.seller_id <> a.account_id
          AND NOT EXISTS (SELECT 1 FROM seller_bans b WHERE b."userId" = m."userId" AND b.seller_id = i.seller_id)
          AND NOT EXISTS (SELECT 1 FROM account_automation_attempts p
              WHERE p.user_id = m."userId" AND p.account_id = a.account_id AND p.domain = a.domain AND p.item_id = i.id AND p.kind = a.kind)
          AND NOT EXISTS (SELECT 1 FROM account_automation_attempts p
              WHERE p.user_id = m."userId" AND p.account_id = a.account_id AND p.domain = a.domain AND p.status <> 'skipped'
                AND (COALESCE(p.completed_at, p.created_at) > NOW() - $1 * INTERVAL '1 second'
                     OR p.status = 'sending'
                     OR (p.status = 'uncertain' AND p.created_at > NOW() - INTERVAL '15 minutes')))
          AND (SELECT COUNT(*) FROM account_automation_attempts p
               WHERE p.user_id = m."userId" AND p.account_id = a.account_id AND p.domain = a.domain AND p.kind = a.kind
                 AND p.status <> 'skipped' AND p.created_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC')) < $2
        ORDER BY i.found_at, a.kind, a.monitor_id LIMIT 100`, automationActionIntervalSeconds, automationDailyAttemptLimit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var candidates []AutomationCandidate
	for rows.Next() {
		var c AutomationCandidate
		if err := rows.Scan(&c.MonitorID, &c.UserID, &c.AccountID, &c.Domain, &c.Kind, &c.Revision,
			&c.DiscountPercent, &c.MaxPriceMinor, &c.Template, &c.ItemID, &c.SellerID, &c.Title,
			&c.Price, &c.Seller, &c.URL, &c.MonitorName, &c.Region, &c.FoundAt); err != nil {
			return nil, err
		}
		candidates = append(candidates, c)
	}
	return candidates, rows.Err()
}

func (m *Manager) ClaimAutomation(ctx context.Context, c AutomationCandidate) (int64, error) {
	if m.store == nil {
		return 0, fmt.Errorf("durable store unavailable")
	}
	tx, err := m.store.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	// Serializes all monitor claims for an account across service replicas.
	if _, err = tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
		fmt.Sprintf("automation:%s:%d:%s", c.UserID, c.AccountID, c.Domain)); err != nil {
		return 0, err
	}
	var revision int
	err = tx.QueryRowContext(ctx, `
        SELECT a.revision FROM monitor_account_automations a
        JOIN monitors m ON m.id = a.monitor_id
        JOIN "User" member ON member.id = m."userId" AND member.banned_at IS NULL
        JOIN vinted_sessions s ON s.user_id = m."userId"
        WHERE a.monitor_id = $1 AND a.kind = $2 AND a.enabled AND a.revision = $3
          AND a.account_id = $4 AND a.domain = $5 AND m."userId" = $6 AND m.status = 'active'
          AND s.vinted_user_id = a.account_id AND s.domain = a.domain AND s.status = 'active'
          AND $7::timestamp > a.enabled_at AND $7::timestamp > NOW() - INTERVAL '2 minutes'
          AND NOT EXISTS (SELECT 1 FROM seller_bans b WHERE b."userId" = m."userId" AND b.seller_id = $8)
        FOR UPDATE OF a`, c.MonitorID, c.Kind, c.Revision, c.AccountID, c.Domain, c.UserID, c.FoundAt, c.SellerID).Scan(&revision)
	if err == sql.ErrNoRows {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	var id int64
	err = tx.QueryRowContext(ctx, `
        INSERT INTO account_automation_attempts (user_id, account_id, domain, item_id, monitor_id, kind)
        SELECT $1::text, $2::bigint, $3::varchar(255), $4::bigint, $5::integer, $6::varchar(20)
        WHERE NOT EXISTS (SELECT 1 FROM account_automation_attempts
            WHERE user_id = $1 AND account_id = $2 AND domain = $3 AND status <> 'skipped'
              AND (COALESCE(completed_at, created_at) > NOW() - $7 * INTERVAL '1 second'
                   OR (status = 'sending')
                   OR (status = 'uncertain' AND created_at > NOW() - INTERVAL '15 minutes')))
          AND (SELECT COUNT(*) FROM account_automation_attempts
               WHERE user_id = $1 AND account_id = $2 AND domain = $3 AND kind = $6 AND status <> 'skipped'
                 AND created_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC')) < $8
        ON CONFLICT (user_id, account_id, domain, item_id, kind) DO NOTHING RETURNING id`,
		c.UserID, c.AccountID, c.Domain, c.ItemID, c.MonitorID, c.Kind, automationActionIntervalSeconds, automationDailyAttemptLimit).Scan(&id)
	if err == sql.ErrNoRows {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return id, nil
}

func (m *Manager) FinishAutomation(ctx context.Context, id int64, status, reason string) error {
	if m.store == nil {
		return fmt.Errorf("durable store unavailable")
	}
	_, err := m.store.db.ExecContext(ctx, `UPDATE account_automation_attempts SET status = $2, reason = $3, completed_at = NOW() WHERE id = $1 AND status = 'sending'`, id, status, reason)
	return err
}

// Check again after refresh/warmup, which may take longer than a settings change.
func (m *Manager) AutomationStillEnabled(ctx context.Context, c AutomationCandidate) (bool, error) {
	if m.store == nil {
		return false, nil
	}
	var enabled bool
	err := m.store.db.QueryRowContext(ctx, `SELECT EXISTS (
		SELECT 1 FROM monitor_account_automations a
		JOIN monitors m ON m.id = a.monitor_id
        JOIN "User" member ON member.id = m."userId" AND member.banned_at IS NULL
		JOIN vinted_sessions s ON s.user_id = m."userId"
		WHERE a.monitor_id = $1 AND a.kind = $2 AND a.revision = $3 AND a.enabled
		  AND m.status = 'active' AND m."userId" = $4
		  AND s.vinted_user_id = $5 AND s.domain = $6 AND s.status = 'active'
		  AND a.account_id = s.vinted_user_id AND a.domain = s.domain
		  AND $7::timestamp > a.enabled_at AND $7::timestamp > NOW() - INTERVAL '2 minutes'
		  AND NOT EXISTS (SELECT 1 FROM seller_bans b WHERE b."userId" = m."userId" AND b.seller_id = $8)
	)`, c.MonitorID, c.Kind, c.Revision, c.UserID, c.AccountID, c.Domain, c.FoundAt, c.SellerID).Scan(&enabled)
	return enabled, err
}

func (m *Manager) ExpireAutomationClaims(ctx context.Context) error {
	if m.store == nil {
		return nil
	}
	_, err := m.store.db.ExecContext(ctx, `UPDATE account_automation_attempts SET status = 'uncertain', reason = 'service_interrupted', completed_at = NOW() WHERE status = 'sending' AND created_at < NOW() - INTERVAL '5 minutes'`)
	return err
}
