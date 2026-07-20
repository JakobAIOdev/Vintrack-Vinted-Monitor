-- `createdAt` was introduced after the User table already contained data.
-- Accounts without any recoverable activity or verification date were all
-- stamped with the migration transaction time, creating a fake signup spike.
-- Keep those dates unknown instead; newly created users still receive NOW().
ALTER TABLE "User"
ALTER COLUMN "createdAt" DROP NOT NULL;

WITH migration_fallback_timestamps AS (
    SELECT "createdAt"
    FROM "User"
    WHERE "createdAt" >= TIMESTAMP '2026-07-18 00:00:00'
      AND "createdAt" < TIMESTAMP '2026-07-22 00:00:00'
    GROUP BY "createdAt"
    HAVING COUNT(*) >= 10
)
UPDATE "User" AS user_row
SET "createdAt" = NULL
FROM migration_fallback_timestamps AS fallback
WHERE user_row."createdAt" = fallback."createdAt";
