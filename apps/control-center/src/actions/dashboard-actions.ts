"use server";

import { auth } from "@/auth";
import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { isValidDiscordWebhook } from "@/lib/validation";
import {
    cancelPendingMonitorNotifications,
    enqueueMonitorStatusNotification,
} from "@/lib/alert-outbox";
import { getTelegramConnection } from "@/lib/telegram-connection";
import {
    getMonitorActivationState,
    monitorActivationBlock,
    monitorActivationErrorMessage,
    rewardNoticeAfterActivation,
    withMonitorActivationLock,
} from "@/lib/monitor-limits";
import { registerRewardPromptReached } from "@/lib/github-rewards.server";
import { getNextDemoMonitorExpiry } from "@/lib/demo-monitor";
import { normalizeQueryDelayMs } from "@/lib/monitor-delay";
import { normalizeQuietHours } from "@/lib/monitor-schedule";
import { logAuditEvent } from "@/lib/audit";
import { touchDashboardActivity } from "@/lib/dashboard-activity";

export type BulkMonitorUpdateInput = {
    monitorIds: number[];
    queryDelayMs?: string;
    quietHours?: {
        enabled: boolean;
        start: string;
        end: string;
        mode: "pause" | "slow";
        delayMs: string;
        timezone: string;
    };
    discord?: {
        mode: "enable" | "disable" | "replace";
        webhookUrl?: string;
    };
    telegram?: "enable" | "disable";
    notifications?: "enable" | "disable";
};

export async function stopAllMonitors() {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");
    const userId = session.user.id;
    const transitionKey = Date.now().toString();
    await withMonitorActivationLock(userId, async (tx) => {
        const monitorsToStop = await tx.monitors.findMany({
            where: { userId, status: "active" },
        });
        await tx.monitors.updateMany({
            where: { userId, status: "active" },
            data: { status: "paused" },
        });
        for (const monitor of monitorsToStop) {
            await enqueueMonitorStatusNotification(tx, monitor, {
                kind: "monitor_paused",
                title: "Monitor paused",
                message: `The monitor ${monitor.name} was paused via Stop All.`,
                idempotencyKey: `monitor-paused:${monitor.id}:${transitionKey}`,
            });
        }
    });

    revalidatePath("/dashboard");
    return { success: true, message: "All monitors stopped successfully." };
}

