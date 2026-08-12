export const MEMBER_ANNOUNCEMENT_SETTING_KEY = "member_announcement";

export const MEMBER_ANNOUNCEMENT_VARIANTS = [
    "support",
    "info",
    "warning",
    "critical",
] as const;

export const MEMBER_ANNOUNCEMENT_AUDIENCES = [
    "free",
    "premium",
    "admin",
] as const;

export const MEMBER_ANNOUNCEMENT_PLACEMENTS = [
    "monitors",
    "live_feed",
    "member_tools",
    "proxy_groups",
    "guide",
    "admin",
] as const;

export type MemberAnnouncementVariant =
    (typeof MEMBER_ANNOUNCEMENT_VARIANTS)[number];
export type MemberAnnouncementAudience =
    (typeof MEMBER_ANNOUNCEMENT_AUDIENCES)[number];
export type MemberAnnouncementPlacement =
    (typeof MEMBER_ANNOUNCEMENT_PLACEMENTS)[number];

export type MemberAnnouncementCta = {
    label: string;
    url: string;
};

export type MemberAnnouncement = {
    enabled: boolean;
    revision: string;
    variant: MemberAnnouncementVariant;
    title: string;
    message: string;
    cta: MemberAnnouncementCta | null;
    dismissible: boolean;
    audiences: MemberAnnouncementAudience[];
    placements: MemberAnnouncementPlacement[];
    startsAt: string | null;
    endsAt: string | null;
};

export type MemberAnnouncementInput = Omit<MemberAnnouncement, "revision">;

export const DEFAULT_MEMBER_ANNOUNCEMENT: MemberAnnouncement = {
    enabled: true,
    revision: "default-sponsor-v1",
    variant: "support",
    title: "Help keep the free demo fast and accessible with as few limits as possible.",
    message:
        "The public demo is running at capacity on a 2 vCPU / 2 GB server. Sponsor Vintrack to help us upgrade to 4 vCPU / 4 GB — or reach our 8 GB stretch goal.",
    cta: {
        label: "Sponsor on GitHub",
        url: "https://github.com/sponsors/JakobAIOdev",
    },
    dismissible: true,
    audiences: [...MEMBER_ANNOUNCEMENT_AUDIENCES],
    placements: ["monitors"],
    startsAt: null,
    endsAt: null,
};

const placementMatchers: Record<
    MemberAnnouncementPlacement,
    (pathname: string) => boolean
> = {
    monitors: (pathname) =>
        pathname === "/dashboard" ||
        pathname === "/monitors" ||
        pathname.startsWith("/monitors/"),
    live_feed: (pathname) =>
        pathname === "/feed" || pathname.startsWith("/feed/"),
    member_tools: (pathname) =>
        [
            "/account",
            "/your-listings",
            "/liked",
            "/chats",
            "/checkout-links",
            "/oneclick-buy-test",
        ].some(
            (prefix) =>
                pathname === prefix || pathname.startsWith(`${prefix}/`),
        ),
    proxy_groups: (pathname) =>
        pathname === "/proxies" || pathname.startsWith("/proxies/"),
    guide: (pathname) =>
        pathname === "/guide" || pathname.startsWith("/guide/"),
    admin: (pathname) =>
        pathname === "/admin" || pathname.startsWith("/admin/"),
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(
    value: unknown,
    field: string,
    maxLength: number,
): string {
    if (typeof value !== "string") {
        throw new Error(`${field} must be a string`);
    }
    const normalized = value.trim();
    if (normalized.length > maxLength) {
        throw new Error(`${field} must be ${maxLength} characters or fewer`);
    }
    return normalized;
}

function requireBoolean(value: unknown, field: string): boolean {
    if (typeof value !== "boolean") {
        throw new Error(`${field} must be a boolean`);
    }
    return value;
}

function requireEnum<T extends string>(
    value: unknown,
    values: readonly T[],
    field: string,
): T {
    if (typeof value !== "string" || !values.includes(value as T)) {
        throw new Error(`${field} is invalid`);
    }
    return value as T;
}

function requireEnumArray<T extends string>(
    value: unknown,
    values: readonly T[],
    field: string,
): T[] {
    if (!Array.isArray(value)) {
        throw new Error(`${field} must be an array`);
    }
    const normalized = Array.from(
        new Set(value.map((entry) => requireEnum(entry, values, field))),
    );
    return values.filter((entry) => normalized.includes(entry));
}

function optionalDate(value: unknown, field: string): string | null {
    if (value === null || value === undefined || value === "") return null;
    if (typeof value !== "string") {
        throw new Error(`${field} must be an ISO date`);
    }
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) {
        throw new Error(`${field} must be a valid ISO date`);
    }
    return date.toISOString();
}

