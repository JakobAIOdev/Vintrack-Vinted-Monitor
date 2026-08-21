export const GITHUB_REWARDS_SETTING_KEY = "github_rewards_policy";

export const GITHUB_REWARD_PROMPT_TYPES = [
    "star_upgrade",
    "donation_upgrade",
    "hard_limit",
    "announcement",
] as const;

export type GithubRewardPromptType =
    (typeof GITHUB_REWARD_PROMPT_TYPES)[number];

export type GithubRewardsPolicy = {
    version: string;
    integrationEnabled: boolean;
    enforcementEnabled: boolean;
    eligibleRoles: string[];
    defaultLimit: number;
    starLimit: number;
    donationLimit: number;
    priceWatchRewardsEnabled: boolean;
    priceWatchDefaultLimit: number;
    priceWatchStarLimit: number;
    priceWatchDonationLimit: number;
    repositoryOwner: string;
    repositoryName: string;
    sponsorsLogin: string;
    syncIntervalMinutes: number;
    announcementEnabled: boolean;
    announcementTitle: string;
    announcementMessage: string;
    starPromptTitle: string;
    starPromptMessage: string;
    donationPromptTitle: string;
    donationPromptMessage: string;
    hardLimitTitle: string;
    hardLimitMessage: string;
};

export const DEFAULT_GITHUB_REWARDS_POLICY: GithubRewardsPolicy = {
    version: "github-rewards-v1",
    integrationEnabled: true,
    enforcementEnabled: false,
    eligibleRoles: ["free"],
    defaultLimit: 3,
    starLimit: 5,
    donationLimit: 15,
    priceWatchRewardsEnabled: true,
    priceWatchDefaultLimit: 3,
    priceWatchStarLimit: 5,
    priceWatchDonationLimit: 15,
    repositoryOwner: "JakobAIOdev",
    repositoryName: "Vintrack-Vinted-Monitor",
    sponsorsLogin: "JakobAIOdev",
    syncIntervalMinutes: 1440,
    announcementEnabled: true,
    announcementTitle: "Free Proxy Pool rewards are here",
    announcementMessage:
        "Free members can run 3 Free Proxy Pool monitors by default, 5 after starring Vintrack on GitHub, or 15 after any GitHub Sponsors donation.",
    starPromptTitle: "Free Proxy Pool limit reached",
    starPromptMessage:
        "You’re currently running {count} of {limit} Free Proxy Pool monitors. Star Vintrack on GitHub to increase your limit to {nextLimit}.",
    donationPromptTitle: "Free Proxy Pool limit reached",
    donationPromptMessage:
        "You’re running {count} of {limit} Free Proxy Pool monitors. Any GitHub Sponsors donation permanently increases your limit to {nextLimit}.",
    hardLimitTitle: "Free Proxy Pool limit reached",
    hardLimitMessage:
        "You’re running {count} of {limit} Free Proxy Pool monitors. Pause another Free Pool monitor or use your own proxies to add more.",
};