export async function startAllMonitors() {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");
    const userId = session.user.id;
    const transitionKey = Date.now().toString();

    const {
        activationState,
        monitorsToStart,
        demoExpirations,
        skippedCount,
        rewardNotice,
    } = await withMonitorActivationLock(userId, async (tx) => {
        const activationState = await getMonitorActivationState(
            userId,
            undefined,
            tx,
        );
        await touchDashboardActivity(tx, userId);
        const pausedMonitors = await tx.monitors.findMany({
            where: {
                userId,
                status: { in: ["paused", "inactivity_paused"] },
            },
            orderBy: [{ created_at: "desc" }, { id: "desc" }],
        });

        let activeSlots = activationState.activeSlots;
        let freeProxySlots = activationState.freeProxyActiveSlots;
        const monitorsToStart = pausedMonitors.filter((monitor) => {
            if (activationState.maintenanceEnabled) return false;
            if (activeSlots !== null && activeSlots <= 0) return false;
            if (
                monitor.proxy_source === "free" &&
                freeProxySlots !== null &&
                freeProxySlots <= 0
            ) {
                return false;
            }

            if (activeSlots !== null) activeSlots -= 1;
            if (monitor.proxy_source === "free" && freeProxySlots !== null) {
                freeProxySlots -= 1;
            }
            return true;
        });

        const startedAt = new Date();
        const demoExpirations = Object.fromEntries(
            monitorsToStart
                .filter((monitor) => monitor.demo_expires_at)
                .map((monitor) => [
                    monitor.id,
                    getNextDemoMonitorExpiry(startedAt).toISOString(),
                ]),
        );

        for (const monitor of monitorsToStart) {
            const startedMonitor = await tx.monitors.update({
                where: { id: monitor.id, userId },
                data: {
                    status: "active",
                    ...(monitor.demo_expires_at
                        ? {
                              demo_expires_at: new Date(
                                  demoExpirations[monitor.id],
                              ),
                          }
                        : {}),
                },
            });
            await enqueueMonitorStatusNotification(tx, startedMonitor, {
                kind: "monitor_started",
                title: "Monitor started",
                message: `The monitor ${startedMonitor.name} was started via Start All.`,
                idempotencyKey: `monitor-started:${startedMonitor.id}:${transitionKey}`,
            });
        }
        const freeProxyStartedCount = monitorsToStart.filter(
            (monitor) => monitor.proxy_source === "free",
        ).length;
        const rewardNotice = rewardNoticeAfterActivation(
            activationState,
            "free",
            freeProxyStartedCount,
        );
        if (rewardNotice) {
            await registerRewardPromptReached(
                userId,
                rewardNotice.policyVersion,
                rewardNotice.promptType,
                tx,
            );
        }

        return {
            activationState,
            monitorsToStart,
            demoExpirations,
            skippedCount: pausedMonitors.length - monitorsToStart.length,
            rewardNotice,
        };
    });

    if (monitorsToStart.length === 0) {
        const freeLimitOnly =
            !activationState.activeLimitReached &&
            activationState.freeProxyActiveSlots === 0 &&
            skippedCount > 0;
        return {
            success: skippedCount === 0,
            startedCount: 0,
            skippedCount,
            startedMonitorIds: [] as number[],
            demoExpirations,
            activeLimit: activationState.activeLimit,
            activeCount: activationState.activeCount,
            block:
                skippedCount === 0
                    ? null
                    : monitorActivationBlock(
                          freeLimitOnly
                              ? {
                                    ...activationState,
                                    freeProxyLimitReached: true,
                                }
                              : activationState,
                          freeLimitOnly ? "free" : undefined,
                      ),
            message:
                skippedCount === 0
                    ? "No paused monitors to start."
                    : activationState.maintenanceEnabled
                      ? "Monitors are temporarily paused while Vintrack is undergoing maintenance."
                      : freeLimitOnly
                        ? monitorActivationErrorMessage(
                              {
                                  ...activationState,
                                  freeProxyLimitReached: true,
                              },
                              "free",
                          )
                        : `Active monitor limit reached (${activationState.activeCount}/${activationState.activeLimit}).`,
        };
    }

    revalidatePath("/dashboard");
    return {
        success: true,
        startedCount: monitorsToStart.length,
        skippedCount,
        startedMonitorIds: monitorsToStart.map((monitor) => monitor.id),
        demoExpirations,
        activeLimit: activationState.activeLimit,
        activeCount: activationState.activeCount + monitorsToStart.length,
        message: rewardNotice
            ? `${rewardNotice.title}: ${rewardNotice.message}`
            : skippedCount > 0
              ? `Started ${monitorsToStart.length} monitor${monitorsToStart.length === 1 ? "" : "s"}. ${skippedCount} skipped because of monitor limits.`
              : `Started ${monitorsToStart.length} monitor${monitorsToStart.length === 1 ? "" : "s"}.`,
    };
}

