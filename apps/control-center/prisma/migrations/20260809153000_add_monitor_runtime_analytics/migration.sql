ALTER TABLE "monitors"
ADD COLUMN "active_since" TIMESTAMP(6),
ADD COLUMN "runtime_total_seconds" BIGINT NOT NULL DEFAULT 0;

CREATE TABLE "monitor_runtime_sessions" (
    "id" BIGSERIAL NOT NULL,
    "monitor_id" INTEGER,
    "user_id" TEXT NOT NULL,
    "proxy_source" VARCHAR(20) NOT NULL,
    "started_at" TIMESTAMP(6) NOT NULL,
    "ended_at" TIMESTAMP(6),
    CONSTRAINT "monitor_runtime_sessions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "member_monitor_runtime_totals" (
    "user_id" TEXT NOT NULL,
    "closed_runtime_seconds" BIGINT NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "member_monitor_runtime_totals_pkey" PRIMARY KEY ("user_id")
);

ALTER TABLE "monitor_runtime_sessions"
ADD CONSTRAINT "monitor_runtime_sessions_monitor_id_fkey"
FOREIGN KEY ("monitor_id") REFERENCES "monitors"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "monitor_runtime_sessions"
ADD CONSTRAINT "monitor_runtime_sessions_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "member_monitor_runtime_totals"
ADD CONSTRAINT "member_monitor_runtime_totals_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "monitor_runtime_sessions_one_open_per_monitor_idx"
ON "monitor_runtime_sessions"("monitor_id")
WHERE "ended_at" IS NULL AND "monitor_id" IS NOT NULL;

CREATE INDEX "monitor_runtime_sessions_closed_window_idx"
ON "monitor_runtime_sessions"("ended_at", "started_at")
WHERE "ended_at" IS NOT NULL;

CREATE INDEX "monitor_runtime_sessions_user_closed_idx"
ON "monitor_runtime_sessions"("user_id", "ended_at")
WHERE "ended_at" IS NOT NULL;

CREATE INDEX "monitor_runtime_sessions_user_open_idx"
ON "monitor_runtime_sessions"("user_id", "started_at")
WHERE "ended_at" IS NULL;

CREATE INDEX "monitors_active_since_user_idx"
ON "monitors"("userId", "active_since")
WHERE "status" = 'active';

WITH tracking_start AS (
    SELECT clock_timestamp()::timestamp(6) AS started_at
)
UPDATE "monitors"
SET "active_since" = tracking_start.started_at
FROM tracking_start
WHERE "status" = 'active';

INSERT INTO "monitor_runtime_sessions" (
    "monitor_id",
    "user_id",
    "proxy_source",
    "started_at"
)
SELECT
    "id",
    "userId",
    COALESCE(
        NULLIF("proxy_source", ''),
        CASE WHEN "proxy_group_id" IS NULL THEN 'server' ELSE 'group' END
    ),
    "active_since"
FROM "monitors"
WHERE "status" = 'active';

INSERT INTO "app_settings" ("key", "value", "created_at", "updated_at")
VALUES (
    'monitor_runtime_tracking_started_at',
    clock_timestamp()::text,
    clock_timestamp(),
    clock_timestamp()
)
ON CONFLICT ("key") DO NOTHING;

CREATE OR REPLACE FUNCTION normalize_monitor_runtime_proxy_source(
    source_value TEXT,
    group_id INTEGER
)
RETURNS TEXT
LANGUAGE SQL
IMMUTABLE
AS $$
    SELECT COALESCE(
        NULLIF(source_value, ''),
        CASE WHEN group_id IS NULL THEN 'server' ELSE 'group' END
    );
$$;

CREATE OR REPLACE FUNCTION prepare_monitor_runtime_state()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    boundary_at TIMESTAMP(6) := clock_timestamp();
    elapsed_seconds BIGINT;
    source_changed BOOLEAN;
