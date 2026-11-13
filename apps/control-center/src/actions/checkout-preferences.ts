"use server";

import { auth } from "@/auth";
import { db } from "@/lib/db";
import {
    checkoutDomain,
    checkoutPaymentAllowed,
    autoCheckoutAllowed,
    isCheckoutPreferences,
    isCheckoutTransport,
    type CheckoutTransport,
    type CheckoutPreferences,
} from "@/lib/checkout";
import {
    loadCheckoutPreferences,
    loadCheckoutSettings,
} from "@/lib/checkout-preferences.server";
import { guardCheckoutConsent } from "@/lib/checkout-consent.server";
import { getFeatureAccessForUser } from "@/lib/features.server";
import { revalidatePath } from "next/cache";
import { validateProxyLine } from "@/lib/custom-proxy-validation";

async function linkedAccount() {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Sign in to Vintrack.");
    const account = await db.vinted_sessions.findUnique({
        where: { userId: session.user.id },
        select: { vinted_user_id: true, domain: true },
    });
    const accountId = Number(account?.vinted_user_id);
    const domain = account && checkoutDomain(account.domain);
    if (!domain || !Number.isSafeInteger(accountId) || accountId <= 0)
        throw new Error("Link your Vinted account first.");
    return { userId: session.user.id, accountId, domain };
}

export async function getCheckoutPreferences() {
    const account = await linkedAccount();
    return loadCheckoutPreferences(
        account.userId,
        account.accountId,
        account.domain,
    );
}

export async function getCheckoutPreferenceSettings() {
    const account = await linkedAccount();
    const proxyGroups = await db.proxy_groups.findMany({
        where: { userId: account.userId },
        select: { id: true, name: true },
        orderBy: { id: "asc" },
    });
    return {
        domain: account.domain,
        proxyGroups,
        ...(await loadCheckoutSettings(
            account.userId,
            account.accountId,
            account.domain,
        )),
    };
}

export async function saveCheckoutPreferences(
    preferences: CheckoutPreferences,
    transport?: CheckoutTransport,
    proxyGroupId?: number | null,
) {
    if (
        proxyGroupId !== undefined &&
        proxyGroupId !== null &&
        (!Number.isSafeInteger(proxyGroupId) || proxyGroupId <= 0)
    )
        return { error: "Invalid checkout proxy group." };
    if (transport !== undefined && !isCheckoutTransport(transport))
        return { error: "Invalid checkout transport." };
    if (!isCheckoutPreferences(preferences))
        return { error: "Invalid checkout preferences." };
    const account = await linkedAccount();
    if (!checkoutPaymentAllowed(account.domain, preferences.payment))
        return {
            error: "This payment method is not offered for your linked Vinted region.",
        };
    if (
        preferences.autoCheckout &&
        !autoCheckoutAllowed(account.domain, preferences.payment)
    )
        return {
            error: "Auto-checkout supports a saved card or PayPal in supported regions, with a verified total matching your limit currency.",
        };
    if (
        !(await getFeatureAccessForUser("checkout_links", account.userId))
            .allowed
    )
        return { error: "Checkout is unavailable for your account." };
    if (
        preferences.autoCheckout &&
        (await guardCheckoutConsent(account.userId))
    )
        return {
            error: "Accept the checkout risk warning before enabling auto-checkout.",
        };
    const settings = await loadCheckoutSettings(
        account.userId,
        account.accountId,
        account.domain,
    );
    const nextTransport = transport ?? settings.checkoutTransport ?? "browser";
    const nextProxyGroupId =
        proxyGroupId === undefined
            ? (settings.checkoutProxyGroupId ?? null)
            : proxyGroupId;
    if (nextTransport === "server") {
        const group = nextProxyGroupId
            ? await db.proxy_groups.findFirst({
                  where: { id: nextProxyGroupId, userId: account.userId },
                  select: { proxies: true },
              })
            : null;
        const firstProxy = group?.proxies
            .split(/\r?\n/)
            .map((line) => line.trim())
            .find(Boolean);
        if (!firstProxy || !validateProxyLine(firstProxy))
            return {
                error: "Select one of your proxy groups with a valid first proxy for request checkout.",
            };
    }
    if (
        (nextTransport !== (settings.checkoutTransport ?? "browser") ||
            nextProxyGroupId !== (settings.checkoutProxyGroupId ?? null)) &&
        preferences.autoCheckout
    )
        return {
            error: "Save the new checkout method or proxy with automatic payment off, then enable it separately.",
        };
    const saved = await db.user.updateMany({
        where: { id: account.userId, checkout_enabled: true },
        data: {
            checkout_preferences: {
                accountId: account.accountId,
                domain: account.domain,
                preferences,
                transport: nextTransport,
                proxyGroupId: nextProxyGroupId,
            },
        },
    });
    if (saved.count !== 1)
        return { error: "Enable the checkout module in Account first." };
    revalidatePath("/account");
    return { success: true };
}

export async function setCheckoutModuleEnabled(enabled: boolean) {
    if (typeof enabled !== "boolean")
        return { error: "Invalid checkout setting." };
    const session = await auth();
    if (!session?.user?.id) throw new Error("Sign in to Vintrack.");
    const userId = session.user.id;
    // Disabling stays available even if an administrator withdraws access.
    if (enabled) {
        const account = await linkedAccount();
        if (
            !(
                await getFeatureAccessForUser(
                    "checkout_links",
                    account.userId,
                    db,
                    false,
                )
            ).allowed
        )
            return { error: "Checkout is unavailable for your account." };
        if (await guardCheckoutConsent(userId))
            return {
                error: "Accept the checkout risk warning before enabling checkout.",
            };
    }
    await db.$transaction(async (tx) => {
        // Serialize concurrent settings changes and always disarm auto-payment.
        await tx.user.update({
            where: { id: userId },
            data: { checkout_enabled: enabled },
        });
        await tx.$executeRaw`
            UPDATE "User"
            SET checkout_preferences = checkout_preferences #- '{preferences,autoCheckout}'
            WHERE id = ${userId}
        `;
    });
    revalidatePath("/", "layout");
    return { success: true };
}
