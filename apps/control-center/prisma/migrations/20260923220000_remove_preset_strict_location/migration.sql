-- Presets historically enabled the strict seller-location gate implicitly.
-- The marketplace region already scopes the catalogue, while this extra gate
-- depends on seller enrichment and can discard every otherwise valid match.
-- Only repair monitors that are auditable preset creations and still carry
-- the exact generated region value; customized multi-region filters remain.
UPDATE monitors AS monitor
SET allowed_countries = NULL
WHERE lower(btrim(monitor.allowed_countries)) = lower(btrim(monitor.region))
  AND EXISTS (
      SELECT 1
      FROM audit_events AS audit
      WHERE audit.action = 'monitor.preset_created'
        AND audit.target_type = 'monitor'
        AND audit.target_id = monitor.id::text
  );
