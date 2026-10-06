import "server-only";

import { db } from "@/lib/db";
import {
    DEFAULT_CHECKOUT_PREFERENCES,
    isCheckoutPreferences,
    checkoutPaymentAllowed,
    autoCheckoutAllowed,
} from "@/lib/checkout";
import {
    checkoutRiskAccepted,
    CHECKOUT_RISK_WARNING_VERSION,
} from "@/lib/checkout-consent";

export async function loadCheckoutSettings(
    userId: string,
    accountId: number,
    domain: string,
) {
    const user = await db.user.findUnique({
        where: { id: userId },
        select: {
            checkout_enabled: true,
            checkout_preferences: true,
            checkout_risk_version: true,
            checkout_risk_accepted_at: true,
        },
    });
    const riskConsentVersion = checkoutRiskAccepted(
        user?.checkout_risk_version,
        user?.checkout_risk_accepted_at,
    )
        ? CHECKOUT_RISK_WARNING_VERSION
        : null;
    const checkoutEnabled = user?.checkout_enabled === true;
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
                checkoutEnabled,
                riskConsentVersion,
                preferences: {
                    shipping: stored.preferences.shipping,
                    payment: "wallet" as const,
                },
            };
        if (
            stored.preferences.autoCheckout &&
            !autoCheckoutAllowed(domain, stored.preferences.payment)
        )
            return {
                checkoutEnabled,
                riskConsentVersion,
                preferences: {
                    shipping: stored.preferences.shipping,
                    payment: stored.preferences.payment,
                },
            };
        return {
            checkoutEnabled,
            riskConsentVersion,
            preferences: checkoutEnabled
                ? stored.preferences
                : {
                      shipping: stored.preferences.shipping,
                      payment: stored.preferences.payment,
                  },
        };
    }
    return {
        checkoutEnabled,
        riskConsentVersion,
        preferences: DEFAULT_CHECKOUT_PREFERENCES,
    };
}

export async function loadCheckoutPreferences(
    userId: string,
    accountId: number,
    domain: string,
) {
    return (await loadCheckoutSettings(userId, accountId, domain)).preferences;
}
