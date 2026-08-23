import { cache } from "react";
import type { Account, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import {
    GITHUB_REWARDS_SETTING_KEY,
    buildRewardPrompt,
    parseGithubRewardsPolicy,
    resolveFreeProxyLimit,
    type GithubRewardPromptType,
    type GithubRewardsPolicy,
} from "@/lib/github-rewards";
import {
    GLOBAL_MONITOR_LIMIT_SCOPE,
    getMonitorLimits,
    roleLimitScope,
    userLimitScope,
} from "@/lib/monitor-limit-scopes";
import { githubFetch, hasUserStarredRepository } from "@/lib/github-api.server";

type RewardClient = Prisma.TransactionClient | typeof db;

type GithubUserProfile = {
    id: number;
    login: string;
    avatar_url?: string | null;
    type?: string;
};

export class GithubStarRecheckError extends Error {
    constructor(
        public readonly code:
            | "integration_disabled"
            | "not_connected"
            | "github_unavailable"
            | "cooldown",
        message: string,
    ) {
        super(message);
        this.name = "GithubStarRecheckError";
    }
}

/**
 * Minimum spacing between two manual rechecks of the same member. The button is
 * prominent in two places, and every click costs a full stargazer snapshot
 * against the shared GitHub rate limit.
 */
export const GITHUB_RECHECK_COOLDOWN_MS = 30_000;

async function getGithubRewardFacts(userId: string, client: RewardClient) {
    const [githubAccount, assignedDonation, authAccount] = await Promise.all([
        client.github_reward_accounts.findUnique({
            where: { claimed_user_id: userId },
            include: {
                sponsorships: {
                    where: { reward_revoked_at: null },
                    orderBy: { sponsored_at: "asc" },
                    take: 1,
                },
            },
        }),
        client.github_sponsorships.findFirst({
            where: { assigned_user_id: userId, reward_revoked_at: null },
            orderBy: { sponsored_at: "asc" },
        }),
        client.account.findMany({
            where: { userId },
            select: { provider: true, providerAccountId: true },
        }),
    ]);
    const githubAuthAccount = authAccount.find(
        (account) =>
            account.provider === "github" &&
            /^\d+$/.test(account.providerAccountId),
    );
    const githubConnected = Boolean(githubAuthAccount);
    const githubIdentityMatches = Boolean(
        githubAccount &&
        githubAuthAccount &&
        githubAccount.github_id.toString() ===
            githubAuthAccount.providerAccountId,
    );
    const githubIdentityKnown = githubIdentityMatches;
    const donation =
        (githubIdentityMatches ? githubAccount?.sponsorships[0] : null) ??
        assignedDonation;
    return {
        loginProviders: Array.from(
            new Set(authAccount.map((account) => account.provider)),
        ),
        githubConnected,
        githubIdentityKnown,
        starred: Boolean(
            githubIdentityMatches && githubAccount?.star_status === "starred",
        ),
        donated: Boolean(donation),
        githubLogin: githubIdentityMatches ? githubAccount?.login : null,
        starVerifiedAt: githubIdentityMatches
            ? (githubAccount?.star_verified_at?.toISOString() ?? null)
            : null,
        donation: donation
            ? {
                  sponsoredAt: donation.sponsored_at.toISOString(),
                  isOneTime: donation.is_one_time,
                  amountCents: donation.amount_cents,
              }
            : null,
    };
}

async function loadGithubRewardsPolicy(
    client: RewardClient,
): Promise<GithubRewardsPolicy> {
    const setting = await client.app_settings.findUnique({
        where: { key: GITHUB_REWARDS_SETTING_KEY },
        select: { value: true },
    });
    return parseGithubRewardsPolicy(setting?.value);
}

// The policy is read several times per request (limit resolution, member
// status card, activation checks). React's per-request cache collapses those
// into a single query without any invalidation to manage.
const getCachedGithubRewardsPolicy = cache(() => loadGithubRewardsPolicy(db));

export async function getGithubRewardsPolicy(
    client: RewardClient = db,
): Promise<GithubRewardsPolicy> {
    // Inside a transaction the caller needs the transaction's own view, so the
    // request-scoped cache is bypassed.
    if (client !== db) return loadGithubRewardsPolicy(client);
    return getCachedGithubRewardsPolicy();
}

export async function getGithubRewardEntitlement(
    userId: string,
    role: string,
    client: RewardClient = db,
) {
    const policy = await getGithubRewardsPolicy(client);
    const facts = await getGithubRewardFacts(userId, client);
    if (!policy.enforcementEnabled) {
        return { enabled: false as const, policy, ...facts };
    }
    if (!policy.eligibleRoles.includes(role)) {
        return {
            enabled: true as const,
            policy,
            limit: null,
            source: "role_exempt" as const,
            ...facts,
        };
    }

    return {
        enabled: true as const,
        policy,
        limit: facts.donated
            ? policy.donationLimit
            : facts.starred
              ? policy.starLimit
              : policy.defaultLimit,
        source: facts.donated
            ? ("donation" as const)
            : facts.starred
              ? ("github_star" as const)
              : ("policy_default" as const),
        ...facts,
    };
}

export async function getMemberGithubRewardStatus(
    userId: string,
    client: RewardClient = db,
) {
    const user = await client.user.findUnique({
        where: { id: userId },
        select: { role: true },
    });
    if (!user) throw new Error("User not found");
    const entitlement = await getGithubRewardEntitlement(
        userId,
        user.role,
        client,
    );
    const [freeProxyActiveCount, limits] = await Promise.all([
        client.monitors.count({
            where: { userId, status: "active", proxy_source: "free" },
        }),
        getMonitorLimits(
            [
                userLimitScope(userId),
                roleLimitScope(user.role),
                GLOBAL_MONITOR_LIMIT_SCOPE,
            ],
            client,
        ),
    ]);

    if (!entitlement.enabled) {
        return {
            policy: entitlement.policy,
            loginProviders: entitlement.loginProviders,
            githubConnected: entitlement.githubConnected,
            githubIdentityKnown: entitlement.githubIdentityKnown,
            githubLogin: entitlement.githubLogin,
            starred: entitlement.starred,
            starVerifiedAt: entitlement.starVerifiedAt,
            donated: entitlement.donated,
            donation: entitlement.donation,
            freeProxyActiveCount,
            effectiveLimit: null,
            source: null,
            limitReached: false,
            prompt: null,
        };
    }

    const { limit: effectiveLimit, source } = resolveFreeProxyLimit({
        userOverride: limits.get(userLimitScope(userId))
            ?.free_proxy_active_limit,
        reward: { limit: entitlement.limit, source: entitlement.source },
        roleLimit: limits.get(roleLimitScope(user.role))
            ?.free_proxy_active_limit,
        globalLimit: limits.get(GLOBAL_MONITOR_LIMIT_SCOPE)
            ?.free_proxy_active_limit,
    });
    const limitReached =
        effectiveLimit !== null && freeProxyActiveCount >= effectiveLimit;
    const prompt =
        limitReached && effectiveLimit !== null
            ? buildRewardPrompt({
                  source,
                  policy: entitlement.policy,
                  count: freeProxyActiveCount,
                  limit: effectiveLimit,
                  githubConnected: entitlement.githubConnected,
              })
            : null;
    return {
        policy: entitlement.policy,
        loginProviders: entitlement.loginProviders,
        githubConnected: entitlement.githubConnected,
        githubIdentityKnown: entitlement.githubIdentityKnown,
        githubLogin: entitlement.githubLogin,
        starred: entitlement.starred,
        starVerifiedAt: entitlement.starVerifiedAt,
        donated: entitlement.donated,
        donation: entitlement.donation ?? null,
        freeProxyActiveCount,
        effectiveLimit,
        source,
        limitReached,
        prompt,
    };
}

export type MemberGithubRewardStatus = Awaited<
    ReturnType<typeof getMemberGithubRewardStatus>
>;

export async function registerRewardPromptReached(
    userId: string,
    policyVersion: string,
    promptType: GithubRewardPromptType,
    client: RewardClient = db,
) {
    return client.member_reward_prompts.upsert({
        where: {
            userId_policy_version_prompt_type: {
                userId,
                policy_version: policyVersion,
                prompt_type: promptType,
            },
        },
        create: {
            userId,
            policy_version: policyVersion,
            prompt_type: promptType,
            shown_at: new Date(),
        },
        update: {},
    });
}

export async function claimGithubAccountForUser(input: {
    userId: string;
    githubId: bigint;
    login: string;
    displayName?: string | null;
    avatarUrl?: string | null;
}) {
    return db.$transaction(async (tx) => {
        await tx.$queryRaw`
            SELECT pg_advisory_xact_lock(
                hashtextextended(${`github-reward-account:${input.githubId}`}, 0)
            )::text AS lock_result
        `;
        const existing = await tx.github_reward_accounts.findUnique({
            where: { github_id: input.githubId },
        });
        if (
            existing?.claimed_user_id &&
            existing.claimed_user_id !== input.userId
        ) {
            throw new Error(
                "This GitHub account is already linked to another Vintrack member",
            );
        }
        return tx.github_reward_accounts.upsert({
            where: { github_id: input.githubId },
            create: {
                github_id: input.githubId,
                login: input.login,
                display_name: input.displayName ?? null,
                avatar_url: input.avatarUrl ?? null,
                claimed_user_id: input.userId,
            },
            update: {
                login: input.login,
                display_name: input.displayName ?? null,
                avatar_url: input.avatarUrl ?? null,
                claimed_user_id: input.userId,
            },
        });
    });
}

export async function updateGithubStarFromToken(input: {
    githubId: bigint;
    login: string;
    accessToken: string;
    userId?: string | null;
    displayName?: string | null;
    avatarUrl?: string | null;
}) {
    const policy = await getGithubRewardsPolicy();
    if (!policy.integrationEnabled) return null;
    const response = await fetch(
        `https://api.github.com/user/starred/${encodeURIComponent(policy.repositoryOwner)}/${encodeURIComponent(policy.repositoryName)}`,
        {
            headers: {
                Accept: "application/vnd.github+json",
                Authorization: `Bearer ${input.accessToken}`,
                "X-GitHub-Api-Version": "2022-11-28",
                "User-Agent": "Vintrack-GitHub-Rewards",
            },
            cache: "no-store",
        },
    );
    if (![204, 404].includes(response.status)) {
        throw new Error(`GitHub star check failed (${response.status})`);
    }
    const now = new Date();
    const starStatus = response.status === 204 ? "starred" : "unstarred";
    if (input.userId) {
        await claimGithubAccountForUser({
            userId: input.userId,
            githubId: input.githubId,
            login: input.login,
            displayName: input.displayName,
            avatarUrl: input.avatarUrl,
        });
    }
    return db.github_reward_accounts.upsert({
        where: { github_id: input.githubId },
        create: {
            github_id: input.githubId,
            login: input.login,
            display_name: input.displayName ?? null,
            avatar_url: input.avatarUrl ?? null,
            claimed_user_id: input.userId ?? null,
            star_status: starStatus,
            star_changed_at: now,
            star_verified_at: now,
            star_event_at: now,
        },
        update: {
            login: input.login,
            display_name: input.displayName ?? null,
            avatar_url: input.avatarUrl ?? null,
            star_status: starStatus,
            star_changed_at: now,
            star_verified_at: now,
            star_event_at: now,
        },
    });
}

export async function recheckGithubStarForUser(userId: string) {
    const policy = await getGithubRewardsPolicy();
    if (!policy.integrationEnabled) {
        throw new GithubStarRecheckError(
            "integration_disabled",
            "GitHub rewards are not enabled right now.",
        );
    }
    const token = process.env.GITHUB_REWARDS_MAINTAINER_TOKEN?.trim();
    if (!token) {
        throw new GithubStarRecheckError(
            "integration_disabled",
            "GitHub rewards are not fully configured yet. Please try again later.",
        );
    }

    const [authAccounts, claimedRewardAccount] = await Promise.all([
        db.account.findMany({
            where: { userId, provider: "github" },
            select: { providerAccountId: true },
        }),
        db.github_reward_accounts.findUnique({
            where: { claimed_user_id: userId },
        }),
    ]);
    const authAccount = authAccounts.find((account) =>
        /^\d+$/.test(account.providerAccountId),
    );
    if (!authAccount) {
        throw new GithubStarRecheckError(
            "not_connected",
            "Connect your GitHub account before checking for a star.",
        );
    }
    const githubId = BigInt(authAccount.providerAccountId);

    const checkStartedAt = new Date();
    const lastVerifiedAt = claimedRewardAccount?.star_verified_at;
    if (
        lastVerifiedAt &&
        checkStartedAt.getTime() - lastVerifiedAt.getTime() <
            GITHUB_RECHECK_COOLDOWN_MS
    ) {
        throw new GithubStarRecheckError(
            "cooldown",
            "We just checked GitHub for you. Please wait a few seconds before trying again.",
        );
    }

    let login = claimedRewardAccount?.login ?? null;
    if (!claimedRewardAccount) {
        // The member has a GitHub login row but no reward identity yet (e.g.
        // the link event failed). Resolve the login before reserving it.
        const profile = await githubFetch<GithubUserProfile>(
            "GitHub user",
            `https://api.github.com/user/${encodeURIComponent(githubId.toString())}`,
            token,
            { publicFallback: true },
        ).catch(() => null);
        if (!profile?.login || String(profile.id) !== githubId.toString()) {
            throw new GithubStarRecheckError(
                "github_unavailable",
                "GitHub could not resolve the linked account right now. Please try again.",
            );
        }
        login = profile.login;
        await claimGithubAccountForUser({
            userId,
            githubId,
            login: profile.login,
            avatarUrl: profile.avatar_url,
        });
    }
    if (!login) {
        throw new GithubStarRecheckError(
            "github_unavailable",
            "GitHub could not resolve the linked account right now. Please try again.",
        );
    }

    // For a single member the per-member starred list is both cheaper than a
    // repository-wide snapshot and available to fine-grained tokens. It is
    // ordered most-recently-starred first, so a star the member just added
    // shows up on the first page.
    const starred = await hasUserStarredRepository(token, login, policy).catch(
        () => {
            throw new GithubStarRecheckError(
                "github_unavailable",
                "GitHub could not verify the repository star right now. Please try again.",
            );
        },
    );

    const previousStatus = claimedRewardAccount?.star_status ?? "unknown";
    const starStatus = starred ? "starred" : "unstarred";
    await db.github_reward_accounts.updateMany({
        where: {
            github_id: githubId,
            OR: [
                { star_event_at: null },
                { star_event_at: { lte: checkStartedAt } },
            ],
        },
        data: {
            star_status: starStatus,
            ...(previousStatus !== starStatus
                ? { star_changed_at: checkStartedAt }
                : {}),
            star_verified_at: checkStartedAt,
            star_event_at: checkStartedAt,
        },
    });

    const verifiedAccount = await db.github_reward_accounts.findUnique({
        where: { github_id: githubId },
        select: { star_status: true },
    });
    const verifiedStarred = verifiedAccount?.star_status === "starred";
    return {
        starred: verifiedStarred,
        changed: previousStatus !== verifiedAccount?.star_status,
    };
}

export function githubIdFromAccount(account: Account) {
    if (
        account.provider !== "github" ||
        !/^\d+$/.test(account.providerAccountId)
    ) {
        return null;
    }
    return BigInt(account.providerAccountId);
}
