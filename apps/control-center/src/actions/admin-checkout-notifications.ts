"use server";

import { auth } from "@/auth";
import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { logAuditEvent } from "@/lib/audit";
import {
    CHECKOUT_NOTIFICATION_SETTING_KEY,
    CHECKOUT_NOTIFICATION_PREVIEW,
    buildCheckoutNotification,
    validateCheckoutNotificationPolicy,
    type CheckoutNotificationPolicy,
} from "@/lib/checkout-notifications";
import {
    loadCheckoutNotificationPolicy,
    sendCheckoutDiscord,
    deliverCheckoutNotification,
} from "@/lib/checkout-notifications.server";

async function requireAdmin() {
    const session = await auth();
    if (!session?.user?.id || session.user.role !== "admin")
        throw new Error("Unauthorized");
    return session.user.id;
}

export async function getCheckoutNotificationsAdminState() {
    await requireAdmin();
    const [policy, recent, counts] = await Promise.all([
        loadCheckoutNotificationPolicy(),
        db.checkout_notification_deliveries.findMany({
            orderBy: { created_at: "desc" },
            take: 10,
            select: {
                id: true,
                method: true,
                outcome: true,
                status: true,
                attempts: true,
                last_error: true,
                created_at: true,
            },
        }),
        db.checkout_notification_deliveries.groupBy({
            by: ["status"],
            where: { created_at: { gte: new Date(Date.now() - 86400_000) } },
            _count: true,
        }),
    ]);
    const { webhookUrl, ...settings } = policy;
    return {
        settings,
        hasWebhook: Boolean(webhookUrl),
        recent: recent.map((row) => ({
            ...row,
            created_at: row.created_at.toISOString(),
        })),
        counts: Object.fromEntries(
            counts.map((row) => [row.status, row._count]),
        ),
    };
}

export async function saveCheckoutNotifications(
    input: CheckoutNotificationPolicy & { removeWebhook?: boolean },
) {
    const userId = await requireAdmin();
    const current = await loadCheckoutNotificationPolicy();
    if (
        typeof input?.webhookUrl !== "string" ||
        (input.removeWebhook !== undefined &&
            typeof input.removeWebhook !== "boolean")
    )
        throw new Error("Invalid webhook settings.");
    const policy = validateCheckoutNotificationPolicy({
        ...input,
        webhookUrl: input.removeWebhook
            ? ""
            : input.webhookUrl.trim() || current.webhookUrl,
    });
    await db.app_settings.upsert({
        where: { key: CHECKOUT_NOTIFICATION_SETTING_KEY },
        create: {
            key: CHECKOUT_NOTIFICATION_SETTING_KEY,
            value: JSON.stringify(policy),
        },
        update: { value: JSON.stringify(policy) },
    });
    await logAuditEvent({
        userId,
        action: "admin.checkout_notifications_updated",
        metadata: {
            enabled: policy.enabled,
            events: policy.events,
            fields: policy.fields,
            webhookConfigured: Boolean(policy.webhookUrl),
        },
    });
    revalidatePath("/admin/integrations");
    return getCheckoutNotificationsAdminState();
}

export async function testCheckoutNotifications() {
    const userId = await requireAdmin();
    const policy = await loadCheckoutNotificationPolicy();
    if (!policy.webhookUrl) throw new Error("Save a Discord webhook first.");
    const result = await sendCheckoutDiscord(
        policy.webhookUrl,
        buildCheckoutNotification(policy, CHECKOUT_NOTIFICATION_PREVIEW, true),
    );
    await logAuditEvent({
        userId,
        action: "admin.checkout_notifications_test",
        status: result.ok ? "success" : "failed",
        metadata: { error: result.error },
    });
    if (!result.ok)
        throw new Error(result.error || "Test notification failed.");
}

export async function retryCheckoutNotifications() {
    const userId = await requireAdmin();
    const policy = await loadCheckoutNotificationPolicy();
    if (!policy.enabled)
        throw new Error("Enable and save notifications first.");
    const rows = await db.checkout_notification_deliveries.findMany({
        where: {
            OR: [
                { status: { in: ["pending", "failed"] } },
                {
                    status: "sending",
                    updated_at: { lt: new Date(Date.now() - 120_000) },
                },
            ],
        },
        orderBy: { created_at: "asc" },
        take: 10,
        select: { id: true },
    });
    // Sequential delivery respects Discord's webhook rate limits.
    for (const row of rows) await deliverCheckoutNotification(row.id);
    await logAuditEvent({
        userId,
        action: "admin.checkout_notifications_retry",
        metadata: { count: rows.length },
    });
    return getCheckoutNotificationsAdminState();
}
