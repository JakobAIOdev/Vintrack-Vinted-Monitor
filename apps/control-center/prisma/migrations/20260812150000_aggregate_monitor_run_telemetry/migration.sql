-- The worker now folds monitor-run telemetry in memory and writes one
-- pre-aggregated upsert per flush interval. Keeping the per-row trigger would
-- double-count the failure and new-item rows that still reach monitor_runs.
DROP TRIGGER IF EXISTS "monitor_runs_hourly_stats_after_insert" ON "monitor_runs";
DROP FUNCTION IF EXISTS update_monitor_run_hourly_stats();

-- The monitor metrics dialog reads its proxy error code from the aggregate now
-- that routine successful checks no longer produce detail rows, so the status
-- code has to survive the fold.
ALTER TABLE "monitor_run_hourly_stats"
ADD COLUMN IF NOT EXISTS "latest_status_code" INTEGER;

-- Each active monitor's current bucket is updated once per flush instead of
-- once per check. The update never touches an indexed column, so reserved page
-- space keeps those updates HOT and the primary key stops churning.
ALTER TABLE "monitor_run_hourly_stats" SET (
    fillfactor = 70,
    autovacuum_vacuum_scale_factor = 0.0,
    autovacuum_vacuum_threshold = 1000,
    autovacuum_analyze_scale_factor = 0.0,
    autovacuum_analyze_threshold = 5000
);

COMMENT ON TABLE "monitor_runs" IS
    'Anomaly-only per-check detail: failed runs, plus successful runs that produced new items. This is NOT a complete record of checks. Check counts, success rates, durations and last-checked timestamps live in monitor_run_hourly_stats.';

COMMENT ON COLUMN "monitor_run_hourly_stats"."latest_status_code" IS
    'HTTP status of the run that produced latest_error, or NULL when unknown.';

-- Release dedupe claims that never resulted in a delivered message.
--
-- The claim used to be written with a 30 day expiry before the first delivery
-- attempt, and it is scoped to the member rather than to the monitor. Every
-- alert lost since the durable outbox shipped therefore left a claim behind
-- that suppressed that item across all of that member's monitors. Claims are
-- now provisional until a delivery succeeds, but the existing rows still have
-- to be cleared.
DELETE FROM "alert_dedupe_claims" c
WHERE NOT EXISTS (
    SELECT 1
    FROM "alert_notifications" n
    JOIN "alert_deliveries" d ON d."notification_id" = n."id"
    WHERE n."user_id" = c."user_id"
      AND n."item_id" = c."item_id"
      AND d."status" = 'sent'
);
