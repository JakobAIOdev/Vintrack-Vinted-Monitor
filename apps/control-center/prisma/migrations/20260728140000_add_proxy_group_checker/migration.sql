ALTER TABLE "proxy_groups"
    ADD COLUMN "proxy_check_status" VARCHAR(20) NOT NULL DEFAULT 'idle',
    ADD COLUMN "proxy_check_region" VARCHAR(10),
    ADD COLUMN "proxy_check_total" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "proxy_check_checked" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "proxy_check_working" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "proxy_check_slow" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "proxy_check_failed" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "proxy_check_results" JSONB,
    ADD COLUMN "proxy_check_error" TEXT,
    ADD COLUMN "proxy_check_requested_at" TIMESTAMP(6),
    ADD COLUMN "proxy_check_started_at" TIMESTAMP(6),
    ADD COLUMN "proxy_check_completed_at" TIMESTAMP(6);

CREATE INDEX "proxy_groups_proxy_check_status_proxy_check_requested_at_idx"
    ON "proxy_groups"("proxy_check_status", "proxy_check_requested_at");
