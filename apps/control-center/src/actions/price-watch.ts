"use server";

import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getEffectivePriceWatchLimit } from "@/lib/monitor-limits";
import { parsePriceWatchUrl } from "@/lib/price-watch";
import { getTelegramConnection } from "@/lib/telegram-connection";
import { isValidDiscordWebhook } from "@/lib/validation";
import {
    PERSONAL_PRICE_WATCH_INTERVALS,
    SHARED_PRICE_WATCH_INTERVALS,
} from "@/lib/price-watch-config";

export type PriceWatchSettingsInput = {
    notificationsEnabled: boolean;
    discordWebhook: string;
    webhookActive: boolean;
    telegramActive: boolean;
    pollIntervalSeconds: number;
    proxyGroupId: number | null;
};

export type PriceWatchActionResult =
    | { ok: true; id?: string; message?: string }
    | { ok: false; message: string };

export type PriceWatchBulkActionResult =
    | {
          ok: true;
          changedCount: number;
          skippedCount: number;
          message: string;
      }
    | { ok: false; changedCount: number; skippedCount: number; message: string };

type Tx = Prisma.TransactionClient;

const PRICE_WATCH_TRANSACTION_OPTIONS = {
    maxWait: 5_000,
    timeout: 15_000,
} as const;

type RuntimeSettings = {
    sharedMinimumSeconds: number;
    personalMinimumSeconds: number;
    sharedMaxRpm: number;
    personalMaxRpmPerProxy: number;
};

function parseWatchId(value: string) {
    try {
        const id = BigInt(value);
        return id > BigInt(0) ? id : null;
    } catch {
        return null;
    }
}

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
        sharedMaxRpm: settingNumber(
            values,
            "price_watch_shared_max_rpm",
            30,
        ),
        personalMaxRpmPerProxy: settingNumber(
            values,
            "price_watch_personal_max_rpm_per_proxy",
            2,
        ),
    };
}

async function normalizeSettings(
    userId: string,
    input: PriceWatchSettingsInput,
) {
    const discordWebhook = input.discordWebhook.trim();
    const webhookActive = input.webhookActive && Boolean(discordWebhook);
    if (webhookActive && !isValidDiscordWebhook(discordWebhook)) {
        return {
            ok: false as const,
            message: "Enter a valid Discord webhook URL.",
        };
    }
    if (input.telegramActive) {
        const connection = await getTelegramConnection(userId);
        if (!connection) {
            return {
                ok: false as const,
                message: "Connect Telegram before enabling it for a Price Watch.",
            };
        }
    }
    if (input.notificationsEnabled && !webhookActive && !input.telegramActive) {
        return {
            ok: false as const,
            message: "Enable Discord or Telegram, or turn notifications off.",
        };
    }
    if (!Number.isInteger(input.pollIntervalSeconds)) {
        return { ok: false as const, message: "Select a valid polling interval." };
    }
    if (
        input.proxyGroupId !== null &&
        (!Number.isInteger(input.proxyGroupId) || input.proxyGroupId <= 0)
    ) {
        return { ok: false as const, message: "Select a valid proxy group." };
    }
    return {
        ok: true as const,
        value: {
            notifications_enabled: input.notificationsEnabled,
            discord_webhook: discordWebhook || null,
            webhook_active: webhookActive,
            telegram_active: input.telegramActive,
            poll_interval_seconds: input.pollIntervalSeconds,
        },
    };
}

async function lockPriceWatchUser(tx: Tx, userId: string) {
    await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtextextended(${`price-watch:${userId}`}, 0))
    `;
}

async function lockPriceWatchCapacity(tx: Tx) {
    await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtextextended('price-watch:capacity', 0))
    `;
}

async function assertPriceWatchSlot(tx: Tx, userId: string) {
    const { priceWatchLimit } = await getEffectivePriceWatchLimit(userId, tx);
    const activeCount = await tx.price_watches.count({
        where: { user_id: userId, status: "active" },
    });
    if (priceWatchLimit !== null && activeCount >= priceWatchLimit) {
        throw new Error(
            `Your active Price Watch limit is ${priceWatchLimit}. Pause or delete a watch before activating another.`,
        );
    }
}

