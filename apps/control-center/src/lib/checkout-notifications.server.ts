import "server-only";

import { createHash } from "node:crypto";
import { after } from "next/server";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import {
    checkoutDomain,
    isCheckoutUrl,
    isCheckoutPreferences,
    CHECKOUT_PAYMENT_LABELS,
    type CheckoutPreferences,
} from "@/lib/checkout";
import {
    buildCheckoutNotification,
    filterStoredCheckoutNotification,
    CHECKOUT_NOTIFICATION_SETTING_KEY,
    CHECKOUT_OUTCOMES,
    DEFAULT_CHECKOUT_NOTIFICATION_POLICY,
    validateCheckoutNotificationPolicy,
    type CheckoutNotificationPolicy,
    type CheckoutNotificationPayload,
    type CheckoutNotificationEvent,
} from "@/lib/checkout-notifications";

export async function loadCheckoutNotificationPolicy(): Promise<CheckoutNotificationPolicy> {
    const row = await db.app_settings.findUnique({
        where: { key: CHECKOUT_NOTIFICATION_SETTING_KEY },
    });
    if (!row) return { ...DEFAULT_CHECKOUT_NOTIFICATION_POLICY };
    // Fail closed if the saved document is malformed.
    return validateCheckoutNotificationPolicy(JSON.parse(row.value));
}

export type CheckoutNotificationReport = {
    userId: string;
    itemId: unknown;
    transactionId: unknown;
    purchaseId: unknown;
    status: unknown;
    method?: "oneclick" | "full_checkout";
    payment?: CheckoutPreferences["payment"];
    domain?: string;
    monitorId?: number;
    browserReported?: boolean;
    checkoutUrl?: unknown;
};

export function checkoutNotificationIdentity(
    report: CheckoutNotificationReport,
    domain: string,
) {
    if (
        !Number.isSafeInteger(report.itemId) ||
        Number(report.itemId) <= 0 ||
        typeof report.status !== "string" ||
        !Object.hasOwn(CHECKOUT_OUTCOMES, report.status)
    )
        return null;
    const purchase =
        typeof report.purchaseId === "string" &&
        /^[a-zA-Z0-9_-]{1,128}$/.test(report.purchaseId)
            ? report.purchaseId
            : "";
    const transaction =
        Number.isSafeInteger(report.transactionId) &&
        Number(report.transactionId) > 0
            ? String(report.transactionId)
            : "";
    if (!purchase && !transaction) return null;
    // One activity message and, if later observed, one confirmed purchase.
    // Reopening a cached checkout must not generate another notification.
    const category = CHECKOUT_OUTCOMES[report.status].confirmed
        ? "confirmed"
        : "activity";
    return createHash("sha256")
        .update(
            JSON.stringify([
                report.userId,
                domain,
                report.itemId,
                purchase || transaction,
                category,
            ]),
        )
        .digest("hex");
}

export async function queueCheckoutNotification(
    report: CheckoutNotificationReport,
) {
    try {
        const policy = await loadCheckoutNotificationPolicy();
        if (
            !policy.enabled ||
            typeof report.status !== "string" ||
            !Object.hasOwn(CHECKOUT_OUTCOMES, report.status) ||
            (policy.events === "confirmed" &&
                !CHECKOUT_OUTCOMES[report.status].confirmed)
        )
            return;
        const account = await db.vinted_sessions.findUnique({
            where: { userId: report.userId },
            select: { domain: true, vinted_name: true, vinted_user_id: true },
        });
        const domain = checkoutDomain(report.domain || account?.domain || "");
        if (!domain || !account || checkoutDomain(account.domain) !== domain)
            return;
        const id = checkoutNotificationIdentity(report, domain);
        if (!id) return;
        if (!CHECKOUT_OUTCOMES[report.status].confirmed) {
            const confirmedId = checkoutNotificationIdentity(
                { ...report, status: "card_payment_confirmed" },
                domain,
            )!;
            if (
                await db.checkout_notification_deliveries.findUnique({
                    where: { id: confirmedId },
                    select: { id: true },
                })
            )
                return;
        }
        if (report.browserReported) {
            if (!isCheckoutUrl(report.checkoutUrl, domain)) return;
            const url = new URL(report.checkoutUrl);
            if (
                url.searchParams.get("purchase_id") !== report.purchaseId ||
                url.searchParams.get("order_id") !==
                    String(report.transactionId)
            )
                return;
        }
        const user = await db.user.findUnique({
            where: { id: report.userId },
            select: { name: true, checkout_preferences: true },
        });
        const stored = user?.checkout_preferences as {
            accountId?: unknown;
            domain?: unknown;
            preferences?: CheckoutPreferences;
        } | null;
        const preferences =
            stored?.accountId === Number(account.vinted_user_id) &&
            stored?.domain === domain &&
            isCheckoutPreferences(stored.preferences)
                ? stored.preferences
                : undefined;
        const item =
            report.browserReported ||
            policy.fields.some((field) =>
                ["item", "image", "price"].includes(field),
            )
                ? await db.items.findFirst({
                      where: {
                          id: BigInt(Number(report.itemId)),
                          ...(report.monitorId
                              ? { monitor_id: report.monitorId }
                              : {}),
                          monitors: { userId: report.userId },
                      },
                      select: { title: true, image_url: true, price: true },
                      orderBy: { found_at: "desc" },
                  })
                : null;
        if (report.browserReported && !item) return;
        const payment = report.payment || preferences?.payment || "vinted";
        const event: CheckoutNotificationEvent = {
            method:
                report.method ||
                (preferences?.autoCheckout ? "full_checkout" : "oneclick"),
            status: report.status,
            payment: CHECKOUT_PAYMENT_LABELS[payment],
            region:
                domain === "www.vinted.co.uk"
                    ? "UK"
                    : domain === "www.vinted.com"
                      ? "US"
                      : domain.split(".").at(-1)!.toUpperCase(),
            item: item?.title,
            image: item?.image_url,
            price: item?.price,
            link: `https://${domain}/items/${report.itemId}`,
            user: `${user?.name || "Member"} (${report.userId})`,
            account: account.vinted_name,
        };
        try {
            await db.checkout_notification_deliveries.create({
                data: {
                    id,
                    method: event.method,
                    outcome: event.status,
                    payload: buildCheckoutNotification(policy, event),
                },
            });
        } catch (error) {
            if (
                error instanceof Prisma.PrismaClientKnownRequestError &&
                error.code === "P2002"
            )
                return;
            throw error;
        }
        after(() => deliverCheckoutNotification(id));
    } catch {
        // Notification failures cannot turn a completed checkout into an error.
        console.error("[checkout-notifications] Could not queue notification");
    }
}

