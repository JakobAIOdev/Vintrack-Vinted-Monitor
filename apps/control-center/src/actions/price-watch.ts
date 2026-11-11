"use server";

import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getFeatureAccessForUser } from "@/lib/features.server";
import { getEffectivePriceWatchLimit } from "@/lib/monitor-limits";
import { parsePriceWatchUrl } from "@/lib/price-watch";
import { getTelegramConnection } from "@/lib/telegram-connection";
import { isValidDiscordWebhook } from "@/lib/validation";
import {
    assertPriceWatchSlot,
    lockPriceWatchCapacity,
    lockPriceWatchUser,
    resolveSchedule,
} from "@/lib/price-watch-schedule.server";

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
    | {
          ok: false;
          changedCount: number;
          skippedCount: number;
          message: string;
      };

const PRICE_WATCH_TRANSACTION_OPTIONS = {
    maxWait: 5_000,
    timeout: 15_000,
} as const;

function parseWatchId(value: string) {
    try {
        const id = BigInt(value);
        return id > BigInt(0) ? id : null;
    } catch {
        return null;
    }
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
                message:
                    "Connect Telegram before enabling it for a Price Watch.",
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
        return {
            ok: false as const,
            message: "Select a valid polling interval.",
        };
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
    const featureAccess = await getFeatureAccessForUser("price_watch", userId);
    if (!featureAccess.allowed) {
        return {
            ok: false,
            message: "Price Watch is not available for your role.",
        };
    }
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
                        user_id_target_id: {
                            user_id: userId,
                            target_id: target.id,
                        },
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
    const featureAccess = await getFeatureAccessForUser("price_watch", userId);
    if (!featureAccess.allowed) {
        return {
            ok: false,
            message: "Price Watch is not available for your role.",
        };
    }
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
                error instanceof Error
                    ? error.message
                    : "Failed to update the Price Watch.",
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
    const featureAccess = await getFeatureAccessForUser("price_watch", userId);
    if (!featureAccess.allowed) {
        return {
            ok: false,
            message: "Price Watch is not available for your role.",
        };
    }
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
                error instanceof Error
                    ? error.message
                    : "Failed to update the Price Watch.",
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
    const featureAccess = await getFeatureAccessForUser("price_watch", userId);
    if (!featureAccess.allowed) {
        return {
            ok: false,
            changedCount: 0,
            skippedCount: 0,
            message: "Price Watch is not available for your role.",
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
    const featureAccess = await getFeatureAccessForUser("price_watch", userId);
    if (!featureAccess.allowed) {
        return {
            ok: false,
            changedCount: 0,
            skippedCount: 0,
            message: "Price Watch is not available for your role.",
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
    const featureAccess = await getFeatureAccessForUser("price_watch", userId);
    if (!featureAccess.allowed) {
        return {
            ok: false,
            message: "Price Watch is not available for your role.",
        };
    }
    const id = parseWatchId(watchId);
    if (!id) return { ok: false, message: "Invalid Price Watch." };
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
    }, PRICE_WATCH_TRANSACTION_OPTIONS);
    if (!deleted) return { ok: false, message: "Price Watch not found." };
    refreshPriceWatchPages();
    return { ok: true };
}
