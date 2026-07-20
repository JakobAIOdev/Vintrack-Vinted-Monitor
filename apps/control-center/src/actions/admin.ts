"use server";

import { auth } from "@/auth";
import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { revalidatePath, unstable_cache } from "next/cache";
import { monitorStatusTelegramText, sendTelegramMessage } from "@/lib/telegram";
import { getTelegramConnection } from "@/lib/telegram-connection";
import {
    GLOBAL_MONITOR_LIMIT_SCOPE,
    normalizeMonitorLimitInput,
    roleLimitScope,
    setMonitorLimit,
    USER_MONITOR_LIMIT_PREFIX,
    userLimitScope,
} from "@/lib/monitor-limits";

const SERVER_PROXIES_SETTING_KEY = "server_proxies";
const FREE_PROXY_ENABLED_KEY = "free_proxy_enabled";
const FREE_PROXY_AUTO_IMPORT_ENABLED_KEY = "free_proxy_auto_import_enabled";
const FREE_PROXY_IMPORT_SOURCE_KEY = "free_proxy_import_source";
const FREE_PROXY_IMPORT_URL_KEY = "free_proxy_import_url";
const FREE_PROXY_MAX_POOL_SIZE_KEY = "free_proxy_max_pool_size";
const FREE_PROXY_FAILURE_THRESHOLD_KEY = "free_proxy_failure_threshold";
const FREE_PROXY_QUARANTINE_MINUTES_KEY = "free_proxy_quarantine_minutes";
const FREE_PROXY_MIN_ACTIVE_PER_REGION_KEY = "free_proxy_min_active_per_region";
const FREE_PROXY_TARGET_ACTIVE_PER_REGION_KEY =
    "free_proxy_target_active_per_region";
const FREE_PROXY_MAX_LATENCY_MS_KEY = "free_proxy_max_latency_ms";
const FREE_PROXY_STARTER_REGIONS_KEY = "free_proxy_starter_regions";
const DEFAULT_FREE_PROXY_IMPORT_URL =
    "https://raw.githubusercontent.com/iplocate/free-proxy-list/main/all-proxies.txt";
const DEFAULT_FREE_PROXY_IMPORT_SOURCE = "iplocate_all";
const DEFAULT_FREE_PROXY_STARTER_REGIONS = "de,fr,it,es,nl,be,at";
const DEFAULT_FREE_PROXY_MAX_POOL_SIZE = 5000;
const DEFAULT_FREE_PROXY_FAILURE_THRESHOLD = 3;
const DEFAULT_FREE_PROXY_QUARANTINE_MINUTES = 30;
const DEFAULT_FREE_PROXY_MIN_ACTIVE_PER_REGION = 25;
const DEFAULT_FREE_PROXY_TARGET_ACTIVE_PER_REGION = 50;
const DEFAULT_FREE_PROXY_MAX_LATENCY_MS = 2500;
const FREE_PROXY_WRITE_BATCH_SIZE = 500;
const VALID_PROXY_SCHEMES = ["http", "https", "socks4", "socks5"];
const FREE_PROXY_SOURCE_URLS: Record<string, string> = {
    iplocate_all:
        "https://raw.githubusercontent.com/iplocate/free-proxy-list/main/all-proxies.txt",
    iplocate_http:
        "https://raw.githubusercontent.com/iplocate/free-proxy-list/main/protocols/http.txt",
    iplocate_https:
        "https://raw.githubusercontent.com/iplocate/free-proxy-list/main/protocols/https.txt",
    iplocate_socks4:
        "https://raw.githubusercontent.com/iplocate/free-proxy-list/main/protocols/socks4.txt",
    iplocate_socks5:
        "https://raw.githubusercontent.com/iplocate/free-proxy-list/main/protocols/socks5.txt",
    proxyscrape:
        "https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&proxy_format=protocolipport&format=text",
};
const IPLocateSupportedCountryRegions = new Set([
    "ar",
    "bd",
    "br",
    "ca",
    "ch",
    "cn",
    "co",
    "cz",
    "de",
    "ec",
    "ee",
    "fi",
    "fr",
    "gb",
    "gh",
    "hk",
    "hu",
    "id",
    "in",
    "iq",
    "jp",
    "ke",
    "kh",
    "kr",
    "lv",
    "md",
    "me",
    "my",
    "nl",
    "pk",
    "ps",
    "ru",
    "se",
    "sg",
    "sy",
    "tr",
    "ua",
    "us",
    "uz",
    "ve",
    "vn",
    "za",
    "zw",
]);
const IPLocateCountryAliases: Record<string, string> = {
    uk: "gb",
};

type AlertIssueSummaryRow = {
    channel: string;
    status: string;
    failure_reason: string | null;
    event_count: bigint;
    last_seen_at: Date;
};

type FreeProxyStatusCountRow = {
    status: string;
    proxy_count: bigint;
};

type FreeProxySettings = {
    enabled: boolean;
    autoImportEnabled: boolean;
    importSource: string;
    importUrl: string;
    maxPoolSize: number;
    failureThreshold: number;
    quarantineMinutes: number;
    minActivePerRegion: number;
    targetActivePerRegion: number;
    maxLatencyMs: number;
    starterRegions: string;
};

type FreeProxyRegionRow = {
    region: string;
    active_count: bigint;
    warming_count: bigint;
    pending_count: bigint;
    cooldown_count: bigint;
    dead_count: bigint;
    recent_success_count: bigint;
    recent_check_count: bigint;
    median_latency_ms: number | null;
    last_checked_at: Date | null;
};

type ParsedProxy = {
    proxyUrl: string;
    protocol: string;
    host: string;
    port: number;
};

type AdminMetricCountRow = {
    userId: string;
    running_monitors?: bigint;
    paused_monitors?: bigint;
    new_items_24h?: bigint;
    checks_24h?: bigint;
    successful_checks_24h?: bigint;
    failed_checks_24h?: bigint;
    avg_duration_ms_24h?: number | null;
    last_check_at?: Date | null;
    latest_error_24h?: string | null;
};

type AdminUserMetrics = {
    runningMonitors: number;
    pausedMonitors: number;
    totalItems: number;
    newItems24h: number;
    checks24h: number;
    successfulChecks24h: number;
    failedChecks24h: number;
    successRate24h: number | null;
    avgDurationMs24h: number | null;
    lastCheckAt: Date | null;
    latestError24h: string | null;
};

type CachedAdminUserMetrics = Omit<AdminUserMetrics, "lastCheckAt"> & {
    lastCheckAt: string | null;
};

type AdminMemberSummaryRow = {
    total_members: bigint;
    new_members_7d: bigint;
    new_members_previous_7d: bigint;
    new_members_30d: bigint;
    new_members_previous_30d: bigint;
    members_without_signup_date: bigint;
};

