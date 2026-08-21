ALTER TABLE "monitor_limits"
ADD COLUMN "price_watch_limit" INTEGER;

ALTER TABLE "monitor_limits"
ADD CONSTRAINT "monitor_limits_price_watch_limit_nonnegative"
CHECK ("price_watch_limit" IS NULL OR "price_watch_limit" >= 0);

INSERT INTO "monitor_limits" (
    "scope",
    "active_limit",
    "free_proxy_active_limit",
    "price_watch_limit",
    "updated_at"
)
VALUES
    ('global', NULL, NULL, 5, NOW()),
    ('role:free', NULL, NULL, 5, NOW()),
    ('role:premium', NULL, NULL, 50, NOW())
ON CONFLICT ("scope") DO UPDATE
SET "price_watch_limit" = EXCLUDED."price_watch_limit",
    "updated_at" = NOW();

CREATE TABLE "price_watch_targets" (
    "id" BIGSERIAL NOT NULL,
    "region" VARCHAR(10) NOT NULL,
    "item_id" BIGINT NOT NULL,
    "canonical_url" TEXT NOT NULL,
    "title" VARCHAR(500),
    "image_url" TEXT,
    "current_price_minor" BIGINT,
    "currency_code" VARCHAR(3),
    "availability" VARCHAR(30) NOT NULL DEFAULT 'pending',
    "consecutive_unavailable" INTEGER NOT NULL DEFAULT 0,
    "consecutive_errors" INTEGER NOT NULL DEFAULT 0,
    "last_error_code" VARCHAR(50),
    "last_error_detail" TEXT,
    "last_checked_at" TIMESTAMP(6),
    "last_success_at" TIMESTAMP(6),
    "next_check_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_until" TIMESTAMP(6),
    "claim_token" VARCHAR(64),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "price_watch_targets_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "price_watch_targets_region_item_id_key" UNIQUE ("region", "item_id"),
    CONSTRAINT "price_watch_targets_availability_check"
        CHECK ("availability" IN ('pending', 'active', 'unavailable')),
    CONSTRAINT "price_watch_targets_price_nonnegative"
        CHECK ("current_price_minor" IS NULL OR "current_price_minor" >= 0),
    CONSTRAINT "price_watch_targets_counters_nonnegative"
        CHECK ("consecutive_unavailable" >= 0 AND "consecutive_errors" >= 0)
);

CREATE INDEX "price_watch_targets_availability_next_check_at_idx"
    ON "price_watch_targets"("availability", "next_check_at");
CREATE INDEX "price_watch_targets_lease_until_idx"
    ON "price_watch_targets"("lease_until");
CREATE INDEX "price_watch_targets_due_idx"
    ON "price_watch_targets"("next_check_at", "id")
    WHERE "availability" IN ('pending', 'active');

CREATE TABLE "price_watches" (
    "id" BIGSERIAL NOT NULL,
    "user_id" TEXT NOT NULL,
    "target_id" BIGINT NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'active',
    "notifications_enabled" BOOLEAN NOT NULL DEFAULT TRUE,
    "discord_webhook" TEXT,
    "webhook_active" BOOLEAN NOT NULL DEFAULT FALSE,
    "telegram_active" BOOLEAN NOT NULL DEFAULT FALSE,
    "initial_price_minor" BIGINT,
    "armed_at" TIMESTAMP(6),
    "stopped_reason" VARCHAR(50),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "price_watches_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "price_watches_user_id_target_id_key" UNIQUE ("user_id", "target_id"),
    CONSTRAINT "price_watches_user_id_fkey"
        FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "price_watches_target_id_fkey"
        FOREIGN KEY ("target_id") REFERENCES "price_watch_targets"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "price_watches_status_check"
        CHECK ("status" IN ('active', 'paused', 'stopped')),
    CONSTRAINT "price_watches_initial_price_nonnegative"
        CHECK ("initial_price_minor" IS NULL OR "initial_price_minor" >= 0)
);

CREATE INDEX "price_watches_user_id_status_idx"
    ON "price_watches"("user_id", "status");
CREATE INDEX "price_watches_target_id_status_idx"
    ON "price_watches"("target_id", "status");

CREATE TABLE "price_watch_events" (
    "id" BIGSERIAL NOT NULL,
    "target_id" BIGINT NOT NULL,
    "previous_price_minor" BIGINT NOT NULL,
    "new_price_minor" BIGINT NOT NULL,
    "currency_code" VARCHAR(3) NOT NULL,
    "observed_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "price_watch_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "price_watch_events_target_id_fkey"
        FOREIGN KEY ("target_id") REFERENCES "price_watch_targets"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "price_watch_events_prices_nonnegative"
        CHECK ("previous_price_minor" >= 0 AND "new_price_minor" >= 0),
    CONSTRAINT "price_watch_events_is_drop"
        CHECK ("new_price_minor" < "previous_price_minor")
);

CREATE INDEX "price_watch_events_target_id_observed_at_idx"
    ON "price_watch_events"("target_id", "observed_at");

ALTER TABLE "alert_notifications"
ADD COLUMN "price_watch_id" BIGINT;

ALTER TABLE "alert_notifications"
ADD CONSTRAINT "alert_notifications_price_watch_id_fkey"
FOREIGN KEY ("price_watch_id") REFERENCES "price_watches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "alert_notifications_price_watch_id_created_at_idx"
    ON "alert_notifications"("price_watch_id", "created_at");

ALTER TABLE "alert_events"
ADD COLUMN "price_watch_id" BIGINT;

ALTER TABLE "alert_events"
ADD CONSTRAINT "alert_events_price_watch_id_fkey"
FOREIGN KEY ("price_watch_id") REFERENCES "price_watches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "alert_events_price_watch_id_created_at_idx"
    ON "alert_events"("price_watch_id", "created_at");
