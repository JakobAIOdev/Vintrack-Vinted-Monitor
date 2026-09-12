export const USER_ROLES = ["free", "premium", "admin"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const FEATURE_KEYS = [
    "price_watch",
    "live_feed",
    "proxy_groups",
    "free_proxy_pool",
    "vinted_account",
    "your_listings",
    "liked_items",
    "chats",
    "offers",
    "checkout_links",
] as const;

export type FeatureKey = (typeof FEATURE_KEYS)[number];
export type FeatureAccessReason =
    | "disabled"
    | "role_denied"
    | "dependency_disabled";

export type FeaturePolicy = {
    feature: FeatureKey;
    enabled: boolean;
    roles: Record<UserRole, boolean>;
    revision: number;
    updatedAt: string | null;
};

export type FeatureAccessResult =
    | { allowed: true; feature: FeatureKey }
    | {
          allowed: false;
          feature: FeatureKey;
          reason: FeatureAccessReason;
          dependency?: FeatureKey;
      };

export type FeatureDefinition = {
    key: FeatureKey;
    label: string;
    description: string;
    disabledEffect: string;
    group: "Tracking" | "Proxy access" | "Vinted account";
    dependencies: FeatureKey[];
};

export const FEATURE_DEFINITIONS: readonly FeatureDefinition[] = [
    {
        key: "price_watch",
        label: "Price Watch",
        description:
            "Track price changes for individual Vinted items and send alerts when their price drops.",
        disabledEffect:
            "Hides Price Watch, blocks page and API access, stops new worker claims, and pauses affected active watches.",
        group: "Tracking",
        dependencies: [],
    },
    {
        key: "live_feed",
        label: "Live Feed",
        description:
            "Show newly discovered items from active monitors as a live, updating feed.",
        disabledEffect:
            "Hides Live Feed and blocks both feed and live-stream API access. Existing monitor data is kept.",
        group: "Tracking",
        dependencies: [],
    },
    {
        key: "proxy_groups",
        label: "Proxy Groups",
        description:
            "Let members create private proxy groups and assign them to monitors or Price Watches.",
        disabledEffect:
            "Hides Proxy Groups, blocks group management, and pauses only jobs that depend on a personal proxy group.",
        group: "Proxy access",
        dependencies: [],
    },
    {
        key: "free_proxy_pool",
        label: "Free Proxy Pool",
        description:
            "Let members run eligible monitors through Vintrack’s operator-managed shared proxy pool.",
        disabledEffect:
            "Removes the Free Pool option and pauses only monitors that currently depend on it.",
        group: "Proxy access",
        dependencies: [],
    },
    {
        key: "vinted_account",
        label: "Vinted Account",
        description:
            "Let members connect and synchronize a Vinted session for authenticated account tools.",
        disabledEffect:
            "Blocks linking and all dependent account tools. Stored sessions and data remain, and unlinking stays available.",
        group: "Vinted account",
        dependencies: [],
    },
    {
        key: "your_listings",
        label: "Your Listings",
        description:
            "Show the member’s own Vinted listings from their linked account.",
        disabledEffect:
            "Hides Your Listings and blocks listing API access without deleting cached listing data.",
        group: "Vinted account",
        dependencies: ["vinted_account"],
    },
    {
        key: "liked_items",
        label: "Liked Items",
        description:
            "Show saved Vinted items and allow members to like or unlike items.",
        disabledEffect:
            "Hides Liked Items and blocks favourite and like actions without changing existing Vinted favourites.",
        group: "Vinted account",
        dependencies: ["vinted_account"],
    },
    {
        key: "chats",
        label: "Chats & Messages",
        description:
            "Read conversations and send messages through the linked Vinted account.",
        disabledEffect:
            "Hides Chats and blocks inbox, conversation, reply, and message APIs. Existing messages are kept.",
        group: "Vinted account",
        dependencies: ["vinted_account"],
    },
    {
        key: "offers",
        label: "Offers",
        description:
            "Allow members to send price offers through their linked Vinted account.",
        disabledEffect:
            "Blocks new offer actions. Existing offers and account data are not modified.",
        group: "Vinted account",
        dependencies: ["vinted_account"],
    },
    {
        key: "checkout_links",
        label: "Checkout Links",
        description:
            "Generate authenticated checkout links for items using the linked Vinted account.",
        disabledEffect:
            "Hides Checkout Links and blocks link generation. Previously stored account data remains untouched.",
        group: "Vinted account",
        dependencies: ["vinted_account"],
    },
] as const;

export const FEATURE_DEFINITION_BY_KEY = Object.fromEntries(
    FEATURE_DEFINITIONS.map((definition) => [definition.key, definition]),
) as Record<FeatureKey, FeatureDefinition>;

export function isUserRole(
    value: string | null | undefined,
): value is UserRole {
    return USER_ROLES.includes(value as UserRole);
}

export function isFeatureKey(value: string): value is FeatureKey {
    return FEATURE_KEYS.includes(value as FeatureKey);
}

export function defaultFeaturePolicy(feature: FeatureKey): FeaturePolicy {
    return {
        feature,
        enabled: feature !== "free_proxy_pool",
        roles: { free: true, premium: true, admin: true },
        revision: 0,
        updatedAt: null,
    };
}

export function resolveFeatureAccess(
    feature: FeatureKey,
    role: string | null | undefined,
    policies: ReadonlyMap<FeatureKey, FeaturePolicy>,
    visited = new Set<FeatureKey>(),
): FeatureAccessResult {
    const policy = policies.get(feature) ?? defaultFeaturePolicy(feature);
    if (!policy.enabled) return { allowed: false, feature, reason: "disabled" };
    if (!isUserRole(role) || !policy.roles[role]) {
        return { allowed: false, feature, reason: "role_denied" };
    }

    if (visited.has(feature)) {
        return { allowed: false, feature, reason: "dependency_disabled" };
    }
    visited.add(feature);
    for (const dependency of FEATURE_DEFINITION_BY_KEY[feature].dependencies) {
        const dependencyAccess = resolveFeatureAccess(
            dependency,
            role,
            policies,
            new Set(visited),
        );
        if (!dependencyAccess.allowed) {
            return {
                allowed: false,
                feature,
                reason: "dependency_disabled",
                dependency,
            };
        }
    }

    return { allowed: true, feature };
}
