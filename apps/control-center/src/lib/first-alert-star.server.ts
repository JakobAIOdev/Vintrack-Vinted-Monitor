import "server-only";

import { db } from "@/lib/db";
import {
    getMemberGithubRewardStatus,
    GithubStarRecheckError,
    recheckGithubStarForUser,
} from "@/lib/github-rewards.server";
import {
    FIRST_ALERT_STAR_TYPE,
    FIRST_ALERT_STAR_VERSION,
    type FirstAlertStarResult,
} from "@/lib/first-alert-star";

const hidden: FirstAlertStarResult = { prompt: null, retry: false };
const waiting: FirstAlertStarResult = { prompt: null, retry: true };

export async function claimFirstAlertStarPrompt(
    userId: string,
): Promise<FirstAlertStarResult> {
    const promptKey = {
        userId,
        policy_version: FIRST_ALERT_STAR_VERSION,
        prompt_type: FIRST_ALERT_STAR_TYPE,
    };
    const seen = await db.member_reward_prompts.findUnique({
        where: { userId_policy_version_prompt_type: promptKey },
        select: { id: true },
    });
    if (seen) return hidden;

    const status = await getMemberGithubRewardStatus(userId);
    if (
        !status.policy.integrationEnabled ||
        !status.policy.enforcementEnabled ||
        status.starred ||
        status.donated ||
        !status.githubConnected ||
        !status.githubIdentityKnown ||
        !status.starVerifiedAt ||
        status.source !== "policy_default" ||
        status.limitReached ||
        status.effectiveLimit === null ||
        status.policy.starLimit <= status.effectiveLimit
    )
        return hidden;

    // "Unknown" is not evidence of an absent star. Never prompt an unverified
    // identity, including people who already starred but did not link GitHub.
    const identity = await db.github_reward_accounts.findUnique({
        where: { claimed_user_id: userId },
        select: { star_status: true },
    });
    if (identity?.star_status !== "unstarred") return hidden;

    const firstAlert = await db.alert_notifications.findFirst({
        where: {
            user_id: userId,
            kind: "item_match",
            deliveries: {
                some: { status: "sent", completed_at: { not: null } },
            },
        },
        select: { id: true },
    });
    if (!firstAlert) return waiting;

    // Refresh a cached negative before displaying anything. Fail closed if
    // GitHub is unavailable or a recent check is still in its cooldown.
    try {
        const verified = await recheckGithubStarForUser(userId);
        if (verified.starred) return hidden;
    } catch (error) {
        return error instanceof GithubStarRecheckError &&
            error.code === "cooldown"
            ? waiting
            : hidden;
    }

    return db.$transaction(async (tx) => {
        const current = await tx.github_reward_accounts.findUnique({
            where: { claimed_user_id: userId },
            select: { star_status: true },
        });
        if (current?.star_status !== "unstarred") return hidden;
        // Unique per account, across tabs and devices. This version deliberately
        // stays independent of reward-policy edits, so they never re-arm it.
        const claimed = await tx.member_reward_prompts.createMany({
            data: { ...promptKey, shown_at: new Date() },
            skipDuplicates: true,
        });
        if (claimed.count !== 1) return hidden;
        return {
            prompt: {
                repositoryUrl: `https://github.com/${status.policy.repositoryOwner}/${status.policy.repositoryName}`,
                currentLimit: status.effectiveLimit!,
                starLimit: status.policy.starLimit,
            },
            retry: false,
        };
    });
}

export async function recordFirstAlertStarAction(
    userId: string,
    action: "dismissed" | "cta",
) {
    // Tracking can update a claimed prompt, but cannot create or re-arm one.
    await db.member_reward_prompts.updateMany({
        where: {
            userId,
            policy_version: FIRST_ALERT_STAR_VERSION,
            prompt_type: FIRST_ALERT_STAR_TYPE,
        },
        data:
            action === "dismissed"
                ? { dismissed_at: new Date() }
                : { cta_clicked_at: new Date() },
    });
}
