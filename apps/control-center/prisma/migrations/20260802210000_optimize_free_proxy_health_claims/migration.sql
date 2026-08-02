CREATE INDEX IF NOT EXISTS "free_proxy_health_window_due_idx"
    ON "free_proxy_health"(
        "region",
        "candidate_window_token",
        "next_check_at",
        "status"
    );

CREATE TABLE IF NOT EXISTS "free_proxy_source_health_stats" (
    "region" VARCHAR(10) NOT NULL,
    "source" VARCHAR(50) NOT NULL,
    "protocol" VARCHAR(20) NOT NULL,
    "checked_count" INTEGER NOT NULL DEFAULT 0,
    "success_count" INTEGER NOT NULL DEFAULT 0,
    "failure_count" INTEGER NOT NULL DEFAULT 0,
    "last_checked_at" TIMESTAMP(6),
    "last_success_at" TIMESTAMP(6),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "free_proxy_source_health_stats_pkey"
        PRIMARY KEY ("region", "source", "protocol")
);

CREATE INDEX IF NOT EXISTS "free_proxy_source_health_stats_region_yield_idx"
    ON "free_proxy_source_health_stats"(
        "region",
        "success_count",
        "checked_count"
    );

INSERT INTO "free_proxy_source_health_stats" (
    "region",
    "source",
    "protocol",
    "checked_count",
    "success_count",
    "failure_count",
    "last_checked_at",
    "last_success_at",
    "updated_at"
)
SELECT
    fph."region",
    fp."source",
    fp."protocol",
    COUNT(*) FILTER (WHERE fph."last_checked_at" IS NOT NULL)::integer,
    COALESCE(SUM(fph."success_count"), 0)::integer,
    COALESCE(SUM(fph."failure_count"), 0)::integer,
    MAX(fph."last_checked_at"),
    MAX(fph."last_success_at"),
    CURRENT_TIMESTAMP
FROM "free_proxy_health" fph
JOIN "free_proxies" fp ON fp."id" = fph."proxy_id"
GROUP BY fph."region", fp."source", fp."protocol"
ON CONFLICT ("region", "source", "protocol") DO NOTHING;
