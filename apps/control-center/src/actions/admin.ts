"use server";

import { OWN_PROXY_LIMIT_SETTING_KEY } from "@/lib/own-proxy-limit";
import {
    reconcileAllOwnProxyMonitorLimits,
    reconcileUserOwnProxyMonitorLimit,
} from "@/lib/own-proxy-limit-reconciliation.server";

import { auth } from "@/auth";
import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { revalidatePath, unstable_cache } from "next/cache";
import {
    getAdminOperationsPage,
    getAdminOperationsSummary,
} from "@/actions/admin-operations";
import { reconcileFreeProxyLimitsForUsers } from "@/lib/free-proxy-limit-reconciliation.server";
import {
    GLOBAL_MONITOR_LIMIT_SCOPE,
    getEffectiveMonitorLimits,
    getEffectivePriceWatchLimit,
    normalizeMonitorLimitInput,
    roleLimitScope,
    setFreeProxyMonitorLimit,
    setMonitorLimit,
    setPriceWatchLimit,
    USER_MONITOR_LIMIT_PREFIX,
    userLimitScope,
    withMonitorActivationLock,
    acquireGlobalMonitorActivationLock,
} from "@/lib/monitor-limits";
import { logAuditEvent } from "@/lib/audit";
import { randomUUID } from "node:crypto";
import {
    MEMBER_ANNOUNCEMENT_SETTING_KEY,
    parseMemberAnnouncement,
    toMemberAnnouncementInput,
    validateMemberAnnouncementInput,
    type MemberAnnouncement,
    type MemberAnnouncementInput,
} from "@/lib/member-announcement";
import {
    MONITOR_MAINTENANCE_SETTING_KEY,
    getMonitorMaintenanceStatus,
    validateMonitorMaintenanceInput,
    type MonitorMaintenance,
} from "@/lib/monitor-maintenance";
import {
    getMonitorMaintenance,
    getMonitorWorkerRuntime,
} from "@/lib/monitor-maintenance.server";
import {
    INACTIVE_MEMBER_POLICY_SETTING_KEY,
    inactivePolicyRuntimeStatus,
    validateInactiveMemberPolicyInput,
    type InactiveMemberPolicy,
    type InactiveMemberPolicyInput,
} from "@/lib/inactive-member-policy";
import {
    countInactivePolicyMatches,
    getInactiveEligibleMonitorIds,
    getInactiveMemberPolicy,
    getInactiveMemberRuntime,
} from "@/lib/inactive-member-policy.server";
import {
    readFreeProxyPolicy,
    readPriceWatchPolicy,
    readWorkerPolicy,
    writePolicyDocument,
} from "@/lib/runtime-policies.server";
import {
    policyPayload,
    RUNTIME_POLICY_KEYS,
    type FreeProxyPolicy,
    type PriceWatchPolicy,
    type WorkerPolicy,
} from "@/lib/runtime-policies";
import { summarizeProxyRegions } from "@/lib/proxy-region-summary";
import { parseFreeProxyCanarySnapshot } from "@/lib/free-proxy-readiness";

const SERVER_PROXIES_SETTING_KEY = "server_proxies";
const PRICE_WATCH_INTERVAL_SETTING_KEY = "price_watch_interval_seconds";
const PRICE_WATCH_ENABLED_SETTING_KEY = "price_watch_enabled";
const PRICE_WATCH_SHARED_MIN_SETTING_KEY =
    "price_watch_shared_min_interval_seconds";
const PRICE_WATCH_PERSONAL_MIN_SETTING_KEY =
    "price_watch_personal_min_interval_seconds";
const PRICE_WATCH_SHARED_RPM_SETTING_KEY = "price_watch_shared_max_rpm";
const PRICE_WATCH_PERSONAL_RPM_SETTING_KEY =
    "price_watch_personal_max_rpm_per_proxy";
const DEFAULT_PRICE_WATCH_INTERVAL_MINUTES = 5;
const MIN_PRICE_WATCH_INTERVAL_MINUTES = 2;
const MAX_PRICE_WATCH_INTERVAL_MINUTES = 60;
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
    adaptivePacingEnabled: boolean;
    adaptiveRegions: string[];
    maxRequestsPerProxySecond: number;
    maxAdmissionDelayMs: number;
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

type FreeProxyRuntimeMetric = {
    region: string;
    requestedRps: number;
    admittedRps: number;
    activeClients: number;
    capacityRps: number;
    successRate: number;
    rateLimitedRate: number;
    poolWaitRate: number;
    admissionP95Ms: number;
    observedEffectiveIntervalMs: number;
    capacityFactor: number;
    reason: string | null;
};

function parseFreeProxyRuntimeMetrics(value: string | undefined) {
    if (!value) return [] as FreeProxyRuntimeMetric[];
    try {
        const parsed = JSON.parse(value) as {
            regions?: Array<Record<string, unknown>>;
        };
        if (!Array.isArray(parsed.regions)) return [];
        return parsed.regions
            .filter((entry) => typeof entry.region === "string")
            .slice(0, 50)
            .map((entry) => ({
                region: String(entry.region),
                requestedRps: Number(entry.requestedRps ?? 0),
                admittedRps: Number(entry.admittedRps ?? 0),
                activeClients: Number(entry.activeClients ?? 0),
                capacityRps: Number(entry.capacityRps ?? 0),
                successRate: Number(entry.successRate ?? 0),
                rateLimitedRate: Number(entry.rateLimitedRate ?? 0),
                poolWaitRate: Number(entry.poolWaitRate ?? 0),
                admissionP95Ms: Number(entry.admissionP95Ms ?? 0),
                observedEffectiveIntervalMs: Number(
                    entry.observedEffectiveIntervalMs ?? 0,
                ),
                capacityFactor: Number(entry.capacityFactor ?? 1),
                reason: typeof entry.reason === "string" ? entry.reason : null,
            }));
    } catch {
        return [];
    }
}

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
};

type AdminUserMetrics = {
    runningMonitors: number;
    runningFreeProxyMonitors: number;
    pausedMonitors: number;
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
        runningFreeProxyMonitors: 0,
        pausedMonitors: 0,
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
                COUNT(*) FILTER (
                    WHERE status = 'active' AND proxy_source = 'free'
                )::bigint AS running_free_proxy_monitors,
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
              AND s.bucket_hour >= DATE_TRUNC('hour', NOW()) - INTERVAL '23 hours'
            GROUP BY m."userId"
        )
        SELECT
            member.id AS "userId",
            COALESCE(monitor_totals.running_monitors, 0)::bigint AS running_monitors,
            COALESCE(monitor_totals.running_free_proxy_monitors, 0)::bigint AS running_free_proxy_monitors,
            COALESCE(monitor_totals.paused_monitors, 0)::bigint AS paused_monitors,
            COALESCE(run_totals.checks_24h, 0)::bigint AS checks_24h,
            COALESCE(run_totals.successful_checks_24h, 0)::bigint AS successful_checks_24h,
            COALESCE(run_totals.failed_checks_24h, 0)::bigint AS failed_checks_24h,
            COALESCE(run_totals.new_items_24h, 0)::bigint AS new_items_24h,
            run_totals.avg_duration_ms_24h,
            run_totals.last_check_at,
            run_totals.latest_error_24h
        FROM "User" member
        LEFT JOIN monitor_totals ON monitor_totals."userId" = member.id
        LEFT JOIN run_totals ON run_totals."userId" = member.id
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
            row.avg_duration_ms_24h == null
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
    ["admin-user-metrics-v8"],
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
    checks_24h: bigint;
    successful_checks_24h: bigint;
    failed_checks_24h: bigint;
    new_items_24h: bigint;
    users_at_limit: bigint;
    user_overrides: bigint;
    role_limits: bigint;
};

type AdminActiveMemberRow = {
    user_id: string;
    name: string | null;
    email: string | null;
    role: string;
    running_monitors: bigint;
};

type AdminCapacityMemberRow = AdminActiveMemberRow & {
    active_limit: number | bigint;
    limit_source: "user" | "role" | "global";
};