export function isAllowedAnnouncementUrl(url: string): boolean {
    if (url.startsWith("/") && !url.startsWith("//")) {
        return !url.includes("\\") && !/[\u0000-\u001f\u007f]/.test(url);
    }
    try {
        return new URL(url).protocol === "https:";
    } catch {
        return false;
    }
}

function normalizeCta(value: unknown): MemberAnnouncementCta | null {
    if (value === null || value === undefined) return null;
    if (!isRecord(value)) throw new Error("CTA must be an object");

    const label = requireString(value.label, "CTA label", 40);
    const url = requireString(value.url, "CTA URL", 500);
    if (!label || !url) {
        throw new Error("CTA label and URL must both be provided");
    }
    if (!isAllowedAnnouncementUrl(url)) {
        throw new Error("CTA URL must be an internal path or use HTTPS");
    }
    return { label, url };
}

export function validateMemberAnnouncementInput(
    value: unknown,
): MemberAnnouncementInput {
    if (!isRecord(value)) throw new Error("Announcement must be an object");

    const enabled = requireBoolean(value.enabled, "Enabled");
    const title = requireString(value.title, "Title", 80);
    const message = requireString(value.message, "Message", 500);
    const audiences = requireEnumArray(
        value.audiences,
        MEMBER_ANNOUNCEMENT_AUDIENCES,
        "Audiences",
    );
    const placements = requireEnumArray(
        value.placements,
        MEMBER_ANNOUNCEMENT_PLACEMENTS,
        "Placements",
    );
    const startsAt = optionalDate(value.startsAt, "Start time");
    const endsAt = optionalDate(value.endsAt, "End time");

    if (enabled && !title) throw new Error("Title is required");
    if (enabled && !message) throw new Error("Message is required");
    if (enabled && audiences.length === 0) {
        throw new Error("Select at least one audience");
    }
    if (enabled && placements.length === 0) {
        throw new Error("Select at least one page area");
    }
    if (
        startsAt &&
        endsAt &&
        new Date(endsAt).getTime() <= new Date(startsAt).getTime()
    ) {
        throw new Error("End time must be after the start time");
    }

    return {
        enabled,
        variant: requireEnum(
            value.variant,
            MEMBER_ANNOUNCEMENT_VARIANTS,
            "Variant",
        ),
        title,
        message,
        cta: normalizeCta(value.cta),
        dismissible: requireBoolean(value.dismissible, "Dismissible"),
        audiences,
        placements,
        startsAt,
        endsAt,
    };
}

export function parseMemberAnnouncement(
    value: string | null | undefined,
): MemberAnnouncement {
    if (!value) return DEFAULT_MEMBER_ANNOUNCEMENT;
    try {
        const parsed: unknown = JSON.parse(value);
        if (!isRecord(parsed) || typeof parsed.revision !== "string") {
            return DEFAULT_MEMBER_ANNOUNCEMENT;
        }
        const revision = parsed.revision.trim();
        if (!revision) return DEFAULT_MEMBER_ANNOUNCEMENT;
        return {
            ...validateMemberAnnouncementInput(parsed),
            revision,
        };
    } catch {
        return DEFAULT_MEMBER_ANNOUNCEMENT;
    }
}

export function toMemberAnnouncementInput(
    announcement: MemberAnnouncement,
): MemberAnnouncementInput {
    return {
        enabled: announcement.enabled,
        variant: announcement.variant,
        title: announcement.title,
        message: announcement.message,
        cta: announcement.cta,
        dismissible: announcement.dismissible,
        audiences: announcement.audiences,
        placements: announcement.placements,
        startsAt: announcement.startsAt,
        endsAt: announcement.endsAt,
    };
}

export function getAnnouncementPlacement(
    pathname: string,
): MemberAnnouncementPlacement | null {
    for (const placement of MEMBER_ANNOUNCEMENT_PLACEMENTS) {
        if (placementMatchers[placement](pathname)) return placement;
    }
    return null;
}

export function isMemberAnnouncementVisible(
    announcement: MemberAnnouncement,
    options: { pathname: string; role?: string | null; now?: Date },
): boolean {
    if (!announcement.enabled) return false;

    const role = MEMBER_ANNOUNCEMENT_AUDIENCES.includes(
        options.role as MemberAnnouncementAudience,
    )
        ? (options.role as MemberAnnouncementAudience)
        : "free";
    if (!announcement.audiences.includes(role)) return false;

    const placement = getAnnouncementPlacement(options.pathname);
    if (!placement || !announcement.placements.includes(placement)) {
        return false;
    }

    const now = (options.now ?? new Date()).getTime();
    if (
        announcement.startsAt &&
        now < new Date(announcement.startsAt).getTime()
    ) {
        return false;
    }
    if (announcement.endsAt && now >= new Date(announcement.endsAt).getTime()) {
        return false;
    }
    return true;
}
