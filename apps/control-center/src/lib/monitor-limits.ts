import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { getMonitorMaintenance } from "@/lib/monitor-maintenance.server";
import { MONITOR_MAINTENANCE_LOCK_KEY } from "@/lib/monitor-maintenance";
import { getGithubRewardEntitlement } from "@/lib/github-rewards.server";
import {
    DEFAULT_GITHUB_REWARDS_POLICY,
    resolveFreeProxyLimit,
    rewardNoticeForLimitTransition,
    type FreeProxyLimitSource,
    type RewardLimitNotice,
} from "@/lib/github-rewards";
import {
    GLOBAL_MONITOR_LIMIT_SCOPE,
    getMonitorLimits,
    roleLimitScope,
    userLimitScope,
    type MonitorLimitClient,
    type MonitorLimitRow,
} from "@/lib/monitor-limit-scopes";

export {
    GLOBAL_MONITOR_LIMIT_SCOPE,
    ROLE_MONITOR_LIMIT_PREFIX,
    USER_MONITOR_LIMIT_PREFIX,
    getMonitorLimits,
    roleLimitScope,
    userLimitScope,
} from "@/lib/monitor-limit-scopes";
export type { MonitorLimitRow } from "@/lib/monitor-limit-scopes";

export const DEFAULT_FREE_PROXY_ACTIVE_LIMIT: number | null = null;

export type EffectiveMonitorLimit = {
    activeLimit: number | null;
    source: "user" | "role" | "global" | null;
};

export type EffectiveFreeProxyMonitorLimit = {
    freeProxyActiveLimit: number | null;
    freeProxyLimitSource: FreeProxyLimitSource;
};

export function normalizeMonitorLimitInput(value: FormDataEntryValue | null) {
    const raw = String(value ?? "").trim();
    if (!raw) return null;

    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 0) {
        throw new Error("Monitor limit must be empty or a non-negative number");
    }

    return parsed;
}

export async function setMonitorLimit(
    scope: string,
    activeLimit: number | null,
) {
    await db.$executeRaw`
        INSERT INTO "monitor_limits" ("scope", "active_limit", "updated_at")
        VALUES (${scope}, ${activeLimit}, NOW())
        ON CONFLICT ("scope") DO UPDATE
        SET "active_limit" = EXCLUDED."active_limit",
            "updated_at" = NOW()
    `;
}

export async function setFreeProxyMonitorLimit(
    scope: string,
    freeProxyActiveLimit: number | null,
) {
    await db.$executeRaw`
        INSERT INTO "monitor_limits" (
            "scope",
            "active_limit",
            "free_proxy_active_limit",
            "updated_at"
        )
        VALUES (${scope}, NULL, ${freeProxyActiveLimit}, NOW())
        ON CONFLICT ("scope") DO UPDATE
        SET "free_proxy_active_limit" = EXCLUDED."free_proxy_active_limit",
            "updated_at" = NOW()
    `;
}

function resolveLimit(
    rows: Map<string, MonitorLimitRow>,
    scopes: string[],
    field: "active_limit" | "free_proxy_active_limit",
) {
    const sources = ["user", "role", "global"] as const;
    for (let index = 0; index < scopes.length; index += 1) {
        const value = rows.get(scopes[index])?.[field];
        if (value !== undefined && value !== null) {
            return { value, source: sources[index] };
        }
    }
    return { value: null, source: null };
}