type AdminMemberGrowthRow = {
    day: Date;
    new_members: bigint;
};

type AdminMemberRoleRow = {
    role: string;
    member_count: bigint;
};

type AdminDemoInsightsRow = {
    users_with_monitors: bigint;
    demo_users: bigint;
    active_demo_users: bigint;
    expired_demo_users: bigint;
    converted_demo_users: bigint;
};

function emptyAdminUserMetrics(): AdminUserMetrics {
    return {
        runningMonitors: 0,
        pausedMonitors: 0,
        totalItems: 0,
        newItems24h: 0,
        checks24h: 0,
        successfulChecks24h: 0,
        failedChecks24h: 0,
        successRate24h: null,
        avgDurationMs24h: null,
        lastCheckAt: null,
        latestError24h: null,
    };
}

async function loadAdminUserMetrics() {
    const metrics = new Map<string, AdminUserMetrics>();
    const rows = await db.$queryRaw<AdminMetricCountRow[]>`
        WITH monitor_totals AS (
            SELECT
                "userId",
                COUNT(*) FILTER (WHERE status = 'active')::bigint AS running_monitors,
                COUNT(*) FILTER (WHERE status IS DISTINCT FROM 'active')::bigint AS paused_monitors
            FROM monitors
            GROUP BY "userId"
        ),
        run_totals AS (
            SELECT
                m."userId",
                SUM(s.check_count)::bigint AS checks_24h,
                SUM(s.successful_check_count)::bigint AS successful_checks_24h,
                SUM(s.failed_check_count)::bigint AS failed_checks_24h,
                SUM(s.new_item_count)::bigint AS new_items_24h,
                CASE
                    WHEN SUM(s.duration_sample_count) > 0
                    THEN SUM(s.duration_total_ms)::double precision /
                         SUM(s.duration_sample_count)::double precision
                    ELSE NULL
                END AS avg_duration_ms_24h,
                MAX(s.last_checked_at) AS last_check_at,
                (
                    ARRAY_AGG(s.latest_error ORDER BY s.latest_error_at DESC)
                    FILTER (WHERE s.latest_error IS NOT NULL)
                )[1] AS latest_error_24h
            FROM monitor_run_hourly_stats s
            INNER JOIN monitors m ON m.id = s.monitor_id
            WHERE s.fetch_source = 'canonical'
              AND s.bucket_hour >=
                  DATE_TRUNC('hour', NOW()) - INTERVAL '23 hours'
            GROUP BY m."userId"
        )
        SELECT
            monitor_totals."userId",
            monitor_totals.running_monitors,
            monitor_totals.paused_monitors,
            COALESCE(run_totals.checks_24h, 0)::bigint AS checks_24h,
            COALESCE(run_totals.successful_checks_24h, 0)::bigint
                AS successful_checks_24h,
            COALESCE(run_totals.failed_checks_24h, 0)::bigint
                AS failed_checks_24h,
            COALESCE(run_totals.new_items_24h, 0)::bigint AS new_items_24h,
            run_totals.avg_duration_ms_24h,
            run_totals.last_check_at,
            run_totals.latest_error_24h
        FROM monitor_totals
        LEFT JOIN run_totals
            ON run_totals."userId" = monitor_totals."userId"
    `.catch((error) => {
        console.error("[admin] failed to load hourly user metrics", error);
        return [];
    });

    for (const row of rows) {
        const current = metrics.get(row.userId) ?? emptyAdminUserMetrics();
        current.runningMonitors = Number(row.running_monitors ?? 0);
        current.pausedMonitors = Number(row.paused_monitors ?? 0);
        const checks = Number(row.checks_24h ?? 0);
        const successful = Number(row.successful_checks_24h ?? 0);
        current.checks24h = checks;
        current.successfulChecks24h = successful;
        current.failedChecks24h = Number(row.failed_checks_24h ?? 0);
        current.newItems24h = Number(row.new_items_24h ?? 0);
        current.successRate24h =
            checks > 0 ? Math.round((successful / checks) * 100) : null;
        current.avgDurationMs24h =
            row.avg_duration_ms_24h === null ||
            row.avg_duration_ms_24h === undefined
                ? null
                : Math.round(row.avg_duration_ms_24h);
        current.lastCheckAt = row.last_check_at ?? null;
        current.latestError24h = row.latest_error_24h ?? null;
        metrics.set(row.userId, current);
    }

    return Array.from(metrics.entries()).map(
        ([userId, values]) =>
            [
                userId,
                {
                    ...values,
                    lastCheckAt: values.lastCheckAt?.toISOString() ?? null,
                },
            ] as [string, CachedAdminUserMetrics],
    );
}

const getCachedAdminUserMetrics = unstable_cache(
    loadAdminUserMetrics,
    ["admin-user-metrics-v5"],
    { revalidate: 30 },
);

