CREATE TABLE "discord_webhooks" (
    "id" SERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "url" TEXT NOT NULL,
    "url_hash" VARCHAR(64) NOT NULL,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL,
    CONSTRAINT "discord_webhooks_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "discord_webhooks_userId_url_hash_key" ON "discord_webhooks"("userId", "url_hash");
CREATE INDEX "discord_webhooks_userId_updated_at_idx" ON "discord_webhooks"("userId", "updated_at");
ALTER TABLE "discord_webhooks" ADD CONSTRAINT "discord_webhooks_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Import each existing destination once per account, including disabled alerts.
INSERT INTO "discord_webhooks" ("userId", "name", "url", "url_hash", "created_at", "updated_at")
SELECT DISTINCT ON ("userId", "url")
    "userId", LEFT("name", 255), "url",
    encode(sha256(convert_to("url", 'UTF8')), 'hex'),
    COALESCE("created_at", CURRENT_TIMESTAMP), CURRENT_TIMESTAMP
FROM (
    SELECT "userId", "name", BTRIM("discord_webhook") AS "url", "created_at"
    FROM "monitors"
    WHERE "userId" IS NOT NULL
    UNION ALL
    SELECT w."user_id", COALESCE(t."title", 'Price Watch'), BTRIM(w."discord_webhook"), w."created_at"
    FROM "price_watches" w
    JOIN "price_watch_targets" t ON t."id" = w."target_id"
) existing
WHERE "url" ~ '^https://(ptb\.|canary\.)?discord(app)?\.com/api/webhooks/[0-9]{17,20}/[A-Za-z0-9_-]+$'
ORDER BY "userId", "url", "created_at" ASC NULLS LAST, "name";
