import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

export const GLOBAL_MONITOR_LIMIT_SCOPE = "global";
export const ROLE_MONITOR_LIMIT_PREFIX = "role:";
export const USER_MONITOR_LIMIT_PREFIX = "user:";
export const DEFAULT_FREE_PROXY_ACTIVE_LIMIT: number | null = null;

export type MonitorLimitRow = {
    scope: string;
    active_limit: number | null;
    free_proxy_active_limit: number | null;
};

export type EffectiveMonitorLimit = {
    activeLimit: number | null;
    source: "user" | "role" | "global" | null;
};

export type EffectiveFreeProxyMonitorLimit = {
    freeProxyActiveLimit: number | null;
    freeProxyLimitSource: "user" | "role" | "global" | null;
};

type MonitorLimitClient = Prisma.TransactionClient | typeof db;

export function roleLimitScope(role: string) {
    return `${ROLE_MONITOR_LIMIT_PREFIX}${role}`;
}

export function userLimitScope(userId: string) {
    return `${USER_MONITOR_LIMIT_PREFIX}${userId}`;
}

export function normalizeMonitorLimitInput(value: FormDataEntryValue | null) {
    const raw = String(value ?? "").trim();
    if (!raw) return null;

    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 0) {
        throw new Error("Monitor limit must be empty or a non-negative number");
    }

    return parsed;
}

export async function getMonitorLimits(
    scopes: string[],
    client: MonitorLimitClient = db,
) {
    if (scopes.length === 0) return new Map<string, MonitorLimitRow>();

    const rows = await client.$queryRaw<MonitorLimitRow[]>`
        SELECT scope, active_limit, free_proxy_active_limit
        FROM "monitor_limits"
        WHERE scope IN (${Prisma.join(scopes)})
    `;

    return new Map(rows.map((row) => [row.scope, row]));
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
    const limits = await getMonitorLimits(scopes, client);
    const active = resolveLimit(limits, scopes, "active_limit");
    const freeProxy = resolveLimit(limits, scopes, "free_proxy_active_limit");

    return {
        activeLimit: active.value,
        source: active.source,
        freeProxyActiveLimit: freeProxy.value,
        freeProxyLimitSource: freeProxy.source,
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
    const [limit, activeCount, freeProxyActiveCount] = await Promise.all([
        getEffectiveMonitorLimits(userId, client),
        getActiveMonitorCount(userId, client),
        client.monitors.count({
            where: { userId, status: "active", proxy_source: "free" },
        }),
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
            withinActiveLimit &&
            (proxySource !== "free" || withinFreeProxyLimit),
        activeLimitReached: !withinActiveLimit,
        freeProxyLimitReached: proxySource === "free" && !withinFreeProxyLimit,
    };
}

export function monitorActivationErrorMessage(
    state: Awaited<ReturnType<typeof getMonitorActivationState>>,
    proxySource?: string | null,
) {
    if (proxySource === "free" && state.freeProxyLimitReached) {
        return `Free proxy monitor limit reached (${state.freeProxyActiveCount}/${state.freeProxyActiveLimit}). Pause another free proxy monitor first.`;
    }
    return `Active monitor limit reached (${state.activeCount}/${state.activeLimit}). Pause another monitor first.`;
}

export async function withMonitorActivationLock<T>(
    userId: string,
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
) {
    return db.$transaction(async (tx) => {
        await tx.$queryRaw`
            SELECT pg_advisory_xact_lock(
                hashtextextended(${userId}, 0)
            )::text AS lock_result
        `;
        return operation(tx);
    });
}