async function loadAdminMemberInsights() {
    const [summaryRows, growthRows, roleRows, demoRows, recentMembers] =
        await Promise.all([
            db.$queryRaw<AdminMemberSummaryRow[]>`
                SELECT
                    COUNT(*)::bigint AS total_members,
                    COUNT(*) FILTER (
                        WHERE "createdAt" >= NOW() - INTERVAL '7 days'
                    )::bigint AS new_members_7d,
                    COUNT(*) FILTER (
                        WHERE "createdAt" >= NOW() - INTERVAL '14 days'
                          AND "createdAt" < NOW() - INTERVAL '7 days'
                    )::bigint AS new_members_previous_7d,
                    COUNT(*) FILTER (
                        WHERE "createdAt" >= NOW() - INTERVAL '30 days'
                    )::bigint AS new_members_30d,
                    COUNT(*) FILTER (
                        WHERE "createdAt" >= NOW() - INTERVAL '60 days'
                          AND "createdAt" < NOW() - INTERVAL '30 days'
                    )::bigint AS new_members_previous_30d,
                    COUNT(*) FILTER (
                        WHERE "createdAt" IS NULL
                    )::bigint AS members_without_signup_date
                FROM "User"
            `,
            db.$queryRaw<AdminMemberGrowthRow[]>`
                WITH days AS (
                    SELECT GENERATE_SERIES(
                        CURRENT_DATE - INTERVAL '89 days',
                        CURRENT_DATE,
                        INTERVAL '1 day'
                    )::date AS day
                ),
                daily_members AS (
                    SELECT
                        "createdAt"::date AS day,
                        COUNT(*)::bigint AS new_members
                    FROM "User"
                    WHERE "createdAt" >= CURRENT_DATE - INTERVAL '89 days'
                    GROUP BY "createdAt"::date
                )
                SELECT
                    days.day,
                    COALESCE(daily_members.new_members, 0)::bigint
                        AS new_members
                FROM days
                LEFT JOIN daily_members ON daily_members.day = days.day
                ORDER BY days.day
            `,
            db.$queryRaw<AdminMemberRoleRow[]>`
                SELECT role, COUNT(*)::bigint AS member_count
                FROM "User"
                GROUP BY role
                ORDER BY member_count DESC, role ASC
            `,
            db.$queryRaw<AdminDemoInsightsRow[]>`
                WITH monitor_users AS (
                    SELECT DISTINCT "userId"
                    FROM monitors
                ),
                demo_users AS (
                    SELECT DISTINCT "userId"
                    FROM monitors
                    WHERE demo_expires_at IS NOT NULL

                    UNION

                    SELECT DISTINCT "userId"
                    FROM audit_events
                    WHERE "userId" IS NOT NULL
                      AND action IN (
                        'monitor.preset_created',
                        'monitor.demo_extended',
                        'monitor.demo_converted'
                      )

                    UNION

                    SELECT DISTINCT monitor."userId"
                    FROM monitor_events AS event
                    INNER JOIN monitors AS monitor
                        ON monitor.id = event.monitor_id
                    WHERE event.event_type = 'demo_auto_paused'
                ),
                active_demo_users AS (
                    SELECT DISTINCT "userId"
                    FROM monitors
                    WHERE demo_expires_at > NOW()
                      AND status = 'active'
                ),
                expired_demo_users AS (
                    SELECT DISTINCT "userId"
                    FROM monitors
                    WHERE demo_expires_at <= NOW()

                    UNION

                    SELECT DISTINCT monitor."userId"
                    FROM monitor_events AS event
                    INNER JOIN monitors AS monitor
                        ON monitor.id = event.monitor_id
                    WHERE event.event_type = 'demo_auto_paused'
                ),
                converted_demo_users AS (
                    SELECT DISTINCT "userId"
                    FROM audit_events
                    WHERE "userId" IS NOT NULL
                      AND action = 'monitor.demo_converted'
                )
                SELECT
                    (SELECT COUNT(*) FROM monitor_users)::bigint
                        AS users_with_monitors,
                    (SELECT COUNT(*) FROM demo_users)::bigint AS demo_users,
                    (SELECT COUNT(*) FROM active_demo_users)::bigint
                        AS active_demo_users,
                    (SELECT COUNT(*) FROM expired_demo_users)::bigint
                        AS expired_demo_users,
                    (SELECT COUNT(*) FROM converted_demo_users)::bigint
                        AS converted_demo_users
            `,
            db.user.findMany({
                where: { createdAt: { not: null } },
                orderBy: { createdAt: "desc" },
                take: 8,
                select: {
                    id: true,
                    name: true,
                    email: true,
                    role: true,
                    createdAt: true,
                    _count: { select: { monitors: true } },
                },
            }),
        ]);

    const summary = summaryRows[0];
    const demo = demoRows[0];
    const totalMembers = Number(summary?.total_members ?? 0);
    const newMembers7d = Number(summary?.new_members_7d ?? 0);
    const previous7d = Number(summary?.new_members_previous_7d ?? 0);
    const newMembers30d = Number(summary?.new_members_30d ?? 0);
    const previous30d = Number(summary?.new_members_previous_30d ?? 0);
    const usersWithMonitors = Number(demo?.users_with_monitors ?? 0);
    const demoUsers = Number(demo?.demo_users ?? 0);
    const convertedDemoUsers = Number(demo?.converted_demo_users ?? 0);

    return {
        summary: {
            totalMembers,
            newMembers7d,
            signupGrowth7d:
                previous7d > 0
                    ? Math.round(
                          ((newMembers7d - previous7d) / previous7d) * 100,
                      )
                    : null,
            newMembers30d,
            signupGrowth30d:
                previous30d > 0
                    ? Math.round(
                          ((newMembers30d - previous30d) / previous30d) * 100,
                      )
                    : null,
            membersWithoutSignupDate: Number(
                summary?.members_without_signup_date ?? 0,
            ),
            usersWithMonitors,
            activationRate:
                totalMembers > 0
                    ? Math.round((usersWithMonitors / totalMembers) * 100)
                    : 0,
        },
        growth: growthRows.map((row) => ({
            date: row.day.toISOString().slice(0, 10),
            newMembers: Number(row.new_members),
        })),
        roles: roleRows.map((row) => ({
            role: row.role,
            count: Number(row.member_count),
        })),
        demo: {
            users: demoUsers,
            activeUsers: Number(demo?.active_demo_users ?? 0),
            expiredUsers: Number(demo?.expired_demo_users ?? 0),
            convertedUsers: convertedDemoUsers,
            adoptionRate:
                totalMembers > 0
                    ? Math.round((demoUsers / totalMembers) * 100)
                    : 0,
            conversionRate:
                demoUsers > 0
                    ? Math.round((convertedDemoUsers / demoUsers) * 100)
                    : 0,
        },
        recentMembers: recentMembers.map(({ _count, ...member }) => ({
            ...member,
            monitorCount: _count.monitors,
            createdAt: member.createdAt?.toISOString() ?? null,
        })),
    };
}

const getCachedAdminMemberInsights = unstable_cache(
    loadAdminMemberInsights,
    ["admin-member-insights-v3"],
    { revalidate: 60 },
);

function canonicalProxyUrl(value: string | URL) {
    let url: URL;
    try {
        url = typeof value === "string" ? new URL(value) : value;
    } catch {
        return String(value);
    }
    const serialized = url.toString();

    if (url.pathname === "/" && !url.search && !url.hash) {
        return serialized.slice(0, -1);
    }

    return serialized;
}

async function requireAdmin() {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");
    if (session.user.role !== "admin") throw new Error("Forbidden");
    return session.user.id;
}

function validateProxyLine(
    line: string,
    defaultScheme = "http",
): string | null {
    line = line.trim();
    if (!line) return null;

    if (/^(https?|socks[45]):\/\//.test(line)) {
        try {
            const url = new URL(line);
            if (!VALID_PROXY_SCHEMES.includes(url.protocol.replace(":", ""))) {
                return null;
            }
            if (!url.hostname || !url.port) return null;
            return line;
        } catch {
            return null;
        }
    }

    const parts = line.split(":");

    if (parts.length >= 4) {
        const pass = parts[parts.length - 1];
        const user = parts[parts.length - 2];
        const port = parts[parts.length - 3];
        const host = parts.slice(0, parts.length - 3).join(":");
        if (!host || !port || !user || !pass) return null;
        if (!/^\d{1,5}$/.test(port)) return null;
        return `http://${user}:${pass}@${host}:${port}`;
    }

    if (parts.length === 2 && /^\d{1,5}$/.test(parts[1])) {
        return `${defaultScheme}://${line}`;
    }

    return null;
}

