"use server";

import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { isValidDiscordWebhook } from "@/lib/validation";
import { getTelegramConnection } from "@/lib/telegram-connection";
import { enqueueMonitorStatusNotification } from "@/lib/alert-outbox";
import {
    DEFAULT_QUERY_DELAY_MS,
    normalizeQueryDelayMs,
} from "@/lib/monitor-delay";
import { normalizeQuietHours } from "@/lib/monitor-schedule";
import {
    getMonitorActivationState,
    monitorActivationErrorMessage,
    rewardNoticeAfterActivation,
    type MonitorRewardNotice,
    withMonitorActivationLock,
} from "@/lib/monitor-limits";
import { registerRewardPromptReached } from "@/lib/github-rewards.server";
import { getFreeProxyPoolHealth } from "@/lib/free-proxy-health";
import { getMonitorPreset } from "@/lib/monitor-presets";
import { REGIONS } from "@/lib/regions";
import { logAuditEvent } from "@/lib/audit";
import { getNextDemoMonitorExpiry } from "@/lib/demo-monitor";
import {
    getMonitorQueryValidationError,
    normalizeMonitorQuery,
} from "@/lib/monitor-query";
import { VIDEO_GAME_PLATFORM_CATALOG_ID } from "@/lib/video-game-platforms";
import {
    getMonitorAntiKeywordsValidationError,
    normalizeMonitorAntiKeywords,
} from "@/lib/monitor-anti-keywords";
import { touchDashboardActivity } from "@/lib/dashboard-activity";
import { normalizeSizeIdsForRegion } from "@/lib/sizes.server";

function normalizeSellerQualityFilter(formData: FormData) {
    const rawRating = String(formData.get("min_seller_rating") ?? "").trim();
    const rawCount = String(
        formData.get("min_seller_rating_count") ?? "",
    ).trim();

    if (!rawRating && !rawCount) {
        return {
            minSellerRating: null,
            minSellerRatingCount: null,
        };
    }
    if (!rawRating || !rawCount) {
        throw new Error(
            "Minimum seller rating and rating count must be enabled together.",
        );
    }

    const minSellerRating = Number(rawRating);
    const minSellerRatingCount = Number(rawCount);
    const ratingTenths = minSellerRating * 10;
    if (
        !Number.isFinite(minSellerRating) ||
        minSellerRating < 1 ||
        minSellerRating > 5 ||
        Math.abs(ratingTenths - Math.round(ratingTenths)) > 1e-9
    ) {
        throw new Error(
            "Minimum seller rating must be between 1.0 and 5.0 in 0.1 steps.",
        );
    }
    if (
        !Number.isSafeInteger(minSellerRatingCount) ||
        minSellerRatingCount < 1 ||
        minSellerRatingCount > 2_147_483_647
    ) {
        throw new Error(
            "Minimum seller rating count must be a positive whole number.",
        );
    }

    return { minSellerRating, minSellerRatingCount };
}