export async function sendCheckoutDiscord(
    webhookUrl: string,
    payload: CheckoutNotificationPayload,
) {
    validateCheckoutNotificationPolicy({
        ...DEFAULT_CHECKOUT_NOTIFICATION_POLICY,
        enabled: true,
        webhookUrl,
    });
    const url = new URL(webhookUrl);
    url.searchParams.set("wait", "true");
    try {
        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            redirect: "error",
            signal: AbortSignal.timeout(10_000),
        });
        const retryAfter = Number(response.headers.get("retry-after"));
        const body =
            response.status === 429
                ? await response.json().catch(() => null)
                : null;
        if (response.body && !body) await response.body.cancel();
        return {
            ok: response.ok,
            error: response.ok ? null : `Discord HTTP ${response.status}`,
            retryable: response.status === 429 || response.status >= 500,
            retryAfterMs: Math.ceil(
                Math.max(retryAfter || 0, Number(body?.retry_after) || 0) *
                    1000,
            ),
        };
    } catch {
        // Transport outcome is ambiguous: do not automatically duplicate it.
        return {
            ok: false,
            error: "Discord connection failed (delivery uncertain)",
            retryable: false,
            retryAfterMs: 0,
        };
    }
}

export async function deliverCheckoutNotification(id: string) {
    let claimed = false;
    try {
        const policy = await loadCheckoutNotificationPolicy();
        if (!policy.enabled) return;
        const claim = await db.checkout_notification_deliveries.updateMany({
            where: {
                id,
                OR: [
                    { status: { in: ["pending", "failed"] } },
                    {
                        status: "sending",
                        updated_at: { lt: new Date(Date.now() - 120_000) },
                    },
                ],
            },
            data: { status: "sending", last_error: null },
        });
        if (claim.count !== 1) return;
        claimed = true;
        const row = await db.checkout_notification_deliveries.findUniqueOrThrow(
            { where: { id } },
        );
        if (
            policy.events === "confirmed" &&
            !CHECKOUT_OUTCOMES[row.outcome]?.confirmed
        ) {
            await db.checkout_notification_deliveries.update({
                where: { id },
                data: { status: "skipped" },
            });
            return;
        }
        const payload = filterStoredCheckoutNotification(
            row.payload as CheckoutNotificationPayload,
            policy,
        );
        for (let attempt = 0; attempt < 3; attempt++) {
            await db.checkout_notification_deliveries.update({
                where: { id },
                data: { attempts: { increment: 1 }, payload },
            });
            const result = await sendCheckoutDiscord(
                policy.webhookUrl,
                payload,
            );
            if (
                !result.ok &&
                result.retryable &&
                attempt < 2 &&
                result.retryAfterMs <= 10_000
            ) {
                await new Promise((resolve) =>
                    setTimeout(
                        resolve,
                        Math.max(1000 * (attempt + 1), result.retryAfterMs),
                    ),
                );
                continue;
            }
            await db.checkout_notification_deliveries.update({
                where: { id },
                data: {
                    status: result.ok ? "delivered" : "failed",
                    last_error: result.error,
                    delivered_at: result.ok ? new Date() : null,
                },
            });
            return;
        }
    } catch {
        if (claimed)
            await db.checkout_notification_deliveries
                .updateMany({
                    where: { id, status: "sending" },
                    data: {
                        status: "failed",
                        last_error: "Notification delivery unavailable",
                    },
                })
                .catch(() => {});
        console.error("[checkout-notifications] Delivery unavailable");
    }
}
