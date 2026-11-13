-- A reserved or hidden Vinted listing still exists and can return to sale, so
-- its schedule keeps being polled under its own availability instead of being
-- reported as active or retired as unavailable.
ALTER TABLE "price_watch_schedules"
    DROP CONSTRAINT IF EXISTS "price_watch_schedules_availability_check";

ALTER TABLE "price_watch_schedules"
    ADD CONSTRAINT "price_watch_schedules_availability_check"
        CHECK ("availability" IN ('pending', 'active', 'reserved', 'hidden', 'unavailable'));
