import { db } from "@/lib/db";
import {
    assertPriceWatchSlot,
    lockPriceWatchCapacity,
    lockPriceWatchUser,
    PriceWatchRuleError,
    resolveSchedule,
} from "@/lib/price-watch-schedule.server";

export type ExtensionPriceWatchMutationResult =
    | { ok: true }
    | { ok: false; status: number; message: string };

function parseWatchId(value: string) {
    try {
        const id = BigInt(value);
        return id > BigInt(0) ? id : null;
    } catch {
        return null;
    }
}

export async function setExtensionPriceWatchStatus(
    userId: string,
    watchId: string,
    status: "active" | "paused",
): Promise<ExtensionPriceWatchMutationResult> {
    const id = parseWatchId(watchId);
    if (!id) return { ok: false, status: 400, message: "Invalid Price Watch." };

    try {
        const result = await db.$transaction(async (tx) => {
            await lockPriceWatchUser(tx, userId);
            await lockPriceWatchCapacity(tx);
            const watch = await tx.price_watches.findFirst({
                where: { id, user_id: userId },
                select: {
                    id: true,
                    status: true,
                    schedule_id: true,
                    poll_interval_seconds: true,
                    target: { select: { id: true, region: true } },
                    schedule: { select: { proxy_group_id: true } },
                },
            });
            if (!watch) return "missing" as const;
            if (watch.status === status) return "unchanged" as const;

            if (status === "active") {
                // Same checks as activating from the dashboard: slot limit,
                // minimum interval, request capacity and proxy group state.
                await assertPriceWatchSlot(tx, userId);
                await resolveSchedule(tx, {
                    userId,
                    targetId: watch.target.id,
                    region: watch.target.region,
                    proxyGroupId: watch.schedule.proxy_group_id,
                    intervalSeconds: watch.poll_interval_seconds,
                    excludeWatchId: watch.id,
                });
                await tx.price_watches.update({
                    where: { id },
                    data: {
                        status: "active",
                        armed_at: null,
                        stopped_reason: null,
                    },
                });
                await tx.price_watch_schedules.update({
                    where: { id: watch.schedule_id },
                    data: {
                        availability: "pending",
                        consecutive_unavailable: 0,
                        consecutive_errors: 0,
                        last_error_code: null,
                        last_error_detail: null,
                        next_check_at: new Date(),
                        lease_until: null,
                        claim_token: null,
                    },
                });
            } else {
                await tx.price_watches.update({
                    where: { id },
                    data: { status: "paused", stopped_reason: null },
                });
            }
            return "changed" as const;
        });

        if (result === "missing") {
            return {
                ok: false,
                status: 404,
                message: "Price Watch not found.",
            };
        }
        return { ok: true };
    } catch (error) {
        if (error instanceof PriceWatchRuleError) {
            return { ok: false, status: 409, message: error.message };
        }
        return {
            ok: false,
            status: 500,
            message: "Failed to update the Price Watch.",
        };
    }
}

export async function deleteExtensionPriceWatch(
    userId: string,
    watchId: string,
): Promise<ExtensionPriceWatchMutationResult> {
    const id = parseWatchId(watchId);
    if (!id) return { ok: false, status: 400, message: "Invalid Price Watch." };

    try {
        const deleted = await db.$transaction(async (tx) => {
            const watch = await tx.price_watches.findFirst({
                where: { id, user_id: userId },
                select: { id: true, target_id: true, schedule_id: true },
            });
            if (!watch) return false;
            await tx.price_watches.delete({ where: { id: watch.id } });
            if (
                (await tx.price_watches.count({
                    where: { schedule_id: watch.schedule_id },
                })) === 0
            ) {
                await tx.price_watch_schedules.delete({
                    where: { id: watch.schedule_id },
                });
            }
            if (
                (await tx.price_watches.count({
                    where: { target_id: watch.target_id },
                })) === 0
            ) {
                await tx.price_watch_targets.delete({
                    where: { id: watch.target_id },
                });
            }
            return true;
        });
        return deleted
            ? { ok: true }
            : { ok: false, status: 404, message: "Price Watch not found." };
    } catch {
        return {
            ok: false,
            status: 500,
            message: "Failed to delete the Price Watch.",
        };
    }
}
