CREATE TABLE "feature_policies" (
    "feature" VARCHAR(50) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT TRUE,
    "free_enabled" BOOLEAN NOT NULL DEFAULT TRUE,
    "premium_enabled" BOOLEAN NOT NULL DEFAULT TRUE,
    "admin_enabled" BOOLEAN NOT NULL DEFAULT TRUE,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "feature_policies_pkey" PRIMARY KEY ("feature")
);

INSERT INTO "feature_policies" (
    "feature",
    "enabled",
    "free_enabled",
    "premium_enabled",
    "admin_enabled"
)
VALUES
    (
        'price_watch',
        COALESCE((SELECT LOWER("value") <> 'false' FROM "app_settings" WHERE "key" = 'price_watch_enabled'), TRUE),
        TRUE,
        TRUE,
        TRUE
    ),
    ('live_feed', TRUE, TRUE, TRUE, TRUE),
    ('proxy_groups', TRUE, TRUE, TRUE, TRUE),
    (
        'free_proxy_pool',
        COALESCE((SELECT LOWER("value") = 'true' FROM "app_settings" WHERE "key" = 'free_proxy_enabled'), FALSE),
        TRUE,
        TRUE,
        TRUE
    ),
    ('vinted_account', TRUE, TRUE, TRUE, TRUE),
    ('your_listings', TRUE, TRUE, TRUE, TRUE),
    ('liked_items', TRUE, TRUE, TRUE, TRUE),
    ('chats', TRUE, TRUE, TRUE, TRUE),
    ('offers', TRUE, TRUE, TRUE, TRUE),
    ('checkout_links', TRUE, TRUE, TRUE, TRUE);
