"use server";

import { auth } from "@/auth";
import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { logAuditEvent } from "@/lib/audit";
import {
    isNotificationMessageStyle,
    type NotificationMessageStyle,
} from "@/lib/notification-message-style";

const API_URL = process.env.VINTED_SERVICE_URL || "http://localhost:4000";

type ApiError = { error: string };
type ApiResult<T extends object> = (T & { error?: never }) | ApiError;

type VintedAccountStatus = {
    linked: boolean;
    status?: string;
    vinted_name?: string;
    vinted_id?: number;
    domain?: string;
    linked_at?: string;
    last_check?: string;
    last_refresh_at?: string;
    last_valid_at?: string;
    invalid_reason?: string;
    has_refresh_token?: boolean;
    requires_browser_reauth?: boolean;
    has_browser_session?: boolean;
    browser_linked?: boolean;
    last_browser_sync?: string;
    has_phone_number?: boolean;
    dedupe_monitor_alerts: boolean;
};

async function apiFetch<T extends object = Record<string, unknown>>(
    path: string,
    options: RequestInit = {},
): Promise<ApiResult<T>> {
    const session = await auth();
    if (!session?.user?.id) {
        return { error: "Not authenticated" };
    }

    let res: Response;
    try {
        res = await fetch(`${API_URL}${path}`, {
            ...options,
            headers: {
                "Content-Type": "application/json",
                "X-User-ID": session.user.id,
                ...options.headers,
            },
            cache: "no-store",
        });
    } catch {
        return { error: "Vinted service unreachable" };
    }

    let data: T;
    try {
        data = (await res.json()) as T;
    } catch {
        return { error: `Request failed (${res.status})` };
    }

    if (!res.ok) {
        const errorData = data as Record<string, unknown>;
        return {
            error:
                typeof errorData.error === "string"
                    ? errorData.error
                    : `Request failed (${res.status})`,
        };
    }

    return data as T & { error?: never };
}

async function auditAccountAction(
    action: string,
    result: { error?: string },
    metadata?: Record<string, unknown>,
) {
    const session = await auth();
    await logAuditEvent({
        userId: session?.user?.id,
        action,
        targetType: "vinted_session",
        status: result.error ? "failed" : "success",
        metadata: {
            ...metadata,
            error: result.error ?? null,
        },
    });
}

export async function getAccountStatus(): Promise<VintedAccountStatus> {
    const session = await auth();
    if (!session?.user?.id) {
        return { linked: false, dedupe_monitor_alerts: false };
    }

    const settings = await db.$queryRaw<{ dedupe_monitor_alerts: boolean }[]>`
        SELECT dedupe_monitor_alerts
        FROM "User"
        WHERE id = ${session.user.id}
        LIMIT 1
    `;
    const data = await apiFetch<VintedAccountStatus>("/api/account/status");
    const dedupeMonitorAlerts = settings[0]?.dedupe_monitor_alerts ?? false;
    if ("error" in data) {
        return {
            linked: false,
            dedupe_monitor_alerts: dedupeMonitorAlerts,
        };
    }
    return {
        ...data,
        dedupe_monitor_alerts: dedupeMonitorAlerts,
    };
}

export async function updateMonitorAlertDedupe(enabled: boolean) {
    const session = await auth();
    if (!session?.user?.id) {
        return { error: "Not authenticated" };
    }

    await db.$executeRaw`
        UPDATE "User"
        SET dedupe_monitor_alerts = ${enabled}
        WHERE id = ${session.user.id}
    `;
    revalidatePath("/account");
    revalidatePath("/dashboard");
    return { success: true, dedupe_monitor_alerts: enabled };
}

async function updateNotificationMessageStyle(
    channel: "telegram" | "discord",
    style: NotificationMessageStyle,
) {
    const session = await auth();
    if (!session?.user?.id) {
        return { error: "Not authenticated" };
    }
    if (!isNotificationMessageStyle(style)) {
        return { error: "Invalid notification message style" };
    }

    await db.user.update({
        where: { id: session.user.id },
        data:
            channel === "telegram"
                ? { telegram_message_style: style }
                : { discord_message_style: style },
    });

    revalidatePath("/dashboard");
    return { success: true, style };
}

export async function updateTelegramMessageStyle(
    style: NotificationMessageStyle,
) {
    return updateNotificationMessageStyle("telegram", style);
}

export async function updateDiscordMessageStyle(
    style: NotificationMessageStyle,
) {
    return updateNotificationMessageStyle("discord", style);
}

export async function linkVintedAccount(
    accessToken: string,
    domain: string,
    refreshToken?: string,
    phoneNumber?: string,
) {
    const result = await apiFetch<{
        linked: boolean;
        vinted_name: string;
        vinted_id: number;
        domain: string;
        has_browser_session: boolean;
        browser_linked: boolean;
        last_browser_sync?: string;
        has_phone_number: boolean;
    }>("/api/account/link", {
        method: "POST",
        body: JSON.stringify({
            access_token: accessToken,
            domain,
            refresh_token: refreshToken || "",
            phone_number: phoneNumber || "",
        }),
    });
    await auditAccountAction("vinted_session.link", result, {
        domain,
        has_refresh_token: Boolean(refreshToken),
        has_phone_number: Boolean(phoneNumber),
    });
    return result;
}

export async function unlinkVintedAccount() {
    const result = await apiFetch("/api/account/unlink", {
        method: "DELETE",
    });
    await auditAccountAction("vinted_session.unlink", result);
    return result;
}

export async function updateVintedPhoneNumber(phoneNumber: string) {
    const result = await apiFetch<{
        has_phone_number: boolean;
        last_check: string;
    }>("/api/account/phone", {
        method: "POST",
        body: JSON.stringify({ phone_number: phoneNumber }),
    });
    await auditAccountAction("vinted_session.phone_update", result, {
        has_phone_number: Boolean(phoneNumber),
    });
    return result;
}

export async function updateVintedDomain(domain: string) {
    const result = await apiFetch<{
        domain: string;
        last_check: string;
    }>("/api/account/domain", {
        method: "POST",
        body: JSON.stringify({ domain }),
    });
    await auditAccountAction("vinted_session.domain_update", result, {
        domain,
    });
    return result;
}

export async function getVintedAccountInfo() {
    return apiFetch("/api/account/info");
}

export async function refreshVintedSession() {
    const result = await apiFetch("/api/account/refresh", {
        method: "POST",
    });
    await auditAccountAction("vinted_session.refresh", result);
    return result;
}

export async function likeItem(itemId: number) {
    return apiFetch("/api/items/like", {
        method: "POST",
        body: JSON.stringify({ item_id: itemId }),
    });
}

export async function unlikeItem(itemId: number) {
    return apiFetch("/api/items/unlike", {
        method: "POST",
        body: JSON.stringify({ item_id: itemId }),
    });
}
