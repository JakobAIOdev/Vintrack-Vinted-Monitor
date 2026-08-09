"use server";

import { auth } from "@/auth";
import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { revalidatePath, unstable_cache } from "next/cache";
import { monitorStatusTelegramText, sendTelegramMessage } from "@/lib/telegram";
import { getTelegramConnection } from "@/lib/telegram-connection";
import {
    getMonitorActivationState,
    GLOBAL_MONITOR_LIMIT_SCOPE,
    normalizeMonitorLimitInput,
    roleLimitScope,
    setFreeProxyMonitorLimit,
    setMonitorLimit,
    USER_MONITOR_LIMIT_PREFIX,
    userLimitScope,
    withMonitorActivationLock,
} from "@/lib/monitor-limits";
import { logAuditEvent } from "@/lib/audit";

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
const FREE_PROXY_INVENTORY_LIMIT_KEY = "free_proxy_inventory_limit";
const FREE_PROXY_ACTIVE_CANDIDATE_LIMIT_KEY =
    "free_proxy_candidate_limit_active_region";
const FREE_PROXY_IDLE_CANDIDATE_LIMIT_KEY =
    "free_proxy_candidate_limit_idle_region";
const FREE_PROXY_READY_TARGET_KEY = "free_proxy_ready_target_active_region";
const FREE_PROXY_RESERVE_TARGET_KEY = "free_proxy_reserve_target_active_region";
const FREE_PROXY_IDLE_TARGET_KEY = "free_proxy_idle_region_target";
const FREE_PROXY_EMERGENCY_RECOVERY_KEY =
    "free_proxy_emergency_recovery_enabled";
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
const DEFAULT_FREE_PROXY_INVENTORY_LIMIT = 30000;
const DEFAULT_FREE_PROXY_ACTIVE_CANDIDATE_LIMIT = 10000;
const DEFAULT_FREE_PROXY_IDLE_CANDIDATE_LIMIT = 5000;
const DEFAULT_FREE_PROXY_READY_TARGET = 50;
const DEFAULT_FREE_PROXY_RESERVE_TARGET = 50;
const DEFAULT_FREE_PROXY_IDLE_TARGET = 10;
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
    inventoryLimit: number;
    activeCandidateLimit: number;
    idleCandidateLimit: number;
    readyTarget: number;
    reserveTarget: number;
    idleTarget: number;
    emergencyRecoveryEnabled: boolean;
};

type FreeProxyRegionRow = {
    region: string;
    active_count: bigint;
    reserve_count: bigint;
    warming_count: bigint;
    pending_count: bigint;
    cooldown_count: bigint;
    dead_count: bigint;
    recent_success_count: bigint;
    recent_check_count: bigint;
    median_latency_ms: number | null;
    last_checked_at: Date | null;
    stalled: boolean;
    top_error_stage: string | null;
    candidate_window: bigint;
    checked_last_hour: bigint;
    promoted_last_hour: bigint;
    minutes_since_last_success: number | null;
    active_monitor_count: bigint;
    due_now_count: bigint;
    never_checked_count: bigint;
};

type FreeProxySourceDiagnosticRow = {
    region: string;
    source: string;
    protocol: string;
    proxy_count: bigint;
    checked_count: bigint;
    successful_count: bigint;
    never_checked_count: bigint;
    active_count: bigint;
    reserve_count: bigint;
    cooldown_count: bigint;
    top_error_code: string | null;
    top_error_stage: string | null;
};

type FreeProxyMaintainerRuntime = {
    status: string;
    heartbeatAt: string;
    startedAt: string;
    concurrency: number;
    perRegionConcurrency: number;
    batchPerRegion: number;
    bootstrapBatchPerRegion: number;
    checked: number;
    passed: number;
    failed: number;
    canceled: number;
    durationMs: number;
};

function parseFreeProxyMaintainerRuntime(
    value: string | undefined,
): FreeProxyMaintainerRuntime | null {
    if (!value) return null;
    try {
        const parsed = JSON.parse(value) as Partial<FreeProxyMaintainerRuntime>;
        if (!parsed.heartbeatAt || !parsed.status) return null;
        return {
            status: parsed.status,
            heartbeatAt: parsed.heartbeatAt,
            startedAt: parsed.startedAt ?? parsed.heartbeatAt,
            concurrency: Number(parsed.concurrency ?? 0),
            perRegionConcurrency: Number(parsed.perRegionConcurrency ?? 0),
            batchPerRegion: Number(parsed.batchPerRegion ?? 0),
            bootstrapBatchPerRegion: Number(
                parsed.bootstrapBatchPerRegion ?? 0,
            ),
            checked: Number(parsed.checked ?? 0),
            passed: Number(parsed.passed ?? 0),
            failed: Number(parsed.failed ?? 0),
            canceled: Number(parsed.canceled ?? 0),
            durationMs: Number(parsed.durationMs ?? 0),
        };
    } catch {
        return null;
    }
}

type ParsedProxy = {
    proxyUrl: string;
    protocol: string;
    host: string;
    port: number;
};

type AdminMetricCountRow = {
    userId: string;
    running_monitors?: bigint;
    running_free_proxy_monitors?: bigint;
    paused_monitors?: bigint;
    new_items_24h?: bigint;
    checks_24h?: bigint;
    successful_checks_24h?: bigint;
    failed_checks_24h?: bigint;
    avg_duration_ms_24h?: number | null;
    last_check_at?: Date | null;
    latest_error_24h?: string | null;
    current_runtime_seconds?: bigint;
    total_runtime_seconds?: bigint;
    oldest_active_since?: Date | null;
};

type AdminUserMetrics = {
    runningMonitors: number;
    runningFreeProxyMonitors: number;
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
    currentRuntimeSeconds: number;
    totalRuntimeSeconds: number;
    oldestActiveSince: Date | null;
};

type CachedAdminUserMetrics = Omit<
    AdminUserMetrics,
    "lastCheckAt" | "oldestActiveSince"
> & {
    lastCheckAt: string | null;
    oldestActiveSince: string | null;
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
        runningFreeProxyMonitors: 0,
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
        currentRuntimeSeconds: 0,
        totalRuntimeSeconds: 0,
        oldestActiveSince: null,
    };
}

