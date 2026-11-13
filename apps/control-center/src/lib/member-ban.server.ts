import "server-only";

import { db } from "@/lib/db";
import { acquireGlobalMonitorActivationLock } from "@/lib/monitor-limits";

export async function changeMemberBan(
    adminUserId: string,
    userId: string,
    banned: boolean,
) {
    if (typeof banned !== "boolean" || !userId)
        throw new Error("Invalid ban request");
    if (adminUserId === userId)
        throw new Error("You cannot ban your own account");

    return db.$transaction(
        async (tx) => {
            // Use the same locks as monitor and Price Watch activation so a request
            // authenticated before the ban cannot reactivate work after it commits.
            await acquireGlobalMonitorActivationLock(tx);
            await tx.$queryRaw`
                SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 0))::text
            `;
            await tx.$executeRaw`
                SELECT pg_advisory_xact_lock(hashtextextended(${`price-watch:${userId}`}, 0))
            `;
            const admin = await tx.user.findUnique({
                where: { id: adminUserId },
                select: { role: true, banned_at: true },
            });
            if (!admin || admin.role !== "admin" || admin.banned_at) {
                throw new Error("Forbidden");
            }
            const member = await tx.user.findUnique({
                where: { id: userId },
                select: { role: true, banned_at: true },
            });
            if (!member) throw new Error("Member not found");
            if (banned && member.role === "admin") {
                throw new Error(
                    "Change this member's admin role before banning them",
                );
            }

            const bannedAt = banned ? (member.banned_at ?? new Date()) : null;
            await tx.user.update({
                where: { id: userId },
                data: { banned_at: bannedAt },
            });

            if (banned) {
                await tx.monitors.updateMany({
                    where: { userId, status: { not: "paused" } },
                    data: { status: "paused" },
                });
                await tx.price_watches.updateMany({
                    where: { user_id: userId, status: "active" },
                    data: { status: "paused", stopped_reason: "member_banned" },
                });
                await tx.monitor_account_automations.updateMany({
                    where: { monitor: { userId }, enabled: true },
                    data: { enabled: false, revision: { increment: 1 } },
                });
                await tx.alert_deliveries.updateMany({
                    where: {
                        notification: { user_id: userId },
                        status: { in: ["pending", "processing", "retrying"] },
                    },
                    data: {
                        status: "cancelled",
                        last_reason_code: "member_banned",
                        completed_at: new Date(),
                        lease_until: null,
                        claim_token: null,
                    },
                });
                await tx.session.deleteMany({ where: { userId } });
                await tx.vinted_browser_links.deleteMany({ where: { userId } });
                await tx.checkout_agent_devices.deleteMany({
                    where: { userId },
                });
                await tx.checkout_agent_jobs.updateMany({
                    where: {
                        userId,
                        state: { in: ["pending", "claimed", "running"] },
                    },
                    data: { state: "cancelled", updated_at: new Date() },
                });
                await tx.telegram_connect_codes.deleteMany({
                    where: { userId },
                });
                await tx.proxy_groups.updateMany({
                    where: {
                        userId,
                        proxy_check_status: { in: ["pending", "running"] },
                    },
                    data: {
                        proxy_check_status: "failed",
                        proxy_check_error: "Member banned",
                    },
                });
            }

            await tx.audit_events.create({
                data: {
                    userId: adminUserId,
                    action: banned
                        ? "admin.member_banned"
                        : "admin.member_unbanned",
                    status: "success",
                    target_type: "user",
                    target_id: userId,
                },
            });
            return { banned_at: bannedAt };
        },
        { timeout: 15000 },
    );
}