type AdminMemberOverviewRow = {
    total_members: bigint;
    new_members_7d: bigint;
    new_members_previous_7d: bigint;
    new_members_30d: bigint;
    new_members_previous_30d: bigint;
    users_with_monitors: bigint;
    demo_users: bigint;
    converted_demo_users: bigint;
};

type AdminFreeProxyRegionCapacityRow = {
    region: string;
    usable_count: bigint;
};

async function loadAdminProxyRegionSummary() {
    const [policy, legacyMinimum, rows] = await Promise.all([
        readFreeProxyPolicy(),
        db.app_settings.findUnique({
            where: { key: FREE_PROXY_MIN_ACTIVE_PER_REGION_KEY },
            select: { value: true },
        }),
        db.$queryRaw<AdminFreeProxyRegionCapacityRow[]>`
            SELECT
                region,
                COUNT(*) FILTER (
                    WHERE (
                        (
                            status = 'active'
                            OR (
                                status = 'cooldown'
                                AND success_count > 0
                                AND failure_streak <= 2
                            )
                        )
                        AND last_success_at >= NOW() - INTERVAL '20 minutes'
                    )
                    OR (
                        (
                            status = 'active'
                            OR (
                                status = 'cooldown'
                                AND success_count > 0
                            )
                        )
                        AND failure_streak <= 2
                        AND last_success_at >= NOW() - INTERVAL '90 minutes'
                        AND last_success_at < NOW() - INTERVAL '20 minutes'
                    )
                    OR (
                        status = 'pending'
                        AND success_streak > 0
                        AND last_success_at >= NOW() - INTERVAL '20 minutes'
                    )
                )::bigint AS usable_count
            FROM free_proxy_health
            WHERE candidate_window_token =
                FLOOR(EXTRACT(EPOCH FROM NOW()) / 3600)::bigint
            GROUP BY region
        `,
    ]);
    const minimumUsable =
        policy?.minActivePerRegion ??
        parsePositiveIntSetting(
            legacyMinimum?.value,
            DEFAULT_FREE_PROXY_MIN_ACTIVE_PER_REGION,
            1,
            1000,
        );
    return summarizeProxyRegions(
        rows.map((row) => ({
            region: row.region,
            usable: Number(row.usable_count),
        })),
        minimumUsable,
    );
}

async function loadAdminMemberOverviewSnapshot() {
    const rows = await db.$queryRaw<AdminMemberOverviewRow[]>`
        WITH member_totals AS (
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
                )::bigint AS new_members_previous_30d
            FROM "User"
        ),
        monitor_users AS (
            SELECT COUNT(DISTINCT "userId")::bigint AS users_with_monitors
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
            INNER JOIN monitors AS monitor ON monitor.id = event.monitor_id
            WHERE event.event_type = 'demo_auto_paused'
        ),
        converted_demo_users AS (
            SELECT DISTINCT "userId"
            FROM audit_events
            WHERE "userId" IS NOT NULL
              AND action = 'monitor.demo_converted'
        )
        SELECT
            member_totals.*,
            monitor_users.users_with_monitors,
            (SELECT COUNT(*) FROM demo_users)::bigint AS demo_users,
            (SELECT COUNT(*) FROM converted_demo_users)::bigint
                AS converted_demo_users
        FROM member_totals
        CROSS JOIN monitor_users
    `;
    const row = rows[0];
    const totalMembers = Number(row?.total_members ?? 0);
    const newMembers7d = Number(row?.new_members_7d ?? 0);
    const previous7d = Number(row?.new_members_previous_7d ?? 0);
    const newMembers30d = Number(row?.new_members_30d ?? 0);
    const previous30d = Number(row?.new_members_previous_30d ?? 0);
    const usersWithMonitors = Number(row?.users_with_monitors ?? 0);
    const demoUsers = Number(row?.demo_users ?? 0);
    const convertedDemoUsers = Number(row?.converted_demo_users ?? 0);

    return {
        newMembers7d,
        signupGrowth7d:
            previous7d > 0
                ? Math.round(((newMembers7d - previous7d) / previous7d) * 100)
                : null,
        newMembers30d,
        signupGrowth30d:
            previous30d > 0
                ? Math.round(
                      ((newMembers30d - previous30d) / previous30d) * 100,
                  )
                : null,
        usersWithMonitors,
        activationRate:
            totalMembers > 0
                ? Math.round((usersWithMonitors / totalMembers) * 100)
                : 0,
        demoUsers,
        convertedDemoUsers,
        demoConversionRate:
            demoUsers > 0
                ? Math.round((convertedDemoUsers / demoUsers) * 100)
                : 0,
    };
}

const getCachedAdminMemberOverviewSnapshot = unstable_cache(
    loadAdminMemberOverviewSnapshot,
    ["admin-member-overview-v1"],
    { revalidate: 30 },
);

