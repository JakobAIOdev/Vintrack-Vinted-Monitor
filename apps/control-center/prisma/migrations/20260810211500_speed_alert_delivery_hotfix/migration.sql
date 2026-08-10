-- Keep item alerts bounded by detection time and keep dispatcher hot queries on
-- small partial indexes even after the delivery history grows large.

CREATE INDEX "alert_notifications_expires_at_id_idx"
    ON "alert_notifications"("expires_at", "id");

CREATE INDEX "alert_deliveries_active_notification_idx"
    ON "alert_deliveries"("notification_id", "id")
    WHERE "status" IN ('pending', 'processing', 'retrying');

-- Alerts created by the previous release used a 15 minute TTL. Never backfill
-- those after this hotfix: the listing advantage is already gone after 2 min.
UPDATE "alert_notifications"
SET "expires_at" = LEAST("expires_at", "created_at" + INTERVAL '2 minutes')
WHERE "kind" = 'item_match'
  AND "expires_at" > "created_at" + INTERVAL '2 minutes';

WITH stale AS (
    SELECT d."id"
    FROM "alert_deliveries" d
    JOIN "alert_notifications" n ON n."id" = d."notification_id"
    WHERE d."status" IN ('pending', 'processing', 'retrying')
      AND n."kind" = 'item_match'
      AND n."created_at" <= NOW() - INTERVAL '2 minutes'
)
UPDATE "alert_deliveries" d
SET "status" = 'failed',
    "last_reason_code" = 'stale',
    "last_error_detail" = 'item alert exceeded the two-minute delivery deadline',
    "completed_at" = NOW(),
    "lease_until" = NULL,
    "claim_token" = NULL,
    "updated_at" = NOW()
FROM stale
WHERE d."id" = stale."id";
