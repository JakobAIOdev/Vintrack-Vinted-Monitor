import type { FeatureAccessResult } from "./features";

// Bump only when Account gains a new member-facing feature to announce.
export const ACCOUNT_UPDATES_VERSION = 2;

export function checkoutFeatureDiscoverable(access: FeatureAccessResult) {
    return access.allowed || access.reason === "user_disabled";
}
