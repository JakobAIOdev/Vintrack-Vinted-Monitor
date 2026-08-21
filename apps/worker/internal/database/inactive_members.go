package database

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

const (
	inactiveMemberPolicyKey  = "inactive_member_monitor_policy"
	inactiveMemberRuntimeKey = "inactive_member_monitor_runtime"
	globalMonitorLockKey     = "vintrack:global-monitor-maintenance"
)

type InactiveMemberPolicy struct {
	Enabled             bool     `json:"enabled"`
	Revision            string   `json:"revision"`
	Duration            int      `json:"duration"`
	DurationUnit        string   `json:"durationUnit"`
	DurationDays        int      `json:"durationDays"`
	MonitorScope        string   `json:"monitorScope"`
	IncludePriceWatches bool     `json:"includePriceWatches"`
	Roles               []string `json:"roles"`
	EnabledAt           string   `json:"enabledAt"`
}

type InactiveMemberEvaluation struct {
	PolicyRevision             string
	PausedMemberCount          int
	PausedMonitorCount         int
	NewlyPausedMemberCount     int
	NewlyPausedMonitorCount    int
	PausedPriceWatchCount      int
	NewlyPausedPriceWatchCount int
	EvaluatedAt                time.Time
}

type inactiveMemberRuntime struct {
	HeartbeatAt           string `json:"heartbeatAt"`
	PolicyRevision        string `json:"policyRevision"`
	LastEvaluatedAt       string `json:"lastEvaluatedAt"`
	PausedMemberCount     int    `json:"pausedMemberCount"`
	PausedMonitorCount    int    `json:"pausedMonitorCount"`
	PausedPriceWatchCount int    `json:"pausedPriceWatchCount"`
}

func parseInactiveMemberPolicy(value string) (InactiveMemberPolicy, error) {
	var policy InactiveMemberPolicy
	if err := json.Unmarshal([]byte(value), &policy); err != nil {
		return policy, err
	}
	policy.Revision = strings.TrimSpace(policy.Revision)
	policy.DurationUnit = strings.TrimSpace(policy.DurationUnit)
	policy.MonitorScope = strings.TrimSpace(policy.MonitorScope)
	if policy.Revision == "" || policy.Duration <= 0 {
		return policy, errors.New("missing policy revision or duration")
	}
	multiplier := 0
	switch policy.DurationUnit {
	case "days":
		multiplier = 1
	case "weeks":
		multiplier = 7
	case "months":
		multiplier = 30
	default:
		return policy, errors.New("invalid duration unit")
	}
	policy.DurationDays = policy.Duration * multiplier
	if policy.DurationDays < 1 || policy.DurationDays > 5*365 {
		return policy, errors.New("duration outside allowed range")
	}
	if policy.MonitorScope != "free_proxy" && policy.MonitorScope != "all" {
		return policy, errors.New("invalid monitor scope")
	}
	seenRoles := make(map[string]bool)
	for _, role := range policy.Roles {
		if role != "free" && role != "premium" {
			return policy, errors.New("invalid member role")
		}
		seenRoles[role] = true
	}
	if policy.Enabled && len(seenRoles) == 0 {
		return policy, errors.New("enabled policy requires a role")
	}
	if policy.Enabled {
		if _, err := time.Parse(time.RFC3339Nano, policy.EnabledAt); err != nil {
			return policy, errors.New("invalid enabledAt")
		}
	}
	return policy, nil
}

