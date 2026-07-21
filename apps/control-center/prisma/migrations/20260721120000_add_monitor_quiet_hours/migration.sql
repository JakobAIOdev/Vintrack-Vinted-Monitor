ALTER TABLE "monitors"
ADD COLUMN "quiet_hours_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "quiet_hours_start_minute" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "quiet_hours_end_minute" INTEGER NOT NULL DEFAULT 420,
ADD COLUMN "quiet_hours_mode" VARCHAR(20) NOT NULL DEFAULT 'pause',
ADD COLUMN "quiet_hours_delay_ms" INTEGER NOT NULL DEFAULT 60000,
ADD COLUMN "quiet_hours_timezone" VARCHAR(64) NOT NULL DEFAULT 'Europe/Berlin';
