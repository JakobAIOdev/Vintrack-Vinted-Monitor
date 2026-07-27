ALTER TABLE "free_proxies"
    ADD COLUMN "sources" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN "last_error_code" VARCHAR(50),
    ADD COLUMN "last_seen_at" TIMESTAMP(6);

UPDATE "free_proxies"
SET "sources" = ARRAY["source"],
    "last_seen_at" = COALESCE("updated_at", "created_at")
WHERE COALESCE(array_length("sources", 1), 0) = 0;

ALTER TABLE "free_proxy_health"
    ADD COLUMN "last_error_code" VARCHAR(50);

CREATE INDEX "free_proxies_last_seen_at_idx"
    ON "free_proxies"("last_seen_at");

CREATE INDEX "free_proxy_health_region_error_code_idx"
    ON "free_proxy_health"("region", "last_error_code");
