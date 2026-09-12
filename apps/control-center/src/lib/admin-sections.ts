export const ADMIN_SECTION_ROUTES = {
    overview: "/admin/overview",
    insights: "/admin/members?view=insights",
    monitors: "/admin/operations",
    price_watch: "/admin/operations?view=price_watch",
    users: "/admin/members",
    features: "/admin/features",
    roles: "/admin/members?view=roles",
    rewards: "/admin/integrations",
    settings: "/admin/system",
    logs: "/admin/operations?view=logs",
    announcements: "/admin/communication",
} as const;

export type AdminSection = keyof typeof ADMIN_SECTION_ROUTES;

export function isAdminSection(
    value: string | null | undefined,
): value is AdminSection {
    return Boolean(value && value in ADMIN_SECTION_ROUTES);
}

const ADMIN_AREA_SECTIONS: Record<
    string,
    {
        defaultSection: AdminSection;
        views?: Partial<Record<AdminSection, AdminSection>>;
    }
> = {
    overview: { defaultSection: "overview" },
    members: {
        defaultSection: "users",
        views: { insights: "insights", roles: "roles" },
    },
    features: { defaultSection: "features" },
    operations: {
        defaultSection: "monitors",
        views: { price_watch: "price_watch", logs: "logs" },
    },
    integrations: { defaultSection: "rewards" },
    communication: { defaultSection: "announcements" },
    system: { defaultSection: "settings" },
};

const LEGACY_ADMIN_SLUGS: Record<string, AdminSection> = {
    "member-insights": "insights",
    monitors: "monitors",
    "price-watch": "price_watch",
    "roles-limits": "roles",
    rewards: "rewards",
    infrastructure: "settings",
    logs: "logs",
    announcements: "announcements",
};

export function adminSectionFromRoute(
    slug: string,
    view: string | null | undefined,
) {
    const area = ADMIN_AREA_SECTIONS[slug];
    if (!area) return null;
    if (!view) return area.defaultSection;
    return area.views?.[view as AdminSection] ?? area.defaultSection;
}

export function legacyAdminRedirect(slug: string) {
    const section = LEGACY_ADMIN_SLUGS[slug];
    return section ? ADMIN_SECTION_ROUTES[section] : null;
}
