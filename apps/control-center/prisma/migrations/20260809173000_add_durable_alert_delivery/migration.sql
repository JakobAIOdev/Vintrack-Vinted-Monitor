-- Durable notification outbox, bounded alert telemetry, and proxy incidents.

CREATE TABLE "alert_dedupe_claims" (
    "user_id" TEXT NOT NULL,
    "item_id" BIGINT NOT NULL,
    "claimed_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(6) NOT NULL,
    CONSTRAINT "alert_dedupe_claims_pkey" PRIMARY KEY ("user_id", "item_id"),
    CONSTRAINT "alert_dedupe_claims_user_id_fkey"
        FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "alert_dedupe_claims_expires_at_idx"
    ON "alert_dedupe_claims"("expires_at");

CREATE TABLE "alert_notifications" (
    "id" BIGSERIAL NOT NULL,
    "user_id" TEXT,
    "monitor_id" INTEGER,
    "item_id" BIGINT,
    "kind" VARCHAR(50) NOT NULL,
    "payload_version" INTEGER NOT NULL DEFAULT 1,
    "payload" JSONB NOT NULL,
    "idempotency_key" VARCHAR(255) NOT NULL,
    "expires_at" TIMESTAMP(6) NOT NULL,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "alert_notifications_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "alert_notifications_idempotency_key_key" UNIQUE ("idempotency_key"),
    CONSTRAINT "alert_notifications_user_id_fkey"
        FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "alert_notifications_monitor_id_fkey"
        FOREIGN KEY ("monitor_id") REFERENCES "monitors"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "alert_notifications_user_id_created_at_idx"
    ON "alert_notifications"("user_id", "created_at");
CREATE INDEX "alert_notifications_monitor_id_created_at_idx"
    ON "alert_notifications"("monitor_id", "created_at");

CREATE TABLE "alert_deliveries" (
    "id" BIGSERIAL NOT NULL,
    "notification_id" BIGINT NOT NULL,
    "channel" VARCHAR(20) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "destination_fingerprint" VARCHAR(64) NOT NULL,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_until" TIMESTAMP(6),
    "claim_token" VARCHAR(64),
    "last_reason_code" VARCHAR(50),
    "last_error_detail" TEXT,
    "completed_at" TIMESTAMP(6),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "alert_deliveries_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "alert_deliveries_notification_id_fkey"
        FOREIGN KEY ("notification_id") REFERENCES "alert_notifications"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "alert_deliveries_notification_id_channel_key" UNIQUE ("notification_id", "channel"),
    CONSTRAINT "alert_deliveries_status_check"
        CHECK ("status" IN ('pending', 'processing', 'retrying', 'sent', 'failed', 'cancelled')),
    CONSTRAINT "alert_deliveries_channel_check"
        CHECK ("channel" IN ('discord', 'telegram'))
);

CREATE INDEX "alert_deliveries_ready_idx"
    ON "alert_deliveries"("next_attempt_at", "created_at", "id")
    WHERE "status" IN ('pending', 'retrying');
CREATE INDEX "alert_deliveries_expired_lease_idx"
    ON "alert_deliveries"("lease_until")
    WHERE "status" = 'processing';
CREATE INDEX "alert_deliveries_destination_active_idx"
    ON "alert_deliveries"("destination_fingerprint", "created_at", "id")
    WHERE "status" IN ('pending', 'processing', 'retrying');
CREATE INDEX "alert_deliveries_terminal_idx"
    ON "alert_deliveries"("completed_at", "id")
    WHERE "status" IN ('sent', 'failed', 'cancelled');
-- Keep Prisma's portable indexes alongside the narrower partial indexes used by
-- the dispatcher. The partial indexes remain the hot-path indexes in production.
CREATE INDEX "alert_deliveries_status_next_attempt_at_idx"
    ON "alert_deliveries"("status", "next_attempt_at");
CREATE INDEX "alert_deliveries_destination_fingerprint_status_created_at_idx"
    ON "alert_deliveries"("destination_fingerprint", "status", "created_at");
CREATE INDEX "alert_deliveries_lease_until_idx"
    ON "alert_deliveries"("lease_until");

ALTER TABLE "alert_events"
    ADD COLUMN "notification_id" BIGINT,
    ADD COLUMN "delivery_id" BIGINT,
    ADD COLUMN "notification_kind" VARCHAR(50) NOT NULL DEFAULT 'item_match',
    ADD COLUMN "reason_code" VARCHAR(50),
    ADD COLUMN "attempt_number" INTEGER;

ALTER TABLE "alert_events"
    ADD CONSTRAINT "alert_events_notification_id_fkey"
        FOREIGN KEY ("notification_id") REFERENCES "alert_notifications"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    ADD CONSTRAINT "alert_events_delivery_id_fkey"
        FOREIGN KEY ("delivery_id") REFERENCES "alert_deliveries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "alert_events_notification_id_idx" ON "alert_events"("notification_id");
CREATE INDEX "alert_events_delivery_id_idx" ON "alert_events"("delivery_id");
CREATE INDEX IF NOT EXISTS "alert_events_created_at_idx" ON "alert_events"("created_at");
CREATE INDEX IF NOT EXISTS "alert_events_status_created_at_idx" ON "alert_events"("status", "created_at");

CREATE TABLE "alert_event_hourly_stats" (
    "bucket_hour" TIMESTAMP(6) NOT NULL,
    "channel" VARCHAR(20) NOT NULL,
    "notification_kind" VARCHAR(50) NOT NULL,
    "outcome" VARCHAR(30) NOT NULL,
    "reason_code" VARCHAR(50) NOT NULL DEFAULT '',
    "event_count" BIGINT NOT NULL DEFAULT 0,
    "last_seen_at" TIMESTAMP(6) NOT NULL,
    CONSTRAINT "alert_event_hourly_stats_pkey"
        PRIMARY KEY ("bucket_hour", "channel", "notification_kind", "outcome", "reason_code")
);

CREATE INDEX "alert_event_hourly_stats_bucket_hour_outcome_idx"
    ON "alert_event_hourly_stats"("bucket_hour", "outcome");

CREATE OR REPLACE FUNCTION update_alert_event_hourly_stats()
RETURNS TRIGGER AS $$
DECLARE
    normalized_outcome TEXT;
    normalized_reason TEXT;
BEGIN
    normalized_outcome := CASE
        WHEN NEW."status" = 'skipped' AND NEW."failure_reason" = 'duplicate_user_item_alert' THEN 'deduplicated'
        WHEN NEW."status" = 'success' THEN 'sent'
        ELSE NEW."status"
    END;
    normalized_reason := COALESCE(
        NEW."reason_code",
        CASE
            WHEN NEW."failure_reason" = 'duplicate_user_item_alert' THEN 'duplicate_user_item_alert'
            WHEN NEW."failure_reason" ILIKE '%429%' THEN 'rate_limited'
            ELSE ''
        END
    );

    INSERT INTO "alert_event_hourly_stats" (
        "bucket_hour", "channel", "notification_kind", "outcome",
        "reason_code", "event_count", "last_seen_at"
    ) VALUES (
        DATE_TRUNC('hour', NEW."created_at"),
        NEW."channel",
        COALESCE(NULLIF(NEW."notification_kind", ''), 'item_match'),
        normalized_outcome,
        normalized_reason,
        1,
        NEW."created_at"
    )
    ON CONFLICT ("bucket_hour", "channel", "notification_kind", "outcome", "reason_code")
    DO UPDATE SET
        "event_count" = "alert_event_hourly_stats"."event_count" + 1,
        "last_seen_at" = GREATEST("alert_event_hourly_stats"."last_seen_at", EXCLUDED."last_seen_at");
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TEMP TABLE "_alert_event_backfill_cutoff" AS
SELECT COALESCE(MAX("id"), 0) AS "max_id" FROM "alert_events";

CREATE TRIGGER "alert_events_hourly_stats_after_insert"
AFTER INSERT ON "alert_events"
FOR EACH ROW EXECUTE FUNCTION update_alert_event_hourly_stats();

INSERT INTO "alert_event_hourly_stats" (
    "bucket_hour", "channel", "notification_kind", "outcome",
    "reason_code", "event_count", "last_seen_at"
)
SELECT
    DATE_TRUNC('hour', "created_at"),
    "channel",
    COALESCE(NULLIF("notification_kind", ''), 'item_match'),
    CASE
        WHEN "status" = 'skipped' AND "failure_reason" = 'duplicate_user_item_alert' THEN 'deduplicated'
        WHEN "status" = 'success' THEN 'sent'
        ELSE "status"
    END,
    COALESCE(
        "reason_code",
        CASE
            WHEN "failure_reason" = 'duplicate_user_item_alert' THEN 'duplicate_user_item_alert'
            WHEN "failure_reason" ILIKE '%429%' THEN 'rate_limited'
            ELSE ''
        END
    ),
    COUNT(*),
    MAX("created_at")
FROM "alert_events"
WHERE "id" <= (SELECT "max_id" FROM "_alert_event_backfill_cutoff")
  AND "created_at" >= NOW() - INTERVAL '24 hours'
GROUP BY 1, 2, 3, 4, 5
ON CONFLICT ("bucket_hour", "channel", "notification_kind", "outcome", "reason_code")
DO UPDATE SET
    "event_count" = "alert_event_hourly_stats"."event_count" + EXCLUDED."event_count",
    "last_seen_at" = GREATEST("alert_event_hourly_stats"."last_seen_at", EXCLUDED."last_seen_at");

INSERT INTO "app_settings" ("key", "value", "created_at", "updated_at")
VALUES ('alert_telemetry_tracked_since', NOW()::TEXT, NOW(), NOW())
ON CONFLICT ("key") DO NOTHING;

CREATE OR REPLACE FUNCTION notify_alert_delivery_ready()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW."status" IN ('pending', 'retrying') THEN
        PERFORM pg_notify('alert_delivery_ready', NEW."id"::TEXT);
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "alert_deliveries_ready_after_change"
AFTER INSERT OR UPDATE OF "status", "next_attempt_at" ON "alert_deliveries"
FOR EACH ROW EXECUTE FUNCTION notify_alert_delivery_ready();

CREATE TABLE "monitor_proxy_incidents" (
    "id" BIGSERIAL NOT NULL,
    "monitor_id" INTEGER NOT NULL,
    "domain" VARCHAR(255) NOT NULL,
    "proxy_source" VARCHAR(20) NOT NULL,
    "started_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_wait_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retry_at" TIMESTAMP(6),
    "wait_count" INTEGER NOT NULL DEFAULT 1,
    "recovered_at" TIMESTAMP(6),
    "end_reason" VARCHAR(30),
    CONSTRAINT "monitor_proxy_incidents_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "monitor_proxy_incidents_monitor_id_fkey"
        FOREIGN KEY ("monitor_id") REFERENCES "monitors"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "monitor_proxy_incidents_one_open_idx"
    ON "monitor_proxy_incidents"("monitor_id") WHERE "recovered_at" IS NULL;
CREATE INDEX "monitor_proxy_incidents_monitor_id_started_at_idx"
    ON "monitor_proxy_incidents"("monitor_id", "started_at");
CREATE INDEX "monitor_proxy_incidents_started_at_idx"
    ON "monitor_proxy_incidents"("started_at");
CREATE INDEX "monitor_proxy_incidents_recovered_at_idx"
    ON "monitor_proxy_incidents"("recovered_at");
