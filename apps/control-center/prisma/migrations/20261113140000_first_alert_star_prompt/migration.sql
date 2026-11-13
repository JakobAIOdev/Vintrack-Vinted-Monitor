-- Do not retroactively celebrate an existing member's first delivered alert.
-- Fixed version: changing the rewards policy must never repeat this prompt.
INSERT INTO "member_reward_prompts"
    ("userId", "policy_version", "prompt_type", "first_reached_at", "dismissed_at")
SELECT n."user_id", 'first-alert-v1', 'first_alert_star', MIN(d."completed_at"), CURRENT_TIMESTAMP
FROM "alert_notifications" n
JOIN "alert_deliveries" d ON d."notification_id" = n."id"
JOIN "User" u ON u."id" = n."user_id"
WHERE n."kind" = 'item_match' AND d."status" = 'sent' AND d."completed_at" IS NOT NULL
GROUP BY n."user_id"
ON CONFLICT ("userId", "policy_version", "prompt_type") DO NOTHING;
