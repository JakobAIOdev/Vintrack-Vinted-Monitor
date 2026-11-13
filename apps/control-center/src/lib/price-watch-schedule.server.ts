import "server-only";

import { Prisma } from "@prisma/client";
import { getEffectivePriceWatchLimit } from "@/lib/monitor-limits";
import {
    PERSONAL_PRICE_WATCH_INTERVALS,
    SHARED_PRICE_WATCH_INTERVALS,
} from "@/lib/price-watch-config";

// The rules every path that activates or reschedules a Price Watch must apply:
// the member's slot limit, the current minimum interval, shared and per-proxy
// request capacity, and the state of the selected proxy group. The dashboard
// actions and the extension API both go through here so neither can activate a
// watch the other would refuse.

type Tx = Prisma.TransactionClient;

/** A rule the member can act on; its message is safe to show them. */
export class PriceWatchRuleError extends Error {}

type RuntimeSettings = {
    sharedMinimumSeconds: number;
    personalMinimumSeconds: number;
    sharedMaxRpm: number;
    personalMaxRpmPerProxy: number;
};

function settingNumber(
    settings: Map<string, string>,
    key: string,
    fallback: number,
) {
    const value = Number(settings.get(key));
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

async function getRuntimeSettings(tx: Tx): Promise<RuntimeSettings> {
    const rows = await tx.app_settings.findMany({
        where: {
            key: {
                in: [
                    "price_watch_shared_min_interval_seconds",
                    "price_watch_personal_min_interval_seconds",
                    "price_watch_shared_max_rpm",
                    "price_watch_personal_max_rpm_per_proxy",
                ],
            },
        },
        select: { key: true, value: true },
    });
    const values = new Map(rows.map((row) => [row.key, row.value]));
    return {
        sharedMinimumSeconds: Math.max(
            120,
            settingNumber(
                values,
                "price_watch_shared_min_interval_seconds",
                120,
            ),
        ),
        personalMinimumSeconds: Math.max(
            30,
            settingNumber(
                values,
                "price_watch_personal_min_interval_seconds",
                30,
            ),
        ),
        sharedMaxRpm: settingNumber(values, "price_watch_shared_max_rpm", 30),
        personalMaxRpmPerProxy: settingNumber(
            values,
            "price_watch_personal_max_rpm_per_proxy",
            2,
        ),
    };
}

export async function lockPriceWatchUser(tx: Tx, userId: string) {
    await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtextextended(${`price-watch:${userId}`}, 0))
    `;
    const user = await tx.user.findUnique({
        where: { id: userId },
        select: { banned_at: true },
    });
    if (!user || user.banned_at) {
        throw new PriceWatchRuleError("Member access denied");
    }
}

export async function lockPriceWatchCapacity(tx: Tx) {
    await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtextextended('price-watch:capacity', 0))
    `;
}

export async function assertPriceWatchSlot(tx: Tx, userId: string) {
    const { priceWatchLimit } = await getEffectivePriceWatchLimit(userId, tx);
    const activeCount = await tx.price_watches.count({
        where: { user_id: userId, status: "active" },
    });
    if (priceWatchLimit !== null && activeCount >= priceWatchLimit) {
        throw new PriceWatchRuleError(
            `Your active Price Watch limit is ${priceWatchLimit}. Pause or delete a watch before activating another.`,
        );
    }
}

