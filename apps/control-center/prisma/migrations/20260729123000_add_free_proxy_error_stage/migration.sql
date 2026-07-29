ALTER TABLE "free_proxies"
    ADD COLUMN "last_error_stage" VARCHAR(20);

ALTER TABLE "free_proxy_health"
    ADD COLUMN "last_error_stage" VARCHAR(20);

CREATE INDEX "free_proxy_health_region_error_stage_idx"
    ON "free_proxy_health"("region", "last_error_stage");