export async function toggleMonitor(id: number, currentStatus: string) {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");
    const userId = session.user.id;

    const newStatus = currentStatus === "active" ? "paused" : "active";
    if (currentStatus === "maintenance_paused") {
        throw new Error("This monitor is paused for maintenance");
    }
    const result = await withMonitorActivationLock(userId, async (tx) => {
        const existing = await tx.monitors.findFirst({
            where: { id, userId },
            select: { demo_expires_at: true, proxy_source: true },
        });
        if (!existing) throw new Error("Monitor not found");

        let activationState: Awaited<
            ReturnType<typeof getMonitorActivationState>
        > | null = null;
        if (newStatus === "active") {
            await touchDashboardActivity(tx, userId);
            activationState = await getMonitorActivationState(
                userId,
                existing.proxy_source,
                tx,
            );
            if (!activationState.canActivate) {
                return {
                    blocked: monitorActivationBlock(
                        activationState,
                        existing.proxy_source,
                    ),
                    monitor: null,
                    rewardNotice: null,
                };
            }
        }

        const monitor = await tx.monitors.update({
            where: { id: id, userId },
            data: {
                status: newStatus,
                ...(newStatus === "active" && existing.demo_expires_at
                    ? { demo_expires_at: getNextDemoMonitorExpiry() }
                    : {}),
            },
        });
        await enqueueMonitorStatusNotification(tx, monitor, {
            kind: newStatus === "active" ? "monitor_started" : "monitor_paused",
            title:
                newStatus === "active" ? "Monitor started" : "Monitor paused",
            message: `The monitor ${monitor.name} was ${newStatus === "active" ? "started" : "paused"}.`,
            idempotencyKey: `monitor-${newStatus}:${monitor.id}:${Date.now()}`,
        });
        const rewardNotice = activationState
            ? rewardNoticeAfterActivation(
                  activationState,
                  existing.proxy_source,
              )
            : null;
        if (rewardNotice) {
            await registerRewardPromptReached(
                userId,
                rewardNotice.policyVersion,
                rewardNotice.promptType,
                tx,
            );
        }
        return { blocked: null, monitor, rewardNotice };
    });

    if (result.blocked || !result.monitor) {
        return {
            success: false as const,
            status: currentStatus,
            block: result.blocked,
        };
    }

    revalidatePath("/dashboard");
    return {
        success: true as const,
        status: newStatus,
        demoExpiresAt: result.monitor.demo_expires_at?.toISOString() ?? null,
        rewardNotice: result.rewardNotice,
    };
}

export async function updateMonitorWebhook(
    monitorId: number,
    webhookUrl: string,
    webhookActive: boolean,
) {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");
    const userId = session.user.id;

    const urlToSave = webhookUrl.trim() === "" ? null : webhookUrl.trim();

    if (urlToSave && !isValidDiscordWebhook(urlToSave)) {
        throw new Error("Invalid Discord Webhook URL");
    }

    await db.$transaction(async (tx) => {
        await cancelPendingMonitorNotifications(tx, monitorId, "discord");
        await tx.monitors.update({
            where: { id: monitorId, userId },
            data: {
                discord_webhook: urlToSave,
                webhook_active: Boolean(urlToSave && webhookActive),
            },
        });
    });

    revalidatePath("/dashboard");
    return { success: true, message: "Webhook saved successfully" };
}

export async function setMonitorWebhookStatus(
    monitorId: number,
    enabled: boolean,
) {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");
    const userId = session.user.id;

    await db.$transaction(async (tx) => {
        if (!enabled) {
            await cancelPendingMonitorNotifications(tx, monitorId, "discord");
        }
        await tx.monitors.update({
            where: { id: monitorId, userId },
            data: { webhook_active: enabled },
        });
    });

    revalidatePath("/dashboard");
    return {
        success: true,
        message: enabled ? "Webhook activated" : "Webhook deactivated",
    };
}

export async function setMonitorNotificationsEnabled(
    monitorId: number,
    enabled: boolean,
) {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");
    if (!Number.isInteger(monitorId) || monitorId <= 0) {
        throw new Error("Invalid monitor");
    }
    if (typeof enabled !== "boolean") {
        throw new Error("Invalid notification status");
    }

    const monitor = await db.monitors.update({
        where: { id: monitorId, userId: session.user.id },
        data: { notifications_enabled: enabled },
        select: { id: true, notifications_enabled: true },
    });
    if (!enabled) {
        await cancelPendingMonitorNotifications(db, monitorId);
    }

    await logAuditEvent({
        userId: session.user.id,
        action: "monitor.notifications_toggled",
        targetType: "monitor",
        targetId: String(monitor.id),
        metadata: { enabled: monitor.notifications_enabled },
    });

    revalidatePath("/dashboard");
    revalidatePath(`/monitors/${monitor.id}`);
    revalidatePath(`/monitors/${monitor.id}/edit`);

    return {
        success: true,
        notificationsEnabled: monitor.notifications_enabled,
    };
}