async function resolveSchedule(
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
        throw new Error(
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
        if (!group) throw new Error("Proxy group not found.");
        if (
            group.proxy_check_status !== "completed" ||
            group.proxy_check_region !== input.region ||
            group.proxy_check_working < 1
        ) {
            throw new Error(
                "Run a successful proxy check for this Vinted region before using the group for Price Watch.",
            );
        }
        if (
            group.bandwidth_limit_bytes !== null &&
            group.bandwidth_rx_bytes + group.bandwidth_tx_bytes >=
                group.bandwidth_limit_bytes
        ) {
            throw new Error("This proxy group has reached its bandwidth limit.");
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
        const projected = Number(rows[0]?.rpm ?? 0) + 60 / input.intervalSeconds;
        const capacity = Math.min(
            60,
            workingProxyCount * runtime.personalMaxRpmPerProxy,
        );
        if (projected > capacity + 0.0001) {
            throw new Error(
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
        const newRate = 60 / Math.min(oldInterval ?? Infinity, input.intervalSeconds);
        const projected = Number(totals[0]?.rpm ?? 0) - oldRate + newRate;
        if (projected > runtime.sharedMaxRpm + 0.0001) {
            throw new Error(
                "Shared Price Watch capacity is currently full. Select a slower interval or use a verified personal proxy group.",
            );
        }
    }

    return schedule;
}

function refreshPriceWatchPages() {
    revalidatePath("/price-watches");
    revalidatePath("/dashboard");
    revalidatePath("/admin");
}

export async function createPriceWatch(
    itemUrl: string,
    settingsInput: PriceWatchSettingsInput,
): Promise<PriceWatchActionResult> {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) return { ok: false, message: "Not authenticated." };
    const parsed = parsePriceWatchUrl(itemUrl);
    if (!parsed.ok) return { ok: false, message: parsed.error };
    const settings = await normalizeSettings(userId, settingsInput);
    if (!settings.ok) return settings;

    try {
        const watch = await db.$transaction(
            async (tx) => {
                await lockPriceWatchUser(tx, userId);
                await lockPriceWatchCapacity(tx);
                const target = await tx.price_watch_targets.upsert({
                    where: {
                        region_item_id: {
                            region: parsed.value.region,
                            item_id: parsed.value.itemId,
                        },
                    },
                    create: {
                        region: parsed.value.region,
                        item_id: parsed.value.itemId,
                        canonical_url: parsed.value.canonicalUrl,
                    },
                    update: { canonical_url: parsed.value.canonicalUrl },
                });
                const existing = await tx.price_watches.findUnique({
                    where: {
                        user_id_target_id: { user_id: userId, target_id: target.id },
                    },
                });
                if (existing?.status === "active") {
                    throw new Error("You are already watching this item.");
                }
                await assertPriceWatchSlot(tx, userId);
                const schedule = await resolveSchedule(tx, {
                    userId,
                    targetId: target.id,
                    region: parsed.value.region,
                    proxyGroupId: settingsInput.proxyGroupId,
                    intervalSeconds: settings.value.poll_interval_seconds,
                    excludeWatchId: existing?.id,
                });
                const saved = existing
                    ? await tx.price_watches.update({
                          where: { id: existing.id },
                          data: {
                              ...settings.value,
                              schedule_id: schedule.id,
                              status: "active",
                              stopped_reason: null,
                              armed_at: null,
                          },
                      })
                    : await tx.price_watches.create({
                          data: {
                              user_id: userId,
                              target_id: target.id,
                              schedule_id: schedule.id,
                              ...settings.value,
                          },
                      });
                await tx.price_watch_schedules.update({
                    where: { id: schedule.id },
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
                return saved;
            },
            {
                ...PRICE_WATCH_TRANSACTION_OPTIONS,
                isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
            },
        );
        refreshPriceWatchPages();
        return { ok: true, id: watch.id.toString() };
    } catch (error) {
        return {
            ok: false,
            message:
                error instanceof Error
                    ? error.message
                    : "Failed to create the Price Watch.",
        };
    }
}

export async function updatePriceWatch(
    watchId: string,
    settingsInput: PriceWatchSettingsInput,
): Promise<PriceWatchActionResult> {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) return { ok: false, message: "Not authenticated." };
    const id = parseWatchId(watchId);
    if (!id) return { ok: false, message: "Invalid Price Watch." };
    const settings = await normalizeSettings(userId, settingsInput);
    if (!settings.ok) return settings;
    try {
        await db.$transaction(async (tx) => {
            await lockPriceWatchUser(tx, userId);
            await lockPriceWatchCapacity(tx);
            const watch = await tx.price_watches.findFirst({
                where: { id, user_id: userId },
                include: { target: { select: { id: true, region: true } } },
            });
            if (!watch) throw new Error("Price Watch not found.");
            const schedule = await resolveSchedule(tx, {
                userId,
                targetId: watch.target.id,
                region: watch.target.region,
                proxyGroupId: settingsInput.proxyGroupId,
                intervalSeconds: settings.value.poll_interval_seconds,
                excludeWatchId: watch.id,
            });
            const transportChanged = schedule.id !== watch.schedule_id;
            await tx.price_watches.update({
                where: { id: watch.id },
                data: {
                    ...settings.value,
                    schedule_id: schedule.id,
                    ...(transportChanged ? { armed_at: null } : {}),
                },
            });
            await tx.price_watch_schedules.update({
                where: { id: schedule.id },
                data: { next_check_at: new Date() },
            });
        }, PRICE_WATCH_TRANSACTION_OPTIONS);
        refreshPriceWatchPages();
        return { ok: true };
    } catch (error) {
        return {
            ok: false,
            message:
                error instanceof Error ? error.message : "Failed to update the Price Watch.",
        };
    }
}

export async function setPriceWatchStatus(
    watchId: string,
    status: "active" | "paused",
): Promise<PriceWatchActionResult> {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) return { ok: false, message: "Not authenticated." };
    const id = parseWatchId(watchId);
    if (!id) return { ok: false, message: "Invalid Price Watch." };
    try {
        await db.$transaction(async (tx) => {
            await lockPriceWatchUser(tx, userId);
            await lockPriceWatchCapacity(tx);
            const watch = await tx.price_watches.findFirst({
                where: { id, user_id: userId },
                select: {
                    id: true,
                    schedule_id: true,
                    status: true,
                    poll_interval_seconds: true,
                    target: { select: { id: true, region: true } },
                    schedule: { select: { proxy_group_id: true } },
                },
            });
            if (!watch) throw new Error("Price Watch not found.");
            if (watch.status === status) return;
            if (status === "active") {
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
                    data: { status: "active", armed_at: null, stopped_reason: null },
                });
                await tx.price_watch_schedules.update({
                    where: { id: watch.schedule_id },
                    data: {
                        availability: "pending",
                        consecutive_unavailable: 0,
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
        }, PRICE_WATCH_TRANSACTION_OPTIONS);
        refreshPriceWatchPages();
        return { ok: true };
    } catch (error) {
        return {
            ok: false,
            message:
                error instanceof Error ? error.message : "Failed to update the Price Watch.",
        };
    }
}

export async function stopAllPriceWatches(): Promise<PriceWatchBulkActionResult> {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) {
        return {
            ok: false,
            changedCount: 0,
            skippedCount: 0,
            message: "Not authenticated.",
        };
    }
    try {
        const changedCount = await db.$transaction(async (tx) => {
            await lockPriceWatchUser(tx, userId);
            await lockPriceWatchCapacity(tx);
            const result = await tx.price_watches.updateMany({
                where: { user_id: userId, status: "active" },
                data: { status: "paused", stopped_reason: null },
            });
            return result.count;
        }, PRICE_WATCH_TRANSACTION_OPTIONS);
        refreshPriceWatchPages();
        return {
            ok: true,
            changedCount,
            skippedCount: 0,
            message:
                changedCount === 0
                    ? "No active Price Watches to stop."
                    : `${changedCount} Price Watch${changedCount === 1 ? "" : "es"} stopped.`,
        };
    } catch (error) {
        return {
            ok: false,
            changedCount: 0,
            skippedCount: 0,
            message:
                error instanceof Error
                    ? error.message
                    : "Failed to stop Price Watches.",
        };
    }
}

export async function startAllPriceWatches(): Promise<PriceWatchBulkActionResult> {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) {
        return {
            ok: false,
            changedCount: 0,
            skippedCount: 0,
            message: "Not authenticated.",
        };
    }
    try {
        const result = await db.$transaction(async (tx) => {
            await lockPriceWatchUser(tx, userId);
            await lockPriceWatchCapacity(tx);

            const [{ priceWatchLimit }, activeCount, candidates] =
                await Promise.all([
                    getEffectivePriceWatchLimit(userId, tx),
                    tx.price_watches.count({
                        where: { user_id: userId, status: "active" },
                    }),
                    tx.price_watches.findMany({
                        where: {
                            user_id: userId,
                            status: { in: ["paused", "stopped"] },
                        },
                        select: {
                            id: true,
                            target_id: true,
                            schedule_id: true,
                            poll_interval_seconds: true,
                            target: { select: { region: true } },
                            schedule: { select: { proxy_group_id: true } },
                        },
                        orderBy: [{ created_at: "desc" }, { id: "desc" }],
                    }),
                ]);

            let availableSlots =
                priceWatchLimit === null
                    ? Number.POSITIVE_INFINITY
                    : Math.max(0, priceWatchLimit - activeCount);
            let changedCount = 0;
            const failures: string[] = [];

            for (const watch of candidates) {
                if (availableSlots <= 0) {
                    failures.push(
                        `Your active Price Watch limit is ${priceWatchLimit}.`,
                    );
                    break;
                }
                try {
                    const schedule = await resolveSchedule(tx, {
                        userId,
                        targetId: watch.target_id,
                        region: watch.target.region,
                        proxyGroupId: watch.schedule.proxy_group_id,
                        intervalSeconds: watch.poll_interval_seconds,
                        excludeWatchId: watch.id,
                    });
                    await tx.price_watches.update({
                        where: { id: watch.id },
                        data: {
                            schedule_id: schedule.id,
                            status: "active",
                            armed_at: null,
                            stopped_reason: null,
                        },
                    });
                    await tx.price_watch_schedules.update({
                        where: { id: schedule.id },
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
                    changedCount += 1;
                    availableSlots -= 1;
                } catch (error) {
                    failures.push(
                        error instanceof Error
                            ? error.message
                            : "A Price Watch could not be started.",
                    );
                }
            }

            return {
                changedCount,
                skippedCount: candidates.length - changedCount,
                firstFailure: failures[0] ?? null,
            };
        }, PRICE_WATCH_TRANSACTION_OPTIONS);

        refreshPriceWatchPages();
        if (result.changedCount === 0 && result.skippedCount > 0) {
            return {
                ok: false,
                changedCount: 0,
                skippedCount: result.skippedCount,
                message:
                    result.firstFailure ||
                    "No Price Watches could be started due to limits or capacity.",
            };
        }
        const skippedSuffix =
            result.skippedCount > 0
                ? ` ${result.skippedCount} skipped due to limits, capacity, or proxy health.`
                : "";
        return {
            ok: true,
            changedCount: result.changedCount,
            skippedCount: result.skippedCount,
            message:
                result.changedCount === 0
                    ? "No paused Price Watches to start."
                    : `${result.changedCount} Price Watch${result.changedCount === 1 ? "" : "es"} started.${skippedSuffix}`,
        };
    } catch (error) {
        return {
            ok: false,
            changedCount: 0,
            skippedCount: 0,
            message:
                error instanceof Error
                    ? error.message
                    : "Failed to start Price Watches.",
        };
    }
}

export async function deletePriceWatch(
    watchId: string,
): Promise<PriceWatchActionResult> {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) return { ok: false, message: "Not authenticated." };
    const id = parseWatchId(watchId);
    if (!id) return { ok: false, message: "Invalid Price Watch." };
    const deleted = await db.$transaction(
        async (tx) => {
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
        },
        PRICE_WATCH_TRANSACTION_OPTIONS,
    );
    if (!deleted) return { ok: false, message: "Price Watch not found." };
    refreshPriceWatchPages();
    return { ok: true };
}
