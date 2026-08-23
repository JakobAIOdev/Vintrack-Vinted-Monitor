import { db } from "@/lib/db";
import { getEffectivePriceWatchLimit } from "@/lib/monitor-limits";

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
            await tx.$executeRaw`
                SELECT pg_advisory_xact_lock(hashtextextended(${`price-watch:${userId}`}, 0))
            `;
            await tx.$executeRaw`
                SELECT pg_advisory_xact_lock(hashtextextended('price-watch:capacity', 0))
            `;
            const watch = await tx.price_watches.findFirst({
                where: { id, user_id: userId },
                select: { id: true, status: true, schedule_id: true },
            });
            if (!watch) return "missing" as const;
            if (watch.status === status) return "unchanged" as const;

            if (status === "active") {
                const { priceWatchLimit } = await getEffectivePriceWatchLimit(
                    userId,
                    tx,
                );
                const activeCount = await tx.price_watches.count({
                    where: { user_id: userId, status: "active" },
                });
                if (
                    priceWatchLimit !== null &&
                    activeCount >= priceWatchLimit
                ) {
                    return "limit" as const;
                }
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
        if (result === "limit") {
            return {
                ok: false,
                status: 409,
                message:
                    "Your active Price Watch limit is reached. Pause or delete a watch first.",
            };
        }
        return { ok: true };
    } catch {
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
