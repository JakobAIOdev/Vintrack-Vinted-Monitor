import { db } from "@/lib/db";
import {
    getEffectiveMonitorLimits,
    withMonitorActivationLock,
} from "@/lib/monitor-limits";

export async function reconcileUserOwnProxyMonitorLimit(
    userId: string,
    scope: string,
    actorUserId: string | null,
) {
    return withMonitorActivationLock(userId, async (tx) => {
        const activeCount = await tx.monitors.count({
            where: { userId, status: "active", proxy_source: "group" },
        });
        if (activeCount === 0) return [];
        const { ownProxyActiveLimit } = await getEffectiveMonitorLimits(
            userId,
            tx,
        );
        if (ownProxyActiveLimit === null || activeCount <= ownProxyActiveLimit)
            return [];
        // Keep the oldest monitors; unknown creation dates sort after known dates.
        const excess = await tx.monitors.findMany({
            where: { userId, status: "active", proxy_source: "group" },
            orderBy: [
                { created_at: { sort: "asc", nulls: "last" } },
                { id: "asc" },
            ],
            skip: ownProxyActiveLimit,
            select: { id: true, name: true },
        });
        await tx.monitors.updateMany({
            where: {
                id: { in: excess.map((monitor) => monitor.id) },
                status: "active",
            },
            data: { status: "paused" },
        });
        // Audit and status changes commit together so retries cannot lose the explanation.
        await tx.audit_events.create({
            data: {
                userId: actorUserId,
                action: "member.own_proxy_limit_reconciled",
                target_type: "user",
                target_id: userId,
                status: "success",
                metadata: {
                    scope,
                    previousActiveCount: activeCount,
                    newLimit: ownProxyActiveLimit,
                    pausedMonitorIds: excess.map((monitor) => monitor.id),
                    pausedMonitorNames: excess.map((monitor) => monitor.name),
                },
            },
        });
        return excess;
    });
}

export async function reconcileAllOwnProxyMonitorLimits(actorUserId: string) {
    const users = await db.monitors.groupBy({
        by: ["userId"],
        where: { status: "active", proxy_source: "group" },
    });
    let pausedCount = 0;
    for (const { userId } of users) {
        pausedCount += (
            await reconcileUserOwnProxyMonitorLimit(
                userId,
                "own-proxy-policy-update",
                actorUserId,
            )
        ).length;
    }
    return { pausedCount };
}