function parseProxyLine(
    line: string,
    defaultScheme = "http",
): ParsedProxy | null {
    const normalized = validateProxyLine(line, defaultScheme);
    if (!normalized) return null;

    try {
        const url = new URL(normalized);
        const protocol = url.protocol.replace(":", "");
        const port = Number(url.port);
        if (!VALID_PROXY_SCHEMES.includes(protocol)) return null;
        if (
            !url.hostname ||
            !Number.isInteger(port) ||
            port < 1 ||
            port > 65535
        ) {
            return null;
        }

        return {
            proxyUrl: canonicalProxyUrl(url),
            protocol,
            host: url.hostname,
            port,
        };
    } catch {
        return null;
    }
}

function validateProxies(text: string) {
    const lines = text.split("\n").filter((line) => line.trim().length > 0);
    const valid: string[] = [];
    const invalid: string[] = [];

    for (const line of lines) {
        const parsed = validateProxyLine(line);
        if (parsed) {
            valid.push(line.trim());
        } else {
            invalid.push(line.trim());
        }
    }

    return { valid, invalid, total: lines.length };
}

function parseBooleanSetting(value: string | undefined, fallback = false) {
    if (value === undefined) return fallback;
    return value === "true";
}

function parsePositiveIntSetting(
    value: string | undefined,
    fallback: number,
    min: number,
    max: number,
) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
}

async function getFreeProxySettings(): Promise<FreeProxySettings> {
    const keys = [
        FREE_PROXY_ENABLED_KEY,
        FREE_PROXY_AUTO_IMPORT_ENABLED_KEY,
        FREE_PROXY_IMPORT_SOURCE_KEY,
        FREE_PROXY_IMPORT_URL_KEY,
        FREE_PROXY_MAX_POOL_SIZE_KEY,
        FREE_PROXY_FAILURE_THRESHOLD_KEY,
        FREE_PROXY_QUARANTINE_MINUTES_KEY,
        FREE_PROXY_MIN_ACTIVE_PER_REGION_KEY,
        FREE_PROXY_TARGET_ACTIVE_PER_REGION_KEY,
        FREE_PROXY_MAX_LATENCY_MS_KEY,
        FREE_PROXY_STARTER_REGIONS_KEY,
    ];
    const rows = await db.app_settings.findMany({
        where: { key: { in: keys } },
        select: { key: true, value: true },
    });
    const values = Object.fromEntries(rows.map((row) => [row.key, row.value]));

    const importSource =
        values[FREE_PROXY_IMPORT_SOURCE_KEY] ??
        DEFAULT_FREE_PROXY_IMPORT_SOURCE;
    const importUrl =
        importSource === "custom"
            ? (values[FREE_PROXY_IMPORT_URL_KEY] ??
              DEFAULT_FREE_PROXY_IMPORT_URL)
            : (FREE_PROXY_SOURCE_URLS[importSource] ??
              values[FREE_PROXY_IMPORT_URL_KEY] ??
              DEFAULT_FREE_PROXY_IMPORT_URL);

    return {
        enabled: parseBooleanSetting(values[FREE_PROXY_ENABLED_KEY], false),
        autoImportEnabled: parseBooleanSetting(
            values[FREE_PROXY_AUTO_IMPORT_ENABLED_KEY],
            false,
        ),
        importSource,
        importUrl,
        maxPoolSize: parsePositiveIntSetting(
            values[FREE_PROXY_MAX_POOL_SIZE_KEY],
            DEFAULT_FREE_PROXY_MAX_POOL_SIZE,
            1,
            20000,
        ),
        failureThreshold: parsePositiveIntSetting(
            values[FREE_PROXY_FAILURE_THRESHOLD_KEY],
            DEFAULT_FREE_PROXY_FAILURE_THRESHOLD,
            1,
            20,
        ),
        quarantineMinutes: parsePositiveIntSetting(
            values[FREE_PROXY_QUARANTINE_MINUTES_KEY],
            DEFAULT_FREE_PROXY_QUARANTINE_MINUTES,
            1,
            1440,
        ),
        minActivePerRegion: parsePositiveIntSetting(
            values[FREE_PROXY_MIN_ACTIVE_PER_REGION_KEY],
            DEFAULT_FREE_PROXY_MIN_ACTIVE_PER_REGION,
            1,
            1000,
        ),
        targetActivePerRegion: parsePositiveIntSetting(
            values[FREE_PROXY_TARGET_ACTIVE_PER_REGION_KEY],
            DEFAULT_FREE_PROXY_TARGET_ACTIVE_PER_REGION,
            1,
            2000,
        ),
        maxLatencyMs: parsePositiveIntSetting(
            values[FREE_PROXY_MAX_LATENCY_MS_KEY],
            DEFAULT_FREE_PROXY_MAX_LATENCY_MS,
            500,
            15000,
        ),
        starterRegions:
            values[FREE_PROXY_STARTER_REGIONS_KEY] ??
            DEFAULT_FREE_PROXY_STARTER_REGIONS,
    };
}

async function setAppSetting(key: string, value: string) {
    await db.app_settings.upsert({
        where: { key },
        create: { key, value },
        update: { value },
    });
}

async function upsertFreeProxies(proxies: ParsedProxy[], source: string) {
    if (proxies.length === 0) return 0;

    const unique = Array.from(
        new Map(proxies.map((proxy) => [proxy.proxyUrl, proxy])).values(),
    );
    let affectedCount = 0;

    for (
        let offset = 0;
        offset < unique.length;
        offset += FREE_PROXY_WRITE_BATCH_SIZE
    ) {
        const batch = unique.slice(
            offset,
            offset + FREE_PROXY_WRITE_BATCH_SIZE,
        );
        const values = batch.map(
            (proxy) => Prisma.sql`(
                ${proxy.proxyUrl},
                ${proxy.protocol},
                ${proxy.host},
                ${proxy.port},
                ${source},
                'pending'
            )`,
        );

        affectedCount += await db.$executeRaw`
            INSERT INTO free_proxies (
                proxy_url,
                protocol,
                host,
                port,
                source,
                status
            )
            VALUES ${Prisma.join(values)}
            ON CONFLICT (proxy_url) DO UPDATE
            SET protocol = EXCLUDED.protocol,
                host = EXCLUDED.host,
                port = EXCLUDED.port,
                source = EXCLUDED.source,
                last_error = NULL,
                quarantined_until = NULL,
                updated_at = NOW()
        `;
    }

    return affectedCount;
}

function sourceLabelForImport(source: string, importUrl: string) {
    const country = iplocateCountryFromImportUrl(importUrl);
    if (country) return `iplocate:${country}`;
    if (source.startsWith("iplocate") || importUrl.includes("iplocate")) {
        return "iplocate";
    }
    if (source.startsWith("proxyscrape") || importUrl.includes("proxyscrape")) {
        return "proxyscrape";
    }
    return "manual";
}

