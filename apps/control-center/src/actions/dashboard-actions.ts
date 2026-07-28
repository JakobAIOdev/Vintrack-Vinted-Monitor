"use server";

import { auth } from "@/auth";
import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { isValidDiscordWebhook } from "@/lib/validation";
import { monitorStatusTelegramText, sendTelegramMessage } from "@/lib/telegram";
import { getTelegramConnection } from "@/lib/telegram-connection";
import { getMonitorActivationState } from "@/lib/monitor-limits";
import { getNextDemoMonitorExpiry } from "@/lib/demo-monitor";
import { normalizeQueryDelayMs } from "@/lib/monitor-delay";
import { normalizeQuietHours } from "@/lib/monitor-schedule";
import { logAuditEvent } from "@/lib/audit";

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
};

async function sendTelegramStatusIfConfigured(
    monitor: { name: string; userId: string; telegram_active: boolean },
    status: "started" | "paused",
) {
    if (!monitor.telegram_active) return;

    const connection = await getTelegramConnection(monitor.userId);
    if (!connection) return;
    const result = await sendTelegramMessage(
        connection.chat_id,
        monitorStatusTelegramText(monitor.name, status),
    );
    if ("error" in result) {
        console.error("Failed to send Telegram status message", result.error);
    }
}

export async function stopAllMonitors() {
    const session = await auth();
    if (!session?.user) throw new Error("Unauthorized");

    const monitorsToStop = await db.monitors.findMany({
        where: { userId: session.user.id, status: "active" },
    });

    await db.monitors.updateMany({
        where: { userId: session.user.id, status: "active" },
        data: { status: "paused" },
    });

    Promise.all(
        monitorsToStop.map(async (monitor) => {
            if (monitor.discord_webhook && monitor.webhook_active) {
                try {
                    const payload = {
                        username: "Vintrack Monitor",
                        avatar_url:
                            "https://cdn-icons-png.flaticon.com/512/8266/8266540.png",
                        embeds: [
                            {
                                title: "⏸️ Monitor Paused",
                                description: `The monitor **${monitor.name}** has been paused via Stop All.`,
                                color: 16753920,
                                footer: {
                                    text: "Vintrack • Status Update",
                                    icon_url:
                                        "https://cdn-icons-png.flaticon.com/512/8266/8266540.png",
                                },
                                timestamp: new Date().toISOString(),
                            },
                        ],
                    };

                    await fetch(monitor.discord_webhook, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(payload),
                    });
                } catch (error) {
                    console.error(
                        "Failed to send status webhook for",
                        monitor.id,
                        error,
                    );
                }
            }
            await sendTelegramStatusIfConfigured(monitor, "paused");
        }),
    ).catch(console.error);

    revalidatePath("/dashboard");
    return { success: true, message: "All monitors stopped successfully." };
}

export async function startAllMonitors() {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");
    const userId = session.user.id;

    const activationState = await getMonitorActivationState(userId);
    const availableSlots =
        activationState.activeLimit === null
            ? null
            : Math.max(
                  activationState.activeLimit - activationState.activeCount,
                  0,
              );

    if (availableSlots === 0) {
        return {
            success: true,
            startedCount: 0,
            skippedCount: await db.monitors.count({
                where: { userId: session.user.id, status: "paused" },
            }),
            startedMonitorIds: [] as number[],
            demoExpirations: {} as Record<number, string>,
            activeLimit: activationState.activeLimit,
            activeCount: activationState.activeCount,
            message: `Active monitor limit reached (${activationState.activeCount}/${activationState.activeLimit}).`,
        };
    }

    const monitorsToStart = await db.monitors.findMany({
        where: { userId: session.user.id, status: "paused" },
        orderBy: { created_at: "desc" },
        ...(availableSlots === null ? {} : { take: availableSlots }),
    });

    if (monitorsToStart.length === 0) {
        return {
            success: true,
            startedCount: 0,
            skippedCount: 0,
            startedMonitorIds: [] as number[],
            demoExpirations: {} as Record<number, string>,
            activeLimit: activationState.activeLimit,
            activeCount: activationState.activeCount,
            message: "No paused monitors to start.",
        };
    }

    const startedAt = new Date();
    const demoExpirations = Object.fromEntries(
        monitorsToStart
            .filter((monitor) => monitor.demo_expires_at)
            .map((monitor) => [
                monitor.id,
                getNextDemoMonitorExpiry(startedAt).toISOString(),
            ]),
    );
    await db.$transaction(
        monitorsToStart.map((monitor) =>
            db.monitors.update({
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
            }),
        ),
    );

    const skippedCount =
        availableSlots === null
            ? 0
            : await db.monitors.count({
                  where: { userId: session.user.id, status: "paused" },
              });

    Promise.all(
        monitorsToStart.map(async (monitor) => {
            if (monitor.discord_webhook && monitor.webhook_active) {
                try {
                    const payload = {
                        username: "Vintrack Monitor",
                        avatar_url:
                            "https://cdn-icons-png.flaticon.com/512/8266/8266540.png",
                        embeds: [
                            {
                                title: "▶️ Monitor Started",
                                description: `The monitor **${monitor.name}** has been started via Start All.`,
                                color: 3066993,
                                footer: {
                                    text: "Vintrack • Status Update",
                                    icon_url:
                                        "https://cdn-icons-png.flaticon.com/512/8266/8266540.png",
                                },
                                timestamp: new Date().toISOString(),
                            },
                        ],
                    };

                    await fetch(monitor.discord_webhook, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(payload),
                    });
                } catch (error) {
                    console.error(
                        "Failed to send status webhook for",
                        monitor.id,
                        error,
                    );
                }
            }
            await sendTelegramStatusIfConfigured(monitor, "started");
        }),
    ).catch(console.error);

    revalidatePath("/dashboard");
    return {
        success: true,
        startedCount: monitorsToStart.length,
        skippedCount,
        startedMonitorIds: monitorsToStart.map((monitor) => monitor.id),
        demoExpirations,
        activeLimit: activationState.activeLimit,
        activeCount: activationState.activeCount + monitorsToStart.length,
        message:
            skippedCount > 0
                ? `Started ${monitorsToStart.length} monitor${monitorsToStart.length === 1 ? "" : "s"}. ${skippedCount} skipped because of the active monitor limit.`
                : `Started ${monitorsToStart.length} monitor${monitorsToStart.length === 1 ? "" : "s"}.`,
    };
}

