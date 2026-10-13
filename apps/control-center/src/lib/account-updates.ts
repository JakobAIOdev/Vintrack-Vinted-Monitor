import type { FeatureAccessResult } from "./features";

// Bump only when Account gains a new member-facing feature to announce.
export const CHECKOUT_UPDATES_VERSION = 2;
export const ACCOUNT_UPDATES_VERSION = CHECKOUT_UPDATES_VERSION;

export function checkoutFeatureDiscoverable(access: FeatureAccessResult) {
    return access.allowed || access.reason === "user_disabled";
}

export function shouldShowCheckoutUpdate(
    seenVersion: number | undefined,
    access: FeatureAccessResult,
    pathname: string,
) {
    return (
        (seenVersion ?? 0) < CHECKOUT_UPDATES_VERSION &&
        checkoutFeatureDiscoverable(access) &&
        ["/dashboard", "/monitors", "/feed", "/guide"].some(
            (route) => pathname === route || pathname.startsWith(`${route}/`),
        )
    );
}
