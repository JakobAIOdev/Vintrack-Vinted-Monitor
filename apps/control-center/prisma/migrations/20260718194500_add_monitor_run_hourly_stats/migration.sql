CREATE TABLE "monitor_run_hourly_stats" (
    "monitor_id" INTEGER NOT NULL,
    "bucket_hour" TIMESTAMP(6) NOT NULL,
    "fetch_source" VARCHAR(20) NOT NULL DEFAULT 'canonical',
    "check_count" BIGINT NOT NULL DEFAULT 0,
    "successful_check_count" BIGINT NOT NULL DEFAULT 0,
    "failed_check_count" BIGINT NOT NULL DEFAULT 0,
    "new_item_count" BIGINT NOT NULL DEFAULT 0,
    "duration_total_ms" BIGINT NOT NULL DEFAULT 0,
    "duration_sample_count" BIGINT NOT NULL DEFAULT 0,
    "last_checked_at" TIMESTAMP(6) NOT NULL,
    "latest_error" TEXT,
    "latest_error_at" TIMESTAMP(6),

    CONSTRAINT "monitor_run_hourly_stats_pkey"
        PRIMARY KEY ("monitor_id", "fetch_source", "bucket_hour")
);

CREATE INDEX "monitor_run_hourly_stats_fetch_source_bucket_hour_idx"
ON "monitor_run_hourly_stats"("fetch_source", "bucket_hour");

ALTER TABLE "monitor_run_hourly_stats"
ADD CONSTRAINT "monitor_run_hourly_stats_monitor_id_fkey"
FOREIGN KEY ("monitor_id") REFERENCES "monitors"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION update_monitor_run_hourly_stats()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO "monitor_run_hourly_stats" (
        "monitor_id",
        "bucket_hour",
        "fetch_source",
        "check_count",
        "successful_check_count",
        "failed_check_count",
        "new_item_count",
        "duration_total_ms",
        "duration_sample_count",
        "last_checked_at",
        "latest_error",
        "latest_error_at"
    ) VALUES (
        NEW."monitor_id",
        DATE_TRUNC('hour', NEW."checked_at"),
        NEW."fetch_source",
        1,
        CASE WHEN NEW."status" = 'success' THEN 1 ELSE 0 END,
        CASE WHEN NEW."status" = 'failed' THEN 1 ELSE 0 END,
        NEW."new_item_count",
        COALESCE(NEW."duration_ms", 0),
        CASE WHEN NEW."duration_ms" IS NULL THEN 0 ELSE 1 END,
        NEW."checked_at",
        NEW."error_message",
        CASE WHEN NEW."error_message" IS NULL THEN NULL ELSE NEW."checked_at" END
    )
    ON CONFLICT ("monitor_id", "fetch_source", "bucket_hour") DO UPDATE
    SET
        "check_count" = "monitor_run_hourly_stats"."check_count" + 1,
        "successful_check_count" =
            "monitor_run_hourly_stats"."successful_check_count" +
            EXCLUDED."successful_check_count",
        "failed_check_count" =
            "monitor_run_hourly_stats"."failed_check_count" +
            EXCLUDED."failed_check_count",
        "new_item_count" =
            "monitor_run_hourly_stats"."new_item_count" +
            EXCLUDED."new_item_count",
        "duration_total_ms" =
            "monitor_run_hourly_stats"."duration_total_ms" +
            EXCLUDED."duration_total_ms",
        "duration_sample_count" =
            "monitor_run_hourly_stats"."duration_sample_count" +
            EXCLUDED."duration_sample_count",
        "last_checked_at" = GREATEST(
            "monitor_run_hourly_stats"."last_checked_at",
            EXCLUDED."last_checked_at"
        ),
        "latest_error" = CASE
            WHEN EXCLUDED."latest_error_at" IS NOT NULL
                 AND (
                    "monitor_run_hourly_stats"."latest_error_at" IS NULL
                    OR EXCLUDED."latest_error_at" >=
                        "monitor_run_hourly_stats"."latest_error_at"
                 )
            THEN EXCLUDED."latest_error"
            ELSE "monitor_run_hourly_stats"."latest_error"
        END,
        "latest_error_at" = CASE
            WHEN EXCLUDED."latest_error_at" IS NOT NULL
                 AND (
                    "monitor_run_hourly_stats"."latest_error_at" IS NULL
                    OR EXCLUDED."latest_error_at" >=
                        "monitor_run_hourly_stats"."latest_error_at"
                 )
            THEN EXCLUDED."latest_error_at"
            ELSE "monitor_run_hourly_stats"."latest_error_at"
        END;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE "_monitor_run_hourly_stats_backfill_cutoff" (
    "max_run_id" BIGINT NOT NULL
);

