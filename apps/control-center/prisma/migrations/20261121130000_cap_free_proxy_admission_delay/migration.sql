UPDATE app_settings
SET value = jsonb_set(
        value::jsonb,
        '{maxAdmissionDelayMs}',
        to_jsonb(1500),
        true
    )::text,
    updated_at = NOW()
WHERE key = 'policy.free_proxy'
  AND jsonb_typeof(value::jsonb->'maxAdmissionDelayMs') = 'number'
  AND (value::jsonb->>'maxAdmissionDelayMs')::numeric > 1500;