async function loadAdminUserMetrics() {
    const metrics = new Map<string, AdminUserMetrics>();
    const rows = await db.$queryRaw<AdminMetricCountRow[]>`
        WITH monitor_totals AS (
            SELECT
                "userId",
                COUNT(*) FILTER (WHERE status = 'active')::bigint AS running_monitors,
                COUNT(*) FILTER (
                    WHERE status = 'active' AND proxy_source = 'free'
                )::bigint AS running_free_proxy_monitors,
                COUNT(*) FILTER (WHERE status IS DISTINCT FROM 'active')::bigint AS paused_monitors
                ,COALESCE(SUM(
                    CASE
                        WHEN status = 'active' AND active_since IS NOT NULL
                        THEN GREATEST(
                            0,
                            FLOOR(EXTRACT(EPOCH FROM (NOW() - active_since)))
                        )
                        ELSE 0
                    END
                ), 0)::bigint AS current_runtime_seconds
                ,MIN(active_since) FILTER (
                    WHERE status = 'active' AND active_since IS NOT NULL
                ) AS oldest_active_since
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
            member.id AS "userId",
            COALESCE(monitor_totals.running_monitors, 0)::bigint
                AS running_monitors,
            COALESCE(monitor_totals.running_free_proxy_monitors, 0)::bigint
                AS running_free_proxy_monitors,
            COALESCE(monitor_totals.paused_monitors, 0)::bigint
                AS paused_monitors,
            COALESCE(run_totals.checks_24h, 0)::bigint AS checks_24h,
            COALESCE(run_totals.successful_checks_24h, 0)::bigint
                AS successful_checks_24h,
            COALESCE(run_totals.failed_checks_24h, 0)::bigint
                AS failed_checks_24h,
            COALESCE(run_totals.new_items_24h, 0)::bigint AS new_items_24h,
            run_totals.avg_duration_ms_24h,
            run_totals.last_check_at,
            run_totals.latest_error_24h
            ,COALESCE(monitor_totals.current_runtime_seconds, 0)::bigint
                AS current_runtime_seconds
            ,(
                COALESCE(runtime_totals.closed_runtime_seconds, 0) +
                COALESCE(monitor_totals.current_runtime_seconds, 0)
            )::bigint AS total_runtime_seconds
            ,monitor_totals.oldest_active_since
        FROM "User" member
        LEFT JOIN monitor_totals
            ON monitor_totals."userId" = member.id
        LEFT JOIN run_totals
            ON run_totals."userId" = member.id
        LEFT JOIN member_monitor_runtime_totals runtime_totals
            ON runtime_totals.user_id = member.id
    `.catch((error) => {
        console.error("[admin] failed to load hourly user metrics", error);
        return [];
    });

    for (const row of rows) {
        const current = metrics.get(row.userId) ?? emptyAdminUserMetrics();
        current.runningMonitors = Number(row.running_monitors ?? 0);
        current.runningFreeProxyMonitors = Number(
            row.running_free_proxy_monitors ?? 0,
        );
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
        current.currentRuntimeSeconds = Number(
            row.current_runtime_seconds ?? 0,
        );
        current.totalRuntimeSeconds = Number(row.total_runtime_seconds ?? 0);
        current.oldestActiveSince = row.oldest_active_since ?? null;
        metrics.set(row.userId, current);
    }

    return Array.from(metrics.entries()).map(
        ([userId, values]) =>
            [
                userId,
                {
                    ...values,
                    lastCheckAt: values.lastCheckAt?.toISOString() ?? null,
                    oldestActiveSince:
                        values.oldestActiveSince?.toISOString() ?? null,
                },
            ] as [string, CachedAdminUserMetrics],
    );
}

const getCachedAdminUserMetrics = unstable_cache(
    loadAdminUserMetrics,
    ["admin-user-metrics-v7"],
    { revalidate: 30 },
);

type AdminOverviewSummaryRow = {
    total_users: bigint;
    free_users: bigint;
    premium_users: bigint;
    admin_users: bigint;
    total_monitors: bigint;
    running_monitors: bigint;
    paused_monitors: bigint;
    free_running: bigint;
    server_running: bigint;
    group_running: bigint;
    current_runtime_seconds: bigint;
    closed_runtime_seconds: bigint;
    oldest_active_since: Date | null;
    checks_24h: bigint;
    successful_checks_24h: bigint;
    failed_checks_24h: bigint;
    new_items_24h: bigint;
    users_at_limit: bigint;
    user_overrides: bigint;
    role_limits: bigint;
};

type AdminRuntimeMemberRow = {
    user_id: string;
    name: string | null;
    email: string | null;
    role: string;
    running_monitors: bigint;
    current_runtime_seconds: bigint;
    total_runtime_seconds: bigint;
};

async function loadAdminOverviewState() {
    const [summaryRows, topMemberRows, trackingSetting] = await Promise.all([
        db.$queryRaw<AdminOverviewSummaryRow[]>`
            WITH user_totals AS (
                SELECT
                    COUNT(*)::bigint AS total_users,
                    COUNT(*) FILTER (WHERE role = 'free')::bigint AS free_users,
                    COUNT(*) FILTER (WHERE role = 'premium')::bigint AS premium_users,
                    COUNT(*) FILTER (WHERE role = 'admin')::bigint AS admin_users
                FROM "User"
            ),
            monitor_totals AS (
                SELECT
                    COUNT(*)::bigint AS total_monitors,
                    COUNT(*) FILTER (WHERE status = 'active')::bigint
                        AS running_monitors,
                    COUNT(*) FILTER (WHERE status IS DISTINCT FROM 'active')::bigint
                        AS paused_monitors,
                    COUNT(*) FILTER (
                        WHERE status = 'active' AND proxy_source = 'free'
                    )::bigint AS free_running,
                    COUNT(*) FILTER (
                        WHERE status = 'active' AND proxy_source = 'server'
                    )::bigint AS server_running,
                    COUNT(*) FILTER (
                        WHERE status = 'active'
                          AND proxy_source NOT IN ('free', 'server')
                    )::bigint AS group_running,
                    COALESCE(SUM(
                        CASE
                            WHEN status = 'active' AND active_since IS NOT NULL
                            THEN GREATEST(
                                0,
                                FLOOR(EXTRACT(EPOCH FROM (NOW() - active_since)))
                            )
                            ELSE 0
                        END
                    ), 0)::bigint AS current_runtime_seconds,
                    MIN(active_since) FILTER (
                        WHERE status = 'active' AND active_since IS NOT NULL
                    ) AS oldest_active_since
                FROM monitors
            ),
            closed_runtime AS (
                SELECT COALESCE(SUM(closed_runtime_seconds), 0)::bigint
                    AS closed_runtime_seconds
                FROM member_monitor_runtime_totals
            ),
            run_totals AS (
                SELECT
                    COALESCE(SUM(check_count), 0)::bigint AS checks_24h,
                    COALESCE(SUM(successful_check_count), 0)::bigint
                        AS successful_checks_24h,
                    COALESCE(SUM(failed_check_count), 0)::bigint
                        AS failed_checks_24h,
                    COALESCE(SUM(new_item_count), 0)::bigint AS new_items_24h
                FROM monitor_run_hourly_stats
                WHERE fetch_source = 'canonical'
                  AND bucket_hour >=
                      DATE_TRUNC('hour', NOW()) - INTERVAL '23 hours'
            ),
            active_by_user AS (
                SELECT
                    "userId" AS user_id,
                    COUNT(*) FILTER (WHERE status = 'active')::bigint
                        AS active_count
                FROM monitors
                GROUP BY "userId"
            ),
            effective_limits AS (
                SELECT
                    member.id,
                    COALESCE(active_by_user.active_count, 0)::bigint
                        AS active_count,
                    COALESCE(
                        user_limit.active_limit,
                        role_limit.active_limit,
                        global_limit.active_limit
                    ) AS active_limit
                FROM "User" member
                LEFT JOIN active_by_user ON active_by_user.user_id = member.id
                LEFT JOIN monitor_limits user_limit
                    ON user_limit.scope = 'user:' || member.id
                LEFT JOIN monitor_limits role_limit
                    ON role_limit.scope = 'role:' || member.role
                LEFT JOIN monitor_limits global_limit
                    ON global_limit.scope = 'global'
                WHERE member.role <> 'admin'
            ),
            limit_totals AS (
                SELECT
                    (
                        SELECT COUNT(*)
                        FROM effective_limits
                        WHERE active_limit IS NOT NULL
                          AND active_count >= active_limit
                    )::bigint AS users_at_limit,
                    (
                        SELECT COUNT(*)
                        FROM monitor_limits
                        WHERE scope LIKE 'user:%'
                          AND active_limit IS NOT NULL
                    )::bigint AS user_overrides,
                    (
                        SELECT COUNT(*)
                        FROM monitor_limits
                        WHERE scope LIKE 'role:%'
                          AND active_limit IS NOT NULL
                    )::bigint AS role_limits
            )
            SELECT *
            FROM user_totals
            CROSS JOIN monitor_totals
            CROSS JOIN closed_runtime
            CROSS JOIN run_totals
            CROSS JOIN limit_totals
        `,
        db.$queryRaw<AdminRuntimeMemberRow[]>`
            WITH active_runtime AS (
                SELECT
                    "userId" AS user_id,
                    COUNT(*) FILTER (WHERE status = 'active')::bigint
                        AS running_monitors,
                    COALESCE(SUM(
                        CASE
                            WHEN status = 'active' AND active_since IS NOT NULL
                            THEN GREATEST(
                                0,
                                FLOOR(EXTRACT(EPOCH FROM (NOW() - active_since)))
                            )
                            ELSE 0
                        END
                    ), 0)::bigint AS current_runtime_seconds
                FROM monitors
                GROUP BY "userId"
            )
            SELECT
                member.id AS user_id,
                member.name,
                member.email,
                member.role,
                COALESCE(active_runtime.running_monitors, 0)::bigint
                    AS running_monitors,
                COALESCE(active_runtime.current_runtime_seconds, 0)::bigint
                    AS current_runtime_seconds,
                (
                    COALESCE(runtime.closed_runtime_seconds, 0) +
                    COALESCE(active_runtime.current_runtime_seconds, 0)
                )::bigint AS total_runtime_seconds
            FROM "User" member
            LEFT JOIN active_runtime ON active_runtime.user_id = member.id
            LEFT JOIN member_monitor_runtime_totals runtime
                ON runtime.user_id = member.id
            ORDER BY total_runtime_seconds DESC, member.id ASC
            LIMIT 5
        `,
        db.app_settings.findUnique({
            where: { key: "monitor_runtime_tracking_started_at" },
            select: { value: true },
        }),
    ]);

    const summary = summaryRows[0];
    const checks = Number(summary?.checks_24h ?? 0);
    const successful = Number(summary?.successful_checks_24h ?? 0);

    return {
        users: {
            total: Number(summary?.total_users ?? 0),
            free: Number(summary?.free_users ?? 0),
            premium: Number(summary?.premium_users ?? 0),
            admin: Number(summary?.admin_users ?? 0),
        },
        monitors: {
            total: Number(summary?.total_monitors ?? 0),
            running: Number(summary?.running_monitors ?? 0),
            paused: Number(summary?.paused_monitors ?? 0),
            sources: {
                free: Number(summary?.free_running ?? 0),
                server: Number(summary?.server_running ?? 0),
                group: Number(summary?.group_running ?? 0),
            },
        },
        activity24h: {
            checks,
            successfulChecks: successful,
            failedChecks: Number(summary?.failed_checks_24h ?? 0),
            newItems: Number(summary?.new_items_24h ?? 0),
            successRate:
                checks > 0 ? Math.round((successful / checks) * 100) : null,
        },
        runtime: {
            currentSeconds: Number(summary?.current_runtime_seconds ?? 0),
            totalSeconds: Number(
                (summary?.closed_runtime_seconds ?? BigInt(0)) +
                    (summary?.current_runtime_seconds ?? BigInt(0)),
            ),
            oldestActiveSince:
                summary?.oldest_active_since?.toISOString() ?? null,
            trackedSince: trackingSetting?.value ?? null,
        },
        limits: {
            usersAtLimit: Number(summary?.users_at_limit ?? 0),
            userOverrides: Number(summary?.user_overrides ?? 0),
            roleLimits: Number(summary?.role_limits ?? 0),
        },
        topMembers: topMemberRows.map((row) => ({
            userId: row.user_id,
            name: row.name,
            email: row.email,
            role: row.role,
            runningMonitors: Number(row.running_monitors),
            currentRuntimeSeconds: Number(row.current_runtime_seconds),
            totalRuntimeSeconds: Number(row.total_runtime_seconds),
        })),
    };
}

