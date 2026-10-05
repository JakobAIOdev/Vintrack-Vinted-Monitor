import "server-only";

import { db } from "@/lib/db";
import {
    DEFAULT_CHECKOUT_PREFERENCES,
    isCheckoutPreferences,
    checkoutPaymentAllowed,
    autoCheckoutAllowed,
} from "@/lib/checkout";

export async function loadCheckoutPreferences(
    userId: string,
    accountId: number,
    domain: string,
) {
    const user = await db.user.findUnique({
        where: { id: userId },
        select: { checkout_preferences: true },
    });
    const stored = user?.checkout_preferences;
    if (
        stored &&
        typeof stored === "object" &&
        !Array.isArray(stored) &&
        stored.accountId === accountId &&
        stored.domain === domain &&
        isCheckoutPreferences(stored.preferences)
    ) {
        if (!checkoutPaymentAllowed(domain, stored.preferences.payment))
            return {
                shipping: stored.preferences.shipping,
                payment: "wallet" as const,
            };
        if (
            stored.preferences.autoCheckout &&
            !autoCheckoutAllowed(domain, stored.preferences.payment)
        )
            return {
                shipping: stored.preferences.shipping,
                payment: stored.preferences.payment,
            };
        return stored.preferences;
    }
    return DEFAULT_CHECKOUT_PREFERENCES;
}
