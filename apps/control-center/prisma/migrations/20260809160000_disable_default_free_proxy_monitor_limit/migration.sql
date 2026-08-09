UPDATE "monitor_limits" AS limits
SET "free_proxy_active_limit" = NULL,
    "updated_at" = NOW()
WHERE limits."scope" = 'global'
  AND limits."free_proxy_active_limit" = 10
  AND EXISTS (
      SELECT 1
      FROM "app_settings" AS tracking
      WHERE tracking."key" = 'monitor_runtime_tracking_started_at'
        AND limits."updated_at" <= tracking."created_at" + INTERVAL '1 minute'
  );