export async function toggleMonitor(id: number, currentStatus: string) {
    const session = await auth();
    if (!session?.user) throw new Error("Unauthorized");

    const newStatus = currentStatus === "active" ? "paused" : "active";
    const existing = await db.monitors.findFirst({
        where: { id, userId: session.user.id },
        select: { demo_expires_at: true },
    });
    if (!existing) throw new Error("Monitor not found");

    if (newStatus === "active") {
        const activationState = await getMonitorActivationState(
            session.user.id,
        );
        if (!activationState.canActivate) {
            throw new Error(
                `Active monitor limit reached (${activationState.activeCount}/${activationState.activeLimit}). Pause another monitor before resuming this one.`,
            );
        }
    }

    const monitor = await db.monitors.update({
        where: { id: id, userId: session.user.id },
        data: {
            status: newStatus,
            ...(newStatus === "active" && existing.demo_expires_at
                ? { demo_expires_at: getNextDemoMonitorExpiry() }
                : {}),
        },
    });

    if (monitor.discord_webhook && monitor.webhook_active) {
        try {
            const isStarting = newStatus === "active";
            const payload = {
                username: "Vintrack Monitor",
                avatar_url:
                    "https://cdn-icons-png.flaticon.com/512/8266/8266540.png",
                embeds: [
                    {
                        title: isStarting
                            ? "▶️ Monitor Started"
                            : "⏸️ Monitor Paused",
                        description: `The monitor **${monitor.name}** has been ${isStarting ? "started" : "paused"}.`,
                        color: isStarting ? 3066993 : 16753920,
                        footer: {
                            text: "Vintrack • Status Update",
                            icon_url:
                                "https://cdn-icons-png.flaticon.com/512/8266/8266540.png",
                        },
                        timestamp: new Date().toISOString(),
                    },
                ],
            };

            await fetch(monitor.discord_webhook, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });
        } catch (error) {
            console.error("Failed to send status webhook", error);
        }
    }

    await sendTelegramStatusIfConfigured(
        monitor,
        newStatus === "active" ? "started" : "paused",
    );

    revalidatePath("/dashboard");
    return {
        success: true,
        status: newStatus,
        demoExpiresAt: monitor.demo_expires_at?.toISOString() ?? null,
    };
}

export async function updateMonitorWebhook(
    monitorId: number,
    webhookUrl: string,
    webhookActive: boolean,
) {
    const session = await auth();
    if (!session?.user) throw new Error("Unauthorized");

    const urlToSave = webhookUrl.trim() === "" ? null : webhookUrl.trim();

    if (urlToSave && !isValidDiscordWebhook(urlToSave)) {
        throw new Error("Invalid Discord Webhook URL");
    }

    await db.monitors.update({
        where: { id: monitorId, userId: session.user.id },
        data: {
            discord_webhook: urlToSave,
            webhook_active: Boolean(urlToSave && webhookActive),
        },
    });

    revalidatePath("/dashboard");
    return { success: true, message: "Webhook saved successfully" };
}

export async function setMonitorWebhookStatus(
    monitorId: number,
    enabled: boolean,
) {
    const session = await auth();
    if (!session?.user) throw new Error("Unauthorized");

    await db.monitors.update({
        where: { id: monitorId, userId: session.user.id },
        data: { webhook_active: enabled },
    });

    revalidatePath("/dashboard");
    return {
        success: true,
        message: enabled ? "Webhook activated" : "Webhook deactivated",
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
        Boolean(input.telegram);
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