func (s *Store) EvaluateInactiveMemberPolicy(ctx context.Context) (InactiveMemberEvaluation, error) {
	now := time.Now().UTC()
	result := InactiveMemberEvaluation{EvaluatedAt: now}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return result, err
	}
	defer tx.Rollback()

	if _, err := tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, globalMonitorLockKey); err != nil {
		return result, fmt.Errorf("acquire global monitor lock: %w", err)
	}

	var raw string
	err = tx.QueryRowContext(ctx, `SELECT value FROM app_settings WHERE key = $1`, inactiveMemberPolicyKey).Scan(&raw)
	var policy InactiveMemberPolicy
	if errors.Is(err, sql.ErrNoRows) {
		policy = InactiveMemberPolicy{
			Revision: "inactive-member-policy-disabled-v1", Duration: 1,
			DurationUnit: "weeks", DurationDays: 7, MonitorScope: "free_proxy", Roles: []string{"free"},
		}
	} else if err != nil {
		return result, fmt.Errorf("read inactivity policy: %w", err)
	} else {
		policy, err = parseInactiveMemberPolicy(raw)
		if err != nil {
			return result, fmt.Errorf("parse inactivity policy: %w", err)
		}
	}
	result.PolicyRevision = policy.Revision

	if policy.Enabled {
		enabledAt, _ := time.Parse(time.RFC3339Nano, policy.EnabledAt)
		cutoff := now.Add(-time.Duration(policy.DurationDays) * 24 * time.Hour)
		freeRole, premiumRole := false, false
		for _, role := range policy.Roles {
			freeRole = freeRole || role == "free"
			premiumRole = premiumRole || role == "premium"
		}
		rows, queryErr := tx.QueryContext(ctx, `
			UPDATE monitors m
			SET status = 'inactivity_paused'
			FROM "User" u
			WHERE m."userId" = u.id
			  AND m.status = 'active'
			  AND (($1 AND u.role = 'free') OR ($2 AND u.role = 'premium'))
			  AND ($3 OR m.proxy_source = 'free')
			  AND GREATEST(
				COALESCE(u.last_dashboard_seen_at, '-infinity'::timestamp),
				COALESCE(u."createdAt", '-infinity'::timestamp),
				$4::timestamp
			  ) <= $5::timestamp
			RETURNING m."userId"`, freeRole, premiumRole, policy.MonitorScope == "all", enabledAt, cutoff)
		if queryErr != nil {
			return result, fmt.Errorf("pause inactive monitors: %w", queryErr)
		}
		pausedMembers := make(map[string]struct{})
		for rows.Next() {
			var userID string
			if err := rows.Scan(&userID); err != nil {
				rows.Close()
				return result, err
			}
			pausedMembers[userID] = struct{}{}
			result.NewlyPausedMonitorCount++
		}
		if err := rows.Close(); err != nil {
			return result, err
		}
		if policy.IncludePriceWatches {
			watchRows, watchErr := tx.QueryContext(ctx, `
				UPDATE price_watches pw
				SET status = 'paused', stopped_reason = 'inactive_member', updated_at = NOW()
				FROM "User" u
				WHERE pw.user_id = u.id
				  AND pw.status = 'active'
				  AND (($1 AND u.role = 'free') OR ($2 AND u.role = 'premium'))
				  AND GREATEST(
					COALESCE(u.last_dashboard_seen_at, '-infinity'::timestamp),
					COALESCE(u."createdAt", '-infinity'::timestamp),
					$3::timestamp
				  ) <= $4::timestamp
				RETURNING pw.user_id`, freeRole, premiumRole, enabledAt, cutoff)
			if watchErr != nil {
				return result, fmt.Errorf("pause inactive Price Watches: %w", watchErr)
			}
			for watchRows.Next() {
				var userID string
				if err := watchRows.Scan(&userID); err != nil {
					watchRows.Close()
					return result, err
				}
				pausedMembers[userID] = struct{}{}
				result.NewlyPausedPriceWatchCount++
			}
			if err := watchRows.Close(); err != nil {
				return result, err
			}
		}
		result.NewlyPausedMemberCount = len(pausedMembers)
		if result.NewlyPausedMonitorCount > 0 || result.NewlyPausedPriceWatchCount > 0 {
			metadata, _ := json.Marshal(map[string]any{
				"revision":        policy.Revision,
				"memberCount":     result.NewlyPausedMemberCount,
				"monitorCount":    result.NewlyPausedMonitorCount,
				"priceWatchCount": result.NewlyPausedPriceWatchCount,
				"monitorScope":    policy.MonitorScope,
			})
			if _, err := tx.ExecContext(ctx, `
				INSERT INTO audit_events (action, target_type, target_id, metadata)
				VALUES ('system.inactive_member_monitors_paused', 'app_setting', $1, $2::jsonb)`, inactiveMemberPolicyKey, string(metadata)); err != nil {
				return result, fmt.Errorf("write inactivity audit event: %w", err)
			}
		}
	}

	if err := tx.QueryRowContext(ctx, `
		WITH paused_resources AS (
			SELECT "userId" AS user_id, COUNT(*)::bigint AS monitor_count, 0::bigint AS watch_count
			FROM monitors WHERE status = 'inactivity_paused' GROUP BY "userId"
			UNION ALL
			SELECT user_id, 0::bigint AS monitor_count, COUNT(*)::bigint AS watch_count
			FROM price_watches
			WHERE status = 'paused' AND stopped_reason = 'inactive_member'
			GROUP BY user_id
		)
		SELECT COUNT(DISTINCT user_id),
		       COALESCE(SUM(monitor_count), 0),
		       COALESCE(SUM(watch_count), 0)
		FROM paused_resources`).Scan(&result.PausedMemberCount, &result.PausedMonitorCount, &result.PausedPriceWatchCount); err != nil {
		return result, fmt.Errorf("count inactivity paused monitors: %w", err)
	}
	runtimeJSON, _ := json.Marshal(inactiveMemberRuntime{
		HeartbeatAt: now.Format(time.RFC3339Nano), PolicyRevision: policy.Revision,
		LastEvaluatedAt: now.Format(time.RFC3339Nano), PausedMemberCount: result.PausedMemberCount,
		PausedMonitorCount: result.PausedMonitorCount, PausedPriceWatchCount: result.PausedPriceWatchCount,
	})
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO app_settings (key, value, updated_at)
		VALUES ($1, $2, NOW())
		ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`, inactiveMemberRuntimeKey, string(runtimeJSON)); err != nil {
		return result, fmt.Errorf("write inactivity runtime: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return result, err
	}
	return result, nil
}
