CREATE TABLE "github_reward_accounts" (
    "github_id" BIGINT NOT NULL,
    "login" VARCHAR(255) NOT NULL,
    "account_type" VARCHAR(30) NOT NULL DEFAULT 'user',
    "display_name" VARCHAR(255),
    "avatar_url" TEXT,
    "star_status" VARCHAR(20) NOT NULL DEFAULT 'unknown',
    "star_changed_at" TIMESTAMP(6),
    "star_verified_at" TIMESTAMP(6),
    "star_event_at" TIMESTAMP(6),
    "claimed_user_id" TEXT,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "github_reward_accounts_pkey" PRIMARY KEY ("github_id")
);

CREATE TABLE "github_sponsorships" (
    "id" VARCHAR(255) NOT NULL,
    "sponsor_github_id" BIGINT NOT NULL,
    "assigned_user_id" TEXT,
    "sponsorable_login" VARCHAR(255) NOT NULL,
    "is_one_time" BOOLEAN NOT NULL,
    "is_active" BOOLEAN NOT NULL,
    "tier_name" VARCHAR(255),
    "amount_cents" INTEGER,
    "payment_source" VARCHAR(50),
    "privacy_level" VARCHAR(30),
    "source" VARCHAR(30) NOT NULL,
    "verification_status" VARCHAR(30) NOT NULL DEFAULT 'verified',
    "sponsored_at" TIMESTAMP(6) NOT NULL,
    "last_seen_at" TIMESTAMP(6) NOT NULL,
    "last_verified_at" TIMESTAMP(6) NOT NULL,
    "reward_revoked_at" TIMESTAMP(6),
    "revoke_reason" TEXT,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "github_sponsorships_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "github_webhook_deliveries" (
    "delivery_id" VARCHAR(255) NOT NULL,
    "event" VARCHAR(100) NOT NULL,
    "action" VARCHAR(100),
    "status" VARCHAR(30) NOT NULL DEFAULT 'processing',
    "error" TEXT,
    "received_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(6),
    CONSTRAINT "github_webhook_deliveries_pkey" PRIMARY KEY ("delivery_id")
);

CREATE TABLE "github_reward_jobs" (
    "id" BIGSERIAL NOT NULL,
    "job_type" VARCHAR(50) NOT NULL,
    "status" VARCHAR(30) NOT NULL DEFAULT 'running',
    "cursor" TEXT,
    "processed" INTEGER NOT NULL DEFAULT 0,
    "changed" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "metadata" JSONB,
    "error" TEXT,
    "started_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(6),
    CONSTRAINT "github_reward_jobs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "member_reward_prompts" (
    "id" BIGSERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "policy_version" VARCHAR(100) NOT NULL,
    "prompt_type" VARCHAR(50) NOT NULL,
    "first_reached_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "shown_at" TIMESTAMP(6),
    "dismissed_at" TIMESTAMP(6),
    "cta_clicked_at" TIMESTAMP(6),
    CONSTRAINT "member_reward_prompts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "github_reward_accounts_claimed_user_id_key"
    ON "github_reward_accounts"("claimed_user_id");
CREATE INDEX "github_reward_accounts_login_idx"
    ON "github_reward_accounts"("login");
CREATE INDEX "github_reward_accounts_star_status_idx"
    ON "github_reward_accounts"("star_status");
CREATE INDEX "github_sponsorships_sponsor_github_id_reward_revoked_at_idx"
    ON "github_sponsorships"("sponsor_github_id", "reward_revoked_at");
CREATE INDEX "github_sponsorships_sponsorable_login_sponsored_at_idx"
    ON "github_sponsorships"("sponsorable_login", "sponsored_at");
CREATE INDEX "github_sponsorships_assigned_user_id_reward_revoked_at_idx"
    ON "github_sponsorships"("assigned_user_id", "reward_revoked_at");
CREATE INDEX "github_webhook_deliveries_event_received_at_idx"
    ON "github_webhook_deliveries"("event", "received_at");
CREATE INDEX "github_webhook_deliveries_status_received_at_idx"
    ON "github_webhook_deliveries"("status", "received_at");
CREATE INDEX "github_reward_jobs_job_type_started_at_idx"
    ON "github_reward_jobs"("job_type", "started_at");
CREATE INDEX "github_reward_jobs_status_started_at_idx"
    ON "github_reward_jobs"("status", "started_at");
CREATE UNIQUE INDEX "member_reward_prompts_userId_policy_version_prompt_type_key"
    ON "member_reward_prompts"("userId", "policy_version", "prompt_type");
CREATE INDEX "member_reward_prompts_prompt_type_first_reached_at_idx"
    ON "member_reward_prompts"("prompt_type", "first_reached_at");

ALTER TABLE "github_reward_accounts"
    ADD CONSTRAINT "github_reward_accounts_claimed_user_id_fkey"
    FOREIGN KEY ("claimed_user_id") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "github_sponsorships"
    ADD CONSTRAINT "github_sponsorships_sponsor_github_id_fkey"
    FOREIGN KEY ("sponsor_github_id") REFERENCES "github_reward_accounts"("github_id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "github_sponsorships"
    ADD CONSTRAINT "github_sponsorships_assigned_user_id_fkey"
    FOREIGN KEY ("assigned_user_id") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "member_reward_prompts"
    ADD CONSTRAINT "member_reward_prompts_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "app_settings" ("key", "value", "created_at", "updated_at")
VALUES (
    'github_rewards_policy',
    '{"version":"github-rewards-v1","integrationEnabled":true,"enforcementEnabled":false,"eligibleRoles":["free"],"defaultLimit":3,"starLimit":5,"donationLimit":15,"repositoryOwner":"JakobAIOdev","repositoryName":"Vintrack-Vinted-Monitor","sponsorsLogin":"JakobAIOdev","syncIntervalMinutes":1440,"announcementEnabled":true,"announcementTitle":"Free Proxy Pool rewards are here","announcementMessage":"Free members can run 3 Free Proxy Pool monitors by default, 5 after starring Vintrack on GitHub, or 15 after any GitHub Sponsors donation."}',
    NOW(),
    NOW()
)
ON CONFLICT ("key") DO NOTHING;
