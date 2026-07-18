\set ON_ERROR_STOP on

BEGIN;

-- This dataset is intentionally isolated by its dev-seed prefix. Re-running
-- the script replaces only data created by this seed and leaves real local
-- accounts untouched.
DELETE FROM monitor_limits
WHERE scope LIKE 'user:dev-seed-user-%';

DELETE FROM "User"
WHERE id LIKE 'dev-seed-user-%';

INSERT INTO "User" (
    id,
    name,
    email,
    "createdAt",
    role,
    monitor_onboarding_status,
    dedupe_monitor_alerts
)
SELECT
    'dev-seed-user-' || LPAD(seed_no::text, 4, '0'),
    'Dev Member ' || LPAD(seed_no::text, 3, '0'),
    'dev.member.' || LPAD(seed_no::text, 3, '0') || '@vintrack.test',
    NOW() - ((seed_no % 180) || ' days')::interval,
    CASE
        WHEN seed_no % 50 = 0 THEN 'admin'
        WHEN seed_no % 4 = 0 THEN 'premium'
        ELSE 'free'
    END,
    CASE WHEN seed_no % 11 = 0 THEN 'pending' ELSE 'completed' END,
    seed_no % 5 = 0
FROM generate_series(1, 300) AS seed(seed_no);

INSERT INTO proxy_groups (
    "userId",
    name,
    proxies,
    bandwidth_rx_bytes,
    bandwidth_tx_bytes,
    bandwidth_limit_bytes,
    bandwidth_reset_at,
    created_at
)
SELECT
    user_row.id,
    'Dev residential pool',
    'http://dev-user:dev-pass@127.0.0.1:' || (10000 + seed.seed_no)::text,
    (seed.seed_no * 1048576)::bigint,
    (seed.seed_no * 524288)::bigint,
    10737418240::bigint,
    NOW() - ((seed.seed_no % 20) || ' days')::interval,
    NOW() - ((seed.seed_no % 120) || ' days')::interval
FROM generate_series(1, 300) AS seed(seed_no)
JOIN "User" AS user_row
    ON user_row.id = 'dev-seed-user-' || LPAD(seed.seed_no::text, 4, '0')
WHERE seed.seed_no % 3 = 0;

INSERT INTO monitors (
    "userId",
    name,
    query,
    anti_keywords,
    query_delay_ms,
    price_min,
    price_max,
    region,
    status,
    created_at,
    demo_expires_at,
    webhook_active,
    telegram_active,
    proxy_group_id,
    proxy_source
)
SELECT
    user_row.id,
    'Dev Monitor ' || LPAD(seed.seed_no::text, 3, '0') || '-' || monitor_no,
    (ARRAY['nike', 'carhartt', 'adidas', 'vintage', 'ralph lauren'])[
        1 + ((seed.seed_no + monitor_no) % 5)
    ],
    CASE WHEN monitor_no % 3 = 0 THEN 'fake,damaged' ELSE NULL END,
    1000 + ((seed.seed_no + monitor_no) % 8) * 250,
    5 + ((seed.seed_no + monitor_no) % 20),
    40 + ((seed.seed_no + monitor_no) % 100),
    (ARRAY['de', 'fr', 'it', 'es', 'nl', 'pl', 'be', 'uk', 'hu'])[
        1 + ((seed.seed_no + monitor_no) % 9)
    ],
    'paused',
    NOW() - (((seed.seed_no + monitor_no) % 180) || ' days')::interval,
    CASE
        WHEN monitor_no = 1 AND seed.seed_no % 5 = 0
        THEN NOW() - ((1 + seed.seed_no % 14) || ' days')::interval
        ELSE NULL
    END,
    seed.seed_no % 2 = 0,
    seed.seed_no % 7 = 0,
    proxy_group.id,
    CASE WHEN proxy_group.id IS NULL THEN 'server' ELSE 'group' END
FROM generate_series(1, 300) AS seed(seed_no)
JOIN "User" AS user_row
    ON user_row.id = 'dev-seed-user-' || LPAD(seed.seed_no::text, 4, '0')