export async function getEffectiveMonitorLimits(
    userId: string,
    client: MonitorLimitClient = db,
) {
    const user = await client.user.findUnique({
        where: { id: userId },
        select: { role: true },
    });
    if (!user) throw new Error("User not found");

    if (user.role === "admin") {
        return {
            activeLimit: null,
            source: null,
            freeProxyActiveLimit: null,
            freeProxyLimitSource: null,
        };
    }

    const scopes = [
        userLimitScope(userId),
        roleLimitScope(user.role),
        GLOBAL_MONITOR_LIMIT_SCOPE,
    ];
    const [limits, reward] = await Promise.all([
        getMonitorLimits(scopes, client),
        getGithubRewardEntitlement(userId, user.role, client),
    ]);
    // GitHub rewards govern the Free Proxy Pool allowance only. The overall
    // active monitor limit keeps resolving through user → role → global so
    // enabling rewards never disables an administrator's global cap.
    const active = resolveLimit(limits, scopes, "active_limit");
    const freeProxy = resolveFreeProxyLimit({
        userOverride: limits.get(userLimitScope(userId))
            ?.free_proxy_active_limit,
        reward: reward.enabled
            ? { limit: reward.limit, source: reward.source }
            : null,
        roleLimit: limits.get(roleLimitScope(user.role))
            ?.free_proxy_active_limit,
        globalLimit: limits.get(GLOBAL_MONITOR_LIMIT_SCOPE)
            ?.free_proxy_active_limit,
    });

    return {
        activeLimit: active.value,
        source: active.source,
        freeProxyActiveLimit: freeProxy.limit,
        freeProxyLimitSource: freeProxy.source,
        reward:
            reward.enabled && "starred" in reward
                ? {
                      policyVersion: reward.policy.version,
                      githubConnected: reward.githubConnected,
                      githubIdentityKnown: reward.githubIdentityKnown,
                      starred: reward.starred,
                      donated: reward.donated,
                      repositoryUrl: `https://github.com/${reward.policy.repositoryOwner}/${reward.policy.repositoryName}`,
                      sponsorsUrl: `https://github.com/sponsors/${reward.policy.sponsorsLogin}`,
                      defaultLimit: reward.policy.defaultLimit,
                      starLimit: reward.policy.starLimit,
                      donationLimit: reward.policy.donationLimit,
                      starPromptTitle: reward.policy.starPromptTitle,
                      starPromptMessage: reward.policy.starPromptMessage,
                      donationPromptTitle: reward.policy.donationPromptTitle,
                      donationPromptMessage:
                          reward.policy.donationPromptMessage,
                      hardLimitTitle: reward.policy.hardLimitTitle,
                      hardLimitMessage: reward.policy.hardLimitMessage,
                  }
                : null,
    };
}

export async function getEffectiveMonitorLimit(
    userId: string,
): Promise<EffectiveMonitorLimit> {
    const limits = await getEffectiveMonitorLimits(userId);
    return { activeLimit: limits.activeLimit, source: limits.source };
}

export async function getActiveMonitorCount(
    userId: string,
    client: MonitorLimitClient = db,
) {
    return client.monitors.count({
        where: { userId, status: "active" },
    });
}

export async function getMonitorActivationState(
    userId: string,
    proxySource?: string | null,
    client: MonitorLimitClient = db,
) {
    const [limit, activeCount, freeProxyActiveCount, maintenance] =
        await Promise.all([
            getEffectiveMonitorLimits(userId, client),
            getActiveMonitorCount(userId, client),
            client.monitors.count({
                where: { userId, status: "active", proxy_source: "free" },
            }),
            getMonitorMaintenance(client),
        ]);

    const withinActiveLimit =
        limit.activeLimit === null || activeCount < limit.activeLimit;
    const withinFreeProxyLimit =
        limit.freeProxyActiveLimit === null ||
        freeProxyActiveCount < limit.freeProxyActiveLimit;

    return {
        ...limit,
        activeCount,
        freeProxyActiveCount,
        activeSlots:
            limit.activeLimit === null
                ? null
                : Math.max(limit.activeLimit - activeCount, 0),
        freeProxyActiveSlots:
            limit.freeProxyActiveLimit === null
                ? null
                : Math.max(
                      limit.freeProxyActiveLimit - freeProxyActiveCount,
                      0,
                  ),
        canActivate:
            !maintenance.enabled &&
            withinActiveLimit &&
            (proxySource !== "free" || withinFreeProxyLimit),
        maintenanceEnabled: maintenance.enabled,
        activeLimitReached: !withinActiveLimit,
        freeProxyLimitReached: proxySource === "free" && !withinFreeProxyLimit,
        freeProxyLimitReachedForAnySource: !withinFreeProxyLimit,
    };
}

export type MonitorRewardNotice = RewardLimitNotice;

export type MonitorActivationBlock = {
    code: "maintenance" | "free_proxy_limit" | "active_limit";
    title: string;
    message: string;
    freePool: {
        activeCount: number;
        limit: number;
        source: FreeProxyLimitSource;
        githubConnected: boolean;
        githubIdentityKnown: boolean;
        starred: boolean;
        donated: boolean;
        repositoryUrl: string | null;
        sponsorsUrl: string | null;
        defaultLimit: number;
        starLimit: number;
        donationLimit: number;
    } | null;
};

