ALTER TABLE "monitor_limits"
ADD COLUMN "free_proxy_active_limit" INTEGER;

ALTER TABLE "monitor_limits"
ADD CONSTRAINT "monitor_limits_free_proxy_active_limit_nonnegative"
CHECK ("free_proxy_active_limit" IS NULL OR "free_proxy_active_limit" >= 0);

INSERT INTO "monitor_limits" (
    "scope",
    "active_limit",
    "free_proxy_active_limit",
    "updated_at"
)
VALUES ('global', NULL, 5, NOW())
ON CONFLICT ("scope") DO UPDATE
SET "free_proxy_active_limit" = 5,
    "updated_at" = NOW();
