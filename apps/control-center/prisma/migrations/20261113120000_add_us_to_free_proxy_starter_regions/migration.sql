-- The United States is now a monitor region. Offer it in the shared starter
-- pool wherever that pool already serves at least one region. An emptied list
-- stays empty, and administrators can still remove the region afterwards.
UPDATE "app_settings"
SET "value" = jsonb_set(
        "value"::jsonb,
        '{starterRegions}',
        to_jsonb(("value"::jsonb ->> 'starterRegions') || ',us')
    )::text,
    "updated_at" = NOW()
WHERE "key" = 'policy.free_proxy'
  AND btrim(COALESCE("value"::jsonb ->> 'starterRegions', ''), ', ') <> ''
  AND NOT (
      'us' = ANY (
          string_to_array(
              replace(lower("value"::jsonb ->> 'starterRegions'), ' ', ''),
              ','
          )
      )
  );