BEGIN
    IF TG_OP = 'INSERT' THEN
        NEW.runtime_total_seconds := COALESCE(NEW.runtime_total_seconds, 0);
        IF NEW.status = 'active' THEN
            NEW.active_since := COALESCE(NEW.active_since, boundary_at);
        ELSE
            NEW.active_since := NULL;
        END IF;
        RETURN NEW;
    END IF;

    source_changed :=
        normalize_monitor_runtime_proxy_source(
            OLD.proxy_source,
            OLD.proxy_group_id
        ) IS DISTINCT FROM normalize_monitor_runtime_proxy_source(
            NEW.proxy_source,
            NEW.proxy_group_id
        ) OR OLD."userId" IS DISTINCT FROM NEW."userId";

    NEW.runtime_total_seconds := OLD.runtime_total_seconds;

    IF OLD.status IS DISTINCT FROM 'active' AND NEW.status = 'active' THEN
        NEW.active_since := boundary_at;
    ELSIF OLD.status = 'active'
        AND (NEW.status IS DISTINCT FROM 'active' OR source_changed) THEN
        elapsed_seconds := GREATEST(
            0,
            FLOOR(EXTRACT(EPOCH FROM (
                boundary_at - COALESCE(OLD.active_since, boundary_at)
            )))::BIGINT
        );
        NEW.runtime_total_seconds :=
            OLD.runtime_total_seconds + elapsed_seconds;
        IF NEW.status = 'active' THEN
            NEW.active_since := boundary_at;
        ELSE
            NEW.active_since := NULL;
        END IF;
    ELSIF NEW.status = 'active' THEN
        NEW.active_since := COALESCE(OLD.active_since, boundary_at);
    ELSE
        NEW.active_since := NULL;
    END IF;

    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION persist_monitor_runtime_state()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    elapsed_seconds BIGINT := 0;
    boundary_at TIMESTAMP(6);
    source_changed BOOLEAN := FALSE;
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.status = 'active' THEN
            INSERT INTO "monitor_runtime_sessions" (
                "monitor_id",
                "user_id",
                "proxy_source",
                "started_at"
            ) VALUES (
                NEW.id,
                NEW."userId",
                normalize_monitor_runtime_proxy_source(
                    NEW.proxy_source,
                    NEW.proxy_group_id
                ),
                NEW.active_since
            );
        END IF;
        RETURN NEW;
    END IF;

    source_changed :=
        normalize_monitor_runtime_proxy_source(
            OLD.proxy_source,
            OLD.proxy_group_id
        ) IS DISTINCT FROM normalize_monitor_runtime_proxy_source(
            NEW.proxy_source,
            NEW.proxy_group_id
        ) OR OLD."userId" IS DISTINCT FROM NEW."userId";

    IF OLD.status = 'active'
        AND (NEW.status IS DISTINCT FROM 'active' OR source_changed) THEN
        elapsed_seconds := GREATEST(
            0,
            NEW.runtime_total_seconds - OLD.runtime_total_seconds
        );
        boundary_at := COALESCE(
            NEW.active_since,
            COALESCE(OLD.active_since, clock_timestamp()) +
                (elapsed_seconds * INTERVAL '1 second')
        );

        UPDATE "monitor_runtime_sessions"
        SET "ended_at" = boundary_at
        WHERE "monitor_id" = OLD.id
          AND "ended_at" IS NULL;

        INSERT INTO "member_monitor_runtime_totals" (
            "user_id",
            "closed_runtime_seconds",
            "updated_at"
        ) VALUES (
            OLD."userId",
            elapsed_seconds,
            clock_timestamp()
        )
        ON CONFLICT ("user_id") DO UPDATE
        SET "closed_runtime_seconds" =
                "member_monitor_runtime_totals"."closed_runtime_seconds" +
                EXCLUDED."closed_runtime_seconds",
            "updated_at" = EXCLUDED."updated_at";
    END IF;

    IF NEW.status = 'active'
        AND (OLD.status IS DISTINCT FROM 'active' OR source_changed) THEN
        INSERT INTO "monitor_runtime_sessions" (
            "monitor_id",
            "user_id",
            "proxy_source",
            "started_at"
        ) VALUES (
            NEW.id,
            NEW."userId",
            normalize_monitor_runtime_proxy_source(
                NEW.proxy_source,
                NEW.proxy_group_id
            ),
            NEW.active_since
        );
    END IF;

    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION close_monitor_runtime_on_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    boundary_at TIMESTAMP(6) := clock_timestamp();
    elapsed_seconds BIGINT := 0;
BEGIN
    IF OLD.status = 'active' THEN
        elapsed_seconds := GREATEST(
            0,
            FLOOR(EXTRACT(EPOCH FROM (
                boundary_at - COALESCE(OLD.active_since, boundary_at)
            )))::BIGINT
        );

        UPDATE "monitor_runtime_sessions"
        SET "ended_at" = boundary_at
        WHERE "monitor_id" = OLD.id
          AND "ended_at" IS NULL;

        INSERT INTO "member_monitor_runtime_totals" (
            "user_id",
            "closed_runtime_seconds",
            "updated_at"
        ) VALUES (OLD."userId", elapsed_seconds, boundary_at)
        ON CONFLICT ("user_id") DO UPDATE
        SET "closed_runtime_seconds" =
                "member_monitor_runtime_totals"."closed_runtime_seconds" +
                EXCLUDED."closed_runtime_seconds",
            "updated_at" = EXCLUDED."updated_at";
    END IF;

    RETURN OLD;
END;
$$;

CREATE TRIGGER "monitors_runtime_before_insert_or_update"
BEFORE INSERT OR UPDATE ON "monitors"
FOR EACH ROW
EXECUTE FUNCTION prepare_monitor_runtime_state();

CREATE TRIGGER "monitors_runtime_after_insert_or_update"
AFTER INSERT OR UPDATE ON "monitors"
FOR EACH ROW
EXECUTE FUNCTION persist_monitor_runtime_state();

CREATE TRIGGER "monitors_runtime_before_delete"
BEFORE DELETE ON "monitors"
FOR EACH ROW
EXECUTE FUNCTION close_monitor_runtime_on_delete();

INSERT INTO "monitor_limits" (
    "scope",
    "active_limit",
    "free_proxy_active_limit",
    "updated_at"
)
VALUES ('global', NULL, 10, NOW())
ON CONFLICT ("scope") DO UPDATE
SET "free_proxy_active_limit" = CASE
        WHEN "monitor_limits"."free_proxy_active_limit" IS NULL
          OR "monitor_limits"."free_proxy_active_limit" = 5
        THEN 10
        ELSE "monitor_limits"."free_proxy_active_limit"
    END,
    "updated_at" = NOW();