function record(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

function boolean(value: unknown, fallback: boolean) {
    return typeof value === "boolean" ? value : fallback;
}

function integer(value: unknown, fallback: number, min = 0) {
    return Number.isInteger(value) && Number(value) >= min
        ? Number(value)
        : fallback;
}

function string(value: unknown, fallback: string, max = 500) {
    if (typeof value !== "string") return fallback;
    const normalized = value.trim();
    return normalized && normalized.length <= max ? normalized : fallback;
}

export function parseGithubRewardsPolicy(
    raw: string | null | undefined,
): GithubRewardsPolicy {
    if (!raw) return DEFAULT_GITHUB_REWARDS_POLICY;
    try {
        const value = record(JSON.parse(raw));
        if (!value) return DEFAULT_GITHUB_REWARDS_POLICY;
        const eligibleRoles = Array.isArray(value.eligibleRoles)
            ? Array.from(
                  new Set(
                      value.eligibleRoles.filter(
                          (role): role is string =>
                              typeof role === "string" &&
                              ["free", "premium"].includes(role),
                      ),
                  ),
              )
            : DEFAULT_GITHUB_REWARDS_POLICY.eligibleRoles;
        const defaultLimit = integer(
            value.defaultLimit,
            DEFAULT_GITHUB_REWARDS_POLICY.defaultLimit,
        );
        const starLimit = integer(
            value.starLimit,
            DEFAULT_GITHUB_REWARDS_POLICY.starLimit,
        );
        const donationLimit = integer(
            value.donationLimit,
            DEFAULT_GITHUB_REWARDS_POLICY.donationLimit,
        );
        const priceWatchDefaultLimit = integer(
            value.priceWatchDefaultLimit,
            DEFAULT_GITHUB_REWARDS_POLICY.priceWatchDefaultLimit,
        );
        const priceWatchStarLimit = integer(
            value.priceWatchStarLimit,
            DEFAULT_GITHUB_REWARDS_POLICY.priceWatchStarLimit,
        );
        const priceWatchDonationLimit = integer(
            value.priceWatchDonationLimit,
            DEFAULT_GITHUB_REWARDS_POLICY.priceWatchDonationLimit,
        );
        if (defaultLimit > starLimit || starLimit > donationLimit) {
            return DEFAULT_GITHUB_REWARDS_POLICY;
        }
        if (
            priceWatchDefaultLimit > priceWatchStarLimit ||
            priceWatchStarLimit > priceWatchDonationLimit
        ) {
            return DEFAULT_GITHUB_REWARDS_POLICY;
        }
        return {
            version: string(
                value.version,
                DEFAULT_GITHUB_REWARDS_POLICY.version,
                100,
            ),
            integrationEnabled: boolean(
                value.integrationEnabled,
                DEFAULT_GITHUB_REWARDS_POLICY.integrationEnabled,
            ),
            enforcementEnabled: boolean(
                value.enforcementEnabled,
                DEFAULT_GITHUB_REWARDS_POLICY.enforcementEnabled,
            ),
            eligibleRoles:
                eligibleRoles.length > 0
                    ? eligibleRoles
                    : DEFAULT_GITHUB_REWARDS_POLICY.eligibleRoles,
            defaultLimit,
            starLimit,
            donationLimit,
            priceWatchRewardsEnabled: boolean(
                value.priceWatchRewardsEnabled,
                DEFAULT_GITHUB_REWARDS_POLICY.priceWatchRewardsEnabled,
            ),
            priceWatchDefaultLimit,
            priceWatchStarLimit,
            priceWatchDonationLimit,
            repositoryOwner: string(
                value.repositoryOwner,
                DEFAULT_GITHUB_REWARDS_POLICY.repositoryOwner,
                255,
            ),
            repositoryName: string(
                value.repositoryName,
                DEFAULT_GITHUB_REWARDS_POLICY.repositoryName,
                255,
            ),
            sponsorsLogin: string(
                value.sponsorsLogin,
                DEFAULT_GITHUB_REWARDS_POLICY.sponsorsLogin,
                255,
            ),
            syncIntervalMinutes: integer(
                value.syncIntervalMinutes,
                DEFAULT_GITHUB_REWARDS_POLICY.syncIntervalMinutes,
                5,
            ),
            announcementEnabled: boolean(
                value.announcementEnabled,
                DEFAULT_GITHUB_REWARDS_POLICY.announcementEnabled,
            ),
            announcementTitle: string(
                value.announcementTitle,
                DEFAULT_GITHUB_REWARDS_POLICY.announcementTitle,
                100,
            ),
            announcementMessage: string(
                value.announcementMessage,
                DEFAULT_GITHUB_REWARDS_POLICY.announcementMessage,
                500,
            ),
            starPromptTitle: string(
                value.starPromptTitle,
                DEFAULT_GITHUB_REWARDS_POLICY.starPromptTitle,
                100,
            ),
            starPromptMessage: string(
                value.starPromptMessage,
                DEFAULT_GITHUB_REWARDS_POLICY.starPromptMessage,
                500,
            ),
            donationPromptTitle: string(
                value.donationPromptTitle,
                DEFAULT_GITHUB_REWARDS_POLICY.donationPromptTitle,
                100,
            ),
            donationPromptMessage: string(
                value.donationPromptMessage,
                DEFAULT_GITHUB_REWARDS_POLICY.donationPromptMessage,
                500,
            ),
            hardLimitTitle: string(
                value.hardLimitTitle,
                DEFAULT_GITHUB_REWARDS_POLICY.hardLimitTitle,
                100,
            ),
            hardLimitMessage: string(
                value.hardLimitMessage,
                DEFAULT_GITHUB_REWARDS_POLICY.hardLimitMessage,
                500,
            ),
        };
    } catch {
        return DEFAULT_GITHUB_REWARDS_POLICY;
    }
}

export function validateGithubRewardsPolicy(value: GithubRewardsPolicy) {
    if (value.eligibleRoles.length === 0) {
        throw new Error("Select at least one eligible role");
    }
    if (
        !Number.isInteger(value.defaultLimit) ||
        !Number.isInteger(value.starLimit) ||
        !Number.isInteger(value.donationLimit) ||
        value.defaultLimit < 0 ||
        value.defaultLimit > value.starLimit ||
        value.starLimit > value.donationLimit
    ) {
        throw new Error(
            "Limits must be non-negative and ordered default ≤ star ≤ donation",
        );
    }
    if (
        !Number.isInteger(value.priceWatchDefaultLimit) ||
        !Number.isInteger(value.priceWatchStarLimit) ||
        !Number.isInteger(value.priceWatchDonationLimit) ||
        value.priceWatchDefaultLimit < 0 ||
        value.priceWatchDefaultLimit > value.priceWatchStarLimit ||
        value.priceWatchStarLimit > value.priceWatchDonationLimit
    ) {
        throw new Error(
            "Price Watch limits must be ordered default ≤ star ≤ donation",
        );
    }
    if (
        !value.repositoryOwner ||
        !value.repositoryName ||
        !value.sponsorsLogin
    ) {
        throw new Error(
            "Repository owner, repository name and Sponsors login are required",
        );
    }
    if (value.syncIntervalMinutes < 5) {
        throw new Error("Sync interval must be at least five minutes");
    }
    return value;
}

export function renderRewardMessage(
    template: string,
    values: { count: number; limit: number; nextLimit?: number | null },
) {
    return template
        .replaceAll("{count}", String(values.count))
        .replaceAll("{limit}", String(values.limit))
        .replaceAll("{nextLimit}", String(values.nextLimit ?? values.limit));
}

/**
 * Where an effective Free Proxy Pool limit came from. Resolved in exactly one
 * place (`resolveFreeProxyLimit`) so the server, the member status view and the
 * admin enforcement preview can never drift apart.
 */
export type FreeProxyLimitSource =
    | "user_override"
    | "donation"
    | "github_star"
    | "policy_default"
    | "role"
    | "global"
    | "role_exempt"
    | null;

export type ResolvedFreeProxyLimit = {
    limit: number | null;
    source: FreeProxyLimitSource;
};

/**
 * Precedence: a per-member admin override always wins, then the GitHub reward
 * tier (only while enforcement is on), then the role and global fallback rows.
 */
export function resolveFreeProxyLimit(input: {
    userOverride: number | null | undefined;
    reward: ResolvedFreeProxyLimit | null;
    roleLimit: number | null | undefined;
    globalLimit: number | null | undefined;
}): ResolvedFreeProxyLimit {
    if (input.userOverride !== null && input.userOverride !== undefined) {
        return { limit: input.userOverride, source: "user_override" };
    }
    if (input.reward) {
        // `role_exempt` deliberately resolves to an unlimited allowance rather
        // than falling through to the role/global rows.
        return input.reward;
    }
    if (input.roleLimit !== null && input.roleLimit !== undefined) {
        return { limit: input.roleLimit, source: "role" };
    }
    if (input.globalLimit !== null && input.globalLimit !== undefined) {
        return { limit: input.globalLimit, source: "global" };
    }
    return { limit: null, source: null };
}

export type RewardPrompt = {
    type: GithubRewardPromptType;
    title: string;
    message: string;
    primaryAction: "connect" | "star" | "donate" | null;
    nextLimit: number | null;
};

/**
 * Builds the upsell shown once a member sits at their Free Pool limit. Shared
 * by the live dashboard status and the notice returned right after an
 * activation pushed the member onto the limit.
 */
export function buildRewardPrompt(input: {
    source: FreeProxyLimitSource;
    policy: GithubRewardsPolicy;
    count: number;
    limit: number;
    githubConnected: boolean;
}): RewardPrompt {
    const { policy, count, limit } = input;
    if (input.source === "policy_default") {
        return {
            type: "star_upgrade",
            title: policy.starPromptTitle,
            message: renderRewardMessage(policy.starPromptMessage, {
                count,
                limit,
                nextLimit: policy.starLimit,
            }),
            primaryAction: input.githubConnected ? "star" : "connect",
            nextLimit: policy.starLimit,
        };
    }
    if (input.source === "github_star") {
        return {
            type: "donation_upgrade",
            title: policy.donationPromptTitle,
            message: renderRewardMessage(policy.donationPromptMessage, {
                count,
                limit,
                nextLimit: policy.donationLimit,
            }),
            primaryAction: "donate",
            nextLimit: policy.donationLimit,
        };
    }
    return {
        type: "hard_limit",
        title: policy.hardLimitTitle,
        message:
            input.source === "user_override"
                ? `Your Free Proxy Pool limit is ${limit}. This limit was set by an administrator.`
                : renderRewardMessage(policy.hardLimitMessage, { count, limit }),
        primaryAction: null,
        nextLimit: null,
    };
}

export type RewardLimitNotice = {
    promptType: GithubRewardPromptType;
    policyVersion: string;
    title: string;
    message: string;
    cta: "connect" | "star" | "donate" | null;
};

export function rewardNoticeForLimitTransition(input: {
    currentCount: number;
    activatedCount: number;
    limit: number | null;
    source: FreeProxyLimitSource;
    githubConnected: boolean;
    policy: GithubRewardsPolicy;
}): RewardLimitNotice | null {
    const { limit } = input;
    if (
        limit === null ||
        input.currentCount >= limit ||
        input.currentCount + input.activatedCount < limit
    ) {
        return null;
    }
    const prompt = buildRewardPrompt({
        source: input.source,
        policy: input.policy,
        count: Math.min(input.currentCount + input.activatedCount, limit),
        limit,
        githubConnected: input.githubConnected,
    });
    return {
        promptType: prompt.type,
        policyVersion: input.policy.version,
        title: prompt.title,
        message: prompt.message,
        cta: prompt.primaryAction,
    };
}