-- Capture a stable high-water mark while installing the trigger. The lock is
-- held only for this statement, so workers resume before the historical
-- backfill starts. Runs above the cutoff are handled exclusively by the
-- trigger and cannot be double-counted by the backfill.
DO $migration$
BEGIN
    LOCK TABLE "monitor_runs" IN SHARE ROW EXCLUSIVE MODE;

    INSERT INTO "_monitor_run_hourly_stats_backfill_cutoff" ("max_run_id")
    SELECT COALESCE(MAX("id"), 0)
    FROM "monitor_runs";

    EXECUTE '
        CREATE TRIGGER "monitor_runs_hourly_stats_after_insert"
        AFTER INSERT ON "monitor_runs"
        FOR EACH ROW
        EXECUTE FUNCTION update_monitor_run_hourly_stats()
    ';
END
$migration$;

INSERT INTO "monitor_run_hourly_stats" (
    "monitor_id",
    "bucket_hour",
    "fetch_source",
    "check_count",
    "successful_check_count",
    "failed_check_count",
    "new_item_count",
    "duration_total_ms",
    "duration_sample_count",
    "last_checked_at",
    "latest_error",
    "latest_error_at"
)
SELECT
    "monitor_id",
    DATE_TRUNC('hour', "checked_at") AS "bucket_hour",
    "fetch_source",
    COUNT(*)::BIGINT AS "check_count",
    COUNT(*) FILTER (WHERE "status" = 'success')::BIGINT,
    COUNT(*) FILTER (WHERE "status" = 'failed')::BIGINT,
    COALESCE(SUM("new_item_count"), 0)::BIGINT,
    COALESCE(SUM("duration_ms"), 0)::BIGINT,
    COUNT("duration_ms")::BIGINT,
    MAX("checked_at"),
    (
        ARRAY_AGG("error_message" ORDER BY "checked_at" DESC)
        FILTER (WHERE "error_message" IS NOT NULL)
    )[1],
    MAX("checked_at") FILTER (WHERE "error_message" IS NOT NULL)
FROM "monitor_runs"
WHERE "id" <= (
        SELECT "max_run_id"
        FROM "_monitor_run_hourly_stats_backfill_cutoff"
    )
  AND "checked_at" >= DATE_TRUNC('hour', NOW()) - INTERVAL '24 hours'
GROUP BY "monitor_id", DATE_TRUNC('hour', "checked_at"), "fetch_source"
ON CONFLICT ("monitor_id", "fetch_source", "bucket_hour") DO UPDATE
SET
    "check_count" =
        "monitor_run_hourly_stats"."check_count" + EXCLUDED."check_count",
    "successful_check_count" =
        "monitor_run_hourly_stats"."successful_check_count" +
        EXCLUDED."successful_check_count",
    "failed_check_count" =
        "monitor_run_hourly_stats"."failed_check_count" +
        EXCLUDED."failed_check_count",
    "new_item_count" =
        "monitor_run_hourly_stats"."new_item_count" +
        EXCLUDED."new_item_count",
    "duration_total_ms" =
        "monitor_run_hourly_stats"."duration_total_ms" +
        EXCLUDED."duration_total_ms",
    "duration_sample_count" =
        "monitor_run_hourly_stats"."duration_sample_count" +
        EXCLUDED."duration_sample_count",
    "last_checked_at" = GREATEST(
        "monitor_run_hourly_stats"."last_checked_at",
        EXCLUDED."last_checked_at"
    ),
    "latest_error" = CASE
        WHEN EXCLUDED."latest_error_at" IS NOT NULL
             AND (
                "monitor_run_hourly_stats"."latest_error_at" IS NULL
                OR EXCLUDED."latest_error_at" >=
                    "monitor_run_hourly_stats"."latest_error_at"
             )
        THEN EXCLUDED."latest_error"
        ELSE "monitor_run_hourly_stats"."latest_error"
    END,
    "latest_error_at" = CASE
        WHEN EXCLUDED."latest_error_at" IS NOT NULL
             AND (
                "monitor_run_hourly_stats"."latest_error_at" IS NULL
                OR EXCLUDED."latest_error_at" >=
                    "monitor_run_hourly_stats"."latest_error_at"
             )
        THEN EXCLUDED."latest_error_at"
        ELSE "monitor_run_hourly_stats"."latest_error_at"
    END;

DROP TABLE "_monitor_run_hourly_stats_backfill_cutoff";