function iplocateCountryFromImportUrl(importUrl: string) {
    const match = importUrl.match(/\/countries\/([a-z]{2})\//i);
    const country = match?.[1]?.toLowerCase();
    if (!country) return null;
    return country === "gb" ? "uk" : country;
}

function defaultSchemeForImport(source: string, importUrl: string) {
    if (
        source === "iplocate_socks4" ||
        importUrl.includes("/protocols/socks4")
    ) {
        return "socks4";
    }
    if (
        source === "iplocate_socks5" ||
        importUrl.includes("/protocols/socks5")
    ) {
        return "socks5";
    }
    if (source === "iplocate_https" || importUrl.includes("/protocols/https")) {
        return "https";
    }
    return "http";
}

function freeProxyImportUrls(settings: FreeProxySettings) {
    if (
        !settings.importUrl.includes(
            "raw.githubusercontent.com/iplocate/free-proxy-list/main",
        )
    ) {
        return [settings.importUrl];
    }

    const urls: string[] = [];
    const seen = new Set<string>();
    for (const region of settings.starterRegions.split(",")) {
        const normalizedRegion = region.trim().toLowerCase();
        const countryRegion =
            IPLocateCountryAliases[normalizedRegion] ?? normalizedRegion;
        if (!IPLocateSupportedCountryRegions.has(countryRegion)) continue;

        const country = countryRegion.toUpperCase();
        const countryUrl = `https://raw.githubusercontent.com/iplocate/free-proxy-list/main/countries/${country}/proxies.txt`;
        if (seen.has(countryUrl)) continue;
        seen.add(countryUrl);
        urls.push(countryUrl);
    }

    if (!seen.has(settings.importUrl)) urls.push(settings.importUrl);

    return urls;
}

export async function getServerProxies() {
    await requireAdmin();

    const rows = await db.$queryRaw<{ value: string }[]>`
        SELECT value FROM app_settings WHERE key = ${SERVER_PROXIES_SETTING_KEY}
    `;

    const proxies = rows[0]?.value ?? "";
    const proxyCount = proxies
        .split("\n")
        .filter((line) => line.trim().length > 0).length;

    return { proxies, proxyCount };
}

export async function updateServerProxies(formData: FormData) {
    await requireAdmin();

    const proxies = (formData.get("proxies") as string | null)?.trim() ?? "";
    const { valid, invalid, total } = validateProxies(proxies);

    if (total > 0 && valid.length === 0) {
        return {
            success: false,
            error: "No valid proxies found. Use format: host:port:user:pass or http://user:pass@host:port",
        };
    }

    if (invalid.length > 0) {
        console.warn(
            `[admin] server proxies: ${invalid.length}/${total} invalid lines skipped`,
        );
    }

    const value = valid.join("\n");

    try {
        await db.$executeRaw`
            INSERT INTO app_settings (key, value, updated_at)
            VALUES (${SERVER_PROXIES_SETTING_KEY}, ${value}, NOW())
            ON CONFLICT (key) DO UPDATE
            SET value = EXCLUDED.value,
                updated_at = NOW()
        `;
    } catch (error) {
        console.error("[admin] failed to update server proxies", error);
        return {
            success: false,
            error: "Failed to save server proxies. Make sure database migrations have been applied.",
        };
    }

    revalidatePath("/admin");

    return {
        success: true,
        proxyCount: valid.length,
        skippedCount: invalid.length,
    };
}

export async function getFreeProxyAdminState() {
    await requireAdmin();

    const [settings, counts, regionRows, recent] = await Promise.all([
        getFreeProxySettings(),
        db.$queryRaw<FreeProxyStatusCountRow[]>`
            SELECT status, COUNT(*)::bigint AS proxy_count
            FROM free_proxies
            GROUP BY status
        `,
        db.$queryRaw<FreeProxyRegionRow[]>`
            SELECT
                region,
                COUNT(*) FILTER (WHERE status = 'active')::bigint AS active_count,
                COUNT(*) FILTER (WHERE status = 'pending' AND success_streak > 0)::bigint AS warming_count,
                COUNT(*) FILTER (WHERE status = 'pending' AND success_streak = 0)::bigint AS pending_count,
                COUNT(*) FILTER (WHERE status = 'cooldown')::bigint AS cooldown_count,
                COUNT(*) FILTER (WHERE status = 'dead')::bigint AS dead_count,
                COUNT(*) FILTER (
                    WHERE last_checked_at >= NOW() - INTERVAL '24 hours'
                      AND last_status_code = 200
                      AND last_error IS NULL
                )::bigint AS recent_success_count,
                COUNT(*) FILTER (
                    WHERE last_checked_at >= NOW() - INTERVAL '24 hours'
                )::bigint AS recent_check_count,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms)
                    FILTER (WHERE latency_ms IS NOT NULL) AS median_latency_ms,
                MAX(last_checked_at) AS last_checked_at
            FROM free_proxy_health
            GROUP BY region
            ORDER BY region
        `,
        db.free_proxies.findMany({
            orderBy: [{ updated_at: "desc" }],
            take: 20,
            select: {
                id: true,
                proxy_url: true,
                protocol: true,
                source: true,
                status: true,
                success_count: true,
                failure_count: true,
                last_checked_at: true,
                last_success_at: true,
                last_failure_at: true,
                quarantined_until: true,
                last_error: true,
            },
        }),
    ]);

    const countsByStatus = Object.fromEntries(
        counts.map((row) => [row.status, Number(row.proxy_count)]),
    );
    const activeHealthCount = regionRows.reduce(
        (sum, row) => sum + Number(row.active_count),
        0,
    );
    const pendingHealthCount = regionRows.reduce(
        (sum, row) => sum + Number(row.pending_count),
        0,
    );
    const cooldownHealthCount = regionRows.reduce(
        (sum, row) => sum + Number(row.cooldown_count),
        0,
    );

    return {
        settings,
        counts: {
            active: activeHealthCount,
            pending: pendingHealthCount || (countsByStatus.pending ?? 0),
            quarantined:
                cooldownHealthCount + (countsByStatus.quarantined ?? 0),
            disabled: countsByStatus.disabled ?? 0,
            total: Object.values(countsByStatus).reduce(
                (sum, count) => sum + count,
                0,
            ),
        },
        regions: regionRows.map((row) => {
            const recentSuccessCount = Number(row.recent_success_count);
            const recentCheckCount = Number(row.recent_check_count);

            return {
                region: row.region,
                active: Number(row.active_count),
                warming: Number(row.warming_count),
                pending: Number(row.pending_count),
                cooldown: Number(row.cooldown_count),
                dead: Number(row.dead_count),
                successRate:
                    recentCheckCount > 0
                        ? Math.round(
                              (recentSuccessCount / recentCheckCount) * 100,
                          )
                        : null,
                medianLatencyMs:
                    row.median_latency_ms === null
                        ? null
                        : Math.round(row.median_latency_ms),
                lastCheckedAt: row.last_checked_at,
                healthy:
                    Number(row.active_count) + Number(row.warming_count) >=
                    settings.minActivePerRegion,
            };
        }),
        recent,
    };
}

export async function updateFreeProxySettings(formData: FormData) {
    await requireAdmin();

    const enabled = formData.get("enabled") === "true";
    const autoImportEnabled = formData.get("autoImportEnabled") === "true";
    const importSource =
        (formData.get("importSource") as string | null)?.trim() ||
        DEFAULT_FREE_PROXY_IMPORT_SOURCE;
    const requestedImportUrl =
        (formData.get("importUrl") as string | null)?.trim() ||
        DEFAULT_FREE_PROXY_IMPORT_URL;
    const importUrl =
        importSource === "custom"
            ? requestedImportUrl
            : (FREE_PROXY_SOURCE_URLS[importSource] ?? requestedImportUrl);
    const maxPoolSize = parsePositiveIntSetting(
        formData.get("maxPoolSize") as string | undefined,
        DEFAULT_FREE_PROXY_MAX_POOL_SIZE,
        1,
        20000,
    );
    const failureThreshold = parsePositiveIntSetting(
        formData.get("failureThreshold") as string | undefined,
        DEFAULT_FREE_PROXY_FAILURE_THRESHOLD,
        1,
        20,
    );
    const quarantineMinutes = parsePositiveIntSetting(
        formData.get("quarantineMinutes") as string | undefined,
        DEFAULT_FREE_PROXY_QUARANTINE_MINUTES,
        1,
        1440,
    );
    const minActivePerRegion = parsePositiveIntSetting(
        formData.get("minActivePerRegion") as string | undefined,
        DEFAULT_FREE_PROXY_MIN_ACTIVE_PER_REGION,
        1,
        1000,
    );
    const targetActivePerRegion = Math.min(
        maxPoolSize,
        Math.max(
            minActivePerRegion,
            parsePositiveIntSetting(
                formData.get("targetActivePerRegion") as string | undefined,
                DEFAULT_FREE_PROXY_TARGET_ACTIVE_PER_REGION,
                1,
                2000,
            ),
        ),
    );
    const maxLatencyMs = parsePositiveIntSetting(
        formData.get("maxLatencyMs") as string | undefined,
        DEFAULT_FREE_PROXY_MAX_LATENCY_MS,
        500,
        15000,
    );
    const starterRegionsValue = formData.get("starterRegions");
    const starterRegions = (
        typeof starterRegionsValue === "string"
            ? starterRegionsValue.trim()
            : DEFAULT_FREE_PROXY_STARTER_REGIONS
    )
        .split(",")
        .map((region) => region.trim().toLowerCase())
        .filter(Boolean)
        .join(",");

    try {
        new URL(importUrl);
    } catch {
        return { success: false, error: "Invalid import URL" };
    }

    await Promise.all([
        setAppSetting(FREE_PROXY_ENABLED_KEY, String(enabled)),
        setAppSetting(
            FREE_PROXY_AUTO_IMPORT_ENABLED_KEY,
            String(autoImportEnabled),
        ),
        setAppSetting(FREE_PROXY_IMPORT_SOURCE_KEY, importSource),
        setAppSetting(FREE_PROXY_IMPORT_URL_KEY, importUrl),
        setAppSetting(FREE_PROXY_MAX_POOL_SIZE_KEY, String(maxPoolSize)),
        setAppSetting(
            FREE_PROXY_FAILURE_THRESHOLD_KEY,
            String(failureThreshold),
        ),
        setAppSetting(
            FREE_PROXY_QUARANTINE_MINUTES_KEY,
            String(quarantineMinutes),
        ),
        setAppSetting(
            FREE_PROXY_MIN_ACTIVE_PER_REGION_KEY,
            String(minActivePerRegion),
        ),
        setAppSetting(
            FREE_PROXY_TARGET_ACTIVE_PER_REGION_KEY,
            String(targetActivePerRegion),
        ),
        setAppSetting(FREE_PROXY_MAX_LATENCY_MS_KEY, String(maxLatencyMs)),
        setAppSetting(FREE_PROXY_STARTER_REGIONS_KEY, starterRegions),
    ]);

    const activeMonitorRegions = await db.monitors.findMany({
        where: { status: "active", proxy_source: "free" },
        distinct: ["region"],
        select: { region: true },
    });
    const retainedRegions = Array.from(
        new Set([
            ...starterRegions.split(",").filter(Boolean),
            ...activeMonitorRegions.map((monitor) => monitor.region),
        ]),
    );
    if (retainedRegions.length > 0) {
        await db.free_proxy_health.deleteMany({
            where: { region: { notIn: retainedRegions } },
        });
    } else {
        await db.free_proxy_health.deleteMany();
    }

    revalidatePath("/admin");
    return { success: true };
}

export async function addFreeProxies(formData: FormData) {
    await requireAdmin();

    const text = (formData.get("proxies") as string | null) ?? "";
    const lines = text.split("\n").filter((line) => line.trim().length > 0);
    const parsed: ParsedProxy[] = [];
    let invalidCount = 0;

    for (const line of lines) {
        const proxy = parseProxyLine(line);
        if (proxy) {
            parsed.push(proxy);
        } else {
            invalidCount++;
        }
    }

    if (lines.length > 0 && parsed.length === 0) {
        return { success: false, error: "No valid proxies found" };
    }

    const addedCount = await upsertFreeProxies(parsed, "manual");

    revalidatePath("/admin");
    return { success: true, addedCount, skippedCount: invalidCount };
}

export async function importFreeProxiesNow() {
    await requireAdmin();

    const settings = await getFreeProxySettings();
    const existingProxyRows = await db.free_proxies.findMany({
        select: { proxy_url: true },
    });
    const existingProxyUrls = new Set(
        existingProxyRows.map((proxy) => canonicalProxyUrl(proxy.proxy_url)),
    );
    const remainingCapacity = Math.max(
        0,
        settings.maxPoolSize - existingProxyUrls.size,
    );

    if (remainingCapacity === 0) {
        return {
            success: true,
            addedCount: 0,
            skippedCount: 0,
            limitReached: true,
        };
    }

    let skippedCount = 0;
    let fetchedCount = 0;
    let addedCount = 0;
    const importUrls = freeProxyImportUrls(settings);
    const perSourceLimit = Math.ceil(
        remainingCapacity / Math.max(1, importUrls.length),
    );
    const seenProxyUrls = new Set<string>();

    for (const importUrl of importUrls) {
        if (seenProxyUrls.size >= remainingCapacity) break;
        let response: Response;
        try {
            response = await fetch(importUrl, {
                headers: { Accept: "text/plain,*/*" },
                cache: "no-store",
                signal: AbortSignal.timeout(15_000),
            });
        } catch (error) {
            console.error("[admin] failed to import free proxies", error);
            continue;
        }

        if (!response.ok) continue;
        fetchedCount++;

        const text = await response.text();
        const sourceProxies: ParsedProxy[] = [];
        const defaultScheme = defaultSchemeForImport(
            settings.importSource,
            importUrl,
        );
        for (const line of text.split("\n")) {
            if (
                seenProxyUrls.size >= remainingCapacity ||
                sourceProxies.length >= perSourceLimit
            ) {
                break;
            }
            if (!line.trim()) continue;
            const proxy = parseProxyLine(line, defaultScheme);
            if (proxy) {
                if (
                    existingProxyUrls.has(proxy.proxyUrl) ||
                    seenProxyUrls.has(proxy.proxyUrl)
                ) {
                    continue;
                }
                seenProxyUrls.add(proxy.proxyUrl);
                sourceProxies.push(proxy);
            } else {
                skippedCount++;
            }
        }

        addedCount += await upsertFreeProxies(
            sourceProxies,
            sourceLabelForImport(settings.importSource, importUrl),
        );
    }

    if (fetchedCount === 0) {
        return { success: false, error: "Failed to fetch proxy list" };
    }

    revalidatePath("/admin");
    return {
        success: true,
        addedCount,
        skippedCount,
        limitReached:
            existingProxyUrls.size + addedCount >= settings.maxPoolSize,
    };
}

export async function clearFreeProxyQuarantine() {
    await requireAdmin();

    const [proxyResult, healthResult] = await Promise.all([
        db.free_proxies.updateMany({
            where: { status: "quarantined" },
            data: {
                status: "pending",
                failure_count: 0,
                last_error: null,
                quarantined_until: null,
            },
        }),
        db.free_proxy_health.updateMany({
            where: { status: "cooldown" },
            data: {
                status: "pending",
                failure_streak: 0,
                last_error: null,
                next_check_at: new Date(),
            },
        }),
    ]);

    revalidatePath("/admin");
    return {
        success: true,
        restoredCount: proxyResult.count + healthResult.count,
    };
}

export async function getUsers() {
    await requireAdmin();

    const users = await db.user.findMany({
        orderBy: { name: "asc" },
        select: {
            id: true,
            name: true,
            email: true,
            image: true,
            role: true,
            _count: {
                select: {
                    monitors: true,
                    proxy_groups: true,
                },
            },
        },
    });

    return users;
}

export async function getAdminUsersState() {
    await requireAdmin();

    const [users, userLimitRows] = await Promise.all([
        db.user.findMany({
            orderBy: { name: "asc" },
            select: {
                id: true,
                name: true,
                email: true,
                image: true,
                role: true,
                _count: {
                    select: {
                        monitors: true,
                        proxy_groups: true,
                    },
                },
            },
        }),
        db.monitor_limits.findMany({
            where: { scope: { startsWith: USER_MONITOR_LIMIT_PREFIX } },
            select: { scope: true, active_limit: true },
        }),
    ]);

    return {
        users: users.map((user) => ({
            ...user,
            monitors: [],
            activeMonitors: [],
            metrics: emptyAdminUserMetrics(),
        })),
        userLimits: Object.fromEntries(
            userLimitRows.map((row) => [
                row.scope.slice(USER_MONITOR_LIMIT_PREFIX.length),
                row.active_limit,
            ]),
        ),
    };
}

export async function getAdminUserMetricsState() {
    await requireAdmin();

    const metricEntries = await getCachedAdminUserMetrics();

    return Object.fromEntries(
        metricEntries.map(([userId, metrics]) => [
            userId,
            {
                ...metrics,
                lastCheckAt: metrics.lastCheckAt
                    ? new Date(metrics.lastCheckAt)
                    : null,
            },
        ]),
    );
}

export async function getAdminMemberInsights() {
    await requireAdmin();
    return getCachedAdminMemberInsights();
}

export async function getAdminActiveMonitors() {
    await requireAdmin();

    const monitors = await db.monitors.findMany({
        where: { status: "active" },
        orderBy: { created_at: "desc" },
        select: {
            id: true,
            userId: true,
            name: true,
            query: true,
            query_delay_ms: true,
            status: true,
            region: true,
            created_at: true,
            price_min: true,
            price_max: true,
            discord_webhook: true,
            webhook_active: true,
            telegram_active: true,
            proxy_group: {
                select: {
                    name: true,
                },
            },
            _count: {
                select: {
                    items: true,
                },
            },
        },
    });

    return monitors.map(({ discord_webhook, ...monitor }) => ({
        ...monitor,
        discord_configured: Boolean(discord_webhook),
    }));
}

export async function getAdminUserDetails(userId: string) {
    await requireAdmin();

    const user = await db.user.findUnique({
        where: { id: userId },
        select: {
            id: true,
            monitors: {
                orderBy: [{ status: "asc" }, { created_at: "desc" }],
                select: {
                    id: true,
                    name: true,
                    query: true,
                    query_delay_ms: true,
                    status: true,
                    region: true,
                    created_at: true,
                    price_min: true,
                    price_max: true,
                    discord_webhook: true,
                    webhook_active: true,
                    telegram_active: true,
                    proxy_group: {
                        select: {
                            name: true,
                        },
                    },
                    _count: {
                        select: {
                            items: true,
                        },
                    },
                },
            },
        },
    });

    if (!user) throw new Error("User not found");

    return user.monitors;
}

export async function getAdminLogs() {
    await requireAdmin();

    const logs: {
        id: string;
        type: "audit" | "monitor" | "alert";
        title: string;
        detail: string | null;
        status: string;
        subject: string | null;
        actor: string | null;
        createdAt: Date;
    }[] = [];

    try {
        const auditRows = await db.audit_events.findMany({
            orderBy: { created_at: "desc" },
            take: 60,
            select: {
                id: true,
                action: true,
                target_type: true,
                target_id: true,
                status: true,
                created_at: true,
                user: { select: { name: true, email: true } },
            },
        });

        logs.push(
            ...auditRows.map((row) => ({
                id: `audit-${row.id.toString()}`,
                type: "audit" as const,
                title: row.action,
                detail: row.target_type
                    ? `${row.target_type}${row.target_id ? ` #${row.target_id}` : ""}`
                    : null,
                status: row.status,
                subject: row.target_id,
                actor: row.user?.name ?? row.user?.email ?? null,
                createdAt: row.created_at,
            })),
        );
    } catch (error) {
        console.error("[admin] failed to load audit logs", error);
    }

    try {
        const monitorRows = await db.monitor_events.findMany({
            orderBy: { created_at: "desc" },
            take: 60,
            select: {
                id: true,
                event_type: true,
                severity: true,
                message: true,
                created_at: true,
                monitor: {
                    select: {
                        name: true,
                        user: { select: { name: true, email: true } },
                    },
                },
            },
        });

        logs.push(
            ...monitorRows.map((row) => ({
                id: `monitor-${row.id.toString()}`,
                type: "monitor" as const,
                title: row.event_type,
                detail: row.message,
                status: row.severity,
                subject: row.monitor.name,
                actor: row.monitor.user.name ?? row.monitor.user.email ?? null,
                createdAt: row.created_at,
            })),
        );
    } catch (error) {
        console.error("[admin] failed to load monitor logs", error);
    }

    try {
        const alertRows = await db.$queryRaw<AlertIssueSummaryRow[]>`
            SELECT
                channel,
                status,
                failure_reason,
                COUNT(*)::bigint AS event_count,
                MAX(created_at) AS last_seen_at
            FROM alert_events
            WHERE created_at >= NOW() - INTERVAL '24 hours'
              AND (
                status <> 'success'
                OR failure_reason IS NOT NULL
              )
            GROUP BY channel, status, failure_reason
            ORDER BY event_count DESC, last_seen_at DESC
            LIMIT 20
        `;

        logs.push(
            ...alertRows.map((row) => ({
                id: `alert-${row.channel}-${row.status}-${row.failure_reason ?? "unknown"}`,
                type: "alert" as const,
                title: `${row.channel} alert issues`,
                detail: `${Number(row.event_count)} event${Number(row.event_count) === 1 ? "" : "s"} in 24h${row.failure_reason ? ` · ${row.failure_reason}` : ""}`,
                status: row.status,
                subject: "24h summary",
                actor: null,
                createdAt: row.last_seen_at,
            })),
        );
    } catch (error) {
        console.error("[admin] failed to load alert logs", error);
    }

    return logs
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, 100);
}

