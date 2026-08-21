-- Separate canonical item identity from polling state so shared polling can be
-- deduplicated while personal proxy traffic remains isolated per proxy group.
CREATE TABLE "price_watch_schedules" (
    "id" BIGSERIAL NOT NULL,
    "target_id" BIGINT NOT NULL,
    "transport_key" VARCHAR(80) NOT NULL,
    "transport_kind" VARCHAR(20) NOT NULL,
    "proxy_group_id" INTEGER,
    "current_price_minor" BIGINT,
    "currency_code" VARCHAR(3),
    "availability" VARCHAR(30) NOT NULL DEFAULT 'pending',
    "consecutive_unavailable" INTEGER NOT NULL DEFAULT 0,
    "consecutive_errors" INTEGER NOT NULL DEFAULT 0,
    "last_error_code" VARCHAR(50),
    "last_error_detail" TEXT,
    "last_status_code" INTEGER,
    "last_duration_ms" INTEGER,
    "last_checked_at" TIMESTAMP(6),
    "last_success_at" TIMESTAMP(6),
    "next_check_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_until" TIMESTAMP(6),
    "claim_token" VARCHAR(64),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "price_watch_schedules_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "price_watch_schedules_target_id_fkey"
        FOREIGN KEY ("target_id") REFERENCES "price_watch_targets"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "price_watch_schedules_proxy_group_id_fkey"
        FOREIGN KEY ("proxy_group_id") REFERENCES "proxy_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "price_watch_schedules_target_transport_key_key" UNIQUE ("target_id", "transport_key"),
    CONSTRAINT "price_watch_schedules_transport_kind_check"
        CHECK ("transport_kind" IN ('shared', 'proxy_group')),
    CONSTRAINT "price_watch_schedules_transport_shape_check"
        CHECK (
            ("transport_kind" = 'shared' AND "proxy_group_id" IS NULL AND "transport_key" = 'shared') OR
            ("transport_kind" = 'proxy_group' AND "proxy_group_id" IS NOT NULL AND "transport_key" = 'proxy:' || "proxy_group_id"::text)
        ),
    CONSTRAINT "price_watch_schedules_availability_check"
        CHECK ("availability" IN ('pending', 'active', 'unavailable')),
    CONSTRAINT "price_watch_schedules_price_nonnegative"
        CHECK ("current_price_minor" IS NULL OR "current_price_minor" >= 0),
    CONSTRAINT "price_watch_schedules_counters_nonnegative"
        CHECK ("consecutive_unavailable" >= 0 AND "consecutive_errors" >= 0)
);

CREATE INDEX "price_watch_schedules_due_idx"
    ON "price_watch_schedules"("next_check_at", "id")
    WHERE "availability" IN ('pending', 'active');
CREATE INDEX "price_watch_schedules_lease_until_idx"
    ON "price_watch_schedules"("lease_until");
CREATE INDEX "price_watch_schedules_proxy_group_id_idx"
    ON "price_watch_schedules"("proxy_group_id");

INSERT INTO "price_watch_schedules" (
    "target_id", "transport_key", "transport_kind", "current_price_minor",
    "currency_code", "availability", "consecutive_unavailable",
    "consecutive_errors", "last_error_code", "last_error_detail",
    "last_checked_at", "last_success_at", "next_check_at", "lease_until",
    "claim_token", "created_at", "updated_at"
)
SELECT
    "id", 'shared', 'shared', "current_price_minor", "currency_code",
    "availability", "consecutive_unavailable", "consecutive_errors",
    "last_error_code", "last_error_detail", "last_checked_at",
    "last_success_at", "next_check_at", "lease_until", "claim_token",
    "created_at", "updated_at"
FROM "price_watch_targets";

ALTER TABLE "price_watches"
    ADD COLUMN "schedule_id" BIGINT,
    ADD COLUMN "poll_interval_seconds" INTEGER NOT NULL DEFAULT 300;

UPDATE "price_watches" watch
SET "schedule_id" = schedule."id"
FROM "price_watch_schedules" schedule
WHERE schedule."target_id" = watch."target_id"
  AND schedule."transport_key" = 'shared';

