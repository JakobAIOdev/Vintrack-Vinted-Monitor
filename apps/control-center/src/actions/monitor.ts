"use server";

import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { isValidDiscordWebhook } from "@/lib/validation";
import { monitorStatusTelegramText, sendTelegramMessage } from "@/lib/telegram";
import { getTelegramConnection } from "@/lib/telegram-connection";
import {
    DEFAULT_QUERY_DELAY_MS,
    normalizeQueryDelayMs,
} from "@/lib/monitor-delay";
import { normalizeQuietHours } from "@/lib/monitor-schedule";
import { getMonitorActivationState } from "@/lib/monitor-limits";
import { getFreeProxyPoolHealth } from "@/lib/free-proxy-health";
import { getMonitorPreset } from "@/lib/monitor-presets";
import { REGIONS } from "@/lib/regions";
import { logAuditEvent } from "@/lib/audit";
import { getNextDemoMonitorExpiry } from "@/lib/demo-monitor";
import {
    getMonitorQueryValidationError,
    normalizeMonitorQuery,
} from "@/lib/monitor-query";
import {
    getMonitorAntiKeywordsValidationError,
    normalizeMonitorAntiKeywords,
} from "@/lib/monitor-anti-keywords";

async function sendTelegramStatusIfConfigured(
    monitor: { name: string; userId: string; telegram_active: boolean },
    status: "created" | "started" | "paused",
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

async function isFreeProxyPoolAvailable(region: string) {
    void region;
    const health = await getFreeProxyPoolHealth();
    return health.enabled;
}

async function resolveMonitorProxySelection(
    userId: string,
    rawValue: string,
    region: string,
) {
    const proxyGroupRaw = rawValue?.trim() ?? "";
    const user = await db.user.findUnique({
        where: { id: userId },
        select: { role: true },
    });

    if (proxyGroupRaw === "free") {
        if (!(await isFreeProxyPoolAvailable(region))) {
            throw new Error("Free proxy pool is currently disabled");
        }
        return { proxyGroupId: null, proxySource: "free" };
    }

    if (proxyGroupRaw === "server") {
        if (user?.role !== "premium" && user?.role !== "admin") {
            throw new Error("Server proxies require a premium account");
        }
        return { proxyGroupId: null, proxySource: "server" };
    }

    if (proxyGroupRaw) {
        const pgId = parseInt(proxyGroupRaw);
        if (!Number.isInteger(pgId)) throw new Error("Invalid proxy group");

        const group = await db.proxy_groups.findFirst({
            where: { id: pgId, userId },
            select: { id: true },
        });
        if (!group) throw new Error("Invalid proxy group");
        return { proxyGroupId: pgId, proxySource: "group" };
    }

    if (user?.role === "free") {
        throw new Error("You must select a proxy group or free proxy pool");
    }

    return { proxyGroupId: null, proxySource: "server" };
}

export type CreateMonitorResult =
    | {
          ok: true;
          redirectTo: string;
          started: boolean;
          activeLimit: number | null;
      }
    | { ok: false; message: string };

export async function createMonitor(
    formData: FormData,
): Promise<CreateMonitorResult> {
    const session = await auth();
    if (!session?.user?.id) {
        throw new Error("Not logged in!");
    }
    const userId = session.user.id;

    const name = formData.get("name") as string;
    const normalizedQuery = normalizeMonitorQuery(formData.get("query"));
    const antiKeywords = normalizeMonitorAntiKeywords(
        formData.get("anti_keywords"),
    );
    const queryDelayMs = normalizeQueryDelayMs(formData.get("query_delay_ms"));
    const quietHours = normalizeQuietHours(formData, queryDelayMs);
    const priceMin = formData.get("price_min")
        ? Number(formData.get("price_min"))
        : null;
    const priceMax = formData.get("price_max")
        ? Number(formData.get("price_max"))
        : null;
    const sizeId = formData.get("size_id") as string;
    const catalogIds = (formData.get("catalog_ids") as string) || null;
    const brandIds = (formData.get("brand_ids") as string) || null;
    const colorIds = (formData.get("color_ids") as string) || null;
    const statusIds = (formData.get("status_ids") as string) || null;
    const region = (formData.get("region") as string) || "de";
    const allowedCountries =
        (formData.get("allowed_countries") as string) || null;
    const discordWebhook = (formData.get("discord_webhook") as string) || null;
    const wantsTelegramActive = formData.get("telegram_active") === "true";
    const proxyGroupRaw = formData.get("proxy_group_id") as string;
    const appliedPreset = getMonitorPreset(formData.get("preset_key"));

    const normalizedName = name?.trim() ?? "";
    const queryValidationError =
        getMonitorQueryValidationError(normalizedQuery);
    const antiKeywordsValidationError =
        getMonitorAntiKeywordsValidationError(antiKeywords);

    if (!normalizedName) return { ok: false, message: "Name is required." };
    if (normalizedName.length > 255) {
        return { ok: false, message: "Name is too long." };
    }
    if (queryValidationError) {
        return { ok: false, message: queryValidationError };
    }
    if (antiKeywordsValidationError) {
        return { ok: false, message: antiKeywordsValidationError };
    }

    const { proxyGroupId, proxySource } = await resolveMonitorProxySelection(
        userId,
        proxyGroupRaw,
        region,
    );

    const urlToSave = discordWebhook?.trim() || null;
    if (urlToSave && !isValidDiscordWebhook(urlToSave)) {
        throw new Error("Invalid Discord Webhook URL");
    }
    const telegramConnection = wantsTelegramActive
        ? await getTelegramConnection(userId)
        : null;

    const activationState = await getMonitorActivationState(userId);
    const initialStatus = activationState.canActivate ? "active" : "paused";

    const monitor = await db.$transaction(async (tx) => {
        const createdMonitor = await tx.monitors.create({
            data: {
                userId,
                name: normalizedName,
                query: normalizedQuery,
                anti_keywords: antiKeywords,
                query_delay_ms: queryDelayMs,
                quiet_hours_enabled: quietHours.enabled,
                quiet_hours_start_minute: quietHours.startMinute,
                quiet_hours_end_minute: quietHours.endMinute,
                quiet_hours_mode: quietHours.mode,
                quiet_hours_delay_ms: quietHours.delayMs,
                quiet_hours_timezone: quietHours.timezone,
                price_min: priceMin,
                price_max: priceMax,
                size_id: sizeId,
                catalog_ids: catalogIds || null,
                brand_ids: brandIds || null,
                color_ids: colorIds || null,
                status_ids: statusIds || null,
                region,
                allowed_countries: allowedCountries || null,
                discord_webhook: urlToSave,
                telegram_active: Boolean(telegramConnection),
                proxy_group_id: proxyGroupId,
                proxy_source: proxySource,
                status: initialStatus,
                webhook_active: urlToSave ? true : false,
            },
        });

        await tx.user.update({
            where: { id: userId },
            data: { monitor_onboarding_status: "completed" },
        });

        return createdMonitor;
    });

    if (appliedPreset) {
        await logAuditEvent({
            userId,
            action: "monitor.preset_created",
            targetType: "monitor",
            targetId: monitor.id,
            metadata: {
                presetKey: appliedPreset.key,
                region,
                source: "create-form",
                proxySource,
                started: initialStatus === "active",
            },
        });
    }

    if (
        initialStatus === "active" &&
        monitor.discord_webhook &&
        monitor.webhook_active
    ) {
        try {
            const payload = {
                username: "Vintrack Monitor",
                avatar_url:
                    "https://cdn-icons-png.flaticon.com/512/8266/8266540.png",
                embeds: [
                    {
                        title: "🚀 New Monitor Created & Started",
                        description: `The monitor **${monitor.name}** has been successfully created and is now active.`,
                        color: 3066993, // Green
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

    if (initialStatus === "active") {
        await sendTelegramStatusIfConfigured(monitor, "created");
    }

    revalidatePath("/dashboard");
    return {
        ok: true,
        redirectTo: `/monitors/${monitor.id}`,
        started: initialStatus === "active",
        activeLimit: activationState.activeLimit,
    };
}

export type CreatePresetMonitorResult =
    | {
          ok: true;
          redirectTo: string;
          started: boolean;
          activeLimit: number | null;
      }
    | {
          ok: false;
          code:
              | "INVALID_PRESET"
              | "INVALID_REGION"
              | "POOL_UNAVAILABLE"
              | "NOT_ELIGIBLE"
              | "CREATE_FAILED";
          message: string;
      };

export async function createPresetMonitor(input: {
    presetKey: string;
    region: string;
}): Promise<CreatePresetMonitorResult> {
    const session = await auth();
    if (!session?.user?.id) {
        throw new Error("Not logged in!");
    }
    const userId = session.user.id;

    const preset = getMonitorPreset(input.presetKey);
    if (!preset) {
        return {
            ok: false,
            code: "INVALID_PRESET",
            message: "Choose a valid monitor preset.",
        };
    }

    const region = input.region.trim().toLowerCase();
    if (!REGIONS.some((candidate) => candidate.code === region)) {
        return {
            ok: false,
            code: "INVALID_REGION",
            message: "Choose a valid Vinted region.",
        };
    }

    const freeProxy = await getFreeProxyPoolHealth();
    if (!freeProxy.enabled) {
        return {
            ok: false,
            code: "POOL_UNAVAILABLE",
            message:
                "The Free Proxy Pool is currently disabled. Set up the monitor manually.",
        };
    }

    const activationState = await getMonitorActivationState(userId);
    const initialStatus = activationState.canActivate ? "active" : "paused";
    const demoExpiresAt = getNextDemoMonitorExpiry();

    try {
        const monitor = await db.$transaction(async (tx) => {
            const existingMonitorCount = await tx.monitors.count({
                where: { userId },
            });

            if (existingMonitorCount > 0) {
                await tx.user.updateMany({
                    where: { id: userId },
                    data: { monitor_onboarding_status: "completed" },
                });
                return null;
            }

            const claim = await tx.user.updateMany({
                where: {
                    id: userId,
                    monitor_onboarding_status: {
                        in: ["pending", "dismissed"],
                    },
                },
                data: { monitor_onboarding_status: "completed" },
            });

            if (claim.count !== 1) return null;

            return tx.monitors.create({
                data: {
                    userId,
                    name: preset.name,
                    query: preset.query,
                    anti_keywords: preset.antiKeywords.join(",") || null,
                    query_delay_ms: DEFAULT_QUERY_DELAY_MS,
                    price_min: preset.priceMin,
                    price_max: preset.priceMax,
                    size_id: preset.sizeIds.join(",") || null,
                    catalog_ids: preset.catalogIds.join(",") || null,
                    brand_ids: preset.brandIds.join(","),
                    color_ids: preset.colorIds.join(",") || null,
                    status_ids: preset.statusIds.join(",") || null,
                    region,
                    allowed_countries: region,
                    discord_webhook: null,
                    webhook_active: false,
                    telegram_active: false,
                    proxy_group_id: null,
                    proxy_source: "free",
                    status: initialStatus,
                    demo_expires_at: demoExpiresAt,
                },
            });
        });

        if (!monitor) {
            return {
                ok: false,
                code: "NOT_ELIGIBLE",
                message:
                    "Quick start is only available before your first monitor. You can still use presets in Create Monitor.",
            };
        }

        await logAuditEvent({
            userId,
            action: "monitor.preset_created",
            targetType: "monitor",
            targetId: monitor.id,
            metadata: {
                presetKey: preset.key,
                region,
                source: "onboarding",
                proxySource: "free",
                started: initialStatus === "active",
                demoExpiresAt: demoExpiresAt.toISOString(),
            },
        });

        revalidatePath("/dashboard");
        return {
            ok: true,
            redirectTo: `/monitors/${monitor.id}`,
            started: initialStatus === "active",
            activeLimit: activationState.activeLimit,
        };
    } catch (error) {
        console.error("Failed to create preset monitor", error);
        return {
            ok: false,
            code: "CREATE_FAILED",
            message: "The monitor could not be created. Please try again.",
        };
    }
}

export async function dismissMonitorOnboarding() {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");

    const result = await db.user.updateMany({
        where: {
            id: session.user.id,
            monitor_onboarding_status: "pending",
        },
        data: { monitor_onboarding_status: "dismissed" },
    });

    if (result.count === 1) {
        await logAuditEvent({
            userId: session.user.id,
            action: "monitor.onboarding_dismissed",
            targetType: "user",
            targetId: session.user.id,
        });
    }

    revalidatePath("/dashboard");
    return { ok: true };
}

export async function extendDemoMonitor(id: number) {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");
    const userId = session.user.id;

    const existing = await db.monitors.findFirst({
        where: { id, userId },
        select: { id: true, status: true, demo_expires_at: true },
    });
    if (!existing) throw new Error("Monitor not found");
    if (!existing.demo_expires_at) {
        throw new Error("This monitor is no longer in demo mode");
    }

    if (existing.status !== "active") {
        const activationState = await getMonitorActivationState(userId);
        if (!activationState.canActivate) {
            throw new Error(
                `Active monitor limit reached (${activationState.activeCount}/${activationState.activeLimit}). Pause another monitor first.`,
            );
        }
    }

    const expiresAt = getNextDemoMonitorExpiry();
    await db.monitors.update({
        where: { id, userId },
        data: { status: "active", demo_expires_at: expiresAt },
    });
    await logAuditEvent({
        userId,
        action: "monitor.demo_extended",
        targetType: "monitor",
        targetId: id,
        metadata: { expiresAt: expiresAt.toISOString() },
    });

    revalidatePath("/dashboard");
    revalidatePath(`/monitors/${id}`);
    return {
        ok: true,
        status: "active" as const,
        expiresAt: expiresAt.toISOString(),
    };
}

export async function keepDemoMonitorRunning(id: number) {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");
    const userId = session.user.id;

    const existing = await db.monitors.findFirst({
        where: { id, userId },
        select: { id: true, status: true, demo_expires_at: true },
    });
    if (!existing) throw new Error("Monitor not found");
    if (!existing.demo_expires_at) {
        return { ok: true, status: existing.status, expiresAt: null };
    }

    if (existing.status !== "active") {
        const activationState = await getMonitorActivationState(userId);
        if (!activationState.canActivate) {
            throw new Error(
                `Active monitor limit reached (${activationState.activeCount}/${activationState.activeLimit}). Pause another monitor first.`,
            );
        }
    }

    await db.monitors.update({
        where: { id, userId },
        data: { status: "active", demo_expires_at: null },
    });
    await logAuditEvent({
        userId,
        action: "monitor.demo_converted",
        targetType: "monitor",
        targetId: id,
    });

    revalidatePath("/dashboard");
    revalidatePath(`/monitors/${id}`);
    return { ok: true, status: "active" as const, expiresAt: null };
}

export async function updateMonitor(id: number, formData: FormData) {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");

    const name = formData.get("name") as string;
    const normalizedQuery = normalizeMonitorQuery(formData.get("query"));
    const antiKeywords = normalizeMonitorAntiKeywords(
        formData.get("anti_keywords"),
    );
    const queryDelayMs = normalizeQueryDelayMs(formData.get("query_delay_ms"));
    const quietHours = normalizeQuietHours(formData, queryDelayMs);
    const priceMin = formData.get("price_min")
        ? Number(formData.get("price_min"))
        : null;
    const priceMax = formData.get("price_max")
        ? Number(formData.get("price_max"))
        : null;
    const sizeId = formData.get("size_id") as string;
    const catalogIds = (formData.get("catalog_ids") as string) || null;
    const brandIds = (formData.get("brand_ids") as string) || null;
    const colorIds = (formData.get("color_ids") as string) || null;
    const statusIds = (formData.get("status_ids") as string) || null;
    const region = (formData.get("region") as string) || "de";
    const allowedCountries =
        (formData.get("allowed_countries") as string) || null;
    const returnTo = (formData.get("return_to") as string) || "detail";
    const discordWebhook = (formData.get("discord_webhook") as string) || null;
    const wantsTelegramActive = formData.get("telegram_active") === "true";
    const proxyGroupRaw = formData.get("proxy_group_id") as string;

    const normalizedName = name?.trim() ?? "";
    if (!normalizedName) throw new Error("Name is required");
    if (normalizedName.length > 255) throw new Error("Name is too long");
    const queryValidationError =
        getMonitorQueryValidationError(normalizedQuery);
    if (queryValidationError) throw new Error(queryValidationError);
    const antiKeywordsValidationError =
        getMonitorAntiKeywordsValidationError(antiKeywords);
    if (antiKeywordsValidationError) {
        throw new Error(antiKeywordsValidationError);
    }

    // Verify the monitor belongs to this user
    const existing = await db.monitors.findFirst({
        where: { id, userId: session.user.id },
    });
    if (!existing) throw new Error("Monitor not found");

    const { proxyGroupId, proxySource } = await resolveMonitorProxySelection(
        session.user.id,
        proxyGroupRaw,
        region,
    );

    const urlToSave = discordWebhook?.trim() || null;
    if (urlToSave && !isValidDiscordWebhook(urlToSave)) {
        throw new Error("Invalid Discord Webhook URL");
    }
    const telegramConnection = wantsTelegramActive
        ? await getTelegramConnection(session.user.id)
        : null;

    await db.monitors.update({
        where: { id, userId: session.user.id },
        data: {
            name: normalizedName,
            query: normalizedQuery,
            anti_keywords: antiKeywords,
            query_delay_ms: queryDelayMs,
            quiet_hours_enabled: quietHours.enabled,
            quiet_hours_start_minute: quietHours.startMinute,
            quiet_hours_end_minute: quietHours.endMinute,
            quiet_hours_mode: quietHours.mode,
            quiet_hours_delay_ms: quietHours.delayMs,
            quiet_hours_timezone: quietHours.timezone,
            price_min: priceMin,
            price_max: priceMax,
            size_id: sizeId,
            catalog_ids: catalogIds || null,
            brand_ids: brandIds || null,
            color_ids: colorIds || null,
            status_ids: statusIds || null,
            region,
            allowed_countries: allowedCountries || null,
            discord_webhook: urlToSave,
            proxy_group_id: proxyGroupId,
            proxy_source: proxySource,
            webhook_active: urlToSave ? true : false,
            telegram_active: Boolean(telegramConnection),
        },
    });

    revalidatePath("/dashboard");
    revalidatePath(`/monitors/${id}`);
    revalidatePath(`/monitors/${id}/edit`);

    if (returnTo === "dashboard") {
        redirect("/dashboard");
    }

    redirect(`/monitors/${id}`);
}

export type UpdateMonitorResult =
    | { success: true; redirectTo: string }
    | { success: false; message: string };

export async function updateMonitorAndReturn(
    id: number,
    formData: FormData,
): Promise<UpdateMonitorResult> {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");

    const name = formData.get("name") as string;
    const normalizedQuery = normalizeMonitorQuery(formData.get("query"));
    const antiKeywords = normalizeMonitorAntiKeywords(
        formData.get("anti_keywords"),
    );
    const queryDelayMs = normalizeQueryDelayMs(formData.get("query_delay_ms"));
    const quietHours = normalizeQuietHours(formData, queryDelayMs);
    const priceMin = formData.get("price_min")
        ? Number(formData.get("price_min"))
        : null;
    const priceMax = formData.get("price_max")
        ? Number(formData.get("price_max"))
        : null;
    const sizeId = formData.get("size_id") as string;
    const catalogIds = (formData.get("catalog_ids") as string) || null;
    const brandIds = (formData.get("brand_ids") as string) || null;
    const colorIds = (formData.get("color_ids") as string) || null;
    const statusIds = (formData.get("status_ids") as string) || null;
    const region = (formData.get("region") as string) || "de";
    const allowedCountries =
        (formData.get("allowed_countries") as string) || null;
    const returnTo = (formData.get("return_to") as string) || "detail";
    const discordWebhook = (formData.get("discord_webhook") as string) || null;
    const wantsTelegramActive = formData.get("telegram_active") === "true";
    const proxyGroupRaw = formData.get("proxy_group_id") as string;

    const normalizedName = name?.trim() ?? "";
    const queryValidationError =
        getMonitorQueryValidationError(normalizedQuery);
    const antiKeywordsValidationError =
        getMonitorAntiKeywordsValidationError(antiKeywords);

    if (!normalizedName) {
        return { success: false, message: "Name is required." };
    }
    if (normalizedName.length > 255) {
        return { success: false, message: "Name is too long." };
    }
    if (queryValidationError) {
        return { success: false, message: queryValidationError };
    }
    if (antiKeywordsValidationError) {
        return { success: false, message: antiKeywordsValidationError };
    }

    const existing = await db.monitors.findFirst({
        where: { id, userId: session.user.id },
    });
    if (!existing) throw new Error("Monitor not found");

    const { proxyGroupId, proxySource } = await resolveMonitorProxySelection(
        session.user.id,
        proxyGroupRaw,
        region,
    );

    const urlToSave = discordWebhook?.trim() || null;
    if (urlToSave && !isValidDiscordWebhook(urlToSave)) {
        throw new Error("Invalid Discord Webhook URL");
    }
    const telegramConnection = wantsTelegramActive
        ? await getTelegramConnection(session.user.id)
        : null;

    await db.monitors.update({
        where: { id, userId: session.user.id },
        data: {
            name: normalizedName,
            query: normalizedQuery,
            anti_keywords: antiKeywords,
            query_delay_ms: queryDelayMs,
            quiet_hours_enabled: quietHours.enabled,
            quiet_hours_start_minute: quietHours.startMinute,
            quiet_hours_end_minute: quietHours.endMinute,
            quiet_hours_mode: quietHours.mode,
            quiet_hours_delay_ms: quietHours.delayMs,
            quiet_hours_timezone: quietHours.timezone,
            price_min: priceMin,
            price_max: priceMax,
            size_id: sizeId,
            catalog_ids: catalogIds || null,
            brand_ids: brandIds || null,
            color_ids: colorIds || null,
            status_ids: statusIds || null,
            region,
            allowed_countries: allowedCountries || null,
            discord_webhook: urlToSave,
            proxy_group_id: proxyGroupId,
            proxy_source: proxySource,
            webhook_active: urlToSave ? true : false,
            telegram_active: Boolean(telegramConnection),
        },
    });

    revalidatePath("/dashboard");
    revalidatePath(`/monitors/${id}`);
    revalidatePath(`/monitors/${id}/edit`);

    return {
        success: true,
        redirectTo: returnTo === "dashboard" ? "/dashboard" : `/monitors/${id}`,
    };
}

export async function toggleMonitorStatus(id: number, currentStatus: string) {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");

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
        where: { id, userId: session.user.id },
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
                        color: isStarting ? 3066993 : 16753920, // Green for start, Orange for pause
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

    revalidatePath(`/monitors/${id}`);
    revalidatePath("/dashboard");
}

export async function deleteMonitor(id: number) {
    const session = await auth();
    if (!session?.user?.id) return;

    await db.monitors.deleteMany({
        where: {
            id,
            userId: session.user.id!,
        },
    });
    revalidatePath("/dashboard");
    revalidatePath(`/monitors/${id}`);
    revalidatePath(`/monitors/${id}/edit`);
    redirect("/dashboard");
}

export async function deleteMonitorAndReturn(id: number) {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");

    await db.monitors.deleteMany({
        where: {
            id,
            userId: session.user.id,
        },
    });

    revalidatePath("/dashboard");
    revalidatePath(`/monitors/${id}`);
    revalidatePath(`/monitors/${id}/edit`);

    return { success: true };
}

export async function testDiscordWebhook(url: string) {
    if (!url || !isValidDiscordWebhook(url)) {
        return { error: "Invalid Discord Webhook URL" };
    }

    try {
        const payload = {
            username: "Vintrack Monitor",
            avatar_url:
                "https://cdn-icons-png.flaticon.com/512/8266/8266540.png",
            embeds: [
                {
                    author: {
                        name: "Vintrack notification test",
                    },
                    title: "Discord webhook connected",
                    description:
                        "New matches will arrive here with the listing image, price, size, condition, seller details, and direct links.",
                    color: 0x007782,
                    fields: [
                        {
                            name: "Delivery",
                            value: "**Ready**",
                            inline: true,
                        },
                        {
                            name: "Content",
                            value: "Structured item cards",
                            inline: true,
                        },
                    ],
                    footer: {
                        text: "Vintrack • Notifications",
                        icon_url:
                            "https://cdn-icons-png.flaticon.com/512/8266/8266540.png",
                    },
                    timestamp: new Date().toISOString(),
                },
            ],
        };

        const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });

        if (!res.ok) {
            return { error: `Discord API returned ${res.status}` };
        }

        return { success: true };
    } catch (error) {
        return {
            error:
                error instanceof Error
                    ? error.message
                    : "Failed to send webhook",
        };
    }
}