export async function toggleTelegramStatus(
    monitorId: number,
    currentStatus: boolean,
) {
    const session = await auth();
    if (!session?.user) throw new Error("Unauthorized");

    if (!currentStatus) {
        const connection = await getTelegramConnection(session.user.id);
        if (!connection) throw new Error("Connect Telegram first");
    }

    await db.monitors.update({
        where: { id: monitorId, userId: session.user.id },
        data: { telegram_active: !currentStatus },
    });
    if (currentStatus) {
        await cancelPendingMonitorNotifications(db, monitorId, "telegram");
    }

    revalidatePath("/dashboard");
    return {
        success: true,
        message: !currentStatus ? "Telegram activated" : "Telegram deactivated",
    };
}

export async function bulkUpdateMonitors(input: BulkMonitorUpdateInput) {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");
    const userId = session.user.id;

    if (!input || !Array.isArray(input.monitorIds)) {
        throw new Error("Invalid monitor selection");
    }
    const monitorIds = Array.from(
        new Set(
            input.monitorIds.filter((id) => Number.isInteger(id) && id > 0),
        ),
    );
    if (monitorIds.length === 0) {
        throw new Error("Select at least one monitor");
    }
    if (monitorIds.length > 500) {
        throw new Error("You can update at most 500 monitors at once");
    }

    const existingMonitors = await db.monitors.findMany({
        where: { id: { in: monitorIds }, userId },
        select: {
            id: true,
            query_delay_ms: true,
            quiet_hours_enabled: true,
            quiet_hours_mode: true,
            quiet_hours_delay_ms: true,
            discord_webhook: true,
        },
    });
    if (existingMonitors.length !== monitorIds.length) {
        throw new Error("One or more selected monitors were not found");
    }

    if (
        input.queryDelayMs !== undefined &&
        typeof input.queryDelayMs !== "string"
    ) {
        throw new Error("Invalid query delay");
    }
    const queryDelayMs =
        input.queryDelayMs === undefined
            ? null
            : normalizeQueryDelayMs(input.queryDelayMs);

    if (
        queryDelayMs !== null &&
        !input.quietHours &&
        existingMonitors.some(
            (monitor) =>
                monitor.quiet_hours_enabled &&
                monitor.quiet_hours_mode === "slow" &&
                monitor.quiet_hours_delay_ms < queryDelayMs,
        )
    ) {
        throw new Error(
            "The new query delay exceeds the slow quiet-hours delay on some selected monitors. Update quiet hours in the same bulk edit.",
        );
    }

    let quietHours: ReturnType<typeof normalizeQuietHours> | null = null;
    if (input.quietHours) {
        const quietHoursForm = new FormData();
        quietHoursForm.set(
            "quiet_hours_enabled",
            String(input.quietHours.enabled),
        );
        quietHoursForm.set("quiet_hours_start", input.quietHours.start);
        quietHoursForm.set("quiet_hours_end", input.quietHours.end);
        quietHoursForm.set("quiet_hours_mode", input.quietHours.mode);
        quietHoursForm.set("quiet_hours_delay_ms", input.quietHours.delayMs);
        quietHoursForm.set("quiet_hours_timezone", input.quietHours.timezone);

        const normalDelayForValidation =
            queryDelayMs ??
            Math.max(
                ...existingMonitors.map((monitor) => monitor.query_delay_ms),
            );
        quietHours = normalizeQuietHours(
            quietHoursForm,
            normalDelayForValidation,
        );
    }

    const discordMode = input.discord?.mode;
    if (
        discordMode &&
        !["enable", "disable", "replace"].includes(discordMode)
    ) {
        throw new Error("Invalid Discord bulk action");
    }
    if (input.telegram && !["enable", "disable"].includes(input.telegram)) {
        throw new Error("Invalid Telegram bulk action");
    }
    if (
        input.notifications &&
        !["enable", "disable"].includes(input.notifications)
    ) {
        throw new Error("Invalid notifications bulk action");
    }
    const replacementWebhook =
        discordMode === "replace"
            ? input.discord?.webhookUrl?.trim() || ""
            : "";
    if (
        discordMode === "replace" &&
        !isValidDiscordWebhook(replacementWebhook)
    ) {
        throw new Error("Enter a valid Discord webhook URL");
    }
    if (
        discordMode === "enable" &&
        existingMonitors.some((monitor) => !monitor.discord_webhook)
    ) {
        throw new Error(
            "Some selected monitors have no Discord webhook. Choose Replace webhook instead.",
        );
    }

    if (input.telegram === "enable") {
        const connection = await getTelegramConnection(userId);
        if (!connection) throw new Error("Connect Telegram first");
    }

    const hasChanges =
        queryDelayMs !== null ||
        quietHours !== null ||
        Boolean(discordMode) ||
        Boolean(input.telegram) ||
        Boolean(input.notifications);
    if (!hasChanges) throw new Error("Choose at least one change");

    const updateData = {
        ...(queryDelayMs !== null ? { query_delay_ms: queryDelayMs } : {}),
        ...(quietHours
            ? {
                  quiet_hours_enabled: quietHours.enabled,
                  quiet_hours_start_minute: quietHours.startMinute,
                  quiet_hours_end_minute: quietHours.endMinute,
                  quiet_hours_mode: quietHours.mode,
                  quiet_hours_delay_ms: quietHours.delayMs,
                  quiet_hours_timezone: quietHours.timezone,
              }
            : {}),
        ...(discordMode === "enable" ? { webhook_active: true } : {}),
        ...(discordMode === "disable" ? { webhook_active: false } : {}),
        ...(discordMode === "replace"
            ? {
                  discord_webhook: replacementWebhook,
                  webhook_active: true,
              }
            : {}),
        ...(input.telegram
            ? { telegram_active: input.telegram === "enable" }
            : {}),
        ...(input.notifications
            ? { notifications_enabled: input.notifications === "enable" }
            : {}),
    };

    const updatedMonitors = await db.$transaction(async (tx) => {
        const updated = await tx.monitors.updateMany({
            where: { id: { in: monitorIds }, userId },
            data: updateData,
        });
        if (updated.count !== monitorIds.length) {
            throw new Error("Not all selected monitors could be updated");
        }

        return tx.monitors.findMany({
            where: { id: { in: monitorIds }, userId },
            select: {
                id: true,
                query_delay_ms: true,
                quiet_hours_enabled: true,
                quiet_hours_start_minute: true,
                quiet_hours_end_minute: true,
                quiet_hours_mode: true,
                quiet_hours_delay_ms: true,
                quiet_hours_timezone: true,
                discord_webhook: true,
                webhook_active: true,
                telegram_active: true,
                notifications_enabled: true,
            },
        });
    });

    await logAuditEvent({
        userId,
        action: "monitor.bulk_updated",
        targetType: "monitor",
        metadata: {
            monitorIds,
            count: monitorIds.length,
            fields: {
                queryDelay: queryDelayMs !== null,
                quietHours: quietHours !== null,
                discord: discordMode ?? null,
                telegram: input.telegram ?? null,
                notifications: input.notifications ?? null,
            },
        },
    });

    revalidatePath("/dashboard");
    for (const monitorId of monitorIds) {
        revalidatePath(`/monitors/${monitorId}`);
        revalidatePath(`/monitors/${monitorId}/edit`);
    }

    return {
        success: true,
        updatedCount: updatedMonitors.length,
        monitors: updatedMonitors,
    };
}