const getCachedAdminOverviewState = unstable_cache(
    loadAdminOverviewState,
    ["admin-overview-state-v1"],
    { revalidate: 30 },
);

type AdminRuntimeDailyRow = {
    day: Date;
    proxy_source: string;
    runtime_seconds: number;
};

type AdminRuntimeLeaderboardRow = AdminRuntimeMemberRow & {
    runtime_seconds_7d: number;
    checks_7d: bigint;
    new_items_7d: bigint;
};

async function loadAdminRuntimeInsights() {
    const [dailyRows, leaderboardRows, sessionRows, trackingSetting] =
        await Promise.all([
            db.$queryRaw<AdminRuntimeDailyRow[]>`
                WITH days AS (
                    SELECT GENERATE_SERIES(
                        DATE_TRUNC('day', NOW() AT TIME ZONE 'UTC') -
                            INTERVAL '29 days',
                        DATE_TRUNC('day', NOW() AT TIME ZONE 'UTC'),
                        INTERVAL '1 day'
                    )::timestamp AS day
                ),
                eligible_sessions AS (
                    SELECT proxy_source, started_at, ended_at
                    FROM monitor_runtime_sessions
                    WHERE ended_at >=
                        DATE_TRUNC('day', NOW() AT TIME ZONE 'UTC') -
                            INTERVAL '29 days'
                      AND started_at < NOW()

                    UNION ALL

                    SELECT proxy_source, started_at, ended_at
                    FROM monitor_runtime_sessions
                    WHERE ended_at IS NULL
                      AND started_at < NOW()
                )
                SELECT
                    days.day,
                    CASE
                        WHEN sessions.proxy_source = 'free' THEN 'free'
                        WHEN sessions.proxy_source = 'server' THEN 'server'
                        ELSE 'group'
                    END AS proxy_source,
                    COALESCE(SUM(GREATEST(
                        0,
                        EXTRACT(EPOCH FROM (
                            LEAST(
                                COALESCE(sessions.ended_at, NOW()),
                                days.day + INTERVAL '1 day'
                            ) - GREATEST(sessions.started_at, days.day)
                        ))
                    )), 0)::double precision AS runtime_seconds
                FROM days
                INNER JOIN eligible_sessions sessions
                    ON sessions.started_at < days.day + INTERVAL '1 day'
                   AND COALESCE(sessions.ended_at, NOW()) > days.day
                GROUP BY days.day, proxy_source
                ORDER BY days.day, proxy_source
            `,
            db.$queryRaw<AdminRuntimeLeaderboardRow[]>`
                WITH eligible_sessions AS (
                    SELECT user_id, started_at, ended_at
                    FROM monitor_runtime_sessions
                    WHERE ended_at >= NOW() - INTERVAL '7 days'
                      AND started_at < NOW()

                    UNION ALL

                    SELECT user_id, started_at, ended_at
                    FROM monitor_runtime_sessions
                    WHERE ended_at IS NULL
                      AND started_at < NOW()
                ),
                runtime_7d AS (
                    SELECT
                        user_id,
                        SUM(GREATEST(
                            0,
                            EXTRACT(EPOCH FROM (
                                LEAST(COALESCE(ended_at, NOW()), NOW()) -
                                GREATEST(started_at, NOW() - INTERVAL '7 days')
                            ))
                        ))::double precision AS runtime_seconds_7d
                    FROM eligible_sessions
                    GROUP BY user_id
                ),
                activity_7d AS (
                    SELECT
                        monitor."userId" AS user_id,
                        SUM(stats.check_count)::bigint AS checks_7d,
                        SUM(stats.new_item_count)::bigint AS new_items_7d
                    FROM monitor_run_hourly_stats stats
                    INNER JOIN monitors monitor ON monitor.id = stats.monitor_id
                    WHERE stats.fetch_source = 'canonical'
                      AND stats.bucket_hour >= NOW() - INTERVAL '7 days'
                    GROUP BY monitor."userId"
                ),
                active_runtime AS (
                    SELECT
                        "userId" AS user_id,
                        COUNT(*) FILTER (WHERE status = 'active')::bigint
                            AS running_monitors,
                        COALESCE(SUM(
                            CASE
                                WHEN status = 'active' AND active_since IS NOT NULL
                                THEN GREATEST(
                                    0,
                                    FLOOR(EXTRACT(EPOCH FROM (NOW() - active_since)))
                                )
                                ELSE 0
                            END
                        ), 0)::bigint AS current_runtime_seconds
                    FROM monitors
                    GROUP BY "userId"
                )
                SELECT
                    member.id AS user_id,
                    member.name,
                    member.email,
                    member.role,
                    COALESCE(active.running_monitors, 0)::bigint
                        AS running_monitors,
                    COALESCE(active.current_runtime_seconds, 0)::bigint
                        AS current_runtime_seconds,
                    (
                        COALESCE(totals.closed_runtime_seconds, 0) +
                        COALESCE(active.current_runtime_seconds, 0)
                    )::bigint AS total_runtime_seconds,
                    runtime.runtime_seconds_7d,
                    COALESCE(activity.checks_7d, 0)::bigint AS checks_7d,
                    COALESCE(activity.new_items_7d, 0)::bigint AS new_items_7d
                FROM runtime_7d runtime
                INNER JOIN "User" member ON member.id = runtime.user_id
                LEFT JOIN active_runtime active ON active.user_id = member.id
                LEFT JOIN member_monitor_runtime_totals totals
                    ON totals.user_id = member.id
                LEFT JOIN activity_7d activity ON activity.user_id = member.id
                ORDER BY runtime.runtime_seconds_7d DESC, member.id ASC
                LIMIT 10
            `,
            db.$queryRaw<{ median_seconds: number | null }[]>`
                SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (
                    ORDER BY EXTRACT(EPOCH FROM (ended_at - started_at))
                )::double precision AS median_seconds
                FROM monitor_runtime_sessions
                WHERE ended_at >= NOW() - INTERVAL '7 days'
                  AND ended_at IS NOT NULL
            `,
            db.app_settings.findUnique({
                where: { key: "monitor_runtime_tracking_started_at" },
                select: { value: true },
            }),
        ]);

    const dailyByDate = new Map<
        string,
        { date: string; freeSeconds: number; serverSeconds: number; groupSeconds: number }
    >();
    for (let offset = 29; offset >= 0; offset -= 1) {
        const date = new Date();
        date.setUTCHours(0, 0, 0, 0);
        date.setUTCDate(date.getUTCDate() - offset);
        const key = date.toISOString().slice(0, 10);
        dailyByDate.set(key, {
            date: key,
            freeSeconds: 0,
            serverSeconds: 0,
            groupSeconds: 0,
        });
    }
    for (const row of dailyRows) {
        const key = row.day.toISOString().slice(0, 10);
        const day = dailyByDate.get(key);
        if (!day) continue;
        if (row.proxy_source === "free") {
            day.freeSeconds = Number(row.runtime_seconds);
        } else if (row.proxy_source === "server") {
            day.serverSeconds = Number(row.runtime_seconds);
        } else {
            day.groupSeconds = Number(row.runtime_seconds);
        }
    }

    return {
        trackedSince: trackingSetting?.value ?? null,
        medianSessionSeconds7d: Number(sessionRows[0]?.median_seconds ?? 0),
        daily: Array.from(dailyByDate.values()),
        leaderboard: leaderboardRows.map((row) => {
            const runtimeSeconds7d = Number(row.runtime_seconds_7d);
            const runtimeHours = runtimeSeconds7d / 3600;
            const checks7d = Number(row.checks_7d);
            const newItems7d = Number(row.new_items_7d);
            return {
                userId: row.user_id,
                name: row.name,
                email: row.email,
                role: row.role,
                runningMonitors: Number(row.running_monitors),
                totalRuntimeSeconds: Number(row.total_runtime_seconds),
                runtimeSeconds7d,
                checks7d,
                newItems7d,
                checksPerRuntimeHour:
                    runtimeHours > 0 ? checks7d / runtimeHours : null,
                newItemsPer100RuntimeHours:
                    runtimeHours > 0
                        ? (newItems7d / runtimeHours) * 100
                        : null,
            };
        }),
    };
}