export async function resolveSchedule(
    tx: Tx,
    input: {
        userId: string;
        targetId: bigint;
        region: string;
        proxyGroupId: number | null;
        intervalSeconds: number;
        excludeWatchId?: bigint;
    },
) {
    const runtime = await getRuntimeSettings(tx);
    const allowedIntervals = input.proxyGroupId
        ? PERSONAL_PRICE_WATCH_INTERVALS
        : SHARED_PRICE_WATCH_INTERVALS;
    const minimum = input.proxyGroupId
        ? runtime.personalMinimumSeconds
        : runtime.sharedMinimumSeconds;
    if (
        !(allowedIntervals as readonly number[]).includes(
            input.intervalSeconds,
        ) ||
        input.intervalSeconds < minimum
    ) {
        throw new PriceWatchRuleError(
            input.proxyGroupId
                ? `Personal proxy polling currently starts at ${minimum} seconds.`
                : `Shared polling currently starts at ${Math.ceil(minimum / 60)} minutes.`,
        );
    }

    let transportKey = "shared";
    let workingProxyCount = 0;
    if (input.proxyGroupId) {
        const group = await tx.proxy_groups.findFirst({
            where: { id: input.proxyGroupId, userId: input.userId },
            select: {
                id: true,
                proxy_check_status: true,
                proxy_check_region: true,
                proxy_check_working: true,
                bandwidth_limit_bytes: true,
                bandwidth_rx_bytes: true,
                bandwidth_tx_bytes: true,
            },
        });
        if (!group) throw new PriceWatchRuleError("Proxy group not found.");
        if (
            group.proxy_check_status !== "completed" ||
            group.proxy_check_region !== input.region ||
            group.proxy_check_working < 1
        ) {
            throw new PriceWatchRuleError(
                "Run a successful proxy check for this Vinted region before using the group for Price Watch.",
            );
        }
        if (
            group.bandwidth_limit_bytes !== null &&
            group.bandwidth_rx_bytes + group.bandwidth_tx_bytes >=
                group.bandwidth_limit_bytes
        ) {
            throw new PriceWatchRuleError(
                "This proxy group has reached its bandwidth limit.",
            );
        }
        workingProxyCount = group.proxy_check_working;
        transportKey = `proxy:${group.id}`;
    }

    const schedule = await tx.price_watch_schedules.upsert({
        where: {
            target_id_transport_key: {
                target_id: input.targetId,
                transport_key: transportKey,
            },
        },
        create: {
            target_id: input.targetId,
            transport_key: transportKey,
            transport_kind: input.proxyGroupId ? "proxy_group" : "shared",
            proxy_group_id: input.proxyGroupId,
        },
        update: {},
    });

    if (input.proxyGroupId) {
        const rows = await tx.$queryRaw<Array<{ rpm: number }>>`
            SELECT COALESCE(SUM(60.0 / watch.poll_interval_seconds), 0)::float8 AS rpm
            FROM price_watches watch
            JOIN price_watch_schedules schedule ON schedule.id = watch.schedule_id
            WHERE watch.status = 'active'
              AND schedule.proxy_group_id = ${input.proxyGroupId}
              AND (${input.excludeWatchId ?? BigInt(0)} = 0 OR watch.id <> ${input.excludeWatchId ?? BigInt(0)})
        `;
        const projected =
            Number(rows[0]?.rpm ?? 0) + 60 / input.intervalSeconds;
        const capacity = Math.min(
            60,
            workingProxyCount * runtime.personalMaxRpmPerProxy,
        );
        if (projected > capacity + 0.0001) {
            throw new PriceWatchRuleError(
                `This proxy group supports about ${capacity.toFixed(1)} Price Watch requests per minute. Select a slower interval or verify more proxies.`,
            );
        }
    } else {
        const totals = await tx.$queryRaw<Array<{ rpm: number }>>`
            WITH schedule_intervals AS (
                SELECT schedule.id,
                    MIN(watch.poll_interval_seconds)::float8 AS interval_seconds
                FROM price_watch_schedules schedule
                JOIN price_watches watch ON watch.schedule_id = schedule.id
                WHERE schedule.transport_kind = 'shared'
                  AND watch.status = 'active'
                  AND (${input.excludeWatchId ?? BigInt(0)} = 0 OR watch.id <> ${input.excludeWatchId ?? BigInt(0)})
                GROUP BY schedule.id
            )
            SELECT COALESCE(SUM(60.0 / interval_seconds), 0)::float8 AS rpm
            FROM schedule_intervals
        `;
        const currentForSchedule = await tx.price_watches.aggregate({
            where: {
                schedule_id: schedule.id,
                status: "active",
                ...(input.excludeWatchId
                    ? { id: { not: input.excludeWatchId } }
                    : {}),
            },
            _min: { poll_interval_seconds: true },
        });
        const oldInterval = currentForSchedule._min.poll_interval_seconds;
        const oldRate = oldInterval ? 60 / oldInterval : 0;
        const newRate =
            60 / Math.min(oldInterval ?? Infinity, input.intervalSeconds);
        const projected = Number(totals[0]?.rpm ?? 0) - oldRate + newRate;
        if (projected > runtime.sharedMaxRpm + 0.0001) {
            throw new PriceWatchRuleError(
                "Shared Price Watch capacity is currently full. Select a slower interval or use a verified personal proxy group.",
            );
        }
    }

    return schedule;
}
