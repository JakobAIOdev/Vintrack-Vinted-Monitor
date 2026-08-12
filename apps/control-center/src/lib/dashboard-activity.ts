import type { Prisma } from "@prisma/client";

export const DASHBOARD_ACTIVITY_THROTTLE_MS = 5 * 60 * 1000;

export async function touchDashboardActivity(
    tx: Prisma.TransactionClient,
    userId: string,
    now = new Date(),
) {
    const staleBefore = new Date(
        now.getTime() - DASHBOARD_ACTIVITY_THROTTLE_MS,
    );
    return tx.user.updateMany({
        where: {
            id: userId,
            OR: [
                { last_dashboard_seen_at: null },
                { last_dashboard_seen_at: { lt: staleBefore } },
            ],
        },
        data: { last_dashboard_seen_at: now },
    });
}
