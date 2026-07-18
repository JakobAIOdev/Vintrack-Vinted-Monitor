ALTER TABLE "User"
ADD COLUMN "createdAt" TIMESTAMP(6);

WITH user_activity AS (
    SELECT "userId", MIN("activity_at") AS "first_activity_at"
    FROM (
        SELECT "userId", "created_at" AS "activity_at"
        FROM "monitors"
        WHERE "created_at" IS NOT NULL

        UNION ALL

        SELECT "userId", "created_at"
        FROM "proxy_groups"
        WHERE "created_at" IS NOT NULL

        UNION ALL

        SELECT "userId", "created_at"
        FROM "audit_events"
        WHERE "userId" IS NOT NULL

        UNION ALL

        SELECT "userId", "created_at"
        FROM "alert_events"
        WHERE "userId" IS NOT NULL

        UNION ALL

        SELECT "user_id", "created_at"
        FROM "vinted_sessions"

        UNION ALL

        SELECT "userId", "created_at"
        FROM "telegram_connections"

        UNION ALL

        SELECT "userId", "created_at"
        FROM "seller_bans"
    ) AS activities
    GROUP BY "userId"
)
UPDATE "User" AS user_row
SET "createdAt" = LEAST(
    COALESCE(user_activity."first_activity_at", CURRENT_TIMESTAMP),
    COALESCE(user_row."emailVerified", CURRENT_TIMESTAMP)
)
FROM user_activity
WHERE user_activity."userId" = user_row."id";

UPDATE "User"
SET "createdAt" = COALESCE("emailVerified", CURRENT_TIMESTAMP)
WHERE "createdAt" IS NULL;

ALTER TABLE "User"
ALTER COLUMN "createdAt" SET DEFAULT CURRENT_TIMESTAMP,
ALTER COLUMN "createdAt" SET NOT NULL;

CREATE INDEX "User_createdAt_idx"
ON "User"("createdAt");
