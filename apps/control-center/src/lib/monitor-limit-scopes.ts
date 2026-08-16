import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

export const GLOBAL_MONITOR_LIMIT_SCOPE = "global";
export const ROLE_MONITOR_LIMIT_PREFIX = "role:";
export const USER_MONITOR_LIMIT_PREFIX = "user:";

export type MonitorLimitRow = {
    scope: string;
    active_limit: number | null;
    free_proxy_active_limit: number | null;
};

export type MonitorLimitClient = Prisma.TransactionClient | typeof db;

export function roleLimitScope(role: string) {
    return `${ROLE_MONITOR_LIMIT_PREFIX}${role}`;
}

export function userLimitScope(userId: string) {
    return `${USER_MONITOR_LIMIT_PREFIX}${userId}`;
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