const MONITOR_CREATION_MAINTENANCE_MESSAGE =
    "Monitor creation is paused while Vintrack is undergoing maintenance.";

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
          pauseReason: "active-limit" | "free-proxy-limit" | null;
          rewardNotice: MonitorRewardNotice | null;
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
    const titleOnly = formData.get("title_only") === "true";
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
    const rawSizeIds = formData.get("size_id");
    const requestedCatalogIds = (formData.get("catalog_ids") as string) || null;
    const brandIds = (formData.get("brand_ids") as string) || null;
    const colorIds = (formData.get("color_ids") as string) || null;
    const statusIds = (formData.get("status_ids") as string) || null;
    const videoGamePlatformIds =
        (formData.get("video_game_platform_ids") as string) || null;
    const catalogIds = videoGamePlatformIds
        ? VIDEO_GAME_PLATFORM_CATALOG_ID
        : requestedCatalogIds;
    const region = (formData.get("region") as string) || "de";
    const allowedCountries =
        (formData.get("allowed_countries") as string) || null;
    const { minSellerRating, minSellerRatingCount } =
        normalizeSellerQualityFilter(formData);
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

    const normalizedSizeIds = await normalizeSizeIdsForRegion(
        rawSizeIds,
        region,
    );
    if (!normalizedSizeIds.ok) {
        return { ok: false, message: normalizedSizeIds.message };
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

    const creation = await withMonitorActivationLock(userId, async (tx) => {
        const activationState = await getMonitorActivationState(
            userId,
            proxySource,
            tx,
        );
        if (activationState.maintenanceEnabled) {
            return {
                monitor: null,
                activationState,
                initialStatus: null,
            };
        }
        const initialStatus = activationState.canActivate ? "active" : "paused";
        const createdMonitor = await tx.monitors.create({
            data: {
                userId,
                name: normalizedName,
                query: normalizedQuery,
                title_only: titleOnly,
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
                size_id: normalizedSizeIds.value,
                catalog_ids: catalogIds || null,
                brand_ids: brandIds || null,
                color_ids: colorIds || null,
                status_ids: statusIds || null,
                video_game_platform_ids: videoGamePlatformIds || null,
                region,
                allowed_countries: allowedCountries || null,
                min_seller_rating: minSellerRating,
                min_seller_rating_count: minSellerRatingCount,
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

        if (initialStatus === "active") {
            await enqueueMonitorStatusNotification(tx, createdMonitor, {
                kind: "monitor_created",
                title: "Monitor created and started",
                message: `The monitor ${createdMonitor.name} was created and is now active.`,
                idempotencyKey: `monitor-created:${createdMonitor.id}`,
            });
        }

        const rewardNotice =
            initialStatus === "active"
                ? rewardNoticeAfterActivation(activationState, proxySource)
                : null;
        if (rewardNotice) {
            await registerRewardPromptReached(
                userId,
                rewardNotice.policyVersion,
                rewardNotice.promptType,
                tx,
            );
        }

        return {
            monitor: createdMonitor,
            activationState,
            initialStatus,
            rewardNotice,
        };
    });

    if (!creation.monitor || !creation.initialStatus) {
        return { ok: false, message: MONITOR_CREATION_MAINTENANCE_MESSAGE };
    }
    const { monitor, activationState, initialStatus, rewardNotice } = creation;

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

    revalidatePath("/dashboard");
    return {
        ok: true,
        redirectTo: `/monitors/${monitor.id}`,
        started: initialStatus === "active",
        activeLimit: activationState.activeLimit,
        pauseReason:
            initialStatus === "active"
                ? null
                : activationState.freeProxyLimitReached
                  ? "free-proxy-limit"
                  : "active-limit",
        rewardNotice,
    };
}

export type CreatePresetMonitorResult =
    | {
          ok: true;
          redirectTo: string;
          started: boolean;
          activeLimit: number | null;
          pauseReason: "active-limit" | "free-proxy-limit" | null;
          rewardNotice: MonitorRewardNotice | null;
      }
    | {
          ok: false;
          code:
              | "INVALID_PRESET"
              | "INVALID_REGION"
              | "POOL_UNAVAILABLE"
              | "MAINTENANCE"
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

    const normalizedSizeIds = await normalizeSizeIdsForRegion(
        preset.sizeIds.join(","),
        region,
    );
    if (!normalizedSizeIds.ok) {
        return {
            ok: false,
            code: "CREATE_FAILED",
            message: normalizedSizeIds.message,
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

    const demoExpiresAt = getNextDemoMonitorExpiry();

    try {
        const { monitor, activationState, initialStatus, maintenanceBlocked } =
            await withMonitorActivationLock(userId, async (tx) => {
                const activationState = await getMonitorActivationState(
                    userId,
                    "free",
                    tx,
                );
                if (activationState.maintenanceEnabled) {
                    return {
                        monitor: null,
                        activationState,
                        initialStatus: null,
                        maintenanceBlocked: true,
                    };
                }
                const initialStatus = activationState.canActivate
                    ? "active"
                    : "paused";
                const existingMonitorCount = await tx.monitors.count({
                    where: { userId },
                });

                if (existingMonitorCount > 0) {
                    await tx.user.updateMany({
                        where: { id: userId },
                        data: { monitor_onboarding_status: "completed" },
                    });
                    return {
                        monitor: null,
                        activationState,
                        initialStatus,
                        maintenanceBlocked: false,
                    };
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

                if (claim.count !== 1) {
                    return {
                        monitor: null,
                        activationState,
                        initialStatus,
                        maintenanceBlocked: false,
                    };
                }

                const monitor = await tx.monitors.create({
                    data: {
                        userId,
                        name: preset.name,
                        query: preset.query,
                        anti_keywords: preset.antiKeywords.join(",") || null,
                        query_delay_ms: DEFAULT_QUERY_DELAY_MS,
                        price_min: preset.priceMin,
                        price_max: preset.priceMax,
                        size_id: normalizedSizeIds.value,
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
                return {
                    monitor,
                    activationState,
                    initialStatus,
                    maintenanceBlocked: false,
                };
            });

        if (maintenanceBlocked) {
            return {
                ok: false,
                code: "MAINTENANCE",
                message: MONITOR_CREATION_MAINTENANCE_MESSAGE,
            };
        }
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
            pauseReason:
                initialStatus === "active"
                    ? null
                    : activationState.freeProxyLimitReached
                      ? "free-proxy-limit"
                      : "active-limit",
            rewardNotice: null,
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

    const expiresAt = getNextDemoMonitorExpiry();
    const activation = await withMonitorActivationLock(userId, async (tx) => {
        const existing = await tx.monitors.findFirst({
            where: { id, userId },
            select: {
                id: true,
                status: true,
                demo_expires_at: true,
                proxy_source: true,
            },
        });
        if (!existing) throw new Error("Monitor not found");
        if (!existing.demo_expires_at) {
            throw new Error("This monitor is no longer in demo mode");
        }

        let activationState: Awaited<
            ReturnType<typeof getMonitorActivationState>
        > | null = null;
        if (existing.status !== "active") {
            activationState = await getMonitorActivationState(
                userId,
                existing.proxy_source,
                tx,
            );
            if (!activationState.canActivate) {
                throw new Error(
                    monitorActivationErrorMessage(
                        activationState,
                        existing.proxy_source,
                    ),
                );
            }
        }

        await tx.monitors.update({
            where: { id, userId },
            data: { status: "active", demo_expires_at: expiresAt },
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
        return { rewardNotice };
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
        rewardNotice: activation.rewardNotice,
    };
}

export async function keepDemoMonitorRunning(id: number) {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");
    const userId = session.user.id;

    const result = await withMonitorActivationLock(userId, async (tx) => {
        const existing = await tx.monitors.findFirst({
            where: { id, userId },
            select: {
                id: true,
                status: true,
                demo_expires_at: true,
                proxy_source: true,
            },
        });
        if (!existing) throw new Error("Monitor not found");
        if (!existing.demo_expires_at) {
            return { status: existing.status, changed: false };
        }

        let activationState: Awaited<
            ReturnType<typeof getMonitorActivationState>
        > | null = null;
        if (existing.status !== "active") {
            activationState = await getMonitorActivationState(
                userId,
                existing.proxy_source,
                tx,
            );
            if (!activationState.canActivate) {
                throw new Error(
                    monitorActivationErrorMessage(
                        activationState,
                        existing.proxy_source,
                    ),
                );
            }
        }

        await tx.monitors.update({
            where: { id, userId },
            data: { status: "active", demo_expires_at: null },
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
        return { status: "active", changed: true, rewardNotice };
    });
    if (!result.changed) {
        return { ok: true, status: result.status, expiresAt: null };
    }
    await logAuditEvent({
        userId,
        action: "monitor.demo_converted",
        targetType: "monitor",
        targetId: id,
    });

    revalidatePath("/dashboard");
    revalidatePath(`/monitors/${id}`);
    return {
        ok: true,
        status: "active" as const,
        expiresAt: null,
        rewardNotice: result.rewardNotice,
    };
}

export async function updateMonitor(id: number, formData: FormData) {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");
    const userId = session.user.id;

    const name = formData.get("name") as string;
    const normalizedQuery = normalizeMonitorQuery(formData.get("query"));
    const titleOnly = formData.get("title_only") === "true";
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
    const rawSizeIds = formData.get("size_id");
    const requestedCatalogIds = (formData.get("catalog_ids") as string) || null;
    const brandIds = (formData.get("brand_ids") as string) || null;
    const colorIds = (formData.get("color_ids") as string) || null;
    const statusIds = (formData.get("status_ids") as string) || null;
    const videoGamePlatformIds =
        (formData.get("video_game_platform_ids") as string) || null;
    const catalogIds = videoGamePlatformIds
        ? VIDEO_GAME_PLATFORM_CATALOG_ID
        : requestedCatalogIds;
    const region = (formData.get("region") as string) || "de";
    const allowedCountries =
        (formData.get("allowed_countries") as string) || null;
    const { minSellerRating, minSellerRatingCount } =
        normalizeSellerQualityFilter(formData);
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

    const normalizedSizeIds = await normalizeSizeIdsForRegion(
        rawSizeIds,
        region,
    );
    if (!normalizedSizeIds.ok) {
        throw new Error(normalizedSizeIds.message);
    }

    // Verify the monitor belongs to this user
    const existing = await db.monitors.findFirst({
        where: { id, userId: session.user.id },
    });
    if (!existing) throw new Error("Monitor not found");

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

    const pausedByFreeProxyLimit = await withMonitorActivationLock(
        userId,
        async (tx) => {
            const currentMonitor = await tx.monitors.findFirst({
                where: { id, userId },
                select: { status: true, proxy_source: true },
            });
            if (!currentMonitor) throw new Error("Monitor not found");

            let pauseForFreeProxyLimit = false;
            if (
                currentMonitor.status === "active" &&
                currentMonitor.proxy_source !== "free" &&
                proxySource === "free"
            ) {
                const activationState = await getMonitorActivationState(
                    userId,
                    "free",
                    tx,
                );
                pauseForFreeProxyLimit = activationState.freeProxyLimitReached;
            }

            await tx.monitors.update({
                where: { id, userId },
                data: {
                    name: normalizedName,
                    query: normalizedQuery,
                    title_only: titleOnly,
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
                    size_id: normalizedSizeIds.value,
                    catalog_ids: catalogIds || null,
                    brand_ids: brandIds || null,
                    color_ids: colorIds || null,
                    status_ids: statusIds || null,
                    video_game_platform_ids: videoGamePlatformIds || null,
                    region,
                    allowed_countries: allowedCountries || null,
                    min_seller_rating: minSellerRating,
                    min_seller_rating_count: minSellerRatingCount,
                    discord_webhook: urlToSave,
                    proxy_group_id: proxyGroupId,
                    proxy_source: proxySource,
                    webhook_active: urlToSave ? true : false,
                    telegram_active: Boolean(telegramConnection),
                    ...(pauseForFreeProxyLimit ? { status: "paused" } : {}),
                },
            });
            return pauseForFreeProxyLimit;
        },
    );

    revalidatePath("/dashboard");
    revalidatePath(`/monitors/${id}`);
    revalidatePath(`/monitors/${id}/edit`);

    if (returnTo === "dashboard") {
        redirect("/dashboard");
    }

    redirect(
        pausedByFreeProxyLimit
            ? `/monitors/${id}?paused=free-proxy-limit`
            : `/monitors/${id}`,
    );
}

export type UpdateMonitorResult =
    | {
          success: true;
          redirectTo: string;
          pausedByFreeProxyLimit: boolean;
          rewardNotice: MonitorRewardNotice | null;
      }
    | { success: false; message: string };

export async function updateMonitorAndReturn(
    id: number,
    formData: FormData,
): Promise<UpdateMonitorResult> {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");
    const userId = session.user.id;

    const name = formData.get("name") as string;
    const normalizedQuery = normalizeMonitorQuery(formData.get("query"));
    const titleOnly = formData.get("title_only") === "true";
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
    const rawSizeIds = formData.get("size_id");
    const requestedCatalogIds = (formData.get("catalog_ids") as string) || null;
    const brandIds = (formData.get("brand_ids") as string) || null;
    const colorIds = (formData.get("color_ids") as string) || null;
    const statusIds = (formData.get("status_ids") as string) || null;
    const videoGamePlatformIds =
        (formData.get("video_game_platform_ids") as string) || null;
    const catalogIds = videoGamePlatformIds
        ? VIDEO_GAME_PLATFORM_CATALOG_ID
        : requestedCatalogIds;
    const region = (formData.get("region") as string) || "de";
    const allowedCountries =
        (formData.get("allowed_countries") as string) || null;
    const { minSellerRating, minSellerRatingCount } =
        normalizeSellerQualityFilter(formData);
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

    const normalizedSizeIds = await normalizeSizeIdsForRegion(
        rawSizeIds,
        region,
    );
    if (!normalizedSizeIds.ok) {
        return { success: false, message: normalizedSizeIds.message };
    }

    const existing = await db.monitors.findFirst({
        where: { id, userId: session.user.id },
    });
    if (!existing) throw new Error("Monitor not found");

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

    const updateResult = await withMonitorActivationLock(userId, async (tx) => {
        const currentMonitor = await tx.monitors.findFirst({
            where: { id, userId },
            select: { status: true, proxy_source: true },
        });
        if (!currentMonitor) throw new Error("Monitor not found");

        let pauseForFreeProxyLimit = false;
        let rewardNotice: MonitorRewardNotice | null = null;
        if (
            currentMonitor.status === "active" &&
            currentMonitor.proxy_source !== "free" &&
            proxySource === "free"
        ) {
            const activationState = await getMonitorActivationState(
                userId,
                "free",
                tx,
            );
            pauseForFreeProxyLimit = activationState.freeProxyLimitReached;
            if (!pauseForFreeProxyLimit) {
                rewardNotice = rewardNoticeAfterActivation(
                    activationState,
                    "free",
                );
            }
        }

        await tx.monitors.update({
            where: { id, userId },
            data: {
                name: normalizedName,
                query: normalizedQuery,
                title_only: titleOnly,
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
                size_id: normalizedSizeIds.value,
                catalog_ids: catalogIds || null,
                brand_ids: brandIds || null,
                color_ids: colorIds || null,
                status_ids: statusIds || null,
                video_game_platform_ids: videoGamePlatformIds || null,
                region,
                allowed_countries: allowedCountries || null,
                min_seller_rating: minSellerRating,
                min_seller_rating_count: minSellerRatingCount,
                discord_webhook: urlToSave,
                proxy_group_id: proxyGroupId,
                proxy_source: proxySource,
                webhook_active: urlToSave ? true : false,
                telegram_active: Boolean(telegramConnection),
                ...(pauseForFreeProxyLimit ? { status: "paused" } : {}),
            },
        });
        if (rewardNotice) {
            await registerRewardPromptReached(
                userId,
                rewardNotice.policyVersion,
                rewardNotice.promptType,
                tx,
            );
        }
        return { pausedByFreeProxyLimit: pauseForFreeProxyLimit, rewardNotice };
    });

    revalidatePath("/dashboard");
    revalidatePath(`/monitors/${id}`);
    revalidatePath(`/monitors/${id}/edit`);

    return {
        success: true,
        redirectTo:
            returnTo === "dashboard"
                ? "/dashboard"
                : updateResult.pausedByFreeProxyLimit
                  ? `/monitors/${id}?paused=free-proxy-limit`
                  : `/monitors/${id}`,
        pausedByFreeProxyLimit: updateResult.pausedByFreeProxyLimit,
        rewardNotice: updateResult.rewardNotice,
    };
}

export async function toggleMonitorStatus(id: number, currentStatus: string) {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");
    const userId = session.user.id;

    const newStatus = currentStatus === "active" ? "paused" : "active";
    if (currentStatus === "maintenance_paused") {
        throw new Error("This monitor is paused for maintenance");
    }
    await withMonitorActivationLock(userId, async (tx) => {
        const existing = await tx.monitors.findFirst({
            where: { id, userId },
            select: { demo_expires_at: true, proxy_source: true },
        });
        if (!existing) throw new Error("Monitor not found");

        if (newStatus === "active") {
            await touchDashboardActivity(tx, userId);
            const activationState = await getMonitorActivationState(
                userId,
                existing.proxy_source,
                tx,
            );
            if (!activationState.canActivate) {
                throw new Error(
                    monitorActivationErrorMessage(
                        activationState,
                        existing.proxy_source,
                    ),
                );
            }
        }

        const monitor = await tx.monitors.update({
            where: { id, userId },
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
        return monitor;
    });

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
