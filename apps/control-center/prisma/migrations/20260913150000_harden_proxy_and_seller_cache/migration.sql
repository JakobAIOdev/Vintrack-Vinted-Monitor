-- Repair source counters created by the initial aggregate migration. A check
-- is a completed success or failure, so it can never be smaller than their sum.
ALTER TABLE free_proxy_source_health_stats
    ADD COLUMN IF NOT EXISTS success_ewma DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    ADD COLUMN IF NOT EXISTS ewma_samples INTEGER NOT NULL DEFAULT 0;

UPDATE free_proxy_source_health_stats
SET checked_count = GREATEST(checked_count, success_count + failure_count),
    success_ewma = CASE
        WHEN success_count + failure_count = 0 THEN 0.5
        ELSE LEAST(1.0, GREATEST(0.0,
            success_count::double precision / (success_count + failure_count)
        ))
    END,
    ewma_samples = GREATEST(ewma_samples, success_count + failure_count),
    updated_at = NOW()
WHERE checked_count < success_count + failure_count
   OR ewma_samples = 0;

CREATE TABLE IF NOT EXISTS seller_profiles (
    domain VARCHAR(255) NOT NULL,
    seller_id BIGINT NOT NULL,
    region TEXT NOT NULL DEFAULT '',
    rating VARCHAR(50) NOT NULL DEFAULT '',
    rating_stars DOUBLE PRECISION NOT NULL DEFAULT 0,
    rating_count INTEGER NOT NULL DEFAULT 0,
    rating_available BOOLEAN NOT NULL DEFAULT FALSE,
    fetched_at TIMESTAMP(6) NOT NULL,
    created_at TIMESTAMP(6) NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP(6) NOT NULL DEFAULT NOW(),
    CONSTRAINT seller_profiles_pkey PRIMARY KEY (domain, seller_id)
);

CREATE INDEX IF NOT EXISTS seller_profiles_fetched_at_idx
    ON seller_profiles (fetched_at);

UPDATE app_settings
SET value = (
    '{"adaptivePacingEnabled":false,"adaptiveRegions":["de","fr"],"maxRequestsPerProxySecond":0.5,"maxAdmissionDelayMs":1500}'::jsonb
    || value::jsonb
)::text,
updated_at = NOW()
WHERE key = 'policy.free_proxy';

UPDATE app_settings
SET value = (
    '{"sellerFreshTtlMinutes":30,"sellerStaleTtlMinutes":1440}'::jsonb
    || value::jsonb
)::text,
updated_at = NOW()
WHERE key = 'policy.worker';