ALTER TABLE "price_watches"
    ALTER COLUMN "schedule_id" SET NOT NULL,
    ADD CONSTRAINT "price_watches_schedule_id_fkey"
        FOREIGN KEY ("schedule_id") REFERENCES "price_watch_schedules"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "price_watches_poll_interval_check"
        CHECK ("poll_interval_seconds" IN (30, 60, 120, 300, 600, 900, 1800, 3600));

CREATE INDEX "price_watches_schedule_id_status_idx"
    ON "price_watches"("schedule_id", "status");

ALTER TABLE "price_watch_events" ADD COLUMN "schedule_id" BIGINT;
UPDATE "price_watch_events" event
SET "schedule_id" = schedule."id"
FROM "price_watch_schedules" schedule
WHERE schedule."target_id" = event."target_id"
  AND schedule."transport_key" = 'shared';
ALTER TABLE "price_watch_events"
    ALTER COLUMN "schedule_id" SET NOT NULL,
    ADD CONSTRAINT "price_watch_events_schedule_id_fkey"
        FOREIGN KEY ("schedule_id") REFERENCES "price_watch_schedules"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "price_watch_events_schedule_id_observed_at_idx"
    ON "price_watch_events"("schedule_id", "observed_at");

CREATE TABLE "price_watch_check_hourly_stats" (
    "schedule_id" BIGINT NOT NULL,
    "bucket_hour" TIMESTAMP(6) NOT NULL,
    "check_count" BIGINT NOT NULL DEFAULT 0,
    "successful_check_count" BIGINT NOT NULL DEFAULT 0,
    "failed_check_count" BIGINT NOT NULL DEFAULT 0,
    "access_denied_count" BIGINT NOT NULL DEFAULT 0,
    "rate_limited_count" BIGINT NOT NULL DEFAULT 0,
    "server_error_count" BIGINT NOT NULL DEFAULT 0,
    "duration_total_ms" BIGINT NOT NULL DEFAULT 0,
    "duration_sample_count" BIGINT NOT NULL DEFAULT 0,
    "tx_bytes" BIGINT NOT NULL DEFAULT 0,
    "rx_bytes" BIGINT NOT NULL DEFAULT 0,
    "latest_status_code" INTEGER,
    "latest_error_code" VARCHAR(50),
    "last_checked_at" TIMESTAMP(6) NOT NULL,
    CONSTRAINT "price_watch_check_hourly_stats_pkey" PRIMARY KEY ("schedule_id", "bucket_hour"),
    CONSTRAINT "price_watch_check_hourly_stats_schedule_id_fkey"
        FOREIGN KEY ("schedule_id") REFERENCES "price_watch_schedules"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "price_watch_check_hourly_stats_bucket_hour_idx"
    ON "price_watch_check_hourly_stats"("bucket_hour");

-- Scheduling state now belongs to price_watch_schedules. Canonical targets keep
-- only the last item metadata observed by any schedule.
ALTER TABLE "price_watch_targets"
    DROP COLUMN "availability",
    DROP COLUMN "consecutive_unavailable",
    DROP COLUMN "consecutive_errors",
    DROP COLUMN "last_error_code",
    DROP COLUMN "last_error_detail",
    DROP COLUMN "last_checked_at",
    DROP COLUMN "last_success_at",
    DROP COLUMN "next_check_at",
    DROP COLUMN "lease_until",
    DROP COLUMN "claim_token";

INSERT INTO "monitor_limits" (
    "scope", "active_limit", "free_proxy_active_limit", "price_watch_limit", "updated_at"
)
VALUES
    ('global', NULL, NULL, 3, NOW()),
    ('role:free', NULL, NULL, 3, NOW()),
    ('role:premium', NULL, NULL, 50, NOW())
ON CONFLICT ("scope") DO UPDATE
SET "price_watch_limit" = EXCLUDED."price_watch_limit", "updated_at" = NOW();

INSERT INTO "app_settings" ("key", "value", "updated_at") VALUES
    ('price_watch_enabled', 'true', NOW()),
    ('price_watch_shared_min_interval_seconds', '120', NOW()),
    ('price_watch_personal_min_interval_seconds', '30', NOW()),
    ('price_watch_default_shared_interval_seconds', '120', NOW()),
    ('price_watch_default_personal_interval_seconds', '60', NOW()),
    ('price_watch_shared_max_rpm', '30', NOW()),
    ('price_watch_personal_max_rpm_per_proxy', '2', NOW())
ON CONFLICT ("key") DO NOTHING;