const getCachedAdminRuntimeInsights = unstable_cache(
    loadAdminRuntimeInsights,
    ["admin-runtime-insights-v1"],
    { revalidate: 60 },
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
        FREE_PROXY_INVENTORY_LIMIT_KEY,
        FREE_PROXY_ACTIVE_CANDIDATE_LIMIT_KEY,
        FREE_PROXY_IDLE_CANDIDATE_LIMIT_KEY,
        FREE_PROXY_READY_TARGET_KEY,
        FREE_PROXY_RESERVE_TARGET_KEY,
        FREE_PROXY_IDLE_TARGET_KEY,
        FREE_PROXY_EMERGENCY_RECOVERY_KEY,
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
        inventoryLimit: parsePositiveIntSetting(
            values[FREE_PROXY_INVENTORY_LIMIT_KEY],
            DEFAULT_FREE_PROXY_INVENTORY_LIMIT,
            1000,
            100000,
        ),
        activeCandidateLimit: parsePositiveIntSetting(
            values[FREE_PROXY_ACTIVE_CANDIDATE_LIMIT_KEY],
            DEFAULT_FREE_PROXY_ACTIVE_CANDIDATE_LIMIT,
            1000,
            50000,
        ),
        idleCandidateLimit: parsePositiveIntSetting(
            values[FREE_PROXY_IDLE_CANDIDATE_LIMIT_KEY],
            DEFAULT_FREE_PROXY_IDLE_CANDIDATE_LIMIT,
            1000,
            50000,
        ),
        readyTarget: parsePositiveIntSetting(
            values[FREE_PROXY_READY_TARGET_KEY],
            DEFAULT_FREE_PROXY_READY_TARGET,
            1,
            1000,
        ),
        reserveTarget: parsePositiveIntSetting(
            values[FREE_PROXY_RESERVE_TARGET_KEY],
            DEFAULT_FREE_PROXY_RESERVE_TARGET,
            1,
            1000,
        ),
        idleTarget: parsePositiveIntSetting(
            values[FREE_PROXY_IDLE_TARGET_KEY],
            DEFAULT_FREE_PROXY_IDLE_TARGET,
            1,
            1000,
        ),
        emergencyRecoveryEnabled: parseBooleanSetting(
            values[FREE_PROXY_EMERGENCY_RECOVERY_KEY],
            true,
        ),
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
        affectedCount += await db.$executeRaw`
            INSERT INTO free_proxies (
                proxy_url,
                protocol,
                host,
                port,
                source,
                sources,
                last_seen_at,
                status
            )
            VALUES ${Prisma.join(
                batch.map(
                    (proxy) => Prisma.sql`(
                        ${proxy.proxyUrl},
                        ${proxy.protocol},
                        ${proxy.host},
                        ${proxy.port},
                        ${source},
                        ARRAY[${source}]::TEXT[],
                        NOW(),
                        'pending'
                    )`,
                ),
            )}
            ON CONFLICT (proxy_url) DO UPDATE
            SET protocol = EXCLUDED.protocol,
                host = EXCLUDED.host,
                port = EXCLUDED.port,
                source = EXCLUDED.source,
                sources = ARRAY(
                    SELECT DISTINCT source_name
                    FROM unnest(free_proxies.sources || EXCLUDED.sources) AS source_rows(source_name)
                ),
                last_seen_at = NOW(),
                last_error = NULL,
                last_error_code = NULL,
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

    const [
        settings,
        counts,
        regionRows,
        recent,
        degradationSetting,
        runtimeSetting,
    ] = await Promise.all([
        getFreeProxySettings(),
        db.$queryRaw<FreeProxyStatusCountRow[]>`
            SELECT status, COUNT(*)::bigint AS proxy_count
            FROM free_proxies
            GROUP BY status
        `,
        db.$queryRaw<FreeProxyRegionRow[]>`
            WITH region_demand AS (
                SELECT region, COUNT(*)::bigint AS active_monitor_count
                FROM monitors
                WHERE status = 'active'
                  AND proxy_source = 'free'
                GROUP BY region
            )
            SELECT
                fph.region,
                COUNT(*) FILTER (
                    WHERE (
                        status = 'active'
                        OR (
                            status = 'cooldown'
                            AND success_count > 0
                            AND failure_streak <= 2
                        )
                      )
                      AND last_success_at >= NOW() - INTERVAL '20 minutes'
                )::bigint AS active_count,
                COUNT(*) FILTER (
                    WHERE (
                        status = 'active'
                        OR (
                            status = 'cooldown'
                            AND success_count > 0
                        )
                      )
                      AND failure_streak <= 2
                      AND last_success_at >= NOW() - INTERVAL '90 minutes'
                      AND last_success_at < NOW() - INTERVAL '20 minutes'
                )::bigint AS reserve_count,
                COUNT(*) FILTER (
                    WHERE status = 'pending'
                      AND success_streak > 0
                      AND last_success_at >= NOW() - INTERVAL '20 minutes'
                )::bigint AS warming_count,
                COUNT(*) FILTER (
                    WHERE status = 'pending'
                      AND (
                        success_streak = 0
                        OR last_success_at IS NULL
                        OR last_success_at < NOW() - INTERVAL '20 minutes'
                      )
                )::bigint AS pending_count,
                COUNT(*) FILTER (
                    WHERE (
                        status = 'cooldown'
                        AND (
                            success_count = 0
                            OR failure_streak > 2
                            OR last_success_at IS NULL
                            OR last_success_at < NOW() - INTERVAL '90 minutes'
                        )
                      )
                       OR (
                        status = 'active'
                        AND (
                            last_success_at IS NULL
                            OR last_success_at < NOW() - INTERVAL '90 minutes'
                            OR (
                                failure_streak > 2
                                AND last_success_at < NOW() - INTERVAL '20 minutes'
                            )
                        )
                      )
                )::bigint AS cooldown_count,
                COUNT(*) FILTER (WHERE status = 'dead')::bigint AS dead_count,
                COUNT(*) FILTER (
                    WHERE last_checked_at >= NOW() - INTERVAL '1 hour'
                      AND last_status_code = 200
                      AND last_error IS NULL
                )::bigint AS recent_success_count,
                COUNT(*) FILTER (
                    WHERE last_checked_at >= NOW() - INTERVAL '1 hour'
                )::bigint AS recent_check_count,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms)
                    FILTER (
                        WHERE latency_ms IS NOT NULL
                          AND last_status_code = 200
                          AND last_error IS NULL
                    ) AS median_latency_ms,
                MAX(last_checked_at) AS last_checked_at,
                COALESCE(
                    MAX(last_checked_at) < NOW() - INTERVAL '10 minutes',
                    TRUE
                )
                AND COUNT(*) FILTER (
                    WHERE status IN ('pending', 'active', 'cooldown', 'dead')
                      AND (
                        next_check_at IS NULL
                        OR next_check_at <= NOW()
                      )
                ) > 0 AS stalled
                ,
                mode() WITHIN GROUP (ORDER BY last_error_stage)
                    FILTER (
                        WHERE last_error_stage IS NOT NULL
                          AND last_checked_at >= NOW() - INTERVAL '1 hour'
                    ) AS top_error_stage,
                COUNT(*)::bigint AS candidate_window,
                COUNT(*) FILTER (
                    WHERE last_checked_at >= NOW() - INTERVAL '1 hour'
                )::bigint AS checked_last_hour,
                COUNT(*) FILTER (
                    WHERE last_success_at >= NOW() - INTERVAL '1 hour'
                )::bigint AS promoted_last_hour,
                EXTRACT(EPOCH FROM (NOW() - MAX(last_success_at))) / 60.0
                    AS minutes_since_last_success,
                COALESCE(region_demand.active_monitor_count, 0)::bigint
                    AS active_monitor_count,
                COUNT(*) FILTER (
                    WHERE next_check_at IS NULL OR next_check_at <= NOW()
                )::bigint AS due_now_count,
                COUNT(*) FILTER (
                    WHERE last_checked_at IS NULL
                )::bigint AS never_checked_count
            FROM free_proxy_health fph
            LEFT JOIN region_demand ON region_demand.region = fph.region
            WHERE fph.candidate_window_token =
                FLOOR(EXTRACT(EPOCH FROM NOW()) / 3600)::bigint
            GROUP BY fph.region, region_demand.active_monitor_count
            ORDER BY fph.region
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
        db.app_settings.findUnique({
            where: { key: "free_proxy_degradation_reason" },
            select: { value: true },
        }),
        db.app_settings.findUnique({
            where: { key: "free_proxy_maintainer_runtime" },
            select: { value: true },
        }),
    ]);

    const countsByStatus = Object.fromEntries(
        counts.map((row) => [row.status, Number(row.proxy_count)]),
    );
    const activeHealthCount = regionRows.reduce(
        (sum, row) =>
            sum + Number(row.active_count) + Number(row.reserve_count),
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
        degradationReason:
            degradationSetting?.value === "host_egress_limited"
                ? ("host_egress_limited" as const)
                : null,
        maintainerRuntime: parseFreeProxyMaintainerRuntime(
            runtimeSetting?.value,
        ),
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
            const usableCount =
                Number(row.active_count) +
                Number(row.reserve_count) +
                Number(row.warming_count);

            return {
                region: row.region,
                active: Number(row.active_count),
                reserve: Number(row.reserve_count),
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
                stalled: row.stalled,
                topErrorStage: row.top_error_stage,
                candidateWindow: Number(row.candidate_window),
                checkedLastHour: Number(row.checked_last_hour),
                promotedLastHour: Number(row.promoted_last_hour),
                minutesSinceLastSuccess:
                    row.minutes_since_last_success === null
                        ? null
                        : Math.round(row.minutes_since_last_success),
                activeMonitorCount: Number(row.active_monitor_count),
                recoveryMode:
                    settings.emergencyRecoveryEnabled &&
                    Number(row.active_monitor_count) > 0 &&
                    usableCount < settings.readyTarget,
                dueNow: Number(row.due_now_count),
                neverChecked: Number(row.never_checked_count),
                healthy:
                    Number(row.active_count) +
                        Number(row.reserve_count) +
                        Number(row.warming_count) >=
                    settings.minActivePerRegion,
            };
        }),
        sourceDiagnostics: [],
        recent,
    };
}