async function loadAdminOverviewState() {
    const [
        summaryRows,
        topMemberRows,
        capacityMemberRows,
        proxyRegions,
        memberSnapshot,
    ] = await Promise.all([
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
                    COUNT(*) FILTER (WHERE status = 'active')::bigint AS running_monitors,
                    COUNT(*) FILTER (WHERE status IS DISTINCT FROM 'active')::bigint AS paused_monitors,
                    COUNT(*) FILTER (WHERE status = 'active' AND proxy_source = 'free')::bigint AS free_running,
                    COUNT(*) FILTER (WHERE status = 'active' AND proxy_source = 'server')::bigint AS server_running,
                    COUNT(*) FILTER (
                        WHERE status = 'active' AND proxy_source NOT IN ('free', 'server')
                    )::bigint AS group_running
                FROM monitors
            ),
            run_totals AS (
                SELECT
                    COALESCE(SUM(check_count), 0)::bigint AS checks_24h,
                    COALESCE(SUM(successful_check_count), 0)::bigint AS successful_checks_24h,
                    COALESCE(SUM(failed_check_count), 0)::bigint AS failed_checks_24h,
                    COALESCE(SUM(new_item_count), 0)::bigint AS new_items_24h
                FROM monitor_run_hourly_stats
                WHERE fetch_source = 'canonical'
                  AND bucket_hour >= DATE_TRUNC('hour', NOW()) - INTERVAL '23 hours'
            ),
            active_by_user AS (
                SELECT "userId" AS user_id, COUNT(*) FILTER (WHERE status = 'active')::bigint AS active_count
                FROM monitors GROUP BY "userId"
            ),
            effective_limits AS (
                SELECT
                    member.id,
                    COALESCE(active_by_user.active_count, 0)::bigint AS active_count,
                    COALESCE(user_limit.active_limit, role_limit.active_limit, global_limit.active_limit) AS active_limit
                FROM "User" member
                LEFT JOIN active_by_user ON active_by_user.user_id = member.id
                LEFT JOIN monitor_limits user_limit ON user_limit.scope = 'user:' || member.id
                LEFT JOIN monitor_limits role_limit ON role_limit.scope = 'role:' || member.role
                LEFT JOIN monitor_limits global_limit ON global_limit.scope = 'global'
                WHERE member.role <> 'admin'
            ),
            limit_totals AS (
                SELECT
                    (SELECT COUNT(*) FROM effective_limits WHERE active_limit IS NOT NULL AND active_count >= active_limit)::bigint AS users_at_limit,
                    (SELECT COUNT(*) FROM monitor_limits WHERE scope LIKE 'user:%' AND active_limit IS NOT NULL)::bigint AS user_overrides,
                    (SELECT COUNT(*) FROM monitor_limits WHERE scope LIKE 'role:%' AND active_limit IS NOT NULL)::bigint AS role_limits
            )
            SELECT * FROM user_totals
            CROSS JOIN monitor_totals
            CROSS JOIN run_totals
            CROSS JOIN limit_totals
        `,
        db.$queryRaw<AdminActiveMemberRow[]>`
            SELECT
                member.id AS user_id,
                member.name,
                member.email,
                member.role,
                COUNT(monitor.id) FILTER (WHERE monitor.status = 'active')::bigint AS running_monitors
            FROM "User" member
            LEFT JOIN monitors monitor ON monitor."userId" = member.id
            GROUP BY member.id, member.name, member.email, member.role
            ORDER BY running_monitors DESC, member.id ASC
            LIMIT 5
        `,
        db.$queryRaw<AdminCapacityMemberRow[]>`
            WITH active_by_user AS (
                SELECT
                    "userId" AS user_id,
                    COUNT(*) FILTER (WHERE status = 'active')::bigint
                        AS active_count
                FROM monitors
                GROUP BY "userId"
            ),
            effective_limits AS (
                SELECT
                    member.id AS user_id,
                    member.name,
                    member.email,
                    member.role,
                    COALESCE(active_by_user.active_count, 0)::bigint
                        AS running_monitors,
                    COALESCE(
                        user_limit.active_limit,
                        role_limit.active_limit,
                        global_limit.active_limit
                    ) AS active_limit,
                    CASE
                        WHEN user_limit.active_limit IS NOT NULL THEN 'user'
                        WHEN role_limit.active_limit IS NOT NULL THEN 'role'
                        ELSE 'global'
                    END AS limit_source
                FROM "User" member
                LEFT JOIN active_by_user
                    ON active_by_user.user_id = member.id
                LEFT JOIN monitor_limits user_limit
                    ON user_limit.scope = 'user:' || member.id
                LEFT JOIN monitor_limits role_limit
                    ON role_limit.scope = 'role:' || member.role
                LEFT JOIN monitor_limits global_limit
                    ON global_limit.scope = 'global'
                WHERE member.role <> 'admin'
            )
            SELECT *
            FROM effective_limits
            WHERE active_limit IS NOT NULL
              AND running_monitors >= active_limit
            ORDER BY running_monitors DESC, user_id ASC
            LIMIT 8
        `,
        loadAdminProxyRegionSummary(),
        getCachedAdminMemberOverviewSnapshot(),
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
        limits: {
            usersAtLimit: Number(summary?.users_at_limit ?? 0),
            userOverrides: Number(summary?.user_overrides ?? 0),
            roleLimits: Number(summary?.role_limits ?? 0),
            membersAtLimit: capacityMemberRows.map((row) => ({
                userId: row.user_id,
                name: row.name,
                email: row.email,
                role: row.role,
                runningMonitors: Number(row.running_monitors),
                activeLimit: Number(row.active_limit),
                limitSource: row.limit_source,
            })),
        },
        memberSnapshot,
        proxyRegions,
        topMembers: topMemberRows.map((row) => ({
            userId: row.user_id,
            name: row.name,
            email: row.email,
            role: row.role,
            runningMonitors: Number(row.running_monitors),
        })),
    };
}

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

export type PriceWatchPollingAdminState = {
    intervalMinutes: number;
    minMinutes: number;
    maxMinutes: number;
    uniqueActiveTargets: number;
    enabled: boolean;
    sharedMinimumSeconds: number;
    personalMinimumSeconds: number;
    sharedMaxRpm: number;
    personalMaxRpmPerProxy: number;
    activeWatches: number;
    sharedSchedules: number;
    personalSchedules: number;
    expectedRpm: number;
    checks24h: number;
    successfulChecks24h: number;
    accessDenied24h: number;
    rateLimited24h: number;
    serverErrors24h: number;
    averageDurationMs: number | null;
    p50DurationMs: number | null;
    p95DurationMs: number | null;
    queueLagSeconds: number;
    trafficBytes24h: number;
    alertSuccessRate24h: number | null;
    problems: Array<{
        scheduleId: string;
        itemId: string;
        title: string;
        region: string;
        transport: string;
        errorCode: string;
        detail: string;
    }>;
    proxyProblems: Array<{
        id: number;
        name: string;
        region: string;
        working: number;
        status: string;
        error: string;
    }>;
    publicUrlHealth: {
        ok: boolean;
        origin: string | null;
        source: string | null;
        error: string | null;
    };
};

export async function getWorkerPolicyAdminState() {
    await requireAdmin();
    return readWorkerPolicy();
}

export async function updateWorkerPolicy(
    input: Omit<WorkerPolicy, "version" | "revision">,
) {
    const adminUserId = await requireAdmin();
    if (!["off", "shadow", "active"].includes(input.discoveryMode)) {
        throw new Error("Invalid discovery mode");
    }
    for (const value of [
        input.discoveryAllowFreeActive,
        input.enrichSellerInfo,
        input.catalogLatencyMetrics,
    ]) {
        if (typeof value !== "boolean")
            throw new Error("Invalid worker policy");
    }
    if (
        !Number.isInteger(input.sellerFreshTtlMinutes) ||
        !Number.isInteger(input.sellerStaleTtlMinutes) ||
        input.sellerFreshTtlMinutes < 1 ||
        input.sellerStaleTtlMinutes < input.sellerFreshTtlMinutes
    ) {
        throw new Error("Invalid seller cache TTL policy");
    }
    const policy = await writePolicyDocument<WorkerPolicy>(
        RUNTIME_POLICY_KEYS.worker,
        input,
    );
    await logAuditEvent({
        userId: adminUserId,
        action: "admin.worker_policy_updated",
        targetType: "app_setting",
        targetId: RUNTIME_POLICY_KEYS.worker,
        metadata: policy,
    });
    revalidatePath("/admin/system");
    return policy;
}

export async function getPriceWatchPollingAdminState(): Promise<PriceWatchPollingAdminState> {
    await requireAdmin();
    const [
        policy,
        featurePolicy,
        settings,
        uniqueActiveTargets,
        scheduleStats,
        telemetry,
        alertStats,
        problemSchedules,
        problemProxyGroups,
    ] = await Promise.all([
        readPriceWatchPolicy(),
        db.feature_policies.findUnique({
            where: { feature: "price_watch" },
            select: { enabled: true },
        }),
        db.app_settings.findMany({
            where: {
                key: {
                    in: [
                        PRICE_WATCH_INTERVAL_SETTING_KEY,
                        PRICE_WATCH_ENABLED_SETTING_KEY,
                        PRICE_WATCH_SHARED_MIN_SETTING_KEY,
                        PRICE_WATCH_PERSONAL_MIN_SETTING_KEY,
                        PRICE_WATCH_SHARED_RPM_SETTING_KEY,
                        PRICE_WATCH_PERSONAL_RPM_SETTING_KEY,
                        "public_app_url_health",
                    ],
                },
            },
            select: { key: true, value: true },
        }),
        db.price_watch_targets.count({
            where: { watches: { some: { status: "active" } } },
        }),
        db.$queryRaw<
            Array<{
                active_watches: bigint;
                shared_schedules: bigint;
                personal_schedules: bigint;
                expected_rpm: number;
                queue_lag_seconds: number;
                p50_duration_ms: number | null;
                p95_duration_ms: number | null;
            }>
        >`
            WITH active AS (
                SELECT schedule.id, schedule.transport_kind,
                    MIN(watch.poll_interval_seconds)::float8 AS interval_seconds,
                    COUNT(*)::bigint AS watches
                FROM price_watch_schedules schedule
                JOIN price_watches watch ON watch.schedule_id = schedule.id
                WHERE watch.status = 'active'
                GROUP BY schedule.id, schedule.transport_kind
            )
            SELECT COALESCE(SUM(watches), 0)::bigint AS active_watches,
                COUNT(*) FILTER (WHERE active.transport_kind = 'shared')::bigint AS shared_schedules,
                COUNT(*) FILTER (WHERE active.transport_kind = 'proxy_group')::bigint AS personal_schedules,
                COALESCE(SUM(60.0 / interval_seconds), 0)::float8 AS expected_rpm
                ,COALESCE(MAX(EXTRACT(EPOCH FROM (NOW() - schedule.next_check_at)))
                    FILTER (WHERE schedule.next_check_at < NOW()), 0)::float8 AS queue_lag_seconds
                ,percentile_cont(0.5) WITHIN GROUP (ORDER BY schedule.last_duration_ms)
                    FILTER (WHERE schedule.last_duration_ms IS NOT NULL)::float8 AS p50_duration_ms
                ,percentile_cont(0.95) WITHIN GROUP (ORDER BY schedule.last_duration_ms)
                    FILTER (WHERE schedule.last_duration_ms IS NOT NULL)::float8 AS p95_duration_ms
            FROM active
            JOIN price_watch_schedules schedule ON schedule.id = active.id
        `,
        db.$queryRaw<
            Array<{
                checks: bigint;
                successes: bigint;
                access_denied: bigint;
                rate_limited: bigint;
                server_errors: bigint;
                duration_total: bigint;
                duration_samples: bigint;
                tx_bytes: bigint;
                rx_bytes: bigint;
            }>
        >`
            SELECT COALESCE(SUM(check_count), 0)::bigint AS checks,
                COALESCE(SUM(successful_check_count), 0)::bigint AS successes,
                COALESCE(SUM(access_denied_count), 0)::bigint AS access_denied,
                COALESCE(SUM(rate_limited_count), 0)::bigint AS rate_limited,
                COALESCE(SUM(server_error_count), 0)::bigint AS server_errors,
                COALESCE(SUM(duration_total_ms), 0)::bigint AS duration_total,
                COALESCE(SUM(duration_sample_count), 0)::bigint AS duration_samples
                ,COALESCE(SUM(tx_bytes), 0)::bigint AS tx_bytes
                ,COALESCE(SUM(rx_bytes), 0)::bigint AS rx_bytes
            FROM price_watch_check_hourly_stats
            WHERE bucket_hour >= NOW() - INTERVAL '24 hours'
        `,
        db.$queryRaw<Array<{ total: bigint; sent: bigint }>>`
            SELECT COUNT(*)::bigint AS total,
                COUNT(*) FILTER (WHERE delivery.status = 'sent')::bigint AS sent
            FROM alert_deliveries delivery
            JOIN alert_notifications notification ON notification.id = delivery.notification_id
            WHERE notification.kind = 'price_drop'
              AND delivery.created_at >= NOW() - INTERVAL '24 hours'
        `,
        db.price_watch_schedules.findMany({
            where: {
                watches: { some: { status: "active" } },
                OR: [
                    { last_error_code: { not: null } },
                    { availability: "unavailable" },
                ],
            },
            select: {
                id: true,
                transport_kind: true,
                last_error_code: true,
                last_error_detail: true,
                target: {
                    select: {
                        item_id: true,
                        title: true,
                        region: true,
                    },
                },
            },
            orderBy: { updated_at: "desc" },
            take: 10,
        }),
        db.proxy_groups.findMany({
            where: {
                price_watch_schedules: {
                    some: { watches: { some: { status: "active" } } },
                },
                OR: [
                    { proxy_check_status: { not: "completed" } },
                    { proxy_check_working: 0 },
                    { proxy_check_error: { not: null } },
                ],
            },
            select: {
                id: true,
                name: true,
                proxy_check_region: true,
                proxy_check_working: true,
                proxy_check_status: true,
                proxy_check_error: true,
            },
            orderBy: { proxy_check_completed_at: "desc" },
            take: 10,
        }),
    ]);
    const settingMap = new Map(
        settings.map((setting) => [setting.key, setting.value]),
    );
    const setting = settingMap.get(PRICE_WATCH_INTERVAL_SETTING_KEY);
    const configuredSeconds = Number(setting);
    const configuredMinutes = configuredSeconds / 60;
    const intervalMinutes =
        Number.isInteger(configuredMinutes) &&
        configuredMinutes >= MIN_PRICE_WATCH_INTERVAL_MINUTES &&
        configuredMinutes <= MAX_PRICE_WATCH_INTERVAL_MINUTES
            ? configuredMinutes
            : DEFAULT_PRICE_WATCH_INTERVAL_MINUTES;
    const runtime = scheduleStats[0];
    const health = telemetry[0];
    const alertHealth = alertStats[0];
    const durationSamples = Number(health?.duration_samples ?? 0);
    let publicUrlHealth: PriceWatchPollingAdminState["publicUrlHealth"] = {
        ok: false,
        origin: null,
        source: null,
        error: "Worker has not reported URL health yet",
    };
    try {
        const parsed = JSON.parse(
            settingMap.get("public_app_url_health") ?? "{}",
        ) as { OK?: boolean; Origin?: string; Source?: string; Error?: string };
        publicUrlHealth = {
            ok: parsed.OK === true,
            origin: parsed.Origin || null,
            source: parsed.Source || null,
            error: parsed.Error || null,
        };
    } catch {
        publicUrlHealth.error = "Worker reported invalid URL health data";
    }
    return {
        intervalMinutes,
        minMinutes: MIN_PRICE_WATCH_INTERVAL_MINUTES,
        maxMinutes: MAX_PRICE_WATCH_INTERVAL_MINUTES,
        uniqueActiveTargets,
        enabled: featurePolicy?.enabled ?? true,
        sharedMinimumSeconds: policy.sharedMinimumSeconds,
        personalMinimumSeconds: policy.personalMinimumSeconds,
        sharedMaxRpm: policy.sharedMaxRpm,
        personalMaxRpmPerProxy: policy.personalMaxRpmPerProxy,
        activeWatches: Number(runtime?.active_watches ?? 0),
        sharedSchedules: Number(runtime?.shared_schedules ?? 0),
        personalSchedules: Number(runtime?.personal_schedules ?? 0),
        expectedRpm: Number(runtime?.expected_rpm ?? 0),
        checks24h: Number(health?.checks ?? 0),
        successfulChecks24h: Number(health?.successes ?? 0),
        accessDenied24h: Number(health?.access_denied ?? 0),
        rateLimited24h: Number(health?.rate_limited ?? 0),
        serverErrors24h: Number(health?.server_errors ?? 0),
        averageDurationMs:
            durationSamples > 0
                ? Number(health?.duration_total ?? 0) / durationSamples
                : null,
        p50DurationMs:
            runtime?.p50_duration_ms == null
                ? null
                : Number(runtime.p50_duration_ms),
        p95DurationMs:
            runtime?.p95_duration_ms == null
                ? null
                : Number(runtime.p95_duration_ms),
        queueLagSeconds: Math.max(0, Number(runtime?.queue_lag_seconds ?? 0)),
        trafficBytes24h:
            Number(health?.tx_bytes ?? 0) + Number(health?.rx_bytes ?? 0),
        alertSuccessRate24h:
            Number(alertHealth?.total ?? 0) > 0
                ? (Number(alertHealth?.sent ?? 0) /
                      Number(alertHealth?.total ?? 0)) *
                  100
                : null,
        problems: problemSchedules.map((schedule) => ({
            scheduleId: schedule.id.toString(),
            itemId: schedule.target.item_id.toString(),
            title:
                schedule.target.title ||
                `Vinted item ${schedule.target.item_id.toString()}`,
            region: schedule.target.region,
            transport: schedule.transport_kind,
            errorCode:
                schedule.last_error_code ||
                (schedule.transport_kind === "proxy_group"
                    ? "proxy_unavailable"
                    : "item_unavailable"),
            detail:
                schedule.last_error_detail ||
                "No successful observation is currently available.",
        })),
        proxyProblems: problemProxyGroups.map((group) => ({
            id: group.id,
            name: group.name,
            region: group.proxy_check_region || "unknown",
            working: group.proxy_check_working,
            status: group.proxy_check_status,
            error:
                group.proxy_check_error ||
                (group.proxy_check_working === 0
                    ? "No working proxies"
                    : "Regional verification required"),
        })),
        publicUrlHealth,
    };
}

export type PriceWatchRuntimeSettingsInput = {
    enabled: boolean;
    sharedMinimumSeconds: number;
    personalMinimumSeconds: number;
    sharedMaxRpm: number;
    personalMaxRpmPerProxy: number;
};

export async function updatePriceWatchRuntimeSettings(
    input: PriceWatchRuntimeSettingsInput,
) {
    const adminUserId = await requireAdmin();
    if (
        ![120, 300, 600, 900, 1800, 3600].includes(input.sharedMinimumSeconds)
    ) {
        throw new Error(
            "Shared minimum must be a supported interval from 2 to 60 minutes.",
        );
    }
    if (
        ![30, 60, 120, 300, 600, 900, 1800, 3600].includes(
            input.personalMinimumSeconds,
        )
    ) {
        throw new Error(
            "Personal minimum must be a supported interval from 30 seconds to 60 minutes.",
        );
    }
    if (
        !Number.isInteger(input.sharedMaxRpm) ||
        input.sharedMaxRpm < 1 ||
        input.sharedMaxRpm > 300
    ) {
        throw new Error("Shared request budget must be between 1 and 300 RPM.");
    }
    if (
        !Number.isInteger(input.personalMaxRpmPerProxy) ||
        input.personalMaxRpmPerProxy < 1 ||
        input.personalMaxRpmPerProxy > 10
    ) {
        throw new Error("Personal proxy budget must be between 1 and 10 RPM.");
    }
    await writePolicyDocument<PriceWatchPolicy>(
        RUNTIME_POLICY_KEYS.priceWatch,
        {
            sharedMinimumSeconds: input.sharedMinimumSeconds,
            personalMinimumSeconds: input.personalMinimumSeconds,
            sharedMaxRpm: input.sharedMaxRpm,
            personalMaxRpmPerProxy: input.personalMaxRpmPerProxy,
        },
    );
    await logAuditEvent({
        userId: adminUserId,
        action: "admin.price_watch_runtime_updated",
        targetType: "app_setting",
        targetId: "price_watch_runtime",
        metadata: input,
    });
    revalidatePath("/admin");
    revalidatePath("/price-watches");
    return getPriceWatchPollingAdminState();
}

export async function updatePriceWatchPollingInterval(intervalMinutes: number) {
    const adminUserId = await requireAdmin();
    if (
        !Number.isInteger(intervalMinutes) ||
        intervalMinutes < MIN_PRICE_WATCH_INTERVAL_MINUTES ||
        intervalMinutes > MAX_PRICE_WATCH_INTERVAL_MINUTES
    ) {
        throw new Error(
            `Price Watch interval must be a whole number from ${MIN_PRICE_WATCH_INTERVAL_MINUTES} to ${MAX_PRICE_WATCH_INTERVAL_MINUTES} minutes.`,
        );
    }
    await db.$transaction([
        db.app_settings.upsert({
            where: { key: PRICE_WATCH_INTERVAL_SETTING_KEY },
            create: {
                key: PRICE_WATCH_INTERVAL_SETTING_KEY,
                value: String(intervalMinutes * 60),
            },
            update: { value: String(intervalMinutes * 60) },
        }),
        db.$executeRaw`
            UPDATE price_watch_schedules schedule
            SET next_check_at = LEAST(
                schedule.next_check_at,
                NOW() + (${intervalMinutes} * INTERVAL '1 minute')
            )
            WHERE EXISTS (
                SELECT 1
                FROM price_watches watch
                WHERE watch.schedule_id = schedule.id
                  AND watch.status = 'active'
            )
        `,
    ]);
    await logAuditEvent({
        userId: adminUserId,
        action: "admin.price_watch_interval_updated",
        targetType: "app_setting",
        targetId: PRICE_WATCH_INTERVAL_SETTING_KEY,
        metadata: { intervalMinutes },
    });
    revalidatePath("/admin");
    revalidatePath("/price-watches");
    return getPriceWatchPollingAdminState();
}

export type MonitorMaintenanceAdminState = {
    maintenance: MonitorMaintenance;
    runtime: Awaited<ReturnType<typeof getMonitorWorkerRuntime>>;
    status: ReturnType<typeof getMonitorMaintenanceStatus>;
    activeMonitorCount: number;
    maintenancePausedCount: number;
};

async function loadMonitorMaintenanceAdminState(): Promise<MonitorMaintenanceAdminState> {
    const [maintenance, runtime, activeMonitorCount, maintenancePausedCount] =
        await Promise.all([
            getMonitorMaintenance(),
            getMonitorWorkerRuntime().catch(() => null),
            db.monitors.count({ where: { status: "active" } }),
            db.monitors.count({ where: { status: "maintenance_paused" } }),
        ]);
    return {
        maintenance,
        runtime,
        status: getMonitorMaintenanceStatus(maintenance, runtime),
        activeMonitorCount,
        maintenancePausedCount,
    };
}

export async function getMonitorMaintenanceAdminState() {
    await requireAdmin();
    return loadMonitorMaintenanceAdminState();
}

export async function enableMonitorMaintenance(input: {
    message: string;
    estimatedEndAt: string | null;
}) {
    const adminUserId = await requireAdmin();
    const normalized = validateMonitorMaintenanceInput(input);
    const enabledAt = new Date();
    const revision = randomUUID();

    const pausedCount = await db.$transaction(async (tx) => {
        await acquireGlobalMonitorActivationLock(tx);
        const existing = await getMonitorMaintenance(tx);
        if (existing.enabled) {
            throw new Error("Monitor maintenance is already enabled");
        }
        // Admins need their own monitors to keep running through maintenance
        // so they can verify a fix while everyone else is paused.
        const result = await tx.monitors.updateMany({
            where: { status: "active", user: { role: { not: "admin" } } },
            data: { status: "maintenance_paused" },
        });
        const maintenance: MonitorMaintenance = {
            enabled: true,
            revision,
            ...normalized,
            enabledAt: enabledAt.toISOString(),
            enabledBy: adminUserId,
            updatedAt: enabledAt.toISOString(),
        };
        await tx.app_settings.upsert({
            where: { key: MONITOR_MAINTENANCE_SETTING_KEY },
            create: {
                key: MONITOR_MAINTENANCE_SETTING_KEY,
                value: JSON.stringify(maintenance),
            },
            update: { value: JSON.stringify(maintenance) },
        });
        return result.count;
    });

    await logAuditEvent({
        userId: adminUserId,
        action: "admin.monitor_maintenance_enabled",
        targetType: "app_setting",
        targetId: MONITOR_MAINTENANCE_SETTING_KEY,
        metadata: {
            revision,
            pausedCount,
            estimatedEndAt: normalized.estimatedEndAt,
        },
    });
    revalidatePath("/", "layout");
    revalidatePath("/admin");
    return loadMonitorMaintenanceAdminState();
}

export async function updateMonitorMaintenance(input: {
    message: string;
    estimatedEndAt: string | null;
}) {
    const adminUserId = await requireAdmin();
    const normalized = validateMonitorMaintenanceInput(input);
    const revision = randomUUID();
    const changed = await db.$transaction(async (tx) => {
        await acquireGlobalMonitorActivationLock(tx);
        const existing = await getMonitorMaintenance(tx);
        if (!existing.enabled) {
            throw new Error("Monitor maintenance is not enabled");
        }
        if (
            existing.message === normalized.message &&
            existing.estimatedEndAt === normalized.estimatedEndAt
        ) {
            return false;
        }
        const maintenance: MonitorMaintenance = {
            ...existing,
            ...normalized,
            revision,
            updatedAt: new Date().toISOString(),
        };
        await tx.app_settings.upsert({
            where: { key: MONITOR_MAINTENANCE_SETTING_KEY },
            create: {
                key: MONITOR_MAINTENANCE_SETTING_KEY,
                value: JSON.stringify(maintenance),
            },
            update: { value: JSON.stringify(maintenance) },
        });
        return true;
    });
    if (!changed) return loadMonitorMaintenanceAdminState();
    await logAuditEvent({
        userId: adminUserId,
        action: "admin.monitor_maintenance_updated",
        targetType: "app_setting",
        targetId: MONITOR_MAINTENANCE_SETTING_KEY,
        metadata: { revision, estimatedEndAt: normalized.estimatedEndAt },
    });
    revalidatePath("/", "layout");
    revalidatePath("/admin");
    return loadMonitorMaintenanceAdminState();
}

export async function disableMonitorMaintenance() {
    const adminUserId = await requireAdmin();
    const disabledAt = new Date();
    const revision = randomUUID();

    const result = await db.$transaction(async (tx) => {
        await acquireGlobalMonitorActivationLock(tx);
        const existing = await getMonitorMaintenance(tx);
        if (!existing.enabled) {
            throw new Error("Monitor maintenance is not enabled");
        }
        const policy = await getInactiveMemberPolicy(tx);
        const inactivityIds = await getInactiveEligibleMonitorIds(
            policy,
            "maintenance_paused",
            tx,
        );
        if (inactivityIds.length > 0) {
            await tx.monitors.updateMany({
                where: { id: { in: inactivityIds } },
                data: { status: "inactivity_paused" },
            });
        }
        const candidates = await tx.monitors.findMany({
            where: { status: "maintenance_paused" },
            orderBy: [
                { created_at: { sort: "asc", nulls: "last" } },
                { id: "asc" },
            ],
            select: { id: true, userId: true, proxy_source: true },
        });
        const byUser = new Map<string, typeof candidates>();
        for (const monitor of candidates) {
            const rows = byUser.get(monitor.userId) ?? [];
            rows.push(monitor);
            byUser.set(monitor.userId, rows);
        }
        const resumeIds: number[] = [];
        const limitPausedIds: number[] = [];
        for (const [userId, monitors] of byUser) {
            const [limits, activeCount, activeFreeCount, activeOwnCount] =
                await Promise.all([
                    getEffectiveMonitorLimits(userId, tx),
                    tx.monitors.count({ where: { userId, status: "active" } }),
                    tx.monitors.count({
                        where: {
                            userId,
                            status: "active",
                            proxy_source: "free",
                        },
                    }),
                    tx.monitors.count({
                        where: {
                            userId,
                            status: "active",
                            proxy_source: "group",
                        },
                    }),
                ]);
            let ownSlots =
                limits.ownProxyActiveLimit === null
                    ? null
                    : Math.max(limits.ownProxyActiveLimit - activeOwnCount, 0);
            let activeSlots =
                limits.activeLimit === null
                    ? null
                    : Math.max(limits.activeLimit - activeCount, 0);
            let freeSlots =
                limits.freeProxyActiveLimit === null
                    ? null
                    : Math.max(
                          limits.freeProxyActiveLimit - activeFreeCount,
                          0,
                      );
            for (const monitor of monitors) {
                const canResume =
                    (activeSlots === null || activeSlots > 0) &&
                    (monitor.proxy_source !== "group" ||
                        ownSlots === null ||
                        ownSlots > 0) &&
                    (monitor.proxy_source !== "free" ||
                        freeSlots === null ||
                        freeSlots > 0);
                if (!canResume) {
                    limitPausedIds.push(monitor.id);
                    continue;
                }
                resumeIds.push(monitor.id);
                if (activeSlots !== null) activeSlots -= 1;
                if (monitor.proxy_source === "group" && ownSlots !== null)
                    ownSlots -= 1;
                if (monitor.proxy_source === "free" && freeSlots !== null) {
                    freeSlots -= 1;
                }
            }
        }
        if (resumeIds.length > 0) {
            await tx.monitors.updateMany({
                where: { id: { in: resumeIds } },
                data: { status: "active" },
            });
        }
        if (limitPausedIds.length > 0) {
            await tx.monitors.updateMany({
                where: { id: { in: limitPausedIds } },
                data: { status: "paused" },
            });
        }
        const maintenance: MonitorMaintenance = {
            ...existing,
            enabled: false,
            revision,
            updatedAt: disabledAt.toISOString(),
        };
        await tx.app_settings.upsert({
            where: { key: MONITOR_MAINTENANCE_SETTING_KEY },
            create: {
                key: MONITOR_MAINTENANCE_SETTING_KEY,
                value: JSON.stringify(maintenance),
            },
            update: { value: JSON.stringify(maintenance) },
        });
        return {
            resumedCount: resumeIds.length,
            inactivityPausedCount: inactivityIds.length,
            limitPausedCount: limitPausedIds.length,
            durationSeconds: existing.enabledAt
                ? Math.max(
                      0,
                      Math.round(
                          (disabledAt.getTime() -
                              new Date(existing.enabledAt).getTime()) /
                              1000,
                      ),
                  )
                : null,
        };
    });

    await logAuditEvent({
        userId: adminUserId,
        action: "admin.monitor_maintenance_disabled",
        targetType: "app_setting",
        targetId: MONITOR_MAINTENANCE_SETTING_KEY,
        metadata: { revision, ...result },
    });
    revalidatePath("/", "layout");
    revalidatePath("/admin");
    return loadMonitorMaintenanceAdminState();
}

export type InactiveMemberPolicyAdminState = {
    policy: InactiveMemberPolicy;
    runtime: Awaited<ReturnType<typeof getInactiveMemberRuntime>>;
    status: ReturnType<typeof inactivePolicyRuntimeStatus>;
    preview: {
        memberCount: number;
        monitorCount: number;
        priceWatchCount: number;
    };
    inactivityPausedCount: number;
    inactivityPausedPriceWatchCount: number;
};

async function loadInactiveMemberPolicyAdminState(): Promise<InactiveMemberPolicyAdminState> {
    const [
        policy,
        runtime,
        inactivityPausedCount,
        inactivityPausedPriceWatchCount,
    ] = await Promise.all([
        getInactiveMemberPolicy(),
        getInactiveMemberRuntime().catch(() => null),
        db.monitors.count({ where: { status: "inactivity_paused" } }),
        db.price_watches.count({
            where: { status: "paused", stopped_reason: "inactive_member" },
        }),
    ]);
    return {
        policy,
        runtime,
        status: inactivePolicyRuntimeStatus(policy, runtime),
        preview: await countInactivePolicyMatches(policy),
        inactivityPausedCount,
        inactivityPausedPriceWatchCount,
    };
}

export async function getInactiveMemberPolicyAdminState() {
    await requireAdmin();
    return loadInactiveMemberPolicyAdminState();
}

export async function previewInactiveMemberPolicy(
    input: InactiveMemberPolicyInput,
) {
    await requireAdmin();
    const normalized = validateInactiveMemberPolicyInput(input);
    const existing = await getInactiveMemberPolicy();
    const policy: InactiveMemberPolicy = {
        ...existing,
        ...normalized,
        enabledAt:
            input.enabled && !existing.enabled
                ? new Date().toISOString()
                : existing.enabledAt,
    };
    return countInactivePolicyMatches(policy);
}

export async function updateInactiveMemberPolicy(
    input: InactiveMemberPolicyInput,
) {
    const adminUserId = await requireAdmin();
    const normalized = validateInactiveMemberPolicyInput(input);
    const now = new Date();
    const result = await db.$transaction(async (tx) => {
        await acquireGlobalMonitorActivationLock(tx);
        const existing = await getInactiveMemberPolicy(tx);
        const changed =
            existing.enabled !== normalized.enabled ||
            existing.duration !== normalized.duration ||
            existing.durationUnit !== normalized.durationUnit ||
            existing.monitorScope !== normalized.monitorScope ||
            existing.includePriceWatches !== normalized.includePriceWatches ||
            existing.roles.join(",") !== normalized.roles.join(",");
        if (!changed) return { changed: false, revision: existing.revision };

        const revision = randomUUID();
        const policy: InactiveMemberPolicy = {
            ...normalized,
            revision,
            enabledAt:
                normalized.enabled && !existing.enabled
                    ? now.toISOString()
                    : existing.enabledAt,
            updatedAt: now.toISOString(),
            updatedBy: adminUserId,
        };
        await tx.app_settings.upsert({
            where: { key: INACTIVE_MEMBER_POLICY_SETTING_KEY },
            create: {
                key: INACTIVE_MEMBER_POLICY_SETTING_KEY,
                value: JSON.stringify(policy),
            },
            update: { value: JSON.stringify(policy) },
        });
        return { changed: true, revision };
    });
    if (result.changed) {
        await logAuditEvent({
            userId: adminUserId,
            action: "admin.inactive_member_policy_updated",
            targetType: "app_setting",
            targetId: INACTIVE_MEMBER_POLICY_SETTING_KEY,
            metadata: {
                revision: result.revision,
                enabled: normalized.enabled,
                durationDays: normalized.durationDays,
                monitorScope: normalized.monitorScope,
                includePriceWatches: normalized.includePriceWatches,
                roles: normalized.roles,
            },
        });
        revalidatePath("/", "layout");
        revalidatePath("/admin");
    }
    return loadInactiveMemberPolicyAdminState();
}

export async function updateMemberAnnouncement(
    input: MemberAnnouncementInput,
): Promise<
    | {
          success: true;
          announcement: MemberAnnouncement;
          changed: boolean;
      }
    | { success: false; error: string }
> {
    const adminUserId = await requireAdmin();
    let normalized: MemberAnnouncementInput;
    try {
        normalized = validateMemberAnnouncementInput(input);
    } catch (error) {
        return {
            success: false,
            error:
                error instanceof Error
                    ? error.message
                    : "Invalid announcement settings",
        };
    }
    const existingSetting = await db.app_settings.findUnique({
        where: { key: MEMBER_ANNOUNCEMENT_SETTING_KEY },
        select: { value: true },
    });
    const existing = parseMemberAnnouncement(existingSetting?.value);
    const changed =
        JSON.stringify(toMemberAnnouncementInput(existing)) !==
        JSON.stringify(normalized);

    if (!changed) {
        return { success: true, announcement: existing, changed: false };
    }

    const announcement: MemberAnnouncement = {
        ...normalized,
        revision: randomUUID(),
    };
    await db.app_settings.upsert({
        where: { key: MEMBER_ANNOUNCEMENT_SETTING_KEY },
        create: {
            key: MEMBER_ANNOUNCEMENT_SETTING_KEY,
            value: JSON.stringify(announcement),
        },
        update: { value: JSON.stringify(announcement) },
    });

    await logAuditEvent({
        userId: adminUserId,
        action: "admin.member_announcement_updated",
        targetType: "app_setting",
        targetId: MEMBER_ANNOUNCEMENT_SETTING_KEY,
        metadata: {
            enabled: announcement.enabled,
            variant: announcement.variant,
            dismissible: announcement.dismissible,
            audiences: announcement.audiences,
            placements: announcement.placements,
            startsAt: announcement.startsAt,
            endsAt: announcement.endsAt,
            hasCta: announcement.cta !== null,
            titleLength: announcement.title.length,
            messageLength: announcement.message.length,
        },
    });

    revalidatePath("/", "layout");
    return { success: true, announcement, changed: true };
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
    const [document, featurePolicy] = await Promise.all([
        readFreeProxyPolicy(),
        db.feature_policies.findUnique({
            where: { feature: "free_proxy_pool" },
            select: { enabled: true },
        }),
    ]);
    if (document) {
        return {
            ...policyPayload(document),
            enabled: featurePolicy?.enabled ?? false,
        };
    }

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
        enabled:
            featurePolicy?.enabled ??
            parseBooleanSetting(values[FREE_PROXY_ENABLED_KEY], false),
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
        adaptivePacingEnabled: false,
        adaptiveRegions: ["de", "fr"],
        maxRequestsPerProxySecond: 0.5,
        maxAdmissionDelayMs: 1500,
    };
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
        pacingRuntimeSetting,
        poolStateSettings,
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
        db.app_settings.findUnique({
            where: { key: "free_proxy_runtime_metrics" },
            select: { value: true },
        }),
        db.app_settings.findMany({
            where: {
                OR: [
                    { key: { startsWith: "free_proxy_canary_state:" } },
                    { key: { startsWith: "free_proxy_serving_state:" } },
                ],
            },
            select: { key: true, value: true },
        }),
    ]);

    const canaryByRegion = new Map(
        poolStateSettings.flatMap((setting) => {
            if (!setting.key.startsWith("free_proxy_canary_state:")) return [];
            const canary = parseFreeProxyCanarySnapshot(setting.value);
            return canary
                ? [
                      [
                          setting.key.replace("free_proxy_canary_state:", ""),
                          canary,
                      ] as const,
                  ]
                : [];
        }),
    );
    const servingByRegion = new Map<string, boolean>();
    for (const setting of poolStateSettings) {
        if (!setting.key.startsWith("free_proxy_serving_state:")) continue;
        try {
            const state = JSON.parse(setting.value) as { serving?: boolean };
            servingByRegion.set(
                setting.key.replace("free_proxy_serving_state:", ""),
                state.serving === true,
            );
        } catch {}
    }

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
        runtimeMetrics: parseFreeProxyRuntimeMetrics(
            pacingRuntimeSetting?.value,
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
            const canary = canaryByRegion.get(row.region) ?? null;
            const serving = servingByRegion.get(row.region) === true;

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
                serving,
                capacityReady:
                    Number(row.active_count) >= settings.minActivePerRegion,
                canaryState: canary?.state ?? null,
                canarySampleCount: canary?.sampleCount ?? 0,
                canarySuccessRate: canary?.successRate ?? null,
                canaryWindowMinutes: canary?.windowMinutes ?? 0,
                canaryLastProbeAt: canary?.lastProbeAt ?? null,
                canaryReadinessReason: canary?.readinessReason ?? null,
                healthy: serving,
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
    const adaptivePacingEnabled =
        formData.get("adaptivePacingEnabled") === "true";
    const adaptiveRegions = String(formData.get("adaptiveRegions") ?? "de,fr")
        .split(",")
        .map((region) => region.trim().toLowerCase())
        .filter(Boolean);
    const maxRequestsPerProxySecond = Math.min(
        10,
        Math.max(
            0.05,
            Number(formData.get("maxRequestsPerProxySecond")) || 0.5,
        ),
    );
    const maxAdmissionDelayMs = parsePositiveIntSetting(
        formData.get("maxAdmissionDelayMs") as string | undefined,
        1500,
        0,
        30000,
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

    await writePolicyDocument<FreeProxyPolicy>(RUNTIME_POLICY_KEYS.freeProxy, {
        autoImportEnabled,
        importSource,
        importUrl,
        maxPoolSize,
        failureThreshold,
        quarantineMinutes,
        minActivePerRegion,
        targetActivePerRegion,
        maxLatencyMs,
        starterRegions,
        inventoryLimit,
        activeCandidateLimit,
        idleCandidateLimit,
        readyTarget,
        reserveTarget,
        idleTarget,
        emergencyRecoveryEnabled,
        adaptivePacingEnabled,
        adaptiveRegions,
        maxRequestsPerProxySecond,
        maxAdmissionDelayMs,
    });

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
    return loadAdminOverviewState();
}

export async function getAdminUsersPage(input?: {
    query?: string;
    page?: number;
    pageSize?: number;
}) {
    await requireAdmin();

    const query = String(input?.query ?? "")
        .trim()
        .slice(0, 100);
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
                      price_watch_limit: true,
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
        userPriceWatchLimits: Object.fromEntries(
            userLimitRows.map((row) => [
                row.scope.slice(USER_MONITOR_LIMIT_PREFIX.length),
                row.price_watch_limit,
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
                price_watch_limit: true,
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
        userPriceWatchLimits: Object.fromEntries(
            userLimitRows.map((row) => [
                row.scope.slice(USER_MONITOR_LIMIT_PREFIX.length),
                row.price_watch_limit,
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
            proxy_source: true,
            proxy_group: {
                select: {
                    name: true,
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
        discord_configured: Boolean(discord_webhook),
    }));
}

export async function getAdminUserDetails(userId: string) {
    await requireAdmin();

    const [user, userLimit] = await Promise.all([
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
                        price_min: true,
                        price_max: true,
                        discord_webhook: true,
                        webhook_active: true,
                        telegram_active: true,
                        proxy_source: true,
                        proxy_group: { select: { name: true } },
                    },
                },
            },
        }),
        db.monitor_limits.findUnique({
            where: { scope: userLimitScope(userId) },
            select: {
                active_limit: true,
                free_proxy_active_limit: true,
            },
        }),
    ]);

    if (!user) throw new Error("User not found");

    return {
        monitors: user.monitors,
        limits: {
            active: userLimit?.active_limit ?? null,
            freeProxy: userLimit?.free_proxy_active_limit ?? null,
        },
    };
}

export async function getAdminOverviewDashboardState() {
    await requireAdmin();
    const [overview, summary, operations] = await Promise.all([
        loadAdminOverviewState(),
        getAdminOperationsSummary(),
        getAdminOperationsPage({ filter: "all", pageSize: 6 }),
    ]);
    return { overview, summary, operations };
}

export async function setUserRole(userId: string, role: string) {
    const adminUserId = await requireAdmin();

    const validRoles = ["free", "premium", "admin"];
    if (!validRoles.includes(role)) throw new Error("Invalid role");

    await db.user.update({
        where: { id: userId },
        data: { role },
    });

    const ownPaused = await reconcileUserOwnProxyMonitorLimit(
        userId,
        `role-change:${role}`,
        adminUserId,
    );
    const reconciliation = await reconcileFreeProxyLimitsForUsers(
        [userId],
        `role-change:${role}`,
        adminUserId,
    );

    revalidatePath("/admin");
    revalidatePath("/dashboard");
    return {
        pausedCount: reconciliation.pausedCount + ownPaused.length,
        pausedMonitorIds: [
            ...reconciliation.pausedMonitorIds,
            ...ownPaused.map((monitor) => monitor.id),
        ],
    };
}

export async function setGlobalOwnProxyMonitorLimit(value: string) {
    const adminUserId = await requireAdmin();
    const limit = Number(value);
    if (!value.trim() || !Number.isSafeInteger(limit) || limit < 0) {
        throw new Error("Own proxy limit must be a non-negative whole number");
    }
    await db.$transaction(async (tx) => {
        await acquireGlobalMonitorActivationLock(tx);
        await tx.app_settings.upsert({
            where: { key: OWN_PROXY_LIMIT_SETTING_KEY },
            create: { key: OWN_PROXY_LIMIT_SETTING_KEY, value: String(limit) },
            update: { value: String(limit) },
        });
        await tx.audit_events.create({
            data: {
                userId: adminUserId,
                action: "admin.own_proxy_limit_updated",
                status: "success",
                target_type: "app_setting",
                target_id: OWN_PROXY_LIMIT_SETTING_KEY,
                metadata: { limit },
            },
        });
    });
    try {
        return {
            limit,
            ...(await reconcileAllOwnProxyMonitorLimits(adminUserId)),
        };
    } catch (error) {
        console.error(
            "[admin] failed to reconcile own proxy monitor limits",
            error,
        );
        throw new Error(
            "Limit saved, but applying it to existing monitors failed. Save and apply again to finish.",
        );
    } finally {
        revalidatePath("/", "layout");
    }
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

async function reconcilePriceWatchLimits(userIds: string[], reason: string) {
    let pausedCount = 0;
    for (const userId of userIds) {
        pausedCount += await db.$transaction(async (tx) => {
            const { priceWatchLimit } = await getEffectivePriceWatchLimit(
                userId,
                tx,
            );
            if (priceWatchLimit === null) return 0;
            const active = await tx.price_watches.findMany({
                where: { user_id: userId, status: "active" },
                orderBy: [{ created_at: "desc" }, { id: "desc" }],
                select: { id: true },
            });
            const excess = active.slice(
                0,
                Math.max(0, active.length - priceWatchLimit),
            );
            if (excess.length === 0) return 0;
            const result = await tx.price_watches.updateMany({
                where: { id: { in: excess.map((watch) => watch.id) } },
                data: {
                    status: "paused",
                    stopped_reason: "limit_reduced",
                    armed_at: null,
                },
            });
            return result.count;
        });
    }
    return { pausedCount, reason };
}

export async function setGlobalPriceWatchLimit(value: string) {
    const adminUserId = await requireAdmin();
    const limit = normalizeMonitorLimitInput(value);
    await setPriceWatchLimit(GLOBAL_MONITOR_LIMIT_SCOPE, limit);
    const users = await db.user.findMany({
        where: { role: { not: "admin" } },
        select: { id: true },
    });
    const reconciliation = await reconcilePriceWatchLimits(
        users.map((user) => user.id),
        GLOBAL_MONITOR_LIMIT_SCOPE,
    );
    await logAuditEvent({
        userId: adminUserId,
        action: "admin.price_watch_limit_updated",
        targetType: "monitor_limit",
        targetId: GLOBAL_MONITOR_LIMIT_SCOPE,
        metadata: { limit, pausedCount: reconciliation.pausedCount },
    });
    revalidatePath("/admin");
    revalidatePath("/price-watches");
    return reconciliation;
}

export async function setRolePriceWatchLimit(role: string, value: string) {
    const adminUserId = await requireAdmin();
    if (!["free", "premium"].includes(role)) throw new Error("Invalid role");
    const limit = normalizeMonitorLimitInput(value);
    const scope = roleLimitScope(role);
    await setPriceWatchLimit(scope, limit);
    const users = await db.user.findMany({
        where: { role },
        select: { id: true },
    });
    const reconciliation = await reconcilePriceWatchLimits(
        users.map((user) => user.id),
        scope,
    );
    await logAuditEvent({
        userId: adminUserId,
        action: "admin.price_watch_limit_updated",
        targetType: "monitor_limit",
        targetId: scope,
        metadata: { limit, pausedCount: reconciliation.pausedCount },
    });
    revalidatePath("/admin");
    revalidatePath("/price-watches");
    return reconciliation;
}

export async function setUserPriceWatchLimit(userId: string, value: string) {
    const adminUserId = await requireAdmin();
    const user = await db.user.findUnique({
        where: { id: userId },
        select: { role: true },
    });
    if (!user) throw new Error("User not found");
    if (user.role === "admin") throw new Error("Admins are always unlimited");
    const limit = normalizeMonitorLimitInput(value);
    const scope = userLimitScope(userId);
    await setPriceWatchLimit(scope, limit);
    const reconciliation = await reconcilePriceWatchLimits([userId], scope);
    await logAuditEvent({
        userId: adminUserId,
        action: "admin.price_watch_limit_updated",
        targetType: "monitor_limit",
        targetId: scope,
        metadata: {
            memberUserId: userId,
            limit,
            pausedCount: reconciliation.pausedCount,
        },
    });
    revalidatePath("/admin");
    revalidatePath("/price-watches");
    return reconciliation;
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
    const adminUserId = await requireAdmin();
    const stoppedCount = await withMonitorActivationLock(userId, async (tx) => {
        const result = await tx.monitors.updateMany({
            where: { userId, status: "active" },
            data: { status: "paused" },
        });
        return result.count;
    });
    await logAuditEvent({
        userId: adminUserId,
        action: "admin.user_monitors_paused",
        targetType: "user",
        targetId: userId,
        metadata: { stoppedCount },
    });

    revalidatePath("/admin");

    return {
        success: true,
        stoppedCount,
    };
}

export async function stopSingleUserMonitor(userId: string, monitorId: number) {
    const adminUserId = await requireAdmin();
    const stopped = await withMonitorActivationLock(userId, async (tx) => {
        const result = await tx.monitors.updateMany({
            where: { id: monitorId, userId, status: "active" },
            data: { status: "paused" },
        });
        return result.count > 0;
    });
    if (stopped) {
        await logAuditEvent({
            userId: adminUserId,
            action: "admin.monitor_paused",
            targetType: "monitor",
            targetId: String(monitorId),
            metadata: { memberUserId: userId },
        });
    }

    revalidatePath("/admin");

    return { success: true, stopped };
}
