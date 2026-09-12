INSERT INTO "app_settings" ("key", "value")
VALUES
(
    'policy.price_watch',
    json_build_object(
        'version', 1,
        'revision', 1,
        'sharedMinimumSeconds', COALESCE((SELECT NULLIF("value", '')::integer FROM "app_settings" WHERE "key" = 'price_watch_shared_min_interval_seconds'), 120),
        'personalMinimumSeconds', COALESCE((SELECT NULLIF("value", '')::integer FROM "app_settings" WHERE "key" = 'price_watch_personal_min_interval_seconds'), 30),
        'sharedMaxRpm', COALESCE((SELECT NULLIF("value", '')::integer FROM "app_settings" WHERE "key" = 'price_watch_shared_max_rpm'), 30),
        'personalMaxRpmPerProxy', COALESCE((SELECT NULLIF("value", '')::integer FROM "app_settings" WHERE "key" = 'price_watch_personal_max_rpm_per_proxy'), 2)
    )::text
),
(
    'policy.free_proxy',
    json_build_object(
        'version', 1,
        'revision', 1,
        'autoImportEnabled', COALESCE((SELECT LOWER("value") = 'true' FROM "app_settings" WHERE "key" = 'free_proxy_auto_import_enabled'), false),
        'importSource', COALESCE((SELECT "value" FROM "app_settings" WHERE "key" = 'free_proxy_import_source'), 'iplocate_all'),
        'importUrl', COALESCE((SELECT "value" FROM "app_settings" WHERE "key" = 'free_proxy_import_url'), 'https://raw.githubusercontent.com/iplocate/free-proxy-list/main/all-proxies.txt'),
        'maxPoolSize', COALESCE((SELECT NULLIF("value", '')::integer FROM "app_settings" WHERE "key" = 'free_proxy_max_pool_size'), 5000),
        'failureThreshold', COALESCE((SELECT NULLIF("value", '')::integer FROM "app_settings" WHERE "key" = 'free_proxy_failure_threshold'), 3),
        'quarantineMinutes', COALESCE((SELECT NULLIF("value", '')::integer FROM "app_settings" WHERE "key" = 'free_proxy_quarantine_minutes'), 30),
        'minActivePerRegion', COALESCE((SELECT NULLIF("value", '')::integer FROM "app_settings" WHERE "key" = 'free_proxy_min_active_per_region'), 25),
        'targetActivePerRegion', COALESCE((SELECT NULLIF("value", '')::integer FROM "app_settings" WHERE "key" = 'free_proxy_target_active_per_region'), 50),
        'maxLatencyMs', COALESCE((SELECT NULLIF("value", '')::integer FROM "app_settings" WHERE "key" = 'free_proxy_max_latency_ms'), 2500),
        'starterRegions', COALESCE((SELECT "value" FROM "app_settings" WHERE "key" = 'free_proxy_starter_regions'), 'de,fr,it,es,nl,be,at'),
        'inventoryLimit', COALESCE((SELECT NULLIF("value", '')::integer FROM "app_settings" WHERE "key" = 'free_proxy_inventory_limit'), 30000),
        'activeCandidateLimit', COALESCE((SELECT NULLIF("value", '')::integer FROM "app_settings" WHERE "key" = 'free_proxy_candidate_limit_active_region'), 10000),
        'idleCandidateLimit', COALESCE((SELECT NULLIF("value", '')::integer FROM "app_settings" WHERE "key" = 'free_proxy_candidate_limit_idle_region'), 5000),
        'readyTarget', COALESCE((SELECT NULLIF("value", '')::integer FROM "app_settings" WHERE "key" = 'free_proxy_ready_target_active_region'), 50),
        'reserveTarget', COALESCE((SELECT NULLIF("value", '')::integer FROM "app_settings" WHERE "key" = 'free_proxy_reserve_target_active_region'), 50),
        'idleTarget', COALESCE((SELECT NULLIF("value", '')::integer FROM "app_settings" WHERE "key" = 'free_proxy_idle_region_target'), 10),
        'emergencyRecoveryEnabled', COALESCE((SELECT LOWER("value") <> 'false' FROM "app_settings" WHERE "key" = 'free_proxy_emergency_recovery_enabled'), true)
    )::text
),
(
    'policy.worker',
    json_build_object(
        'version', 1,
        'revision', 1,
        'discoveryMode', 'off',
        'discoveryAllowFreeActive', false,
        'enrichSellerInfo', true,
        'catalogLatencyMetrics', true
    )::text
)
ON CONFLICT ("key") DO NOTHING;