export function rewardNoticeAfterActivation(
    state: Awaited<ReturnType<typeof getMonitorActivationState>>,
    proxySource: string | null | undefined,
    activatedCount = 1,
): MonitorRewardNotice | null {
    if (proxySource !== "free" || !state.reward) {
        return null;
    }
    return rewardNoticeForLimitTransition({
        currentCount: state.freeProxyActiveCount,
        activatedCount,
        limit: state.freeProxyActiveLimit,
        source: state.freeProxyLimitSource,
        githubConnected: state.reward.githubConnected,
        policy: {
            ...DEFAULT_GITHUB_REWARDS_POLICY,
            version: state.reward.policyVersion,
            starLimit: state.reward.starLimit,
            donationLimit: state.reward.donationLimit,
            starPromptTitle: state.reward.starPromptTitle,
            starPromptMessage: state.reward.starPromptMessage,
            donationPromptTitle: state.reward.donationPromptTitle,
            donationPromptMessage: state.reward.donationPromptMessage,
            hardLimitTitle: state.reward.hardLimitTitle,
            hardLimitMessage: state.reward.hardLimitMessage,
        },
    });
}

export function monitorActivationErrorMessage(
    state: Awaited<ReturnType<typeof getMonitorActivationState>>,
    proxySource?: string | null,
) {
    return monitorActivationBlock(state, proxySource).message;
}

export function monitorActivationBlock(
    state: Awaited<ReturnType<typeof getMonitorActivationState>>,
    proxySource?: string | null,
): MonitorActivationBlock {
    if (state.maintenanceEnabled) {
        return {
            code: "maintenance",
            title: "Monitor starts are paused",
            message:
                "Monitors are temporarily paused while Vintrack is undergoing maintenance.",
            freePool: null,
        };
    }
    if (proxySource === "free" && state.freeProxyLimitReached) {
        const base = `Free Proxy Pool limit reached (${state.freeProxyActiveCount}/${state.freeProxyActiveLimit}).`;
        let message: string;
        if (
            state.freeProxyLimitSource === "policy_default" &&
            state.reward &&
            !state.reward.starred
        ) {
            message = `${base} Star Vintrack on GitHub to unlock ${state.reward.starLimit}.`;
        } else if (
            state.freeProxyLimitSource === "github_star" &&
            state.reward &&
            !state.reward.donated
        ) {
            message = `${base} Any GitHub Sponsors donation permanently unlocks ${state.reward.donationLimit}.`;
        } else if (state.freeProxyLimitSource === "user_override") {
            message = `${base} This limit was set by an administrator.`;
        } else {
            message = `${base} Pause another Free Pool monitor or use your own proxies.`;
        }
        return {
            code: "free_proxy_limit",
            title: "Free Proxy Pool limit reached",
            message,
            freePool: {
                activeCount: state.freeProxyActiveCount,
                limit: state.freeProxyActiveLimit ?? 0,
                source: state.freeProxyLimitSource,
                githubConnected: state.reward?.githubConnected ?? false,
                githubIdentityKnown: state.reward?.githubIdentityKnown ?? false,
                starred: state.reward?.starred ?? false,
                donated: state.reward?.donated ?? false,
                repositoryUrl: state.reward?.repositoryUrl ?? null,
                sponsorsUrl: state.reward?.sponsorsUrl ?? null,
                defaultLimit:
                    state.reward?.defaultLimit ??
                    state.freeProxyActiveLimit ??
                    0,
                starLimit:
                    state.reward?.starLimit ?? state.freeProxyActiveLimit ?? 0,
                donationLimit:
                    state.reward?.donationLimit ??
                    state.freeProxyActiveLimit ??
                    0,
            },
        };
    }
    return {
        code: "active_limit",
        title: "Active monitor limit reached",
        message: `Active monitor limit reached (${state.activeCount}/${state.activeLimit}). Pause another monitor first.`,
        freePool: null,
    };
}

export async function withMonitorActivationLock<T>(
    userId: string,
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
) {
    return db.$transaction(async (tx) => {
        await acquireGlobalMonitorActivationLock(tx);
        await tx.$queryRaw`
            SELECT pg_advisory_xact_lock(
                hashtextextended(${userId}, 0)
            )::text AS lock_result
        `;
        return operation(tx);
    });
}

export async function acquireGlobalMonitorActivationLock(
    tx: Prisma.TransactionClient,
) {
    await tx.$queryRaw`
        SELECT pg_advisory_xact_lock(
            hashtextextended(${MONITOR_MAINTENANCE_LOCK_KEY}, 0)
        )::text AS lock_result
    `;
}
