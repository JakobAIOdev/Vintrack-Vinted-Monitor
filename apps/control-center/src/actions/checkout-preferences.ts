"use server";

import { auth } from "@/auth";
import { db } from "@/lib/db";
import {
    checkoutDomain,
    checkoutPaymentAllowed,
    autoCheckoutAllowed,
    isCheckoutPreferences,
    type CheckoutPreferences,
} from "@/lib/checkout";
import {
    loadCheckoutPreferences,
    loadCheckoutSettings,
} from "@/lib/checkout-preferences.server";
import { guardCheckoutConsent } from "@/lib/checkout-consent.server";
import { getFeatureAccessForUser } from "@/lib/features.server";
import { revalidatePath } from "next/cache";

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
    return {
        domain: account.domain,
        ...(await loadCheckoutSettings(
            account.userId,
            account.accountId,
            account.domain,
        )),
    };
}

export async function saveCheckoutPreferences(
    preferences: CheckoutPreferences,
) {
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
            error: "Auto-checkout supports a saved card or PayPal in supported regions, with a verified EUR total.",
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
    await db.user.update({
        where: { id: account.userId },
        data: {
            checkout_preferences: {
                accountId: account.accountId,
                domain: account.domain,
                preferences,
            },
        },
    });
    revalidatePath("/account");
    return { success: true };
}