async function sendPausedWebhook(
    name: string,
    monitorId: number,
    webhookUrl: string,
) {
    try {
        const payload = {
            username: "Vintrack Monitor",
            avatar_url:
                "https://cdn-icons-png.flaticon.com/512/8266/8266540.png",
            embeds: [
                {
                    title: "⏸️ Monitor Paused",
                    description: `The monitor **${name}** has been paused via User Management.`,
                    color: 16753920,
                    footer: {
                        text: "Vintrack • Status Update",
                        icon_url:
                            "https://cdn-icons-png.flaticon.com/512/8266/8266540.png",
                    },
                    timestamp: new Date().toISOString(),
                },
            ],
        };

        await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
    } catch (error) {
        console.error(
            "Failed to send admin pause webhook for",
            monitorId,
            error,
        );
    }
}

async function sendPausedTelegram(
    name: string,
    monitorId: number,
    userId: string,
) {
    const connection = await getTelegramConnection(userId);
    if (!connection) return;

    const result = await sendTelegramMessage(
        connection.chat_id,
        monitorStatusTelegramText(name, "paused"),
    );
    if ("error" in result) {
        console.error(
            "Failed to send admin pause Telegram message for",
            monitorId,
            result.error,
        );
    }
}

export async function setUserRole(userId: string, role: string) {
    await requireAdmin();

    const validRoles = ["free", "premium", "admin"];
    if (!validRoles.includes(role)) throw new Error("Invalid role");

    await db.user.update({
        where: { id: userId },
        data: { role },
    });

    revalidatePath("/admin");
}

