export const ADMIN_SECTION_ROUTES = {
    overview: "/admin/overview",
    insights: "/admin/member-insights",
    monitors: "/admin/monitors",
    price_watch: "/admin/price-watch",
    users: "/admin/members",
    roles: "/admin/roles-limits",
    rewards: "/admin/rewards",
    settings: "/admin/infrastructure",
    logs: "/admin/logs",
    announcements: "/admin/announcements",
} as const;

export type AdminSection = keyof typeof ADMIN_SECTION_ROUTES;

const ADMIN_SECTION_BY_SLUG = Object.fromEntries(
    Object.entries(ADMIN_SECTION_ROUTES).map(([section, route]) => [
        route.slice("/admin/".length),
        section,
    ]),
) as Record<string, AdminSection>;

export function isAdminSection(value: string | null | undefined): value is AdminSection {
    return Boolean(value && value in ADMIN_SECTION_ROUTES);
}

export function adminSectionFromSlug(slug: string) {
    return ADMIN_SECTION_BY_SLUG[slug] ?? null;
}
