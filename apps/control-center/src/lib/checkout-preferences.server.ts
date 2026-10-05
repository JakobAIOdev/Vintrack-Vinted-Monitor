import "server-only";

import { db } from "@/lib/db";
import {
    DEFAULT_CHECKOUT_PREFERENCES,
    isCheckoutPreferences,
    checkoutPaymentAllowed,
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
        return checkoutPaymentAllowed(domain, stored.preferences.payment)
            ? stored.preferences
            : { ...stored.preferences, payment: "wallet" as const };
    }
    return DEFAULT_CHECKOUT_PREFERENCES;
}