export async function getFreeProxySourceDiagnostics(region: string) {
    await requireAdmin();
    const normalizedRegion = region.trim().toLowerCase();
    if (!/^[a-z]{2}$/.test(normalizedRegion)) {
        return [];
    }

    const rows = await db.$queryRaw<FreeProxySourceDiagnosticRow[]>`
        SELECT
            fph.region,
            listed_source.source_name AS source,
            fp.protocol,
            COUNT(DISTINCT fp.id)::bigint AS proxy_count,
            COUNT(*) FILTER (
                WHERE fph.last_checked_at >= NOW() - INTERVAL '1 hour'
            )::bigint AS checked_count,
            COUNT(*) FILTER (
                WHERE fph.last_checked_at >= NOW() - INTERVAL '1 hour'
                  AND fph.last_status_code = 200
                  AND fph.last_error IS NULL
            )::bigint AS successful_count,
            COUNT(*) FILTER (
                WHERE fph.last_checked_at IS NULL
            )::bigint AS never_checked_count,
            COUNT(*) FILTER (
                WHERE (
                    fph.status = 'active'
                    OR (
                        fph.status = 'cooldown'
                        AND fph.success_count > 0
                        AND fph.failure_streak <= 2
                    )
                  )
                  AND fph.last_success_at >= NOW() - INTERVAL '20 minutes'
            )::bigint AS active_count,
            COUNT(*) FILTER (
                WHERE (
                    fph.status = 'active'
                    OR (
                        fph.status = 'cooldown'
                        AND fph.success_count > 0
                    )
                  )
                  AND fph.failure_streak <= 2
                  AND fph.last_success_at >= NOW() - INTERVAL '90 minutes'
                  AND fph.last_success_at < NOW() - INTERVAL '20 minutes'
            )::bigint AS reserve_count,
            COUNT(*) FILTER (
                WHERE fph.status = 'dead'
                   OR (
                        fph.status = 'cooldown'
                        AND (
                            fph.success_count = 0
                            OR fph.failure_streak > 2
                            OR fph.last_success_at IS NULL
                            OR fph.last_success_at < NOW() - INTERVAL '90 minutes'
                        )
                   )
            )::bigint AS cooldown_count,
            mode() WITHIN GROUP (ORDER BY fph.last_error_code)
                FILTER (
                    WHERE fph.last_error_code IS NOT NULL
                      AND fph.last_checked_at >= NOW() - INTERVAL '1 hour'
                ) AS top_error_code,
            mode() WITHIN GROUP (ORDER BY fph.last_error_stage)
                FILTER (
                    WHERE fph.last_error_stage IS NOT NULL
                      AND fph.last_checked_at >= NOW() - INTERVAL '1 hour'
                ) AS top_error_stage
        FROM free_proxies fp
        CROSS JOIN LATERAL unnest(
            CASE
                WHEN cardinality(fp.sources) > 0 THEN fp.sources
                ELSE ARRAY[fp.source]::text[]
            END
        ) AS listed_source(source_name)
        JOIN free_proxy_health fph ON fph.proxy_id = fp.id
        WHERE fph.region = ${normalizedRegion}
          AND fph.candidate_window_token =
            FLOOR(EXTRACT(EPOCH FROM NOW()) / 3600)::bigint
        GROUP BY fph.region, listed_source.source_name, fp.protocol
        ORDER BY successful_count DESC, checked_count DESC,
            listed_source.source_name, fp.protocol
        LIMIT 12
    `;

    return rows.map((row) => {
        const checked = Number(row.checked_count);
        const successful = Number(row.successful_count);
        return {
            region: row.region,
            source: row.source,
            protocol: row.protocol,
            proxyCount: Number(row.proxy_count),
            checked,
            successful,
            successRate:
                checked > 0
                    ? Math.round((successful / checked) * 1000) / 10
                    : null,
            neverChecked: Number(row.never_checked_count),
            active: Number(row.active_count),
            reserve: Number(row.reserve_count),
            cooldown: Number(row.cooldown_count),
            topErrorCode: row.top_error_code,
            topErrorStage: row.top_error_stage,
        };
    });
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
    const inventoryLimit = parsePositiveIntSetting(
        formData.get("inventoryLimit") as string | undefined,
        DEFAULT_FREE_PROXY_INVENTORY_LIMIT,
        1000,
        100000,
    );
    const activeCandidateLimit = parsePositiveIntSetting(
        formData.get("activeCandidateLimit") as string | undefined,
        DEFAULT_FREE_PROXY_ACTIVE_CANDIDATE_LIMIT,
        1000,
        inventoryLimit,
    );
    const idleCandidateLimit = parsePositiveIntSetting(
        formData.get("idleCandidateLimit") as string | undefined,
        DEFAULT_FREE_PROXY_IDLE_CANDIDATE_LIMIT,
        1000,
        inventoryLimit,
    );
    const readyTarget = parsePositiveIntSetting(
        formData.get("readyTarget") as string | undefined,
        DEFAULT_FREE_PROXY_READY_TARGET,
        1,
        Math.max(1, activeCandidateLimit - 1),
    );
    const reserveTarget = parsePositiveIntSetting(
        formData.get("reserveTarget") as string | undefined,
        DEFAULT_FREE_PROXY_RESERVE_TARGET,
        1,
        Math.max(1, activeCandidateLimit - readyTarget),
    );
    const idleTarget = parsePositiveIntSetting(
        formData.get("idleTarget") as string | undefined,
        DEFAULT_FREE_PROXY_IDLE_TARGET,
        1,
        idleCandidateLimit,
    );
    const emergencyRecoveryEnabled =
        formData.get("emergencyRecoveryEnabled") !== "false";
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
        setAppSetting(FREE_PROXY_INVENTORY_LIMIT_KEY, String(inventoryLimit)),
        setAppSetting(
            FREE_PROXY_ACTIVE_CANDIDATE_LIMIT_KEY,
            String(activeCandidateLimit),
        ),
        setAppSetting(
            FREE_PROXY_IDLE_CANDIDATE_LIMIT_KEY,
            String(idleCandidateLimit),
        ),
        setAppSetting(FREE_PROXY_READY_TARGET_KEY, String(readyTarget)),
        setAppSetting(FREE_PROXY_RESERVE_TARGET_KEY, String(reserveTarget)),
        setAppSetting(FREE_PROXY_IDLE_TARGET_KEY, String(idleTarget)),
        setAppSetting(
            FREE_PROXY_EMERGENCY_RECOVERY_KEY,
            String(emergencyRecoveryEnabled),
        ),
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
        settings.inventoryLimit - existingProxyUrls.size,
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
            existingProxyUrls.size + addedCount >= settings.inventoryLimit,
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

export async function getAdminOverviewState() {
    await requireAdmin();
    return getCachedAdminOverviewState();
}

export async function getAdminRuntimeInsights() {
    await requireAdmin();
    return getCachedAdminRuntimeInsights();
}

export async function getAdminUsersPage(input?: {
    query?: string;
    page?: number;
    pageSize?: number;
}) {
    await requireAdmin();

    const query = String(input?.query ?? "").trim().slice(0, 100);
    const pageSizeOptions = [25, 50, 100];
    const requestedPageSize = Number(input?.pageSize ?? 25);
    const pageSize = pageSizeOptions.includes(requestedPageSize)
        ? requestedPageSize
        : 25;
    const requestedPage = Number(input?.page ?? 1);
    const page =
        Number.isInteger(requestedPage) && requestedPage > 0
            ? requestedPage
            : 1;
    const where: Prisma.UserWhereInput = query
        ? {
              OR: [
                  { name: { contains: query, mode: "insensitive" } },
                  { email: { contains: query, mode: "insensitive" } },
                  { role: { contains: query, mode: "insensitive" } },
              ],
          }
        : {};

    const [total, users, metricEntries] = await Promise.all([
        db.user.count({ where }),
        db.user.findMany({
            where,
            orderBy: [{ name: "asc" }, { id: "asc" }],
            skip: (page - 1) * pageSize,
            take: pageSize,
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
        getCachedAdminUserMetrics(),
    ]);

    const userIds = users.map((user) => user.id);
    const userLimitRows =
        userIds.length > 0
            ? await db.monitor_limits.findMany({
                  where: {
                      scope: {
                          in: userIds.map((userId) => userLimitScope(userId)),
                      },
                  },
                  select: {
                      scope: true,
                      active_limit: true,
                      free_proxy_active_limit: true,
                  },
              })
            : [];
    const metrics = new Map(metricEntries);

    return {
        users: users.map((user) => {
            const cached = metrics.get(user.id);
            return {
                ...user,
                monitors: [],
                activeMonitors: [],
                metrics: cached
                    ? {
                          ...cached,
                          lastCheckAt: cached.lastCheckAt
                              ? new Date(cached.lastCheckAt)
                              : null,
                          oldestActiveSince: cached.oldestActiveSince
                              ? new Date(cached.oldestActiveSince)
                              : null,
                      }
                    : emptyAdminUserMetrics(),
            };
        }),
        pagination: {
            page,
            pageSize,
            total,
            totalPages: Math.max(1, Math.ceil(total / pageSize)),
        },
        userLimits: Object.fromEntries(
            userLimitRows.map((row) => [
                row.scope.slice(USER_MONITOR_LIMIT_PREFIX.length),
                row.active_limit,
            ]),
        ),
        userFreeProxyLimits: Object.fromEntries(
            userLimitRows.map((row) => [
                row.scope.slice(USER_MONITOR_LIMIT_PREFIX.length),
                row.free_proxy_active_limit,
            ]),
        ),
    };
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
            select: {
                scope: true,
                active_limit: true,
                free_proxy_active_limit: true,
            },
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
        userFreeProxyLimits: Object.fromEntries(
            userLimitRows.map((row) => [
                row.scope.slice(USER_MONITOR_LIMIT_PREFIX.length),
                row.free_proxy_active_limit,
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
                oldestActiveSince: metrics.oldestActiveSince
                    ? new Date(metrics.oldestActiveSince)
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
            active_since: true,
            runtime_total_seconds: true,
            price_min: true,
            price_max: true,
            discord_webhook: true,
            webhook_active: true,
            telegram_active: true,
            proxy_source: true,
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
            user: {
                select: {
                    id: true,
                    name: true,
                    email: true,
                    role: true,
                    image: true,
                    _count: {
                        select: {
                            monitors: true,
                            proxy_groups: true,
                        },
                    },
                },
            },
        },
    });

    return monitors.map(({ discord_webhook, ...monitor }) => ({
        ...monitor,
        runtime_total_seconds: Number(monitor.runtime_total_seconds),
        discord_configured: Boolean(discord_webhook),
    }));
}

export async function getAdminUserDetails(userId: string) {
    await requireAdmin();

    const [user, runtimeRows, userLimit] = await Promise.all([
        db.user.findUnique({
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
                        active_since: true,
                        runtime_total_seconds: true,
                        price_min: true,
                        price_max: true,
                        discord_webhook: true,
                        webhook_active: true,
                        telegram_active: true,
                        proxy_source: true,
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
        }),
        db.$queryRaw<
            {
                runtime_seconds_7d: number;
                average_session_seconds: number | null;
                closed_runtime_seconds: bigint;
            }[]
        >`
            WITH eligible_sessions AS (
                SELECT started_at, ended_at
                FROM monitor_runtime_sessions
                WHERE user_id = ${userId}
                  AND ended_at >= NOW() - INTERVAL '7 days'
                  AND started_at < NOW()

                UNION ALL

                SELECT started_at, ended_at
                FROM monitor_runtime_sessions
                WHERE user_id = ${userId}
                  AND ended_at IS NULL
                  AND started_at < NOW()
            )
            SELECT
                COALESCE(SUM(GREATEST(
                    0,
                    EXTRACT(EPOCH FROM (
                        LEAST(COALESCE(ended_at, NOW()), NOW()) -
                        GREATEST(started_at, NOW() - INTERVAL '7 days')
                    ))
                )), 0)::double precision AS runtime_seconds_7d,
                (
                    SELECT AVG(EXTRACT(EPOCH FROM (ended_at - started_at)))
                    FROM monitor_runtime_sessions
                    WHERE user_id = ${userId}
                      AND ended_at IS NOT NULL
                )::double precision AS average_session_seconds,
                COALESCE((
                    SELECT closed_runtime_seconds
                    FROM member_monitor_runtime_totals
                    WHERE user_id = ${userId}
                ), 0)::bigint AS closed_runtime_seconds
            FROM eligible_sessions
        `,
        db.monitor_limits.findUnique({
            where: { scope: userLimitScope(userId) },
            select: {
                active_limit: true,
                free_proxy_active_limit: true,
            },
        }),
    ]);

    if (!user) throw new Error("User not found");

    const currentRuntimeSeconds = user.monitors.reduce((sum, monitor) => {
        if (monitor.status !== "active" || !monitor.active_since) return sum;
        return (
            sum +
            Math.max(
                0,
                Math.floor(
                    (Date.now() - monitor.active_since.getTime()) / 1000,
                ),
            )
        );
    }, 0);
    const closedRuntimeSeconds = Number(
        runtimeRows[0]?.closed_runtime_seconds ?? 0,
    );

    return {
        monitors: user.monitors.map((monitor) => ({
            ...monitor,
            runtime_total_seconds: Number(monitor.runtime_total_seconds),
        })),
        runtime: {
            currentRuntimeSeconds,
            totalRuntimeSeconds: closedRuntimeSeconds + currentRuntimeSeconds,
            runtimeSeconds7d: Number(runtimeRows[0]?.runtime_seconds_7d ?? 0),
            averageSessionSeconds: Number(
                runtimeRows[0]?.average_session_seconds ?? 0,
            ),
        },
        limits: {
            active: userLimit?.active_limit ?? null,
            freeProxy: userLimit?.free_proxy_active_limit ?? null,
        },
    };
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

type FreeProxyLimitPausedMonitor = {
    id: number;
    name: string;
    userId: string;
    discord_webhook: string | null;
    webhook_active: boolean;
    telegram_active: boolean;
    notifications_enabled: boolean;
};

async function sendFreeProxyLimitPausedWebhook(
    monitor: FreeProxyLimitPausedMonitor,
    limit: number,
) {
    if (!monitor.discord_webhook) return;
    try {
        await fetch(monitor.discord_webhook, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                username: "Vintrack Monitor",
                avatar_url:
                    "https://cdn-icons-png.flaticon.com/512/8266/8266540.png",
                embeds: [
                    {
                        title: "⏸️ Monitor Paused",
                        description: `The monitor **${monitor.name}** was automatically paused because your running Free Proxy Pool monitor limit is **${limit}**.`,
                        color: 16753920,
                        footer: { text: "Vintrack • Free Proxy Limit" },
                        timestamp: new Date().toISOString(),
                    },
                ],
            }),
        });
    } catch (error) {
        console.error(
            "Failed to send free proxy limit webhook for",
            monitor.id,
            error,
        );
    }
}

async function sendFreeProxyLimitPausedTelegram(
    monitor: FreeProxyLimitPausedMonitor,
    limit: number,
) {
    const connection = await getTelegramConnection(monitor.userId);
    if (!connection) return;
    const result = await sendTelegramMessage(
        connection.chat_id,
        `⏸️ Monitor paused\n\n${monitor.name} was automatically paused because your running Free Proxy Pool monitor limit is ${limit}.`,
    );
    if ("error" in result) {
        console.error(
            "Failed to send free proxy limit Telegram message for",
            monitor.id,
            result.error,
        );
    }
}

async function reconcileUserFreeProxyMonitorLimit(
    userId: string,
    scope: string,
    adminUserId: string,
) {
    const result = await withMonitorActivationLock(userId, async (tx) => {
        const state = await getMonitorActivationState(userId, "free", tx);
        if (state.freeProxyActiveLimit === null) {
            return {
                limit: null,
                monitors: [] as FreeProxyLimitPausedMonitor[],
            };
        }

        const excess = Math.max(
            state.freeProxyActiveCount - state.freeProxyActiveLimit,
            0,
        );
        if (excess === 0) {
            return {
                limit: state.freeProxyActiveLimit,
                monitors: [] as FreeProxyLimitPausedMonitor[],
            };
        }

        const monitors = await tx.monitors.findMany({
            where: { userId, status: "active", proxy_source: "free" },
            orderBy: [
                { created_at: { sort: "desc", nulls: "last" } },
                { id: "desc" },
            ],
            take: excess,
            select: {
                id: true,
                name: true,
                userId: true,
                discord_webhook: true,
                webhook_active: true,
                telegram_active: true,
                notifications_enabled: true,
            },
        });

        if (monitors.length > 0) {
            await tx.monitors.updateMany({
                where: { id: { in: monitors.map((monitor) => monitor.id) } },
                data: { status: "paused" },
            });
        }

        return { limit: state.freeProxyActiveLimit, monitors };
    });

    if (result.limit === null || result.monitors.length === 0) {
        return result.monitors;
    }

    await Promise.all(
        result.monitors.map(async (monitor) => {
            await logAuditEvent({
                userId: adminUserId,
                action: "monitor.free_proxy_limit_paused",
                targetType: "monitor",
                targetId: monitor.id,
                metadata: {
                    memberUserId: userId,
                    scope,
                    limit: result.limit,
                    reason: "free_proxy_active_limit",
                },
            });

            if (!monitor.notifications_enabled) return;
            const notifications: Promise<unknown>[] = [];
            if (monitor.discord_webhook && monitor.webhook_active) {
                notifications.push(
                    sendFreeProxyLimitPausedWebhook(monitor, result.limit!),
                );
            }
            if (monitor.telegram_active) {
                notifications.push(
                    sendFreeProxyLimitPausedTelegram(monitor, result.limit!),
                );
            }
            await Promise.all(notifications);
        }),
    );

    return result.monitors;
}

async function reconcileFreeProxyLimitsForUsers(
    userIds: string[],
    scope: string,
    adminUserId: string,
) {
    let pausedCount = 0;
    const pausedMonitorIds: number[] = [];
    for (const userId of userIds) {
        const paused = await reconcileUserFreeProxyMonitorLimit(
            userId,
            scope,
            adminUserId,
        );
        pausedCount += paused.length;
        pausedMonitorIds.push(...paused.map((monitor) => monitor.id));
    }
    return { pausedCount, pausedMonitorIds };
}

export async function setUserRole(userId: string, role: string) {
    const adminUserId = await requireAdmin();

    const validRoles = ["free", "premium", "admin"];
    if (!validRoles.includes(role)) throw new Error("Invalid role");

    await db.user.update({
        where: { id: userId },
        data: { role },
    });

    const reconciliation = await reconcileFreeProxyLimitsForUsers(
        [userId],
        `role-change:${role}`,
        adminUserId,
    );

    revalidatePath("/admin");
    revalidatePath("/dashboard");
    return reconciliation;
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

export async function setGlobalFreeProxyMonitorLimit(value: string) {
    const adminUserId = await requireAdmin();
    const limit = normalizeMonitorLimitInput(value);
    await setFreeProxyMonitorLimit(GLOBAL_MONITOR_LIMIT_SCOPE, limit);

    const users = await db.user.findMany({
        where: { role: { not: "admin" } },
        select: { id: true },
    });
    const reconciliation = await reconcileFreeProxyLimitsForUsers(
        users.map((user) => user.id),
        GLOBAL_MONITOR_LIMIT_SCOPE,
        adminUserId,
    );
    await logAuditEvent({
        userId: adminUserId,
        action: "admin.free_proxy_monitor_limit_updated",
        targetType: "monitor_limit",
        targetId: GLOBAL_MONITOR_LIMIT_SCOPE,
        metadata: { limit, pausedCount: reconciliation.pausedCount },
    });

    revalidatePath("/admin");
    revalidatePath("/dashboard");
    return reconciliation;
}

export async function setRoleFreeProxyMonitorLimit(
    role: string,
    value: string,
) {
    const adminUserId = await requireAdmin();
    const validRoles = ["free", "premium"];
    if (!validRoles.includes(role)) throw new Error("Invalid role");

    const limit = normalizeMonitorLimitInput(value);
    const scope = roleLimitScope(role);
    await setFreeProxyMonitorLimit(scope, limit);

    const users = await db.user.findMany({
        where: { role },
        select: { id: true },
    });
    const reconciliation = await reconcileFreeProxyLimitsForUsers(
        users.map((user) => user.id),
        scope,
        adminUserId,
    );
    await logAuditEvent({
        userId: adminUserId,
        action: "admin.free_proxy_monitor_limit_updated",
        targetType: "monitor_limit",
        targetId: scope,
        metadata: { limit, pausedCount: reconciliation.pausedCount },
    });

    revalidatePath("/admin");
    revalidatePath("/dashboard");
    return reconciliation;
}

export async function setUserFreeProxyMonitorLimit(
    userId: string,
    value: string,
) {
    const adminUserId = await requireAdmin();
    const user = await db.user.findUnique({
        where: { id: userId },
        select: { id: true, role: true },
    });
    if (!user) throw new Error("User not found");
    if (user.role === "admin") {
        throw new Error("Admins are always unlimited");
    }

    const limit = normalizeMonitorLimitInput(value);
    const scope = userLimitScope(userId);
    await setFreeProxyMonitorLimit(scope, limit);
    const reconciliation = await reconcileFreeProxyLimitsForUsers(
        [userId],
        scope,
        adminUserId,
    );
    await logAuditEvent({
        userId: adminUserId,
        action: "admin.free_proxy_monitor_limit_updated",
        targetType: "monitor_limit",
        targetId: scope,
        metadata: {
            memberUserId: userId,
            limit,
            pausedCount: reconciliation.pausedCount,
        },
    });

    revalidatePath("/admin");
    revalidatePath("/dashboard");
    return reconciliation;
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
            notifications_enabled: true,
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
            if (
                monitor.notifications_enabled &&
                monitor.discord_webhook &&
                monitor.webhook_active
            ) {
                await sendPausedWebhook(
                    monitor.name,
                    monitor.id,
                    monitor.discord_webhook,
                );
            }
            if (monitor.notifications_enabled && monitor.telegram_active) {
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
            notifications_enabled: true,
        },
    });

    if (!monitor) {
        return { success: true, stopped: false };
    }

    await db.monitors.update({
        where: { id: monitorId, userId },
        data: { status: "paused" },
    });

    if (
        monitor.notifications_enabled &&
        monitor.discord_webhook &&
        monitor.webhook_active
    ) {
        sendPausedWebhook(
            monitor.name,
            monitor.id,
            monitor.discord_webhook,
        ).catch(console.error);
    }
    if (monitor.notifications_enabled && monitor.telegram_active) {
        sendPausedTelegram(monitor.name, monitor.id, monitor.userId).catch(
            console.error,
        );
    }

    revalidatePath("/admin");

    return { success: true, stopped: true };
}