export async function setGlobalActiveMonitorLimit(value: string) {
    await requireAdmin();

    await setMonitorLimit(
        GLOBAL_MONITOR_LIMIT_SCOPE,
        normalizeMonitorLimitInput(value),
    );

    revalidatePath("/admin");
}

export async function setRoleActiveMonitorLimit(role: string, value: string) {
    await requireAdmin();

    const validRoles = ["free", "premium"];
    if (!validRoles.includes(role)) throw new Error("Invalid role");

    await setMonitorLimit(
        roleLimitScope(role),
        normalizeMonitorLimitInput(value),
    );

    revalidatePath("/admin");
}

export async function setUserActiveMonitorLimit(userId: string, value: string) {
    await requireAdmin();

    const user = await db.user.findUnique({
        where: { id: userId },
        select: { id: true, role: true },
    });
    if (!user) throw new Error("User not found");
    if (user.role === "admin") {
        throw new Error("Admins are always unlimited");
    }

    await setMonitorLimit(
        userLimitScope(userId),
        normalizeMonitorLimitInput(value),
    );

    revalidatePath("/admin");
}

export async function stopUserActiveMonitors(userId: string) {
    await requireAdmin();

    const monitorsToStop = await db.monitors.findMany({
        where: { userId, status: "active" },
        select: {
            id: true,
            name: true,
            userId: true,
            discord_webhook: true,
            webhook_active: true,
            telegram_active: true,
        },
    });

    if (monitorsToStop.length === 0) {
        return { success: true, stoppedCount: 0 };
    }

    await db.monitors.updateMany({
        where: { userId, status: "active" },
        data: { status: "paused" },
    });

    Promise.all(
        monitorsToStop.map(async (monitor) => {
            if (monitor.discord_webhook && monitor.webhook_active) {
                await sendPausedWebhook(
                    monitor.name,
                    monitor.id,
                    monitor.discord_webhook,
                );
            }
            if (monitor.telegram_active) {
                await sendPausedTelegram(
                    monitor.name,
                    monitor.id,
                    monitor.userId,
                );
            }
        }),
    ).catch(console.error);

    revalidatePath("/admin");

    return {
        success: true,
        stoppedCount: monitorsToStop.length,
    };
}

export async function stopSingleUserMonitor(userId: string, monitorId: number) {
    await requireAdmin();

    const monitor = await db.monitors.findFirst({
        where: {
            id: monitorId,
            userId,
            status: "active",
        },
        select: {
            id: true,
            name: true,
            userId: true,
            discord_webhook: true,
            webhook_active: true,
            telegram_active: true,
        },
    });

    if (!monitor) {
        return { success: true, stopped: false };
    }

    await db.monitors.update({
        where: { id: monitorId, userId },
        data: { status: "paused" },
    });

    if (monitor.discord_webhook && monitor.webhook_active) {
        sendPausedWebhook(
            monitor.name,
            monitor.id,
            monitor.discord_webhook,
        ).catch(console.error);
    }
    if (monitor.telegram_active) {
        sendPausedTelegram(monitor.name, monitor.id, monitor.userId).catch(
            console.error,
        );
    }

    revalidatePath("/admin");

    return { success: true, stopped: true };
}