CROSS JOIN LATERAL generate_series(1, 1 + (seed.seed_no % 4)) AS monitor(monitor_no)
LEFT JOIN proxy_groups AS proxy_group
    ON proxy_group."userId" = user_row.id
   AND proxy_group.name = 'Dev residential pool';

INSERT INTO monitor_runs (
    monitor_id,
    status,
    status_code,
    duration_ms,
    item_count,
    new_item_count,
    error_message,
    proxy_source,
    fetch_source,
    region,
    checked_at
)
SELECT
    monitor.id,
    CASE WHEN run_no % 13 = 0 THEN 'failed' ELSE 'success' END,
    CASE WHEN run_no % 13 = 0 THEN 429 ELSE 200 END,
    450 + ((monitor.id + run_no) % 1800),
    (monitor.id + run_no) % 96,
    CASE WHEN run_no % 9 = 0 THEN 2 WHEN run_no % 4 = 0 THEN 1 ELSE 0 END,
    CASE WHEN run_no % 13 = 0 THEN 'Synthetic dev rate limit' ELSE NULL END,
    monitor.proxy_source,
    'canonical',
    monitor.region,
    NOW() - ((run_no * 30) || ' minutes')::interval
FROM monitors AS monitor
CROSS JOIN generate_series(1, 48) AS run(run_no)
WHERE monitor."userId" LIKE 'dev-seed-user-%';

INSERT INTO audit_events (
    "userId",
    action,
    target_type,
    target_id,
    status,
    metadata,
    created_at
)
SELECT
    user_row.id,
    CASE WHEN seed.seed_no % 4 = 0 THEN 'monitor.updated' ELSE 'user.seeded' END,
    'user',
    user_row.id,
    'success',
    jsonb_build_object('devSeed', true, 'seedNumber', seed.seed_no),
    NOW() - ((seed.seed_no % 72) || ' hours')::interval
FROM generate_series(1, 300) AS seed(seed_no)
JOIN "User" AS user_row
    ON user_row.id = 'dev-seed-user-' || LPAD(seed.seed_no::text, 4, '0');

INSERT INTO audit_events (
    "userId",
    action,
    target_type,
    target_id,
    status,
    metadata,
    created_at
)
SELECT
    user_row.id,
    'monitor.demo_converted',
    'monitor',
    MIN(monitor.id)::text,
    'success',
    jsonb_build_object('devSeed', true),
    NOW() - ((seed.seed_no % 30) || ' days')::interval
FROM generate_series(9, 300, 9) AS seed(seed_no)
JOIN "User" AS user_row
    ON user_row.id = 'dev-seed-user-' || LPAD(seed.seed_no::text, 4, '0')
JOIN monitors AS monitor ON monitor."userId" = user_row.id
GROUP BY user_row.id, seed.seed_no;

INSERT INTO monitor_limits (scope, active_limit)
SELECT
    'user:dev-seed-user-' || LPAD(seed_no::text, 4, '0'),
    2 + (seed_no % 8)
FROM generate_series(10, 300, 10) AS seed(seed_no)
ON CONFLICT (scope) DO UPDATE
SET active_limit = EXCLUDED.active_limit,
    updated_at = NOW();

COMMIT;

ANALYZE "User";
ANALYZE monitors;
ANALYZE monitor_runs;
ANALYZE proxy_groups;

SELECT
    (SELECT COUNT(*) FROM "User" WHERE id LIKE 'dev-seed-user-%') AS seeded_users,
    (SELECT COUNT(*) FROM monitors WHERE "userId" LIKE 'dev-seed-user-%') AS seeded_monitors,
    (
        SELECT COUNT(*)
        FROM monitor_runs AS run
        JOIN monitors AS monitor ON monitor.id = run.monitor_id
        WHERE monitor."userId" LIKE 'dev-seed-user-%'
    ) AS seeded_runs,
    (SELECT COUNT(*) FROM proxy_groups WHERE "userId" LIKE 'dev-seed-user-%') AS seeded_proxy_groups;
