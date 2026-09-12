DROP TRIGGER IF EXISTS "monitors_runtime_before_insert_or_update" ON "monitors";
DROP TRIGGER IF EXISTS "monitors_runtime_after_insert_or_update" ON "monitors";
DROP TRIGGER IF EXISTS "monitors_runtime_before_delete" ON "monitors";

DROP FUNCTION IF EXISTS prepare_monitor_runtime_state();
DROP FUNCTION IF EXISTS persist_monitor_runtime_state();
DROP FUNCTION IF EXISTS close_monitor_runtime_on_delete();
DROP FUNCTION IF EXISTS normalize_monitor_runtime_proxy_source(TEXT, INTEGER);

DROP TABLE IF EXISTS "monitor_runtime_sessions";
DROP TABLE IF EXISTS "member_monitor_runtime_totals";

DROP INDEX IF EXISTS "monitors_active_since_user_idx";
ALTER TABLE "monitors"
    DROP COLUMN IF EXISTS "active_since",
    DROP COLUMN IF EXISTS "runtime_total_seconds";

DELETE FROM "app_settings" WHERE "key" = 'monitor_runtime_tracking_started_at';
