-- The hourly retention sweeps delete by created_at, but the existing indexes on
-- these tables all lead with another column, so each sweep was a sequential scan
-- followed by a large delete. These tables are among the largest in the
-- database, so that is the most expensive thing the maintainer does.

CREATE INDEX IF NOT EXISTS "monitor_item_detections_created_at_idx"
    ON "monitor_item_detections"("created_at");

CREATE INDEX IF NOT EXISTS "monitor_events_created_at_idx"
    ON "monitor_events"("created_at");

CREATE INDEX IF NOT EXISTS "item_preindex_samples_first_seen_at_idx"
    ON "item_preindex_samples"("first_seen_at");
