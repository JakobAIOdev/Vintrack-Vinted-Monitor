import { db } from "@/lib/db";
import { enqueueMonitorStatusNotification } from "@/lib/alert-outbox";
import {
    getMonitorActivationState,
    withMonitorActivationLock,
} from "@/lib/monitor-limits";
import { logAuditEvent } from "@/lib/audit";

type FreeProxyLimitPausedMonitor = {
    id: number;
    name: string;
    userId: string;
    discord_webhook: string | null;
    webhook_active: boolean;
    telegram_active: boolean;
    notifications_enabled: boolean;
};

export async function reconcileUserFreeProxyMonitorLimit(
    userId: string,
    scope: string,
    actorUserId: string | null,
) {
    const transitionKey = Date.now().toString();
    const result = await withMonitorActivationLock(userId, async (tx) => {
        const state = await getMonitorActivationState(userId, "free", tx);
        if (state.freeProxyActiveLimit === null) {
            return {
                limit: null,
                source: state.freeProxyLimitSource,
                activeBefore: state.freeProxyActiveCount,
                monitors: [] as FreeProxyLimitPausedMonitor[],
            };
        }

        const excess = Math.max(
            state.freeProxyActiveCount - state.freeProxyActiveLimit,
            0,
        );
        if (excess === 0) {
            return {
                limit: state.freeProxyActiveLimit,
                source: state.freeProxyLimitSource,
                activeBefore: state.freeProxyActiveCount,
                monitors: [] as FreeProxyLimitPausedMonitor[],
            };
        }

        const monitors = await tx.monitors.findMany({
            where: { userId, status: "active", proxy_source: "free" },
            orderBy: [
                { created_at: { sort: "desc", nulls: "last" } },
                { id: "desc" },
            ],
            take: excess,
            select: {
                id: true,
                name: true,
                userId: true,
                discord_webhook: true,
                webhook_active: true,
                telegram_active: true,
                notifications_enabled: true,
            },
        });

        if (monitors.length > 0) {
            await tx.monitors.updateMany({
                where: { id: { in: monitors.map((monitor) => monitor.id) } },
                data: { status: "paused" },
            });
            for (const monitor of monitors) {
                await enqueueMonitorStatusNotification(tx, monitor, {
                    kind: "free_proxy_limit_pause",
                    title: "Monitor paused",
                    message: `The monitor ${monitor.name} was automatically paused because the running Free Proxy Pool monitor limit is ${state.freeProxyActiveLimit}.`,
                    idempotencyKey: `free-proxy-limit:${monitor.id}:${scope}:${state.freeProxyActiveLimit}:${transitionKey}`,
                });
            }
        }

        return {
            limit: state.freeProxyActiveLimit,
            source: state.freeProxyLimitSource,
            activeBefore: state.freeProxyActiveCount,
            monitors,
        };
    });

    if (result.limit !== null && result.monitors.length > 0) {
        await logAuditEvent({
            userId: actorUserId,
            action: "member.free_proxy_limit_reconciled",
            targetType: "user",
            targetId: userId,
            metadata: {
                memberUserId: userId,
                scope,
                previousActiveCount: result.activeBefore,
                newLimit: result.limit,
                limitSource: result.source,
                pausedMonitorIds: result.monitors.map((monitor) => monitor.id),
                pausedMonitorNames: result.monitors.map(
                    (monitor) => monitor.name,
                ),
            },
        });
        await Promise.all(
            result.monitors.map((monitor) =>
                logAuditEvent({
                    userId: actorUserId,
                    action: "monitor.free_proxy_limit_paused",
                    targetType: "monitor",
                    targetId: monitor.id,
                    metadata: {
                        memberUserId: userId,
                        scope,
                        limit: result.limit,
                        reason: "free_proxy_active_limit",
                    },
                }),
            ),
        );
    }

    return result.monitors;
}

export async function reconcileFreeProxyLimitsForUsers(
    userIds: string[],
    scope: string,
    actorUserId: string | null,
) {
    let pausedCount = 0;
    const pausedMonitorIds: number[] = [];
    for (const userId of userIds) {
        const paused = await reconcileUserFreeProxyMonitorLimit(
            userId,
            scope,
            actorUserId,
        );
        pausedCount += paused.length;
        pausedMonitorIds.push(...paused.map((monitor) => monitor.id));
    }
    return { pausedCount, pausedMonitorIds };
}

export async function reconcileAllRewardEligibleUsers(scope: string) {
    // Only members with a running Free Pool monitor can be over the limit.
    // Walking every member would hold the global activation lock — which
    // serializes every monitor start/stop in the instance — far longer than
    // necessary.
    const activeFreePoolUsers = await db.monitors.groupBy({
        by: ["userId"],
        where: { status: "active", proxy_source: "free" },
    });
    const users = await db.user.findMany({
        where: {
            role: { not: "admin" },
            id: { in: activeFreePoolUsers.map((row) => row.userId) },
        },
        select: { id: true },
    });
    return reconcileFreeProxyLimitsForUsers(
        users.map((user) => user.id),
        scope,
        null,
    );
}
