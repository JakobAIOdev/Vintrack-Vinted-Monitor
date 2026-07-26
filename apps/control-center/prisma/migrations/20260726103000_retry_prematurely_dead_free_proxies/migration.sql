-- Older workers ignored free_proxy_failure_threshold for fresh candidates and
-- marked them dead after their first failed check. Give those candidates a
-- clean retry under the corrected cooldown/retry state machine.
UPDATE "free_proxies"
SET "status" = 'pending',
    "failure_count" = 0,
    "last_error" = NULL,
    "quarantined_until" = NULL,
    "updated_at" = NOW()
WHERE "status" = 'disabled'
  AND "last_error" = 'disabled after failing all regional Vinted checks'
  AND EXISTS (
      SELECT 1
      FROM "free_proxy_health" AS "fph"
      WHERE "fph"."proxy_id" = "free_proxies"."id"
        AND "fph"."status" = 'dead'
  );

UPDATE "free_proxy_health"
SET "status" = 'pending',
    "success_streak" = 0,
    "failure_streak" = 0,
    "last_error" = NULL,
    "next_check_at" = NOW(),
    "updated_at" = NOW()
WHERE "status" = 'dead';
