INSERT INTO app_settings (key, value, updated_at)
VALUES
    ('free_proxy_inventory_limit', '30000', NOW()),
    ('free_proxy_candidate_limit_active_region', '10000', NOW()),
    ('free_proxy_candidate_limit_idle_region', '5000', NOW()),
    ('free_proxy_ready_target_active_region', '50', NOW()),
    ('free_proxy_reserve_target_active_region', '50', NOW()),
    ('free_proxy_idle_region_target', '10', NOW()),
    ('free_proxy_emergency_recovery_enabled', 'true', NOW())
ON CONFLICT (key) DO NOTHING;

ALTER TABLE "free_proxy_health"
    ADD COLUMN "candidate_window_token" BIGINT DEFAULT (
        FLOOR(EXTRACT(EPOCH FROM NOW()) / 3600)::bigint
    );
UPDATE "free_proxy_health"
SET "candidate_window_token" = FLOOR(EXTRACT(EPOCH FROM NOW()) / 3600)::bigint;

CREATE INDEX IF NOT EXISTS "free_proxy_health_region_last_checked_at_idx"
    ON "free_proxy_health"("region", "last_checked_at");
CREATE INDEX IF NOT EXISTS "free_proxy_health_region_last_success_at_idx"
    ON "free_proxy_health"("region", "last_success_at");
CREATE INDEX IF NOT EXISTS "free_proxy_health_region_candidate_window_idx"
    ON "free_proxy_health"("region", "candidate_window_token");
CREATE INDEX IF NOT EXISTS "free_proxies_last_seen_at_idx"
    ON "free_proxies"("last_seen_at");

-- Older maintainers globally quarantined a proven proxy after one warmup
-- transport failure. Release those proxies so the new three-strike policy can
-- fan them out to target regions again.
UPDATE free_proxies
SET failure_count = 0,
    quarantined_until = NULL,
    check_claimed_until = NULL,
    updated_at = NOW()
WHERE success_count > 0
  AND last_error_stage = 'warmup'
  AND last_error_code IN (
      'connect',
      'timeout',
      'tls',
      'proxy_handshake',
      'transport'
  );

-- Recheck only the 100 most recently successful candidates per region and
-- spread them over five minutes to avoid a deployment-time request spike.
WITH ranked AS (
    SELECT
        fph.id,
        ROW_NUMBER() OVER (
            PARTITION BY fph.region
            ORDER BY fph.last_success_at DESC NULLS LAST, fph.score DESC, fph.id
        ) AS region_rank
    FROM free_proxy_health fph
    JOIN free_proxies fp ON fp.id = fph.proxy_id
    WHERE fph.last_success_at IS NOT NULL
      AND fp.success_count > 0
), scheduled AS (
    SELECT id
    FROM ranked
    WHERE region_rank <= 100
)
UPDATE free_proxy_health fph
SET next_check_at = LEAST(
        COALESCE(fph.next_check_at, NOW() + INTERVAL '5 minutes'),
        NOW() + MOD(fph.id, 300) * INTERVAL '1 second'
    ),
    updated_at = NOW()
FROM scheduled
WHERE fph.id = scheduled.id;
