"use client";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
    Activity,
    AlertTriangle,
    ArrowDownRight,
    ArrowUpRight,
    BarChart3,
    CheckCircle2,
    ChevronDown,
    ChevronLeft,
    ChevronRight,
    Shield,
    Crown,
    User,
    Monitor,
    Minus,
    Globe,
    Server,
    Search,
    ScrollText,
    Settings2,
    Users,
    PauseCircle,
    Clock3,
    Boxes,
    Webhook,
    Gauge,
    TrendingUp,
    UserPlus,
    FlaskConical,
    Sparkles,
    Megaphone,
    Wrench,
    TimerReset,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import {
    setGlobalActiveMonitorLimit,
    setGlobalFreeProxyMonitorLimit,
    setRoleActiveMonitorLimit,
    setRoleFreeProxyMonitorLimit,
    setUserRole,
    setUserActiveMonitorLimit,
    setUserFreeProxyMonitorLimit,
    getAdminActiveMonitors,
    getAdminOverviewState,
    getAdminRuntimeInsights,
    getAdminUsersPage,
    getAdminMemberInsights,
    getAdminOperationsPage,
    getAdminOperationsSummary,
    getFreeProxyAdminState,
    getFreeProxySourceDiagnostics,
    getAdminUserDetails,
    addFreeProxies,
    clearFreeProxyQuarantine,
    importFreeProxiesNow,
    updateFreeProxySettings,
    updateServerProxies,
    updateMemberAnnouncement,
    stopSingleUserMonitor,
    stopUserActiveMonitors,
    enableMonitorMaintenance,
    updateMonitorMaintenance,
    disableMonitorMaintenance,
    type MonitorMaintenanceAdminState,
    previewInactiveMemberPolicy,
    updateInactiveMemberPolicy,
    type InactiveMemberPolicyAdminState,
} from "@/actions/admin";
import { getRegionLabel, REGIONS } from "@/lib/regions";
import { getProxyErrorDetails } from "@/lib/proxy-errors";
import { MemberAnnouncementBanner } from "@/components/announcements/member-announcement-banner";
import {
    MEMBER_ANNOUNCEMENT_AUDIENCES,
    MEMBER_ANNOUNCEMENT_PLACEMENTS,
    MEMBER_ANNOUNCEMENT_VARIANTS,
    toMemberAnnouncementInput,
    type MemberAnnouncement,
    type MemberAnnouncementAudience,
    type MemberAnnouncementPlacement,
} from "@/lib/member-announcement";
import { DEFAULT_MONITOR_MAINTENANCE_MESSAGE } from "@/lib/monitor-maintenance";
import type {
    InactivityDurationUnit,
    InactivityMonitorScope,
} from "@/lib/inactive-member-policy";

type UserMonitor = {
    id: number;
    name: string;
    query: string;
    query_delay_ms: number;
    status: string | null;
    region: string;
    created_at: Date | null;
    active_since: Date | null;
    runtime_total_seconds: number;
    price_min: number | null;
    price_max: number | null;
    discord_webhook: string | null;
    webhook_active: boolean;
    telegram_active: boolean;
    proxy_source: string;
    proxy_group: { name: string } | null;
    _count: { items: number };
};

type ActiveMonitor = Omit<UserMonitor, "discord_webhook"> & {
    discord_configured: boolean;
    userId: string;
    user: {
        id: string;
        name: string | null;
        email: string | null;
        role: string;
        image: string | null;
        _count: { monitors: number; proxy_groups: number };
    };
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

type AdminOverviewState = Awaited<ReturnType<typeof getAdminOverviewState>>;
type RuntimeInsights = Awaited<ReturnType<typeof getAdminRuntimeInsights>>;

type UserRuntimeDetails = {
    currentRuntimeSeconds: number;
    totalRuntimeSeconds: number;
    runtimeSeconds7d: number;
    averageSessionSeconds: number;
};

type UserRow = {
    id: string;
    name: string | null;
    email: string | null;
    image: string | null;
    role: string;
    _count: { monitors: number; proxy_groups: number };
    monitors: UserMonitor[];
    activeMonitors: ActiveMonitor[];
    metrics: AdminUserMetrics;
    runtimeDetails?: UserRuntimeDetails;
};

type AdminTab =
    | "overview"
    | "insights"
    | "monitors"
    | "users"
    | "roles"
    | "logs"
    | "announcements"
    | "settings";

type AdminLogRow = {
    id: string;
    type: "audit" | "monitor" | "delivery" | "proxy";
    title: string;
    detail: string | null;
    status: string;
    subject: string | null;
    actor: string | null;
    createdAt: Date;
};

type AdminOperationsSummary = {
    windowHours: number;
    sent: number;
    failed: number;
    deduplicated: number;
    queued: number;
    retryScheduled: number;
    pending: number;
    retrying: number;
    successRate: number | null;
    oldestPendingAt: Date | null;
    byChannel: Record<
        string,
        { sent: number; failed: number; deduplicated: number }
    >;
    topFailures: {
        channel: string;
        reasonCode: string;
        count: number;
        lastSeenAt: Date;
    }[];
    proxyIncidents: {
        open: number;
        recovered: number;
        brief: number;
        briefGroups: {
            domain: string;
            proxySource: string;
            incidents: number;
            waits: number;
        }[];
    };
    trackedSince: string | null;
    dispatcherHeartbeat: string | null;
    enrichment: {
        queueAgeMs: number;
        cacheHitRate: number;
        cacheHits: number;
        cacheMisses: number;
        remoteP95Ms: number;
        timeouts: number;
        updatedAt: string | null;
    } | null;
    notificationLatency: {
        p50Ms: number | null;
        p95Ms: number | null;
        p99Ms: number | null;
    };
};

type AdminOperationFilter = "all" | "delivery" | "proxy" | "monitor" | "audit";

type MemberInsights = {
    summary: {
        totalMembers: number;
        newMembers7d: number;
        signupGrowth7d: number | null;
        newMembers30d: number;
        signupGrowth30d: number | null;
        membersWithoutSignupDate: number;
        usersWithMonitors: number;
        activationRate: number;
    };
    growth: {
        date: string;
        newMembers: number;
    }[];
    roles: { role: string; count: number }[];
    demo: {
        users: number;
        activeUsers: number;
        expiredUsers: number;
        convertedUsers: number;
        adoptionRate: number;
        conversionRate: number;
    };
    recentMembers: {
        id: string;
        name: string | null;
        email: string | null;
        role: string;
        monitorCount: number;
        createdAt: string | null;
    }[];
};

type MonitorLimits = {
    global: number | null;
    roles: Record<string, number | null>;
    users: Record<string, number | null>;
    freeProxyGlobal: number | null;
    freeProxyRoles: Record<string, number | null>;
    freeProxyUsers: Record<string, number | null>;
};

type FreeProxyRow = {
    id: number;
    proxy_url: string;
    protocol: string;
    source: string;
    status: string;
    success_count: number;
    failure_count: number;
    last_checked_at: Date | null;
    last_success_at: Date | null;
    last_failure_at: Date | null;
    quarantined_until: Date | null;
    last_error: string | null;
};

type FreeProxyState = {
    degradationReason: "host_egress_limited" | null;
    maintainerRuntime: {
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
    } | null;
    settings: {
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
    counts: {
        active: number;
        pending: number;
        quarantined: number;
        disabled: number;
        total: number;
    };
    regions: {
        region: string;
        active: number;
        reserve: number;
        warming: number;
        pending: number;
        cooldown: number;
        dead: number;
        successRate: number | null;
        medianLatencyMs: number | null;
        lastCheckedAt: Date | null;
        stalled: boolean;
        healthy: boolean;
        topErrorStage: string | null;
        candidateWindow: number;
        checkedLastHour: number;
        promotedLastHour: number;
        minutesSinceLastSuccess: number | null;
        activeMonitorCount: number;
        recoveryMode: boolean;
        dueNow: number;
        neverChecked: number;
    }[];
    sourceDiagnostics: {
        region: string;
        source: string;
        protocol: string;
        proxyCount: number;
        checked: number;
        successful: number;
        successRate: number | null;
        neverChecked: number;
        active: number;
        reserve: number;
        cooldown: number;
        topErrorCode: string | null;
        topErrorStage: string | null;
    }[];
    recent: FreeProxyRow[];
};

function AdminMonitorError({ message }: { message: string }) {
    const issue = getProxyErrorDetails(null, message);
    return (
        <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-200">
            <p className="font-semibold">{issue.title}</p>
            <p className="mt-0.5">{issue.description}</p>
            {issue.action ? (
                <p className="mt-1 font-medium">{issue.action}</p>
            ) : null}
            <details className="mt-2 text-[11px]">
                <summary className="cursor-pointer font-medium">
                    Technical details
                </summary>
                <p className="mt-1 font-mono break-words">{message}</p>
            </details>
        </div>
    );
}

const ROLES = [
    {
        value: "free",
        label: "Free",
        icon: User,
        color: "bg-muted text-muted-foreground",
    },
    {
        value: "premium",
        label: "Premium",
        icon: Crown,
        color: "bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-400",
    },
    {
        value: "admin",
        label: "Admin",
        icon: Shield,
        color: "bg-red-100 dark:bg-red-500/20 text-red-700 dark:text-red-400",
    },
] as const;

const LIMIT_ROLES = ROLES.filter((role) => role.value !== "admin");
const USER_PAGE_SIZES = [25, 50, 100] as const;
const FREE_PROXY_SOURCE_OPTIONS = [
    {
        value: "iplocate_all",
        label: "IPLocate all",
        url: "https://raw.githubusercontent.com/iplocate/free-proxy-list/main/all-proxies.txt",
    },
    {
        value: "iplocate_http",
        label: "IPLocate HTTP",
        url: "https://raw.githubusercontent.com/iplocate/free-proxy-list/main/protocols/http.txt",
    },
    {
        value: "iplocate_https",
        label: "IPLocate HTTPS",
        url: "https://raw.githubusercontent.com/iplocate/free-proxy-list/main/protocols/https.txt",
    },
    {
        value: "iplocate_socks4",
        label: "IPLocate SOCKS4",
        url: "https://raw.githubusercontent.com/iplocate/free-proxy-list/main/protocols/socks4.txt",
    },
    {
        value: "iplocate_socks5",
        label: "IPLocate SOCKS5",
        url: "https://raw.githubusercontent.com/iplocate/free-proxy-list/main/protocols/socks5.txt",
    },
    {
        value: "proxyscrape",
        label: "ProxyScrape",
        url: "https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&proxy_format=protocolipport&format=text",
    },
    {
        value: "custom",
        label: "Custom URL",
        url: "",
    },
] as const;

const ANNOUNCEMENT_AUDIENCE_LABELS: Record<MemberAnnouncementAudience, string> =
    {
        free: "Free members",
        premium: "Premium members",
        admin: "Admins",
    };

const ANNOUNCEMENT_PLACEMENT_LABELS: Record<
    MemberAnnouncementPlacement,
    { label: string; description: string }
> = {
    monitors: {
        label: "Monitors",
        description: "Dashboard and monitor pages",
    },
    live_feed: { label: "Live Feed", description: "Feed page" },
    member_tools: {
        label: "Member Tools",
        description: "Account, listings, likes, chats and checkout",
    },
    proxy_groups: {
        label: "Proxy Groups",
        description: "Proxy management",
    },
    guide: { label: "Guide", description: "Member guide" },
    admin: { label: "Admin", description: "Admin panel" },
};

function announcementDateTimeValue(value: string | null) {
    if (!value) return "";
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return "";
    const localDate = new Date(
        date.getTime() - date.getTimezoneOffset() * 60_000,
    );
    return localDate.toISOString().slice(0, 16);
}

function announcementDateTimeIso(value: string) {
    return value ? new Date(value).toISOString() : null;
}
const ADMIN_TABS: {
    value: AdminTab;
    label: string;
    icon: typeof BarChart3;
    description: string;
}[] = [
    {
        value: "overview",
        label: "Overview",
        icon: BarChart3,
        description: "Live system capacity, monitor health, and recent issues.",
    },
    {
        value: "insights",
        label: "Member Insights",
        icon: TrendingUp,
        description:
            "Member growth, activation, roles, and demo monitor adoption.",
    },
    {
        value: "monitors",
        label: "Running Monitors",
        icon: Monitor,
        description:
            "Monitor operations, maintenance controls, and active workloads.",
    },
    {
        value: "users",
        label: "Users",
        icon: Users,
        description: "Accounts, usage, monitor activity, and quick actions.",
    },
    {
        value: "roles",
        label: "Roles",
        icon: Shield,
        description: "Access levels and active monitor limits.",
    },
    {
        value: "logs",
        label: "Logs",
        icon: ScrollText,
        description: "Important audit, monitor, and alert events.",
    },
    {
        value: "announcements",
        label: "Announcements",
        icon: Megaphone,
        description: "Create and target member-facing product updates.",
    },
    {
        value: "settings",
        label: "Settings",
        icon: Settings2,
        description: "Shared proxy infrastructure and worker configuration.",
    },
];

function OverviewMetric({
    label,
    value,
    detail,
    icon: Icon,
    iconClassName,
}: {
    label: string;
    value: number | string;
    detail: string;
    icon: typeof BarChart3;
    iconClassName: string;
}) {
    return (
        <div className="bg-card min-w-0 px-4 py-4 sm:px-5">
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <p className="text-muted-foreground text-[11px] font-medium uppercase">
                        {label}
                    </p>
                    <p className="mt-1 text-2xl font-semibold tabular-nums">
                        {value}
                    </p>
                </div>
                <span
                    className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md ${iconClassName}`}
                >
                    <Icon className="h-4 w-4" />
                </span>
            </div>
            <p className="text-muted-foreground mt-2 truncate text-[11px]">
                {detail}
            </p>
        </div>
    );
}

type MemberMetricTone = "neutral" | "sky" | "violet" | "amber";

function MemberMetricCard({
    label,
    value,
    detail,
    icon: Icon,
    tone,
    change,
    changeLabel,
    progress,
}: {
    label: string;
    value: number | string;
    detail: string;
    icon: typeof BarChart3;
    tone: MemberMetricTone;
    change?: number | null;
    changeLabel?: string;
    progress?: number;
}) {
    const toneStyles: Record<
        MemberMetricTone,
        { icon: string; glow: string; progress: string }
    > = {
        neutral: {
            icon: "bg-muted text-foreground",
            glow: "bg-foreground/5",
            progress: "bg-foreground/70",
        },
        sky: {
            icon: "bg-sky-500/10 text-sky-500",
            glow: "bg-sky-500/10",
            progress: "bg-sky-500",
        },
        violet: {
            icon: "bg-violet-500/10 text-violet-500",
            glow: "bg-violet-500/10",
            progress: "bg-violet-500",
        },
        amber: {
            icon: "bg-amber-500/10 text-amber-500",
            glow: "bg-amber-500/10",
            progress: "bg-amber-500",
        },
    };
    const styles = toneStyles[tone];
    const ChangeIcon =
        change === null || change === 0
            ? Minus
            : change !== undefined && change > 0
              ? ArrowUpRight
              : ArrowDownRight;
    const changeClassName =
        change === null || change === 0
            ? "bg-muted text-muted-foreground"
            : change !== undefined && change > 0
              ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
              : "bg-rose-500/10 text-rose-600 dark:text-rose-400";

    return (
        <div className="border-border/60 bg-card relative overflow-hidden rounded-xl border p-5 shadow-sm">
            <div
                className={`pointer-events-none absolute -top-12 -right-12 h-28 w-28 rounded-full blur-2xl ${styles.glow}`}
            />
            <div className="relative">
                <div className="flex items-start justify-between gap-3">
                    <div>
                        <p className="text-muted-foreground text-[11px] font-semibold tracking-wide uppercase">
                            {label}
                        </p>
                        <p className="mt-2 text-3xl font-semibold tracking-tight tabular-nums">
                            {value}
                        </p>
                    </div>
                    <span
                        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${styles.icon}`}
                    >
                        <Icon className="h-4 w-4" />
                    </span>
                </div>
                <div className="mt-3 flex min-h-5 items-center gap-2">
                    {change !== undefined ? (
                        <span
                            className={`inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-[10px] font-semibold tabular-nums ${changeClassName}`}
                        >
                            <ChangeIcon className="h-3 w-3" />
                            {change === null
                                ? "No baseline"
                                : `${change > 0 ? "+" : ""}${change}%`}
                        </span>
                    ) : null}
                    <p className="text-muted-foreground truncate text-[11px]">
                        {change !== undefined && changeLabel
                            ? changeLabel
                            : detail}
                    </p>
                </div>
                {progress !== undefined ? (
                    <div className="bg-muted mt-3 h-1.5 overflow-hidden rounded-full">
                        <div
                            className={`h-full rounded-full ${styles.progress}`}
                            style={{
                                width: `${Math.max(progress > 0 ? 3 : 0, Math.min(100, progress))}%`,
                            }}
                        />
                    </div>
                ) : null}
            </div>
        </div>
    );
}

function MemberGrowthChart({ data }: { data: MemberInsights["growth"] }) {
    if (data.length === 0) {
        return (
            <div className="text-muted-foreground flex h-64 items-center justify-center text-sm">
                No member history available yet.
            </div>
        );
    }

    const width = 960;
    const height = 250;
    const left = 42;
    const right = 12;
    const top = 12;
    const bottom = 226;
    const plotWidth = width - left - right;
    const slotWidth = plotWidth / data.length;
    const rollingAverage = data.map((_, index) => {
        if (index < 6) return null;
        const sevenDays = data.slice(index - 6, index + 1);
        return sevenDays.reduce((sum, point) => sum + point.newMembers, 0) / 7;
    });
    const maxDaily = Math.max(1, ...data.map((point) => point.newMembers));
    const roughStep = maxDaily / 4;
    const magnitude = 10 ** Math.floor(Math.log10(roughStep));
    const normalizedStep = roughStep / magnitude;
    const stepMultiplier =
        maxDaily <= 4
            ? 1 / magnitude
            : normalizedStep < 1.5
              ? 1
              : normalizedStep < 3
                ? 2
                : normalizedStep < 7
                  ? 5
                  : 10;
    const tickStep = Math.max(1, stepMultiplier * magnitude);
    const chartMax = Math.ceil(maxDaily / tickStep) * tickStep;
    const tickValues = Array.from(
        { length: Math.round(chartMax / tickStep) + 1 },
        (_, index) => index * tickStep,
    );
    const pointX = (index: number) => left + (index + 0.5) * slotWidth;
    const pointY = (value: number) =>
        bottom - (value / chartMax) * (bottom - top);
    const averagePoints = rollingAverage
        .map((average, index) =>
            average === null ? null : `${pointX(index)},${pointY(average)}`,
        )
        .filter((point): point is string => point !== null)
        .join(" ");
    const averageAreaPoints = averagePoints
        ? `${pointX(6)},${bottom} ${averagePoints} ${pointX(data.length - 1)},${bottom}`
        : "";
    const dateLabel = (value: string) =>
        new Intl.DateTimeFormat("de-DE", {
            day: "2-digit",
            month: "short",
        }).format(new Date(`${value}T12:00:00Z`));
    const middlePoint = data[Math.floor(data.length / 2)];
    const totalSignups = data.reduce((sum, point) => sum + point.newMembers, 0);
    const currentAverage = rollingAverage[data.length - 1];

    return (
        <div>
            <div className="mb-4 flex flex-wrap items-center gap-4 text-xs">
                <div className="flex items-center gap-2">
                    <span className="h-2.5 w-2.5 rounded-sm bg-sky-500/50" />
                    <span className="text-muted-foreground">Daily signups</span>
                </div>
                <div className="flex items-center gap-2">
                    <span className="h-0.5 w-5 rounded-full bg-emerald-500" />
                    <span className="text-muted-foreground">7-day average</span>
                </div>
                <span className="text-muted-foreground ml-auto tabular-nums">
                    {totalSignups} signups in 90 days
                    {currentAverage !== null
                        ? ` · ${currentAverage.toFixed(1)}/day now`
                        : ""}
                </span>
            </div>
            <svg
                viewBox={`0 0 ${width} ${height}`}
                className="h-64 w-full overflow-visible"
                role="img"
                aria-label="Member signups over the last 90 days"
            >
                <desc>
                    {`${totalSignups} signups over 90 days. The bars show daily signups and the line shows the seven-day average.`}
                </desc>
                <defs>
                    <linearGradient
                        id="member-average-area"
                        x1="0"
                        y1="0"
                        x2="0"
                        y2="1"
                    >
                        <stop
                            offset="0%"
                            className="text-emerald-500"
                            stopColor="currentColor"
                            stopOpacity="0.2"
                        />
                        <stop
                            offset="100%"
                            className="text-emerald-500"
                            stopColor="currentColor"
                            stopOpacity="0"
                        />
                    </linearGradient>
                </defs>
                {tickValues.map((value) => {
                    const y = pointY(value);
                    return (
                        <g key={value}>
                            <line
                                x1={left}
                                x2={width - right}
                                y1={y}
                                y2={y}
                                className="stroke-border"
                                strokeDasharray="4 6"
                            />
                            <text
                                x={left - 10}
                                y={y + 4}
                                textAnchor="end"
                                className="fill-muted-foreground text-[10px] tabular-nums"
                            >
                                {value}
                            </text>
                        </g>
                    );
                })}
                {averageAreaPoints ? (
                    <polygon
                        points={averageAreaPoints}
                        fill="url(#member-average-area)"
                    />
                ) : null}
                {data.map((point, index) => {
                    const y = pointY(point.newMembers);
                    return (
                        <rect
                            key={point.date}
                            x={left + index * slotWidth + 1.25}
                            y={y}
                            width={Math.max(2, slotWidth - 2.5)}
                            height={Math.max(0, bottom - y)}
                            rx="1.5"
                            className="fill-sky-500"
                            opacity={index >= data.length - 7 ? "0.72" : "0.34"}
                        >
                            <title>{`${dateLabel(point.date)}: ${point.newMembers} signup${point.newMembers === 1 ? "" : "s"}`}</title>
                        </rect>
                    );
                })}
                {averagePoints ? (
                    <>
                        <polyline
                            points={averagePoints}
                            fill="none"
                            className="stroke-emerald-500"
                            strokeWidth="3"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        />
                        <circle
                            cx={pointX(data.length - 1)}
                            cy={pointY(currentAverage ?? 0)}
                            r="4"
                            className="fill-background stroke-emerald-500"
                            strokeWidth="2.5"
                        />
                    </>
                ) : null}
            </svg>
            <div className="text-muted-foreground flex justify-between text-[11px]">
                <span>{dateLabel(data[0].date)}</span>
                <span>{dateLabel(middlePoint.date)}</span>
                <span>{dateLabel(data[data.length - 1].date)}</span>
            </div>
        </div>
    );
}

function getRoleBadge(role: string) {
    const r = ROLES.find((r) => r.value === role) ?? ROLES[0];
    return (
        <Badge
            className={`${r.color} gap-1 text-[10px] font-semibold tracking-wide uppercase`}
        >
            <r.icon className="h-3 w-3" />
            {r.label}
        </Badge>
    );
}

function formatCreatedAt(value: Date | null) {
    if (!value) return "Unknown";

    return new Intl.DateTimeFormat("de-DE", {
        dateStyle: "medium",
        timeStyle: "short",
    }).format(new Date(value));
}

function formatMetricDate(value: Date | null) {
    if (!value) return "No checks";

    return new Intl.DateTimeFormat("de-DE", {
        dateStyle: "short",
        timeStyle: "short",
    }).format(new Date(value));
}

function formatSuccessRate(value: number | null) {
    return value === null ? "n/a" : `${value}%`;
}

function formatDuration(value: number | null) {
    return value === null ? "n/a" : `${value} ms`;
}

function formatRuntime(totalSeconds: number) {
    const seconds = Math.max(0, Math.floor(totalSeconds));
    const days = Math.floor(seconds / 86_400);
    const hours = Math.floor((seconds % 86_400) / 3_600);
    const minutes = Math.floor((seconds % 3_600) / 60);
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
}

function monitorRuntimeSeconds(monitor: UserMonitor, nowMs: number) {
    const currentSeconds =
        monitor.status === "active" && monitor.active_since
            ? Math.max(
                  0,
                  Math.floor(
                      (nowMs - new Date(monitor.active_since).getTime()) / 1000,
                  ),
              )
            : 0;
    return monitor.runtime_total_seconds + currentSeconds;
}

function RuntimeStackedChart({ data }: { data: RuntimeInsights["daily"] }) {
    const totals = data.map(
        (day) => day.freeSeconds + day.serverSeconds + day.groupSeconds,
    );
    const maximum = Math.max(1, ...totals);
    const totalHours = totals.reduce((sum, value) => sum + value, 0) / 3_600;

    return (
        <div>
            <div className="mb-4 flex flex-wrap items-center gap-4 text-xs">
                {[
                    ["Free pool", "bg-amber-500"],
                    ["Server", "bg-sky-500"],
                    ["Own pools", "bg-violet-500"],
                ].map(([label, color]) => (
                    <span key={label} className="flex items-center gap-2">
                        <span className={`h-2.5 w-2.5 rounded-sm ${color}`} />
                        <span className="text-muted-foreground">{label}</span>
                    </span>
                ))}
                <span className="text-muted-foreground ml-auto tabular-nums">
                    {totalHours.toFixed(1)} monitor-hours / 30d
                </span>
            </div>
            <div
                className="flex h-64 items-end gap-1 rounded-lg border border-dashed p-3"
                role="img"
                aria-label="Monitor runtime by proxy source over the last 30 days"
            >
                {data.map((day, index) => {
                    const total = totals[index];
                    const height = Math.max(
                        total > 0 ? 2 : 0,
                        (total / maximum) * 100,
                    );
                    const date = new Intl.DateTimeFormat("de-DE", {
                        day: "2-digit",
                        month: "short",
                    }).format(new Date(`${day.date}T12:00:00Z`));
                    return (
                        <div
                            key={day.date}
                            className="group relative flex h-full min-w-0 flex-1 items-end"
                            title={`${date}: ${(total / 3_600).toFixed(1)} monitor-hours`}
                        >
                            <div
                                className="flex w-full flex-col-reverse overflow-hidden rounded-sm transition-opacity group-hover:opacity-80"
                                style={{ height: `${height}%` }}
                            >
                                {total > 0 ? (
                                    <>
                                        <div
                                            className="bg-amber-500"
                                            style={{
                                                height: `${(day.freeSeconds / total) * 100}%`,
                                            }}
                                        />
                                        <div
                                            className="bg-sky-500"
                                            style={{
                                                height: `${(day.serverSeconds / total) * 100}%`,
                                            }}
                                        />
                                        <div
                                            className="bg-violet-500"
                                            style={{
                                                height: `${(day.groupSeconds / total) * 100}%`,
                                            }}
                                        />
                                    </>
                                ) : null}
                            </div>
                        </div>
                    );
                })}
            </div>
            <div className="text-muted-foreground mt-2 flex justify-between text-[10px]">
                <span>{data[0]?.date ?? ""}</span>
                <span>{data[data.length - 1]?.date ?? ""}</span>
            </div>
        </div>
    );
}

function limitInputValue(value: number | null | undefined) {
    return value === null || value === undefined ? "" : String(value);
}

function formatLimit(value: number | null) {
    return value === null ? "Unlimited" : `${value} active`;
}

function monitorProxyLabel(monitor: {
    proxy_source: string;
    proxy_group: { name: string } | null;
}) {
    if (monitor.proxy_source === "free") return "Free Proxy Pool";
    return monitor.proxy_group?.name ?? "Server Proxies";
}

function normalizeTab(value: string | null | undefined): AdminTab {
    return ADMIN_TABS.some((tab) => tab.value === value)
        ? (value as AdminTab)
        : "overview";
}

function normalizeFreeProxySettings(settings: FreeProxyState["settings"]) {
    if (settings.importSource === "custom") return settings;
    const source = FREE_PROXY_SOURCE_OPTIONS.find(
        (option) => option.value === settings.importSource,
    );
    if (!source?.url || source.url === settings.importUrl) return settings;
    return { ...settings, importUrl: source.url };
}

export function AdminClient({
    users: initialUsers,
    logs,
    initialTab,
    currentUserId,
    serverProxies: initialServerProxies,
    memberAnnouncement: initialMemberAnnouncement,
    initialMonitorMaintenanceState,
    initialInactiveMemberPolicyState,
    freeProxyState: initialFreeProxyState,
    monitorLimits: initialMonitorLimits,
}: {
    users: UserRow[];
    logs: AdminLogRow[];
    initialTab?: string;
    currentUserId: string;
    serverProxies: string;
    memberAnnouncement: MemberAnnouncement;
    initialMonitorMaintenanceState: MonitorMaintenanceAdminState;
    initialInactiveMemberPolicyState: InactiveMemberPolicyAdminState;
    freeProxyState: FreeProxyState;
    monitorLimits: MonitorLimits;
}) {
    const [users, setUsers] = useState<UserRow[]>(initialUsers);
    const [overviewState, setOverviewState] =
        useState<AdminOverviewState | null>(null);
    const [isLoadingOverview, setIsLoadingOverview] = useState(false);
    const [overviewLoadFailed, setOverviewLoadFailed] = useState(false);
    const overviewRequestRef = useRef<Promise<void> | null>(null);
    const [runtimeInsights, setRuntimeInsights] =
        useState<RuntimeInsights | null>(null);
    const [isLoadingRuntimeInsights, setIsLoadingRuntimeInsights] =
        useState(false);
    const [runtimeInsightsLoadFailed, setRuntimeInsightsLoadFailed] =
        useState(false);
    const runtimeInsightsRequestRef = useRef<Promise<void> | null>(null);
    const [activeMonitorRows, setActiveMonitorRows] = useState<ActiveMonitor[]>(
        [],
    );
    const [userPagination, setUserPagination] = useState({
        page: 1,
        pageSize: 25,
        total: initialUsers.length,
        totalPages: 1,
    });
    const usersRequestSequenceRef = useRef(0);
    const [nowMs, setNowMs] = useState(() => Date.now());
    const [adminLogs, setAdminLogs] = useState<AdminLogRow[]>(logs);
    const [operationsSummary, setOperationsSummary] =
        useState<AdminOperationsSummary | null>(null);
    const [operationFilter, setOperationFilter] =
        useState<AdminOperationFilter>("all");
    const [operationNextCursor, setOperationNextCursor] = useState<
        string | null
    >(null);
    const [logsLoaded, setLogsLoaded] = useState(logs.length > 0);
    const [isLoadingLogs, setIsLoadingLogs] = useState(false);
    const [memberInsights, setMemberInsights] = useState<MemberInsights | null>(
        null,
    );
    const [isLoadingMemberInsights, setIsLoadingMemberInsights] =
        useState(false);
    const [memberInsightsLoadFailed, setMemberInsightsLoadFailed] =
        useState(false);
    const memberInsightsRequestRef = useRef<Promise<void> | null>(null);
    const [isLoadingUsers, setIsLoadingUsers] = useState(false);
    const [usersLoadFailed, setUsersLoadFailed] = useState(false);
    const [activeMonitorsLoaded, setActiveMonitorsLoaded] = useState(false);
    const [isLoadingActiveMonitors, setIsLoadingActiveMonitors] =
        useState(false);
    const [activeMonitorsLoadFailed, setActiveMonitorsLoadFailed] =
        useState(false);
    const activeMonitorsRequestRef = useRef<Promise<void> | null>(null);
    const [activeTab, setActiveTab] = useState<AdminTab>(
        normalizeTab(initialTab),
    );
    const [selected, setSelected] = useState<UserRow | null>(null);
    const [loadingUserDetailsId, setLoadingUserDetailsId] = useState<
        string | null
    >(null);
    const [pendingRole, setPendingRole] = useState<string>("");
    const [isOpen, setIsOpen] = useState(false);
    const [isDetailsOpen, setIsDetailsOpen] = useState(false);
    const [isProxyDialogOpen, setIsProxyDialogOpen] = useState(false);
    const [searchQuery, setSearchQuery] = useState("");
    const [monitorSearchQuery, setMonitorSearchQuery] = useState("");
    const [expandedMonitorUserIds, setExpandedMonitorUserIds] = useState<
        Set<string>
    >(new Set());
    const [collapsedMonitorSearchUserIds, setCollapsedMonitorSearchUserIds] =
        useState<Set<string>>(new Set());
    const [userPage, setUserPage] = useState(1);
    const [usersPerPage, setUsersPerPage] =
        useState<(typeof USER_PAGE_SIZES)[number]>(25);
    const [isStoppingMonitors, setIsStoppingMonitors] = useState(false);
    const [stoppingMonitorId, setStoppingMonitorId] = useState<number | null>(
        null,
    );
    const [monitorLimits, setMonitorLimits] =
        useState<MonitorLimits>(initialMonitorLimits);
    const [globalLimitInput, setGlobalLimitInput] = useState(
        limitInputValue(initialMonitorLimits.global),
    );
    const [roleLimitInputs, setRoleLimitInputs] = useState<
        Record<string, string>
    >(
        Object.fromEntries(
            LIMIT_ROLES.map((role) => [
                role.value,
                limitInputValue(initialMonitorLimits.roles[role.value]),
            ]),
        ),
    );
    const [userLimitInput, setUserLimitInput] = useState("");
    const [globalFreeProxyLimitInput, setGlobalFreeProxyLimitInput] = useState(
        limitInputValue(initialMonitorLimits.freeProxyGlobal),
    );
    const [roleFreeProxyLimitInputs, setRoleFreeProxyLimitInputs] = useState<
        Record<string, string>
    >(
        Object.fromEntries(
            LIMIT_ROLES.map((role) => [
                role.value,
                limitInputValue(
                    initialMonitorLimits.freeProxyRoles[role.value],
                ),
            ]),
        ),
    );
    const [userFreeProxyLimitInput, setUserFreeProxyLimitInput] = useState("");
    const [serverProxies, setServerProxies] = useState(initialServerProxies);
    const [isSavingServerProxies, setIsSavingServerProxies] = useState(false);
    const [memberAnnouncement, setMemberAnnouncement] = useState(
        initialMemberAnnouncement,
    );
    const [isSavingMemberAnnouncement, setIsSavingMemberAnnouncement] =
        useState(false);
    const [monitorMaintenanceState, setMonitorMaintenanceState] = useState(
        initialMonitorMaintenanceState,
    );
    const [maintenanceDialogMode, setMaintenanceDialogMode] = useState<
        "enable" | "update" | "disable" | null
    >(null);
    const [maintenanceMessage, setMaintenanceMessage] = useState(
        initialMonitorMaintenanceState.maintenance.message ||
            DEFAULT_MONITOR_MAINTENANCE_MESSAGE,
    );
    const [maintenanceEstimatedEndAt, setMaintenanceEstimatedEndAt] = useState(
        announcementDateTimeValue(
            initialMonitorMaintenanceState.maintenance.estimatedEndAt,
        ),
    );
    const [isSavingMaintenance, setIsSavingMaintenance] = useState(false);
    const [inactivePolicyState, setInactivePolicyState] = useState(
        initialInactiveMemberPolicyState,
    );
    const [inactivePolicyDraft, setInactivePolicyDraft] = useState(() => ({
        enabled: initialInactiveMemberPolicyState.policy.enabled,
        duration: initialInactiveMemberPolicyState.policy.duration,
        durationUnit: initialInactiveMemberPolicyState.policy.durationUnit,
        monitorScope: initialInactiveMemberPolicyState.policy.monitorScope,
        roles: initialInactiveMemberPolicyState.policy.roles,
    }));
    const [inactivePolicyPreview, setInactivePolicyPreview] = useState(
        initialInactiveMemberPolicyState.preview,
    );
    const [isSavingInactivePolicy, setIsSavingInactivePolicy] = useState(false);
    const [freeProxyState, setFreeProxyState] = useState(initialFreeProxyState);
    const [freeProxySettings, setFreeProxySettings] = useState(
        normalizeFreeProxySettings(initialFreeProxyState.settings),
    );
    const [manualFreeProxies, setManualFreeProxies] = useState("");
    const [isSavingFreeProxySettings, setIsSavingFreeProxySettings] =
        useState(false);
    const [isImportingFreeProxies, setIsImportingFreeProxies] = useState(false);
    const [isAddingFreeProxies, setIsAddingFreeProxies] = useState(false);
    const [isClearingFreeProxyQuarantine, setIsClearingFreeProxyQuarantine] =
        useState(false);
    const [selectedFreeProxyRegion, setSelectedFreeProxyRegion] = useState<
        string | null
    >(null);
    const [freeProxySourceDiagnostics, setFreeProxySourceDiagnostics] =
        useState<Record<string, FreeProxyState["sourceDiagnostics"]>>({});
    const [isLoadingFreeProxySources, setIsLoadingFreeProxySources] =
        useState(false);
    const starterRegionSet = new Set(
        freeProxySettings.starterRegions
            .split(",")
            .map((region) => region.trim().toLowerCase())
            .filter(Boolean),
    );
    const freeProxyHealthByRegion = new Map(
        freeProxyState.regions.map((region) => [region.region, region]),
    );
    const displayedFreeProxyRegionCodes = new Set([
        ...starterRegionSet,
        ...freeProxyState.regions
            .filter((region) => region.activeMonitorCount > 0)
            .map((region) => region.region),
    ]);
    const displayedFreeProxyRegions = REGIONS.filter((region) =>
        displayedFreeProxyRegionCodes.has(region.code),
    ).map((region) => {
        const health = freeProxyHealthByRegion.get(region.code);
        return health
            ? { ...health, initializing: false }
            : {
                  region: region.code,
                  active: 0,
                  reserve: 0,
                  warming: 0,
                  pending: 0,
                  cooldown: 0,
                  dead: 0,
                  successRate: null,
                  medianLatencyMs: null,
                  lastCheckedAt: null,
                  stalled: false,
                  healthy: false,
                  topErrorStage: null,
                  candidateWindow: 0,
                  checkedLastHour: 0,
                  promotedLastHour: 0,
                  minutesSinceLastSuccess: null,
                  activeMonitorCount: 0,
                  recoveryMode: false,
                  dueNow: 0,
                  neverChecked: 0,
                  initializing: true,
              };
    });
    const totalFreeProxyMonitors = displayedFreeProxyRegions.reduce(
        (total, region) => total + region.activeMonitorCount,
        0,
    );
    const selectedFreeProxyHealth = selectedFreeProxyRegion
        ? displayedFreeProxyRegions.find(
              (region) => region.region === selectedFreeProxyRegion,
          )
        : undefined;
    const selectedFreeProxySources = selectedFreeProxyRegion
        ? freeProxySourceDiagnostics[selectedFreeProxyRegion]
        : undefined;

    const toggleStarterRegion = (regionCode: string) => {
        setFreeProxySettings((current) => {
            const selected = new Set(
                current.starterRegions
                    .split(",")
                    .map((region) => region.trim().toLowerCase())
                    .filter(Boolean),
            );

            if (selected.has(regionCode)) {
                selected.delete(regionCode);
            } else {
                selected.add(regionCode);
            }

            return {
                ...current,
                starterRegions: REGIONS.filter((region) =>
                    selected.has(region.code),
                )
                    .map((region) => region.code)
                    .join(","),
            };
        });
    };

    const loadAdminLogs = (
        filter: AdminOperationFilter = operationFilter,
        append = false,
    ) => {
        if (
            (!append && logsLoaded && filter === operationFilter) ||
            isLoadingLogs
        )
            return;

        setIsLoadingLogs(true);
        Promise.all([
            operationsSummary
                ? Promise.resolve(operationsSummary)
                : getAdminOperationsSummary(),
            getAdminOperationsPage({
                filter,
                cursor: append ? operationNextCursor : null,
                pageSize: 50,
            }),
        ])
            .then(([summary, page]) => {
                setOperationsSummary(summary);
                setAdminLogs((current) =>
                    append ? [...current, ...page.rows] : page.rows,
                );
                setOperationNextCursor(page.nextCursor);
                setOperationFilter(filter);
                setLogsLoaded(true);
            })
            .catch(() => {
                toast.error("Failed to load admin logs");
            })
            .finally(() => setIsLoadingLogs(false));
    };

    const loadMemberInsights = () => {
        if (memberInsights || memberInsightsRequestRef.current) return;

        setIsLoadingMemberInsights(true);
        setMemberInsightsLoadFailed(false);

        const request = getAdminMemberInsights()
            .then((insights) => {
                setMemberInsights(insights);
            })
            .catch(() => {
                setMemberInsightsLoadFailed(true);
                toast.error("Failed to load member insights");
            })
            .finally(() => {
                memberInsightsRequestRef.current = null;
                setIsLoadingMemberInsights(false);
            });

        memberInsightsRequestRef.current = request;
    };

    const loadOverview = () => {
        if (overviewState || overviewRequestRef.current) return;
        setIsLoadingOverview(true);
        setOverviewLoadFailed(false);
        const request = Promise.all([
            getAdminOverviewState(),
            getAdminOperationsSummary(),
            getAdminOperationsPage({ filter: "all", pageSize: 6 }),
        ])
            .then(([overview, summary, operations]) => {
                setOverviewState(overview);
                setOperationsSummary(summary);
                setAdminLogs(operations.rows);
            })
            .catch(() => {
                setOverviewLoadFailed(true);
                toast.error("Failed to load admin overview");
            })
            .finally(() => {
                overviewRequestRef.current = null;
                setIsLoadingOverview(false);
            });
        overviewRequestRef.current = request;
    };

    const loadRuntimeInsights = () => {
        if (runtimeInsights || runtimeInsightsRequestRef.current) return;
        setIsLoadingRuntimeInsights(true);
        setRuntimeInsightsLoadFailed(false);
        const request = getAdminRuntimeInsights()
            .then(setRuntimeInsights)
            .catch(() => {
                setRuntimeInsightsLoadFailed(true);
                toast.error("Failed to load runtime insights");
            })
            .finally(() => {
                runtimeInsightsRequestRef.current = null;
                setIsLoadingRuntimeInsights(false);
            });
        runtimeInsightsRequestRef.current = request;
    };

    const loadAdminUsers = (
        query = searchQuery,
        page = userPage,
        pageSize = usersPerPage,
    ) => {
        const requestSequence = ++usersRequestSequenceRef.current;
        setIsLoadingUsers(true);
        setUsersLoadFailed(false);

        const request = getAdminUsersPage({ query, page, pageSize })
            .then((state) => {
                if (requestSequence !== usersRequestSequenceRef.current) {
                    return false;
                }
                setUsers(state.users);
                setUserPagination(state.pagination);
                setMonitorLimits((current) => ({
                    ...current,
                    users: { ...current.users, ...state.userLimits },
                    freeProxyUsers: {
                        ...current.freeProxyUsers,
                        ...state.userFreeProxyLimits,
                    },
                }));
                return true;
            })
            .catch(() => {
                setUsersLoadFailed(true);
                toast.error("Failed to load members");
                return false;
            })
            .finally(() => {
                if (requestSequence === usersRequestSequenceRef.current) {
                    setIsLoadingUsers(false);
                }
            });

        return request;
    };

    const loadActiveMonitors = () => {
        if (activeMonitorsLoaded || activeMonitorsRequestRef.current) return;

        setIsLoadingActiveMonitors(true);
        setActiveMonitorsLoadFailed(false);

        const request = getAdminActiveMonitors()
            .then((monitors) => {
                setActiveMonitorRows(monitors);
                setActiveMonitorsLoaded(true);
            })
            .catch(() => {
                setActiveMonitorsLoadFailed(true);
                toast.error("Failed to load running monitors");
            })
            .finally(() => {
                activeMonitorsRequestRef.current = null;
                setIsLoadingActiveMonitors(false);
            });

        activeMonitorsRequestRef.current = request;
    };

    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const tab = normalizeTab(params.get("tab"));
        setActiveTab(tab);
        loadOverview();
        if (["users", "roles"].includes(tab)) void loadAdminUsers();
        if (tab === "insights") {
            loadMemberInsights();
            loadRuntimeInsights();
        }
        if (tab === "logs") loadAdminLogs();
        if (tab === "monitors") loadActiveMonitors();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const switchTab = (tab: AdminTab) => {
        setActiveTab(tab);
        const url = new URL(window.location.href);
        url.searchParams.set("tab", tab);
        window.history.replaceState(null, "", url.toString());

        if (["users", "roles"].includes(tab)) {
            void loadAdminUsers();
        }
        if (tab === "overview") loadOverview();
        if (tab === "insights") {
            loadMemberInsights();
            loadRuntimeInsights();
        }
        if (tab === "logs") loadAdminLogs();
        if (tab === "monitors") loadActiveMonitors();
    };

    useEffect(() => {
        const interval = window.setInterval(() => setNowMs(Date.now()), 60_000);
        return () => window.clearInterval(interval);
    }, []);

    useEffect(() => {
        if (
            !monitorMaintenanceState.maintenance.enabled ||
            monitorMaintenanceState.status === "active"
        ) {
            return;
        }
        const refresh = () => {
            void fetch("/api/admin/maintenance", { cache: "no-store" })
                .then(async (response) => {
                    if (!response.ok) throw new Error("Refresh failed");
                    return (await response.json()) as MonitorMaintenanceAdminState;
                })
                .then(setMonitorMaintenanceState)
                .catch(() => undefined);
        };
        const interval = window.setInterval(refresh, 2_000);
        return () => window.clearInterval(interval);
    }, [
        monitorMaintenanceState.maintenance.enabled,
        monitorMaintenanceState.status,
    ]);

    useEffect(() => {
        if (
            !inactivePolicyState.policy.enabled ||
            inactivePolicyState.status === "active"
        ) {
            return;
        }
        const refresh = () => {
            void fetch("/api/admin/inactive-member-policy", {
                cache: "no-store",
            })
                .then(async (response) => {
                    if (!response.ok) throw new Error("Refresh failed");
                    return (await response.json()) as InactiveMemberPolicyAdminState;
                })
                .then(setInactivePolicyState)
                .catch(() => undefined);
        };
        const interval = window.setInterval(refresh, 5_000);
        return () => window.clearInterval(interval);
    }, [inactivePolicyState.policy.enabled, inactivePolicyState.status]);

    useEffect(() => {
        if (!["users", "roles"].includes(activeTab)) return;
        const timeout = window.setTimeout(() => {
            void loadAdminUsers(searchQuery, userPage, usersPerPage);
        }, 300);
        return () => window.clearTimeout(timeout);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [searchQuery, userPage, usersPerPage, activeTab]);

    const normalizedQuery = searchQuery.trim().toLowerCase();
    const totalUserPages = userPagination.totalPages;
    const currentUserPage = Math.min(userPagination.page, totalUserPages);
    const userPageStart = (currentUserPage - 1) * usersPerPage;
    const paginatedUsers = users;
    const shownUserStart = userPagination.total === 0 ? 0 : userPageStart + 1;
    const shownUserEnd = Math.min(
        userPageStart + users.length,
        userPagination.total,
    );

    const normalizedMonitorQuery = monitorSearchQuery.trim().toLowerCase();
    const activeMonitorMemberMap = new Map<string, UserRow>();
    for (const monitor of activeMonitorRows) {
        const current = activeMonitorMemberMap.get(monitor.userId);
        if (current) {
            current.activeMonitors.push(monitor);
            current.metrics.runningMonitors += 1;
            if (monitor.proxy_source === "free") {
                current.metrics.runningFreeProxyMonitors += 1;
            }
            continue;
        }
        activeMonitorMemberMap.set(monitor.userId, {
            ...monitor.user,
            monitors: [],
            activeMonitors: [monitor],
            metrics: {
                runningMonitors: 1,
                runningFreeProxyMonitors:
                    monitor.proxy_source === "free" ? 1 : 0,
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
                oldestActiveSince: monitor.active_since,
            },
        });
    }
    const activeMonitorMembers = Array.from(activeMonitorMemberMap.values());
    const filteredActiveMonitorMembers = activeMonitorMembers
        .map((user) => {
            if (!normalizedMonitorQuery) {
                return { user, monitors: user.activeMonitors };
            }

            const userMatches = [user.name ?? "", user.email ?? "", user.role]
                .join(" ")
                .toLowerCase()
                .includes(normalizedMonitorQuery);
            const monitors = userMatches
                ? user.activeMonitors
                : user.activeMonitors.filter((monitor) =>
                      [
                          monitor.id.toString(),
                          monitor.name,
                          monitor.query,
                          monitor.region,
                          getRegionLabel(monitor.region),
                          monitorProxyLabel(monitor),
                      ]
                          .join(" ")
                          .toLowerCase()
                          .includes(normalizedMonitorQuery),
                  );

            return { user, monitors };
        })
        .filter(({ monitors }) => monitors.length > 0);
    const filteredActiveMonitorCount = filteredActiveMonitorMembers.reduce(
        (sum, { monitors }) => sum + monitors.length,
        0,
    );
    const toggleMonitorMember = (userId: string) => {
        if (normalizedMonitorQuery) {
            setCollapsedMonitorSearchUserIds((current) => {
                const next = new Set(current);
                if (next.has(userId)) {
                    next.delete(userId);
                } else {
                    next.add(userId);
                }
                return next;
            });
            return;
        }

        setExpandedMonitorUserIds((current) => {
            const next = new Set(current);
            if (next.has(userId)) {
                next.delete(userId);
            } else {
                next.add(userId);
            }
            return next;
        });
    };

    const totalUsers = overviewState?.users.total ?? 0;
    const freeUsers = overviewState?.users.free ?? 0;
    const premiumUsers = overviewState?.users.premium ?? 0;
    const adminUsers = overviewState?.users.admin ?? 0;
    const runningMonitors = overviewState?.monitors.running ?? 0;
    const newItems24h = overviewState?.activity24h.newItems ?? 0;
    const failedChecks24h = overviewState?.activity24h.failedChecks ?? 0;
    const totalMonitors = overviewState?.monitors.total ?? 0;
    const pausedMonitors = overviewState?.monitors.paused ?? 0;
    const checks24h = overviewState?.activity24h.checks ?? 0;
    const successfulChecks24h =
        overviewState?.activity24h.successfulChecks ?? 0;
    const successRate24h = overviewState?.activity24h.successRate ?? null;
    const topUsers: UserRow[] = (overviewState?.topMembers ?? []).map(
        (member) => ({
            id: member.userId,
            name: member.name,
            email: member.email,
            image: null,
            role: member.role,
            _count: { monitors: member.runningMonitors, proxy_groups: 0 },
            monitors: [],
            activeMonitors: [],
            metrics: {
                runningMonitors: member.runningMonitors,
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
                currentRuntimeSeconds: member.currentRuntimeSeconds,
                totalRuntimeSeconds: member.totalRuntimeSeconds,
                oldestActiveSince: null,
            },
        }),
    );
    const importantLogs = adminLogs
        .filter(
            (log) =>
                log.status !== "success" ||
                log.type === "monitor" ||
                log.detail,
        )
        .slice(0, 6);
    const serverProxyLineCount = serverProxies
        .split("\n")
        .filter((line) => line.trim().length > 0).length;

    const getEffectiveLimit = (user: UserRow) => {
        if (user.role === "admin") {
            return { value: null, source: "Admin" };
        }

        const userLimit = monitorLimits.users[user.id];
        if (userLimit !== null && userLimit !== undefined) {
            return { value: userLimit, source: "User" };
        }

        const roleLimit = monitorLimits.roles[user.role];
        if (roleLimit !== null && roleLimit !== undefined) {
            return { value: roleLimit, source: "Role" };
        }

        if (monitorLimits.global !== null) {
            return { value: monitorLimits.global, source: "Global" };
        }

        return { value: null, source: "Unlimited" };
    };
    const getEffectiveFreeProxyLimit = (user: UserRow) => {
        if (user.role === "admin") {
            return { value: null, source: "Admin" };
        }

        const userLimit = monitorLimits.freeProxyUsers[user.id];
        if (userLimit !== null && userLimit !== undefined) {
            return { value: userLimit, source: "User" };
        }

        const roleLimit = monitorLimits.freeProxyRoles[user.role];
        if (roleLimit !== null && roleLimit !== undefined) {
            return { value: roleLimit, source: "Role" };
        }

        if (monitorLimits.freeProxyGlobal !== null) {
            return { value: monitorLimits.freeProxyGlobal, source: "Global" };
        }

        return { value: null, source: "Unlimited" };
    };
    const usersAtLimit = overviewState?.limits.usersAtLimit ?? 0;
    const userOverrides = overviewState?.limits.userOverrides ?? 0;
    const roleLimitsConfigured = overviewState?.limits.roleLimits ?? 0;
    const activeMonitorShare =
        totalMonitors > 0
            ? Math.round((runningMonitors / totalMonitors) * 100)
            : 0;

    const hydrateUserDetails = async (user: UserRow) => {
        if (user.monitors.length > 0) {
            return user;
        }

        setLoadingUserDetailsId(user.id);
        const details = await getAdminUserDetails(user.id);
        const monitors = details.monitors;
        setMonitorLimits((current) => ({
            ...current,
            users: { ...current.users, [user.id]: details.limits.active },
            freeProxyUsers: {
                ...current.freeProxyUsers,
                [user.id]: details.limits.freeProxy,
            },
        }));
        const hydratedUser = {
            ...user,
            monitors,
            _count: { ...user._count, monitors: monitors.length },
            runtimeDetails: details.runtime,
            metrics: {
                ...user.metrics,
                currentRuntimeSeconds: details.runtime.currentRuntimeSeconds,
                totalRuntimeSeconds: details.runtime.totalRuntimeSeconds,
                totalItems: monitors.reduce(
                    (sum, monitor) => sum + monitor._count.items,
                    0,
                ),
            },
        };

        setUsers((prev) =>
            prev.map((current) =>
                current.id === user.id ? hydratedUser : current,
            ),
        );

        return hydratedUser;
    };

    const openUserDetails = (user: UserRow) => {
        setSelected(user);
        setPendingRole(user.role);
        setUserLimitInput(limitInputValue(monitorLimits.users[user.id]));
        setUserFreeProxyLimitInput(
            limitInputValue(monitorLimits.freeProxyUsers[user.id]),
        );
        setIsDetailsOpen(true);

        hydrateUserDetails(user)
            .then((hydratedUser) => {
                setSelected((current) =>
                    current?.id === hydratedUser.id ? hydratedUser : current,
                );
            })
            .catch(() => {
                toast.error("Failed to load user monitor details");
            })
            .finally(() => setLoadingUserDetailsId(null));
    };

    const openRoleDialog = (user: UserRow) => {
        setSelected(user);
        setPendingRole(user.role);
        setIsOpen(true);
    };

    const markUserMonitorsStopped = (
        user: UserRow,
        monitorId: number | null = null,
    ): UserRow => {
        const stoppedCount =
            monitorId === null
                ? user.metrics.runningMonitors
                : user.activeMonitors.some(
                        (monitor) => monitor.id === monitorId,
                    ) ||
                    user.monitors.some(
                        (monitor) =>
                            monitor.id === monitorId &&
                            monitor.status === "active",
                    )
                  ? 1
                  : 0;

        if (stoppedCount === 0) return user;

        const stoppedFreeProxyCount =
            monitorId === null
                ? user.metrics.runningFreeProxyMonitors
                : [...user.activeMonitors, ...user.monitors].some(
                        (monitor) =>
                            monitor.id === monitorId &&
                            monitor.status === "active" &&
                            monitor.proxy_source === "free",
                    )
                  ? 1
                  : 0;

        return {
            ...user,
            monitors: user.monitors.map((monitor) =>
                monitor.status === "active" &&
                (monitorId === null || monitor.id === monitorId)
                    ? { ...monitor, status: "paused" }
                    : monitor,
            ),
            activeMonitors: user.activeMonitors.filter(
                (monitor) => monitorId !== null && monitor.id !== monitorId,
            ),
            metrics: {
                ...user.metrics,
                runningMonitors: Math.max(
                    0,
                    user.metrics.runningMonitors - stoppedCount,
                ),
                runningFreeProxyMonitors: Math.max(
                    0,
                    user.metrics.runningFreeProxyMonitors -
                        stoppedFreeProxyCount,
                ),
                pausedMonitors: user.metrics.pausedMonitors + stoppedCount,
            },
        };
    };

    const handleSave = async () => {
        if (!selected || pendingRole === selected.role) {
            setIsOpen(false);
            return;
        }

        const prevRole = selected.role;
        setUsers((prev) =>
            prev.map((u) =>
                u.id === selected.id ? { ...u, role: pendingRole } : u,
            ),
        );
        setSelected((prev) =>
            prev?.id === selected.id ? { ...prev, role: pendingRole } : prev,
        );
        setIsOpen(false);

        toast.promise(
            setUserRole(selected.id, pendingRole).then((result) => {
                applyAutomaticallyPausedMonitors(result.pausedMonitorIds);
                return result;
            }),
            {
                loading: "Updating role...",
                success: (result) =>
                    result.pausedCount > 0
                        ? `${selected.name ?? "User"} is now ${pendingRole} · ${result.pausedCount} paused`
                        : `${selected.name ?? "User"} is now ${pendingRole}`,
                error: () => {
                    setUsers((prev) =>
                        prev.map((u) =>
                            u.id === selected.id ? { ...u, role: prevRole } : u,
                        ),
                    );
                    setSelected((prev) =>
                        prev?.id === selected.id
                            ? { ...prev, role: prevRole }
                            : prev,
                    );
                    return "Failed to update role";
                },
            },
        );
    };

    const handleSaveGlobalLimit = async () => {
        const previous = monitorLimits.global;
        const next = globalLimitInput.trim()
            ? Number(globalLimitInput.trim())
            : null;

        setMonitorLimits((prev) => ({ ...prev, global: next }));
        try {
            await setGlobalActiveMonitorLimit(globalLimitInput);
            toast.success("Global monitor limit saved");
        } catch (error) {
            setMonitorLimits((prev) => ({ ...prev, global: previous }));
            setGlobalLimitInput(limitInputValue(previous));
            toast.error(
                error instanceof Error
                    ? error.message
                    : "Failed to save global monitor limit",
            );
        }
    };

    const applyAutomaticallyPausedMonitors = (monitorIds: number[]) => {
        if (monitorIds.length === 0) return;
        const pausedIds = new Set(monitorIds);
        setActiveMonitorRows((current) =>
            current.filter((monitor) => !pausedIds.has(monitor.id)),
        );
        const updateUser = (user: UserRow) => {
            const knownMonitors = [...user.monitors, ...user.activeMonitors];
            const pausedForUser = new Map(
                knownMonitors
                    .filter((monitor) => pausedIds.has(monitor.id))
                    .map((monitor) => [monitor.id, monitor]),
            );
            if (pausedForUser.size === 0) return user;

            const pausedFreeCount = Array.from(pausedForUser.values()).filter(
                (monitor) => monitor.proxy_source === "free",
            ).length;
            return {
                ...user,
                monitors: user.monitors.map((monitor) =>
                    pausedIds.has(monitor.id)
                        ? { ...monitor, status: "paused" }
                        : monitor,
                ),
                activeMonitors: user.activeMonitors.filter(
                    (monitor) => !pausedIds.has(monitor.id),
                ),
                metrics: {
                    ...user.metrics,
                    runningMonitors: Math.max(
                        user.metrics.runningMonitors - pausedForUser.size,
                        0,
                    ),
                    runningFreeProxyMonitors: Math.max(
                        user.metrics.runningFreeProxyMonitors - pausedFreeCount,
                        0,
                    ),
                    pausedMonitors:
                        user.metrics.pausedMonitors + pausedForUser.size,
                },
            };
        };

        setUsers((current) => current.map(updateUser));
        setSelected((current) => (current ? updateUser(current) : current));
    };

    const handleSaveGlobalFreeProxyLimit = async () => {
        const previous = monitorLimits.freeProxyGlobal;
        const next = globalFreeProxyLimitInput.trim()
            ? Number(globalFreeProxyLimitInput.trim())
            : null;
        setMonitorLimits((current) => ({
            ...current,
            freeProxyGlobal: next,
        }));
        try {
            const result = await setGlobalFreeProxyMonitorLimit(
                globalFreeProxyLimitInput,
            );
            applyAutomaticallyPausedMonitors(result.pausedMonitorIds);
            toast.success(
                result.pausedCount > 0
                    ? `Free proxy limit saved · ${result.pausedCount} monitor${result.pausedCount === 1 ? "" : "s"} paused`
                    : "Global free proxy monitor limit saved",
            );
        } catch (error) {
            setMonitorLimits((current) => ({
                ...current,
                freeProxyGlobal: previous,
            }));
            setGlobalFreeProxyLimitInput(limitInputValue(previous));
            toast.error(
                error instanceof Error
                    ? error.message
                    : "Failed to save global free proxy limit",
            );
        }
    };

    const handleSaveRoleFreeProxyLimit = async (role: string) => {
        const previous = monitorLimits.freeProxyRoles[role] ?? null;
        const input = roleFreeProxyLimitInputs[role] ?? "";
        const next = input.trim() ? Number(input.trim()) : null;
        setMonitorLimits((current) => ({
            ...current,
            freeProxyRoles: { ...current.freeProxyRoles, [role]: next },
        }));
        try {
            const result = await setRoleFreeProxyMonitorLimit(role, input);
            applyAutomaticallyPausedMonitors(result.pausedMonitorIds);
            toast.success(
                result.pausedCount > 0
                    ? `${role} free proxy limit saved · ${result.pausedCount} paused`
                    : `${role} free proxy monitor limit saved`,
            );
        } catch (error) {
            setMonitorLimits((current) => ({
                ...current,
                freeProxyRoles: {
                    ...current.freeProxyRoles,
                    [role]: previous,
                },
            }));
            setRoleFreeProxyLimitInputs((current) => ({
                ...current,
                [role]: limitInputValue(previous),
            }));
            toast.error(
                error instanceof Error
                    ? error.message
                    : "Failed to save role free proxy limit",
            );
        }
    };

    const handleSaveUserFreeProxyLimit = async () => {
        if (!selected) return;
        const previous = monitorLimits.freeProxyUsers[selected.id] ?? null;
        const next = userFreeProxyLimitInput.trim()
            ? Number(userFreeProxyLimitInput.trim())
            : null;
        setMonitorLimits((current) => ({
            ...current,
            freeProxyUsers: {
                ...current.freeProxyUsers,
                [selected.id]: next,
            },
        }));
        try {
            const result = await setUserFreeProxyMonitorLimit(
                selected.id,
                userFreeProxyLimitInput,
            );
            applyAutomaticallyPausedMonitors(result.pausedMonitorIds);
            toast.success(
                result.pausedCount > 0
                    ? `Free proxy limit saved · ${result.pausedCount} paused`
                    : "User free proxy monitor limit saved",
            );
        } catch (error) {
            setMonitorLimits((current) => ({
                ...current,
                freeProxyUsers: {
                    ...current.freeProxyUsers,
                    [selected.id]: previous,
                },
            }));
            setUserFreeProxyLimitInput(limitInputValue(previous));
            toast.error(
                error instanceof Error
                    ? error.message
                    : "Failed to save user free proxy limit",
            );
        }
    };

    const handleSaveRoleLimit = async (role: string) => {
        const previous = monitorLimits.roles[role] ?? null;
        const input = roleLimitInputs[role] ?? "";
        const next = input.trim() ? Number(input.trim()) : null;

        setMonitorLimits((prev) => ({
            ...prev,
            roles: { ...prev.roles, [role]: next },
        }));
        try {
            await setRoleActiveMonitorLimit(role, input);
            toast.success(`${role} monitor limit saved`);
        } catch (error) {
            setMonitorLimits((prev) => ({
                ...prev,
                roles: { ...prev.roles, [role]: previous },
            }));
            setRoleLimitInputs((prev) => ({
                ...prev,
                [role]: limitInputValue(previous),
            }));
            toast.error(
                error instanceof Error
                    ? error.message
                    : "Failed to save role monitor limit",
            );
        }
    };

    const handleSaveUserLimit = async () => {
        if (!selected) return;

        const previous = monitorLimits.users[selected.id] ?? null;
        const next = userLimitInput.trim()
            ? Number(userLimitInput.trim())
            : null;

        setMonitorLimits((prev) => ({
            ...prev,
            users: { ...prev.users, [selected.id]: next },
        }));
        try {
            await setUserActiveMonitorLimit(selected.id, userLimitInput);
            toast.success("User monitor limit saved");
        } catch (error) {
            setMonitorLimits((prev) => ({
                ...prev,
                users: { ...prev.users, [selected.id]: previous },
            }));
            setUserLimitInput(limitInputValue(previous));
            toast.error(
                error instanceof Error
                    ? error.message
                    : "Failed to save user monitor limit",
            );
        }
    };

    const handleStopUserMonitors = async () => {
        if (!selected) return;

        setIsStoppingMonitors(true);

        try {
            const result = await stopUserActiveMonitors(selected.id);

            setActiveMonitorRows((current) =>
                current.filter((monitor) => monitor.userId !== selected.id),
            );

            setUsers((prev) =>
                prev.map((user) =>
                    user.id === selected.id
                        ? markUserMonitorsStopped(user)
                        : user,
                ),
            );

            setSelected((prev) =>
                prev ? markUserMonitorsStopped(prev) : prev,
            );

            toast.success(
                result.stoppedCount > 0
                    ? `${result.stoppedCount} monitor${result.stoppedCount === 1 ? "" : "s"} stopped`
                    : "No running monitors for this user",
            );
        } catch {
            toast.error("Failed to stop user monitors");
        } finally {
            setIsStoppingMonitors(false);
        }
    };

    const handleStopSingleMonitor = async (
        userId: string,
        monitorId: number,
    ) => {
        setStoppingMonitorId(monitorId);

        try {
            const result = await stopSingleUserMonitor(userId, monitorId);

            setActiveMonitorRows((current) =>
                current.filter((monitor) => monitor.id !== monitorId),
            );

            setUsers((prev) =>
                prev.map((user) =>
                    user.id === userId
                        ? markUserMonitorsStopped(user, monitorId)
                        : user,
                ),
            );

            setSelected((prev) =>
                prev?.id === userId
                    ? markUserMonitorsStopped(prev, monitorId)
                    : prev,
            );

            toast.success(
                result.stopped
                    ? "Monitor stopped"
                    : "Monitor is already stopped",
            );
        } catch {
            toast.error("Failed to stop monitor");
        } finally {
            setStoppingMonitorId(null);
        }
    };

    const handleSaveMemberAnnouncement = async () => {
        setIsSavingMemberAnnouncement(true);
        try {
            const result = await updateMemberAnnouncement(
                toMemberAnnouncementInput(memberAnnouncement),
            );
            if (!result.success) {
                toast.error(result.error);
                return;
            }
            setMemberAnnouncement(result.announcement);
            toast.success(
                result.changed
                    ? "Member announcement published"
                    : "Announcement is already up to date",
            );
        } catch (error) {
            toast.error(
                error instanceof Error
                    ? error.message
                    : "Failed to save member announcement",
            );
        } finally {
            setIsSavingMemberAnnouncement(false);
        }
    };

    const openMaintenanceDialog = (mode: "enable" | "update" | "disable") => {
        setMaintenanceMessage(
            monitorMaintenanceState.maintenance.message ||
                DEFAULT_MONITOR_MAINTENANCE_MESSAGE,
        );
        setMaintenanceEstimatedEndAt(
            announcementDateTimeValue(
                monitorMaintenanceState.maintenance.estimatedEndAt,
            ),
        );
        setMaintenanceDialogMode(mode);
    };

    const handleMaintenanceAction = async () => {
        if (!maintenanceDialogMode) return;
        setIsSavingMaintenance(true);
        try {
            const nextState =
                maintenanceDialogMode === "disable"
                    ? await disableMonitorMaintenance()
                    : maintenanceDialogMode === "update"
                      ? await updateMonitorMaintenance({
                            message: maintenanceMessage,
                            estimatedEndAt: announcementDateTimeIso(
                                maintenanceEstimatedEndAt,
                            ),
                        })
                      : await enableMonitorMaintenance({
                            message: maintenanceMessage,
                            estimatedEndAt: announcementDateTimeIso(
                                maintenanceEstimatedEndAt,
                            ),
                        });
            setMonitorMaintenanceState(nextState);
            setMaintenanceDialogMode(null);
            toast.success(
                maintenanceDialogMode === "disable"
                    ? `${nextState.activeMonitorCount} monitor${nextState.activeMonitorCount === 1 ? "" : "s"} resumed`
                    : maintenanceDialogMode === "update"
                      ? "Maintenance notice updated"
                      : `${nextState.maintenancePausedCount} monitor${nextState.maintenancePausedCount === 1 ? "" : "s"} safely paused`,
            );
            void loadOverview();
        } catch (error) {
            toast.error(
                error instanceof Error
                    ? error.message
                    : "Failed to update maintenance mode",
            );
        } finally {
            setIsSavingMaintenance(false);
        }
    };

    const refreshInactivePolicyPreview = async () => {
        try {
            setInactivePolicyPreview(
                await previewInactiveMemberPolicy(inactivePolicyDraft),
            );
        } catch (error) {
            toast.error(
                error instanceof Error ? error.message : "Invalid policy",
            );
        }
    };

    const handleSaveInactivePolicy = async () => {
        setIsSavingInactivePolicy(true);
        try {
            const next = await updateInactiveMemberPolicy(inactivePolicyDraft);
            setInactivePolicyState(next);
            setInactivePolicyPreview(next.preview);
            toast.success(
                next.policy.enabled
                    ? "Inactive member automation enabled"
                    : "Inactive member automation disabled",
            );
        } catch (error) {
            toast.error(
                error instanceof Error
                    ? error.message
                    : "Failed to save inactivity policy",
            );
        } finally {
            setIsSavingInactivePolicy(false);
        }
    };

    const handleSaveServerProxies = async () => {
        const previous = serverProxies;
        const formData = new FormData();
        formData.set("proxies", serverProxies);
        setIsSavingServerProxies(true);

        try {
            const result = await updateServerProxies(formData);
            if (!result.success) {
                toast.error(result.error);
                return;
            }
            const skippedCount = result.skippedCount ?? 0;
            toast.success(
                `Server proxies saved (${result.proxyCount} active${
                    skippedCount > 0 ? `, ${skippedCount} skipped` : ""
                })`,
            );
            setServerProxies(
                serverProxies
                    .split("\n")
                    .map((line) => line.trim())
                    .filter(Boolean)
                    .join("\n"),
            );
        } catch (error) {
            setServerProxies(previous);
            toast.error(
                error instanceof Error
                    ? error.message
                    : "Failed to save server proxies",
            );
        } finally {
            setIsSavingServerProxies(false);
        }
    };

    const refreshFreeProxyState = async () => {
        const nextState = await getFreeProxyAdminState();
        setFreeProxyState(nextState);
        setFreeProxySettings(normalizeFreeProxySettings(nextState.settings));
    };

    const openFreeProxyRegion = async (region: string) => {
        setSelectedFreeProxyRegion(region);
        if (freeProxySourceDiagnostics[region]) return;
        setIsLoadingFreeProxySources(true);
        try {
            const diagnostics = await getFreeProxySourceDiagnostics(region);
            setFreeProxySourceDiagnostics((current) => ({
                ...current,
                [region]: diagnostics,
            }));
        } catch (error) {
            toast.error(
                error instanceof Error
                    ? error.message
                    : "Failed to load proxy source diagnostics",
            );
        } finally {
            setIsLoadingFreeProxySources(false);
        }
    };

    const handleSaveFreeProxySettings = async () => {
        setIsSavingFreeProxySettings(true);
        const formData = new FormData();
        formData.set("enabled", String(freeProxySettings.enabled));
        formData.set(
            "autoImportEnabled",
            String(freeProxySettings.autoImportEnabled),
        );
        formData.set("importSource", freeProxySettings.importSource);
        formData.set("importUrl", freeProxySettings.importUrl);
        formData.set("maxPoolSize", String(freeProxySettings.maxPoolSize));
        formData.set(
            "failureThreshold",
            String(freeProxySettings.failureThreshold),
        );
        formData.set(
            "quarantineMinutes",
            String(freeProxySettings.quarantineMinutes),
        );
        formData.set(
            "minActivePerRegion",
            String(freeProxySettings.minActivePerRegion),
        );
        formData.set(
            "targetActivePerRegion",
            String(freeProxySettings.targetActivePerRegion),
        );
        formData.set("maxLatencyMs", String(freeProxySettings.maxLatencyMs));
        formData.set("starterRegions", freeProxySettings.starterRegions);
        formData.set(
            "inventoryLimit",
            String(freeProxySettings.inventoryLimit),
        );
        formData.set(
            "activeCandidateLimit",
            String(freeProxySettings.activeCandidateLimit),
        );
        formData.set(
            "idleCandidateLimit",
            String(freeProxySettings.idleCandidateLimit),
        );
        formData.set("readyTarget", String(freeProxySettings.readyTarget));
        formData.set("reserveTarget", String(freeProxySettings.reserveTarget));
        formData.set("idleTarget", String(freeProxySettings.idleTarget));
        formData.set(
            "emergencyRecoveryEnabled",
            String(freeProxySettings.emergencyRecoveryEnabled),
        );

        try {
            const result = await updateFreeProxySettings(formData);
            if (!result.success) {
                toast.error(result.error);
                return;
            }
            await refreshFreeProxyState();
            toast.success(
                "Free proxy settings saved. New regions start on the next worker cycle.",
            );
        } catch (error) {
            toast.error(
                error instanceof Error
                    ? error.message
                    : "Failed to save free proxy settings",
            );
        } finally {
            setIsSavingFreeProxySettings(false);
        }
    };

    const handleImportFreeProxies = async () => {
        setIsImportingFreeProxies(true);
        try {
            const result = await importFreeProxiesNow();
            if (!result.success) {
                toast.error(result.error);
                return;
            }
            await refreshFreeProxyState();
            toast.success(
                result.limitReached
                    ? "Free proxy pool limit already reached"
                    : `Imported ${result.addedCount} free proxies`,
            );
        } catch (error) {
            toast.error(
                error instanceof Error
                    ? error.message
                    : "Failed to import free proxies",
            );
        } finally {
            setIsImportingFreeProxies(false);
        }
    };

    const handleAddFreeProxies = async () => {
        const formData = new FormData();
        formData.set("proxies", manualFreeProxies);
        setIsAddingFreeProxies(true);

        try {
            const result = await addFreeProxies(formData);
            if (!result.success) {
                toast.error(result.error);
                return;
            }
            await refreshFreeProxyState();
            setManualFreeProxies("");
            const skippedCount = result.skippedCount ?? 0;
            toast.success(
                `Added ${result.addedCount} free proxies${
                    skippedCount > 0 ? `, skipped ${skippedCount}` : ""
                }`,
            );
        } catch (error) {
            toast.error(
                error instanceof Error
                    ? error.message
                    : "Failed to add free proxies",
            );
        } finally {
            setIsAddingFreeProxies(false);
        }
    };

    const handleClearFreeProxyQuarantine = async () => {
        setIsClearingFreeProxyQuarantine(true);
        try {
            const result = await clearFreeProxyQuarantine();
            await refreshFreeProxyState();
            toast.success(
                `Restored ${result.restoredCount} quarantined proxies`,
            );
        } catch (error) {
            toast.error(
                error instanceof Error
                    ? error.message
                    : "Failed to clear quarantine",
            );
        } finally {
            setIsClearingFreeProxyQuarantine(false);
        }
    };

    const selectedActiveMonitors =
        selected?.monitors.filter((monitor) => monitor.status === "active") ??
        [];
    const selectedPausedMonitors =
        selected?.monitors.filter((monitor) => monitor.status !== "active") ??
        [];
    const selectedRunningMonitors =
        selected && selected.monitors.length > 0
            ? selectedActiveMonitors.length
            : (selected?.metrics.runningMonitors ?? 0);
    const selectedRunningFreeProxyMonitors =
        selected && selected.monitors.length > 0
            ? selectedActiveMonitors.filter(
                  (monitor) => monitor.proxy_source === "free",
              ).length
            : (selected?.metrics.runningFreeProxyMonitors ?? 0);
    const selectedItems = selected?.metrics.totalItems ?? 0;
    const selectedEffectiveLimit = selected
        ? getEffectiveLimit(selected)
        : { value: null, source: "Unlimited" };
    const selectedEffectiveFreeProxyLimit = selected
        ? getEffectiveFreeProxyLimit(selected)
        : { value: null, source: "Unlimited" };
    const isLoadingSelectedDetails =
        selected !== null && loadingUserDetailsId === selected.id;
    const deadFreeProxyHealthCount = freeProxyState.regions.reduce(
        (sum, region) => sum + region.dead,
        0,
    );
    const readyFreeProxyRegionCount = freeProxyState.regions.filter(
        (region) => region.healthy,
    ).length;
    const activeTabDefinition =
        ADMIN_TABS.find((tab) => tab.value === activeTab) ?? ADMIN_TABS[0];
    const ActiveTabIcon = activeTabDefinition.icon;
    const maintenanceStatusLabel =
        monitorMaintenanceState.status === "active"
            ? "Maintenance active"
            : monitorMaintenanceState.status === "draining"
              ? "Draining"
              : monitorMaintenanceState.status === "confirmation_pending"
                ? "Worker confirmation pending"
                : "Normal operation";
    const userMetricsLoaded = overviewState !== null;
    const userMetricsLoadFailed = overviewLoadFailed;
    const isLoadingUserMetrics = isLoadingOverview;
    const areUserMetricsPending = !overviewState && !overviewLoadFailed;
    const dispatcherHeartbeatAge = operationsSummary?.dispatcherHeartbeat
        ? Date.now() - new Date(operationsSummary.dispatcherHeartbeat).getTime()
        : null;
    const pendingAge = operationsSummary?.oldestPendingAt
        ? Date.now() - new Date(operationsSummary.oldestPendingAt).getTime()
        : 0;
    const hasOperationalIssues =
        (successRate24h !== null && successRate24h < 90) ||
        (operationsSummary !== null && dispatcherHeartbeatAge === null) ||
        (dispatcherHeartbeatAge !== null && dispatcherHeartbeatAge > 30_000) ||
        (operationsSummary?.enrichment?.queueAgeMs ?? 0) > 2_000 ||
        (operationsSummary?.notificationLatency.p95Ms ?? 0) > 1_000 ||
        pendingAge > 120_000;
    const membersWithoutMonitors = memberInsights
        ? Math.max(
              0,
              memberInsights.summary.totalMembers -
                  memberInsights.summary.usersWithMonitors,
          )
        : 0;
    const activatedWithoutDemo = memberInsights
        ? Math.max(
              0,
              memberInsights.summary.usersWithMonitors -
                  memberInsights.demo.users,
          )
        : 0;

    return (
        <div className="space-y-6">
            <div className="border-border/60 flex flex-col gap-4 border-b pb-5 lg:flex-row lg:items-end lg:justify-between">
                <div className="flex items-start gap-3">
                    <div className="border-border/70 bg-muted/40 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border">
                        <ActiveTabIcon className="text-muted-foreground h-5 w-5" />
                    </div>
                    <div>
                        <h1 className="text-2xl font-bold">Admin Panel</h1>
                        <p className="text-muted-foreground mt-1 text-sm">
                            {activeTabDefinition.description}
                        </p>
                    </div>
                </div>
                <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs">
                    <div className="flex items-center gap-2">
                        <span
                            className={`h-2 w-2 rounded-full ${
                                areUserMetricsPending
                                    ? "bg-muted-foreground"
                                    : hasOperationalIssues
                                      ? "bg-amber-500"
                                      : "bg-emerald-500"
                            }`}
                        />
                        <span className="font-medium">
                            {areUserMetricsPending
                                ? "Loading"
                                : hasOperationalIssues
                                  ? "Needs attention"
                                  : "Operational"}
                        </span>
                    </div>
                    {usersLoadFailed ? (
                        <button
                            type="button"
                            className="text-amber-600 hover:underline dark:text-amber-400"
                            onClick={() => void loadAdminUsers()}
                            disabled={isLoadingUsers}
                        >
                            Retry members
                        </button>
                    ) : userMetricsLoadFailed ? (
                        <button
                            type="button"
                            className="text-amber-600 hover:underline dark:text-amber-400"
                            onClick={loadOverview}
                            disabled={isLoadingUserMetrics}
                        >
                            Retry member metrics
                        </button>
                    ) : (
                        <span className="text-muted-foreground">
                            {userMetricsLoaded
                                ? `${runningMonitors} running monitors`
                                : "Loading overview..."}
                        </span>
                    )}
                    <span className="text-muted-foreground">
                        {readyFreeProxyRegionCount} proxy regions ready
                    </span>
                </div>
            </div>

            <div
                role="tablist"
                aria-label="Admin sections"
                className="border-border/60 bg-card flex gap-1 overflow-x-auto rounded-lg border p-1"
            >
                {ADMIN_TABS.map((tab) => {
                    const Icon = tab.icon;
                    const isActive = activeTab === tab.value;

                    return (
                        <button
                            key={tab.value}
                            type="button"
                            role="tab"
                            aria-selected={isActive}
                            className={`flex h-9 min-w-max flex-1 items-center justify-center gap-2 rounded-md px-3 text-sm font-medium transition-colors ${
                                isActive
                                    ? "bg-primary text-primary-foreground"
                                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                            }`}
                            onClick={() => switchTab(tab.value)}
                        >
                            <Icon className="h-4 w-4" />
                            {tab.label}
                        </button>
                    );
                })}
            </div>

            {activeTab === "monitors" ? (
                <div className="w-full">
                    <div
                        className={`rounded-xl border p-5 ${
                            monitorMaintenanceState.maintenance.enabled
                                ? "border-red-500/30 bg-red-500/5"
                                : "border-border/60 bg-card"
                        }`}
                        data-testid="maintenance-system-control"
                    >
                        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                            <div className="flex items-start gap-3">
                                <div
                                    className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${
                                        monitorMaintenanceState.maintenance
                                            .enabled
                                            ? "bg-red-500 text-white"
                                            : "bg-muted text-muted-foreground"
                                    }`}
                                >
                                    <Wrench className="h-5 w-5" />
                                </div>
                                <div>
                                    <div className="flex flex-wrap items-center gap-2">
                                        <p className="text-sm font-semibold">
                                            Monitor Maintenance
                                        </p>
                                        <Badge
                                            variant={
                                                monitorMaintenanceState
                                                    .maintenance.enabled
                                                    ? "destructive"
                                                    : "secondary"
                                            }
                                            className="rounded-md text-[10px] uppercase"
                                        >
                                            {maintenanceStatusLabel}
                                        </Badge>
                                    </div>
                                    <p className="text-muted-foreground mt-1 max-w-2xl text-xs leading-5">
                                        {monitorMaintenanceState.maintenance
                                            .enabled
                                            ? monitorMaintenanceState
                                                  .maintenance.message
                                            : "Pause every monitor safely and block new starts while planned maintenance is in progress."}
                                    </p>
                                </div>
                            </div>
                            <div className="flex shrink-0 flex-wrap gap-2">
                                {monitorMaintenanceState.maintenance.enabled ? (
                                    <>
                                        <Button
                                            type="button"
                                            size="sm"
                                            variant="outline"
                                            onClick={() =>
                                                openMaintenanceDialog("update")
                                            }
                                        >
                                            Edit notice
                                        </Button>
                                        <Button
                                            type="button"
                                            size="sm"
                                            onClick={() =>
                                                openMaintenanceDialog("disable")
                                            }
                                        >
                                            End maintenance
                                        </Button>
                                    </>
                                ) : (
                                    <Button
                                        type="button"
                                        size="sm"
                                        variant="destructive"
                                        onClick={() =>
                                            openMaintenanceDialog("enable")
                                        }
                                    >
                                        Enable maintenance
                                    </Button>
                                )}
                            </div>
                        </div>
                        <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
                            <div className="border-border/60 bg-background/50 rounded-lg border px-3 py-2.5">
                                <p className="text-muted-foreground text-[10px] uppercase">
                                    Active monitors
                                </p>
                                <p className="mt-1 text-lg font-semibold tabular-nums">
                                    {monitorMaintenanceState.activeMonitorCount}
                                </p>
                            </div>
                            <div className="border-border/60 bg-background/50 rounded-lg border px-3 py-2.5">
                                <p className="text-muted-foreground text-[10px] uppercase">
                                    Maintenance paused
                                </p>
                                <p className="mt-1 text-lg font-semibold tabular-nums">
                                    {
                                        monitorMaintenanceState.maintenancePausedCount
                                    }
                                </p>
                            </div>
                            <div className="border-border/60 bg-background/50 rounded-lg border px-3 py-2.5">
                                <p className="text-muted-foreground text-[10px] uppercase">
                                    Worker tasks
                                </p>
                                <p className="mt-1 text-lg font-semibold tabular-nums">
                                    {monitorMaintenanceState.runtime
                                        ? monitorMaintenanceState.runtime
                                              .runningMonitorTasks +
                                          monitorMaintenanceState.runtime
                                              .runningDiscoveryTasks
                                        : "—"}
                                </p>
                            </div>
                            <div className="border-border/60 bg-background/50 rounded-lg border px-3 py-2.5">
                                <p className="text-muted-foreground text-[10px] uppercase">
                                    Worker heartbeat
                                </p>
                                <p className="mt-1 text-sm font-semibold">
                                    {monitorMaintenanceState.runtime
                                        ? formatMetricDate(
                                              new Date(
                                                  monitorMaintenanceState
                                                      .runtime.heartbeatAt,
                                              ),
                                          )
                                        : "No confirmation"}
                                </p>
                            </div>
                            <div className="border-border/60 bg-background/50 rounded-lg border px-3 py-2.5">
                                <p className="text-muted-foreground text-[10px] uppercase">
                                    Last change
                                </p>
                                <p className="mt-1 text-sm font-semibold">
                                    {monitorMaintenanceState.maintenance
                                        .updatedAt
                                        ? formatMetricDate(
                                              new Date(
                                                  monitorMaintenanceState
                                                      .maintenance.updatedAt,
                                              ),
                                          )
                                        : "Never"}
                                </p>
                            </div>
                        </div>
                    </div>
                </div>
            ) : null}

            {activeTab === "overview" ? (
                <>
                    <div className="border-border/60 bg-border/60 grid gap-px overflow-hidden rounded-lg border sm:grid-cols-2 xl:grid-cols-5">
                        <OverviewMetric
                            label="Total users"
                            value={totalUsers}
                            detail={`${premiumUsers} premium · ${adminUsers} admin`}
                            icon={Users}
                            iconClassName="bg-muted text-muted-foreground"
                        />
                        <OverviewMetric
                            label="Running"
                            value={userMetricsLoaded ? runningMonitors : "—"}
                            detail={
                                userMetricsLoaded
                                    ? `${pausedMonitors} paused monitors`
                                    : "Loading monitor totals"
                            }
                            icon={Activity}
                            iconClassName="bg-emerald-500/10 text-emerald-600"
                        />
                        <OverviewMetric
                            label="Canonical checks 24h"
                            value={userMetricsLoaded ? checks24h : "—"}
                            detail={
                                userMetricsLoaded
                                    ? `${formatSuccessRate(successRate24h)} successful`
                                    : "Loading worker activity"
                            }
                            icon={Gauge}
                            iconClassName="bg-sky-500/10 text-sky-600"
                        />
                        <OverviewMetric
                            label="New items 24h"
                            value={userMetricsLoaded ? newItems24h : "—"}
                            detail={
                                userMetricsLoaded
                                    ? "From completed monitor checks"
                                    : "Loading item totals"
                            }
                            icon={Boxes}
                            iconClassName="bg-rose-500/10 text-rose-600"
                        />
                        <OverviewMetric
                            label="Proxy regions"
                            value={readyFreeProxyRegionCount}
                            detail={`${freeProxyState.regions.length} configured regions`}
                            icon={Globe}
                            iconClassName="bg-amber-500/10 text-amber-600"
                        />
                    </div>
                    <div className="border-border/60 bg-card rounded-lg border p-5">
                        <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
                            <div>
                                <p className="text-foreground text-sm font-semibold">
                                    Runtime Snapshot
                                </p>
                                <p className="text-muted-foreground text-xs">
                                    Aggregate monitor-hours without scanning
                                    runtime history.
                                </p>
                            </div>
                            <Badge
                                variant="outline"
                                className="rounded-md text-[10px] uppercase"
                            >
                                {overviewState?.runtime.trackedSince
                                    ? `Tracked since ${new Intl.DateTimeFormat("de-DE", { dateStyle: "medium" }).format(new Date(overviewState.runtime.trackedSince))}`
                                    : "Tracking starts with migration"}
                            </Badge>
                        </div>
                        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                            <div className="bg-muted/30 rounded-lg px-4 py-3">
                                <p className="text-muted-foreground text-[11px] uppercase">
                                    Total runtime
                                </p>
                                <p className="mt-1 text-2xl font-semibold tabular-nums">
                                    {overviewState
                                        ? formatRuntime(
                                              overviewState.runtime
                                                  .totalSeconds,
                                          )
                                        : "—"}
                                </p>
                            </div>
                            <div className="bg-muted/30 rounded-lg px-4 py-3">
                                <p className="text-muted-foreground text-[11px] uppercase">
                                    Open sessions
                                </p>
                                <p className="mt-1 text-2xl font-semibold tabular-nums">
                                    {overviewState
                                        ? formatRuntime(
                                              overviewState.runtime
                                                  .currentSeconds,
                                          )
                                        : "—"}
                                </p>
                            </div>
                            <div className="bg-muted/30 rounded-lg px-4 py-3">
                                <p className="text-muted-foreground text-[11px] uppercase">
                                    Oldest running
                                </p>
                                <p className="mt-1 text-2xl font-semibold tabular-nums">
                                    {overviewState?.runtime.oldestActiveSince
                                        ? formatRuntime(
                                              (nowMs -
                                                  new Date(
                                                      overviewState.runtime
                                                          .oldestActiveSince,
                                                  ).getTime()) /
                                                  1000,
                                          )
                                        : "—"}
                                </p>
                            </div>
                            <div className="bg-muted/30 rounded-lg px-4 py-3">
                                <p className="text-muted-foreground text-[11px] uppercase">
                                    Active source mix
                                </p>
                                <div className="bg-muted mt-3 flex h-3 overflow-hidden rounded-full">
                                    {(["free", "server", "group"] as const).map(
                                        (source) => (
                                            <span
                                                key={source}
                                                className={
                                                    source === "free"
                                                        ? "bg-amber-500"
                                                        : source === "server"
                                                          ? "bg-sky-500"
                                                          : "bg-violet-500"
                                                }
                                                style={{
                                                    width: `${runningMonitors > 0 ? ((overviewState?.monitors.sources[source] ?? 0) / runningMonitors) * 100 : 0}%`,
                                                }}
                                            />
                                        ),
                                    )}
                                </div>
                                <p className="text-muted-foreground mt-2 text-[10px]">
                                    {overviewState?.monitors.sources.free ?? 0}{" "}
                                    free ·{" "}
                                    {overviewState?.monitors.sources.server ??
                                        0}{" "}
                                    server ·{" "}
                                    {overviewState?.monitors.sources.group ?? 0}{" "}
                                    own
                                </p>
                            </div>
                        </div>
                    </div>
                    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
                        <div className="border-border/60 bg-card flex h-full flex-col rounded-lg border p-5">
                            <div className="mb-4 flex items-center justify-between">
                                <div>
                                    <p className="text-foreground text-sm font-semibold">
                                        Monitor Health
                                    </p>
                                    <p className="text-muted-foreground text-xs">
                                        Current monitor mix and 24h worker
                                        activity.
                                    </p>
                                </div>
                                <Badge
                                    variant={
                                        failedChecks24h > 0
                                            ? "outline"
                                            : "secondary"
                                    }
                                    className="rounded-md text-[10px] uppercase"
                                >
                                    {areUserMetricsPending
                                        ? "Loading"
                                        : failedChecks24h > 0
                                          ? `${failedChecks24h} failures`
                                          : "Healthy"}
                                </Badge>
                            </div>

                            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                                <div className="border-border/60 rounded-lg border px-4 py-3">
                                    <p className="text-muted-foreground text-[11px] font-medium tracking-widest uppercase">
                                        Total monitors
                                    </p>
                                    <p className="mt-1 text-2xl font-semibold">
                                        {totalMonitors}
                                    </p>
                                </div>
                                <div className="border-border/60 rounded-lg border px-4 py-3">
                                    <p className="text-muted-foreground text-[11px] font-medium tracking-widest uppercase">
                                        Paused
                                    </p>
                                    <p className="mt-1 text-2xl font-semibold">
                                        {userMetricsLoaded
                                            ? pausedMonitors
                                            : "—"}
                                    </p>
                                </div>
                                <div className="border-border/60 rounded-lg border px-4 py-3">
                                    <p className="text-muted-foreground text-[11px] font-medium tracking-widest uppercase">
                                        Canonical checks 24h
                                    </p>
                                    <p className="mt-1 text-2xl font-semibold">
                                        {userMetricsLoaded ? checks24h : "—"}
                                    </p>
                                </div>
                                <div className="border-border/60 rounded-lg border px-4 py-3">
                                    <p className="text-muted-foreground text-[11px] font-medium tracking-widest uppercase">
                                        Success rate
                                    </p>
                                    <p className="mt-1 text-2xl font-semibold">
                                        {userMetricsLoaded
                                            ? formatSuccessRate(successRate24h)
                                            : "—"}
                                    </p>
                                </div>
                            </div>

                            <div className="mt-4 grid gap-3 sm:grid-cols-3">
                                <div className="bg-muted/30 rounded-lg px-4 py-3">
                                    <p className="text-muted-foreground text-xs">
                                        Successful checks
                                    </p>
                                    <p className="mt-1 text-xl font-semibold">
                                        {userMetricsLoaded
                                            ? successfulChecks24h
                                            : "—"}
                                    </p>
                                </div>
                                <div className="bg-muted/30 rounded-lg px-4 py-3">
                                    <p className="text-muted-foreground text-xs">
                                        New items 24h
                                    </p>
                                    <p className="mt-1 text-xl font-semibold">
                                        {userMetricsLoaded ? newItems24h : "—"}
                                    </p>
                                </div>
                                <div className="bg-muted/30 rounded-lg px-4 py-3">
                                    <p className="text-muted-foreground text-xs">
                                        Server proxies
                                    </p>
                                    <p className="mt-1 text-xl font-semibold">
                                        {serverProxyLineCount}
                                    </p>
                                </div>
                            </div>

                            <div className="mt-4 flex-1 rounded-lg border px-4 py-3">
                                <div className="mb-2 flex items-center justify-between gap-3">
                                    <p className="text-muted-foreground text-xs font-medium">
                                        Running capacity
                                    </p>
                                    <p className="text-foreground text-sm font-semibold">
                                        {activeMonitorShare}%
                                    </p>
                                </div>
                                <div className="bg-muted h-2 overflow-hidden rounded-full">
                                    <div
                                        className="h-full rounded-full bg-emerald-500 transition-all"
                                        style={{
                                            width: `${activeMonitorShare}%`,
                                        }}
                                    />
                                </div>
                                <div className="mt-3 grid gap-2 sm:grid-cols-3">
                                    <div className="flex items-center justify-between gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-xs dark:bg-emerald-500/10">
                                        <span className="text-emerald-700 dark:text-emerald-300">
                                            Running
                                        </span>
                                        <span className="font-semibold text-emerald-800 dark:text-emerald-200">
                                            {runningMonitors}
                                        </span>
                                    </div>
                                    <div className="bg-muted/40 flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-xs">
                                        <span className="text-muted-foreground">
                                            Paused
                                        </span>
                                        <span className="font-semibold">
                                            {pausedMonitors}
                                        </span>
                                    </div>
                                    <div className="bg-muted/40 flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-xs">
                                        <span className="text-muted-foreground">
                                            Failed checks
                                        </span>
                                        <span className="font-semibold">
                                            {failedChecks24h}
                                        </span>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <div className="border-border/60 bg-card rounded-lg border p-5">
                            <div className="mb-4">
                                <p className="text-foreground text-sm font-semibold">
                                    Limits & Capacity
                                </p>
                                <p className="text-muted-foreground text-xs">
                                    Active monitor limits that need admin
                                    attention.
                                </p>
                            </div>
                            <div className="space-y-3">
                                {[
                                    ["Users at limit", usersAtLimit],
                                    ["User overrides", userOverrides],
                                    ["Role limits", roleLimitsConfigured],
                                ].map(([label, count]) => (
                                    <div
                                        key={label}
                                        className="flex items-center justify-between rounded-lg border px-4 py-3"
                                    >
                                        <span className="text-sm font-medium">
                                            {label}
                                        </span>
                                        <span className="text-muted-foreground text-sm">
                                            {count}
                                        </span>
                                    </div>
                                ))}
                            </div>
                            {usersAtLimit > 0 ? (
                                <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 dark:border-amber-500/20 dark:bg-amber-500/10">
                                    <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
                                        {usersAtLimit} user
                                        {usersAtLimit === 1 ? "" : "s"} at
                                        active monitor capacity
                                    </p>
                                    <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
                                        Review role or user overrides in the
                                        Roles tab.
                                    </p>
                                </div>
                            ) : (
                                <p className="text-muted-foreground mt-4 rounded-lg border px-4 py-3 text-xs">
                                    No users are currently blocked by active
                                    monitor limits.
                                </p>
                            )}
                        </div>
                    </div>

                    <div className="grid gap-4 lg:grid-cols-2">
                        <div className="border-border/60 bg-card overflow-hidden rounded-lg border">
                            <div className="border-border/60 border-b px-5 py-4">
                                <p className="text-foreground text-sm font-semibold">
                                    Runtime Leaders
                                </p>
                                <p className="text-muted-foreground text-xs">
                                    Highest tracked aggregate monitor runtime.
                                </p>
                            </div>
                            <div className="divide-border/50 divide-y">
                                {topUsers.map((user) => (
                                    <button
                                        key={user.id}
                                        type="button"
                                        className="hover:bg-muted/40 flex w-full items-center justify-between gap-4 px-5 py-3 text-left transition-colors"
                                        onClick={() => openUserDetails(user)}
                                    >
                                        <div className="min-w-0">
                                            <p className="text-foreground truncate text-sm font-medium">
                                                {user.name ?? "Unknown"}
                                            </p>
                                            <p className="text-muted-foreground truncate text-xs">
                                                {user.email ?? "No email"}
                                            </p>
                                        </div>
                                        <div className="text-right text-xs">
                                            <p className="text-foreground font-semibold">
                                                {formatRuntime(
                                                    user.metrics
                                                        .totalRuntimeSeconds,
                                                )}
                                            </p>
                                            <p className="text-muted-foreground">
                                                {user.metrics.runningMonitors}{" "}
                                                running ·{" "}
                                                {formatRuntime(
                                                    user.metrics
                                                        .currentRuntimeSeconds,
                                                )}{" "}
                                                open
                                            </p>
                                        </div>
                                    </button>
                                ))}
                            </div>
                        </div>

                        <div className="border-border/60 bg-card overflow-hidden rounded-lg border">
                            <div className="border-border/60 border-b px-5 py-4">
                                <p className="text-foreground text-sm font-semibold">
                                    Recent Important Events
                                </p>
                                <p className="text-muted-foreground text-xs">
                                    Failures and monitor events without the
                                    successful alert noise.
                                </p>
                            </div>
                            {importantLogs.length > 0 ? (
                                <div className="divide-border/50 divide-y">
                                    {importantLogs.map((log) => (
                                        <div key={log.id} className="px-5 py-3">
                                            <div className="flex flex-wrap items-center gap-2">
                                                <Badge
                                                    variant="outline"
                                                    className="rounded-md text-[10px] uppercase"
                                                >
                                                    {log.type}
                                                </Badge>
                                                <span className="text-foreground text-sm font-medium">
                                                    {log.title}
                                                </span>
                                                <span className="text-muted-foreground ml-auto text-xs">
                                                    {formatMetricDate(
                                                        log.createdAt,
                                                    )}
                                                </span>
                                            </div>
                                            <p className="text-muted-foreground mt-1 truncate text-xs">
                                                {log.detail ??
                                                    log.subject ??
                                                    log.actor ??
                                                    "No detail"}
                                            </p>
                                        </div>
                                    ))}
                                </div>
                            ) : (
                                <div className="text-muted-foreground px-5 py-8 text-center text-sm">
                                    No important events right now.
                                </div>
                            )}
                        </div>
                    </div>
                </>
            ) : null}

            {activeTab === "insights" ? (
                <div className="space-y-5">
                    {isLoadingRuntimeInsights && !runtimeInsights ? (
                        <div className="border-border/60 bg-card text-muted-foreground flex min-h-48 items-center justify-center rounded-lg border text-sm">
                            Loading runtime analytics...
                        </div>
                    ) : runtimeInsightsLoadFailed && !runtimeInsights ? (
                        <div className="border-border/60 bg-card flex min-h-48 flex-col items-center justify-center gap-3 rounded-lg border text-center">
                            <AlertTriangle className="h-6 w-6 text-amber-500" />
                            <p className="text-sm font-medium">
                                Runtime analytics could not be loaded
                            </p>
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={loadRuntimeInsights}
                            >
                                Retry runtime analytics
                            </Button>
                        </div>
                    ) : runtimeInsights ? (
                        <>
                            <div className="grid gap-4 sm:grid-cols-3">
                                <MemberMetricCard
                                    label="Monitor-hours 7d"
                                    value={formatRuntime(
                                        runtimeInsights.daily
                                            .slice(-7)
                                            .reduce(
                                                (sum, day) =>
                                                    sum +
                                                    day.freeSeconds +
                                                    day.serverSeconds +
                                                    day.groupSeconds,
                                                0,
                                            ),
                                    )}
                                    detail="Aggregate active time across all monitors"
                                    icon={Clock3}
                                    tone="sky"
                                />
                                <MemberMetricCard
                                    label="Median session 7d"
                                    value={formatRuntime(
                                        runtimeInsights.medianSessionSeconds7d,
                                    )}
                                    detail="Completed active sessions"
                                    icon={Activity}
                                    tone="violet"
                                />
                                <MemberMetricCard
                                    label="Tracked members 7d"
                                    value={runtimeInsights.leaderboard.length}
                                    detail="Top runtime members shown below"
                                    icon={Users}
                                    tone="amber"
                                />
                            </div>
                            <div className="grid gap-5 xl:grid-cols-[minmax(0,1.5fr)_minmax(340px,1fr)]">
                                <div className="border-border/60 bg-card rounded-xl border p-5 shadow-sm sm:p-6">
                                    <div className="mb-5">
                                        <p className="text-sm font-semibold">
                                            Runtime by proxy source
                                        </p>
                                        <p className="text-muted-foreground text-xs">
                                            UTC day buckets · tracked since{" "}
                                            {runtimeInsights.trackedSince
                                                ? new Intl.DateTimeFormat(
                                                      "de-DE",
                                                      { dateStyle: "medium" },
                                                  ).format(
                                                      new Date(
                                                          runtimeInsights.trackedSince,
                                                      ),
                                                  )
                                                : "feature launch"}
                                        </p>
                                    </div>
                                    <RuntimeStackedChart
                                        data={runtimeInsights.daily}
                                    />
                                </div>
                                <div className="border-border/60 bg-card overflow-hidden rounded-xl border shadow-sm">
                                    <div className="border-border/50 border-b px-5 py-4">
                                        <p className="text-sm font-semibold">
                                            7-day runtime leaderboard
                                        </p>
                                        <p className="text-muted-foreground text-xs">
                                            Efficiency uses existing hourly
                                            worker stats.
                                        </p>
                                    </div>
                                    <div className="divide-border/50 divide-y">
                                        {runtimeInsights.leaderboard.map(
                                            (member, index) => {
                                                const maximum =
                                                    runtimeInsights
                                                        .leaderboard[0]
                                                        ?.runtimeSeconds7d || 1;
                                                return (
                                                    <div
                                                        key={member.userId}
                                                        className="px-5 py-3"
                                                    >
                                                        <div className="flex items-center gap-3">
                                                            <span className="text-muted-foreground w-5 text-xs tabular-nums">
                                                                #{index + 1}
                                                            </span>
                                                            <div className="min-w-0 flex-1">
                                                                <div className="flex items-center justify-between gap-3">
                                                                    <p className="truncate text-sm font-medium">
                                                                        {member.name ??
                                                                            member.email ??
                                                                            "Unknown"}
                                                                    </p>
                                                                    <span className="text-xs font-semibold tabular-nums">
                                                                        {formatRuntime(
                                                                            member.runtimeSeconds7d,
                                                                        )}
                                                                    </span>
                                                                </div>
                                                                <div className="bg-muted mt-2 h-1.5 overflow-hidden rounded-full">
                                                                    <div
                                                                        className="h-full rounded-full bg-violet-500"
                                                                        style={{
                                                                            width: `${(member.runtimeSeconds7d / maximum) * 100}%`,
                                                                        }}
                                                                    />
                                                                </div>
                                                                <p className="text-muted-foreground mt-1 text-[10px]">
                                                                    {member.checksPerRuntimeHour ===
                                                                    null
                                                                        ? "—"
                                                                        : member.checksPerRuntimeHour.toFixed(
                                                                              1,
                                                                          )}{" "}
                                                                    checks/h ·{" "}
                                                                    {member.newItemsPer100RuntimeHours ===
                                                                    null
                                                                        ? "—"
                                                                        : member.newItemsPer100RuntimeHours.toFixed(
                                                                              1,
                                                                          )}{" "}
                                                                    items/100h
                                                                </p>
                                                            </div>
                                                        </div>
                                                    </div>
                                                );
                                            },
                                        )}
                                        {runtimeInsights.leaderboard.length ===
                                        0 ? (
                                            <p className="text-muted-foreground px-5 py-8 text-center text-sm">
                                                Runtime tracking has just
                                                started.
                                            </p>
                                        ) : null}
                                    </div>
                                </div>
                            </div>
                        </>
                    ) : null}
                    {isLoadingMemberInsights && !memberInsights ? (
                        <div className="border-border/60 bg-card text-muted-foreground flex min-h-72 items-center justify-center rounded-lg border text-sm">
                            Loading member insights...
                        </div>
                    ) : memberInsightsLoadFailed && !memberInsights ? (
                        <div className="border-border/60 bg-card flex min-h-72 flex-col items-center justify-center gap-3 rounded-lg border px-6 text-center">
                            <AlertTriangle className="h-6 w-6 text-amber-500" />
                            <div>
                                <p className="text-sm font-medium">
                                    Member insights could not be loaded
                                </p>
                                <p className="text-muted-foreground mt-1 text-xs">
                                    The rest of the admin panel is still
                                    available.
                                </p>
                            </div>
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={loadMemberInsights}
                            >
                                Retry
                            </Button>
                        </div>
                    ) : memberInsights ? (
                        <>
                            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                                <MemberMetricCard
                                    label="Total members"
                                    value={memberInsights.summary.totalMembers}
                                    detail={`${memberInsights.summary.newMembers30d} joined in the last 30 days`}
                                    icon={Users}
                                    tone="neutral"
                                />
                                <MemberMetricCard
                                    label="New this week"
                                    value={memberInsights.summary.newMembers7d}
                                    detail="Member acquisition this week"
                                    icon={UserPlus}
                                    tone="sky"
                                    change={
                                        memberInsights.summary.signupGrowth7d
                                    }
                                    changeLabel="vs previous 7 days"
                                />
                                <MemberMetricCard
                                    label="Activation rate"
                                    value={`${memberInsights.summary.activationRate}%`}
                                    detail={`${memberInsights.summary.usersWithMonitors} members created a monitor`}
                                    icon={Monitor}
                                    tone="violet"
                                    progress={
                                        memberInsights.summary.activationRate
                                    }
                                />
                                <MemberMetricCard
                                    label="Demo conversion"
                                    value={`${memberInsights.demo.conversionRate}%`}
                                    detail={`${memberInsights.demo.convertedUsers} of ${memberInsights.demo.users} demo users kept it running`}
                                    icon={FlaskConical}
                                    tone="amber"
                                    progress={
                                        memberInsights.demo.conversionRate
                                    }
                                />
                            </div>

                            <div className="border-border/60 bg-card overflow-hidden rounded-xl border shadow-sm">
                                <div className="border-border/50 flex flex-col gap-4 border-b px-5 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-6">
                                    <div className="flex items-start gap-3">
                                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-500">
                                            <TrendingUp className="h-4 w-4" />
                                        </span>
                                        <div>
                                            <p className="text-foreground text-sm font-semibold">
                                                Member growth
                                            </p>
                                            <p className="text-muted-foreground mt-0.5 text-xs">
                                                Daily registrations and the
                                                rolling 7-day trend.
                                            </p>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-3 sm:text-right">
                                        <div>
                                            <p className="text-lg font-semibold tabular-nums">
                                                {
                                                    memberInsights.summary
                                                        .newMembers30d
                                                }
                                            </p>
                                            <p className="text-muted-foreground text-[10px] uppercase">
                                                Last 30 days
                                            </p>
                                        </div>
                                        <span
                                            className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[10px] font-semibold tabular-nums ${
                                                memberInsights.summary
                                                    .signupGrowth30d === null ||
                                                memberInsights.summary
                                                    .signupGrowth30d === 0
                                                    ? "bg-muted text-muted-foreground"
                                                    : memberInsights.summary
                                                            .signupGrowth30d > 0
                                                      ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                                                      : "bg-rose-500/10 text-rose-600 dark:text-rose-400"
                                            }`}
                                        >
                                            {memberInsights.summary
                                                .signupGrowth30d === null ? (
                                                <Minus className="h-3 w-3" />
                                            ) : memberInsights.summary
                                                  .signupGrowth30d > 0 ? (
                                                <ArrowUpRight className="h-3 w-3" />
                                            ) : memberInsights.summary
                                                  .signupGrowth30d < 0 ? (
                                                <ArrowDownRight className="h-3 w-3" />
                                            ) : (
                                                <Minus className="h-3 w-3" />
                                            )}
                                            {memberInsights.summary
                                                .signupGrowth30d === null
                                                ? "No baseline"
                                                : `${memberInsights.summary.signupGrowth30d > 0 ? "+" : ""}${memberInsights.summary.signupGrowth30d}%`}
                                        </span>
                                    </div>
                                </div>
                                <div className="px-5 py-5 sm:px-6">
                                    <MemberGrowthChart
                                        data={memberInsights.growth}
                                    />
                                    {memberInsights.summary
                                        .membersWithoutSignupDate > 0 ? (
                                        <div className="border-border/60 bg-muted/30 mt-4 flex gap-2 rounded-lg border px-3 py-2.5">
                                            <AlertTriangle className="text-muted-foreground mt-0.5 h-3.5 w-3.5 shrink-0" />
                                            <p className="text-muted-foreground text-[11px] leading-relaxed">
                                                {
                                                    memberInsights.summary
                                                        .membersWithoutSignupDate
                                                }{" "}
                                                legacy accounts are excluded
                                                from time-based metrics because
                                                their original signup date was
                                                never recorded.
                                            </p>
                                        </div>
                                    ) : null}
                                </div>
                            </div>

                            <div className="grid gap-4 lg:grid-cols-5">
                                <div className="border-border/60 bg-card rounded-xl border p-5 shadow-sm sm:p-6 lg:col-span-3">
                                    <div className="mb-5 flex items-start justify-between gap-4">
                                        <div>
                                            <p className="text-foreground text-sm font-semibold">
                                                Activation funnel
                                            </p>
                                            <p className="text-muted-foreground mt-0.5 text-xs">
                                                From registration to a retained
                                                demo monitor.
                                            </p>
                                        </div>
                                        <span className="rounded-lg bg-violet-500/10 p-2 text-violet-500">
                                            <Sparkles className="h-4 w-4" />
                                        </span>
                                    </div>

                                    <div className="space-y-3">
                                        {[
                                            {
                                                label: "Registered",
                                                value: memberInsights.summary
                                                    .totalMembers,
                                                detail: "All member accounts",
                                                color: "bg-slate-500",
                                            },
                                            {
                                                label: "Activated",
                                                value: memberInsights.summary
                                                    .usersWithMonitors,
                                                detail: `${memberInsights.summary.activationRate}% created a monitor`,
                                                color: "bg-violet-500",
                                            },
                                            {
                                                label: "Tried the demo",
                                                value: memberInsights.demo
                                                    .users,
                                                detail: `${memberInsights.demo.adoptionRate}% of all members`,
                                                color: "bg-sky-500",
                                            },
                                            {
                                                label: "Converted",
                                                value: memberInsights.demo
                                                    .convertedUsers,
                                                detail: `${memberInsights.demo.conversionRate}% of demo users`,
                                                color: "bg-emerald-500",
                                            },
                                        ].map((stage, index) => {
                                            const share = Math.round(
                                                (stage.value /
                                                    Math.max(
                                                        1,
                                                        memberInsights.summary
                                                            .totalMembers,
                                                    )) *
                                                    100,
                                            );

                                            return (
                                                <div
                                                    key={stage.label}
                                                    className="border-border/50 bg-muted/20 rounded-lg border px-4 py-3"
                                                >
                                                    <div className="mb-2 flex items-center gap-3">
                                                        <span className="bg-background text-muted-foreground flex h-6 w-6 shrink-0 items-center justify-center rounded-md border text-[10px] font-semibold">
                                                            {index + 1}
                                                        </span>
                                                        <div className="min-w-0 flex-1">
                                                            <p className="truncate text-xs font-medium">
                                                                {stage.label}
                                                            </p>
                                                            <p className="text-muted-foreground truncate text-[10px]">
                                                                {stage.detail}
                                                            </p>
                                                        </div>
                                                        <div className="text-right">
                                                            <p className="text-base font-semibold tabular-nums">
                                                                {stage.value}
                                                            </p>
                                                            <p className="text-muted-foreground text-[10px] tabular-nums">
                                                                {share}% of
                                                                total
                                                            </p>
                                                        </div>
                                                    </div>
                                                    <div className="bg-muted h-1.5 overflow-hidden rounded-full">
                                                        <div
                                                            className={`h-full rounded-full ${stage.color}`}
                                                            style={{
                                                                width: `${Math.max(stage.value > 0 ? 2 : 0, share)}%`,
                                                            }}
                                                        />
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>

                                    <div className="mt-4 rounded-lg border border-violet-500/20 bg-violet-500/[0.06] px-4 py-3">
                                        <p className="text-xs font-semibold text-violet-700 dark:text-violet-300">
                                            Biggest activation opportunity
                                        </p>
                                        <p className="mt-1 text-[11px] leading-relaxed text-violet-700/80 dark:text-violet-300/80">
                                            {membersWithoutMonitors > 0
                                                ? `${membersWithoutMonitors} members have not created a monitor yet. ${activatedWithoutDemo} activated members have not tried the demo.`
                                                : "Every member has created at least one monitor."}
                                        </p>
                                    </div>

                                    <div className="mt-4 grid grid-cols-3 gap-2">
                                        {[
                                            [
                                                "Active demos",
                                                memberInsights.demo.activeUsers,
                                            ],
                                            [
                                                "Expired",
                                                memberInsights.demo
                                                    .expiredUsers,
                                            ],
                                            [
                                                "Converted",
                                                memberInsights.demo
                                                    .convertedUsers,
                                            ],
                                        ].map(([label, value]) => (
                                            <div
                                                key={label}
                                                className="bg-muted/30 rounded-lg px-3 py-2.5 text-center"
                                            >
                                                <p className="text-base font-semibold tabular-nums">
                                                    {value}
                                                </p>
                                                <p className="text-muted-foreground mt-0.5 text-[10px]">
                                                    {label}
                                                </p>
                                            </div>
                                        ))}
                                    </div>
                                </div>

                                <div className="border-border/60 bg-card rounded-xl border p-5 shadow-sm sm:p-6 lg:col-span-2">
                                    <div className="mb-5">
                                        <p className="text-foreground text-sm font-semibold">
                                            Account mix
                                        </p>
                                        <p className="text-muted-foreground mt-0.5 text-xs">
                                            Actual share of members by role.
                                        </p>
                                    </div>

                                    <div className="bg-muted flex h-3 overflow-hidden rounded-full">
                                        {memberInsights.roles.map((role) => {
                                            const share =
                                                (role.count /
                                                    Math.max(
                                                        1,
                                                        memberInsights.summary
                                                            .totalMembers,
                                                    )) *
                                                100;

                                            return (
                                                <div
                                                    key={role.role}
                                                    className={`h-full min-w-0 ${
                                                        role.role === "admin"
                                                            ? "bg-rose-500"
                                                            : role.role ===
                                                                "premium"
                                                              ? "bg-amber-500"
                                                              : "bg-slate-400"
                                                    }`}
                                                    style={{
                                                        width: `${share}%`,
                                                    }}
                                                    title={`${role.role}: ${role.count} (${Math.round(share)}%)`}
                                                />
                                            );
                                        })}
                                    </div>

                                    <div className="mt-5 space-y-2.5">
                                        {memberInsights.roles.map((role) => {
                                            const share = Math.round(
                                                (role.count /
                                                    Math.max(
                                                        1,
                                                        memberInsights.summary
                                                            .totalMembers,
                                                    )) *
                                                    100,
                                            );

                                            return (
                                                <div
                                                    key={role.role}
                                                    className="border-border/50 flex items-center gap-3 rounded-lg border px-3 py-3"
                                                >
                                                    <span
                                                        className={`h-2.5 w-2.5 shrink-0 rounded-full ${
                                                            role.role ===
                                                            "admin"
                                                                ? "bg-rose-500"
                                                                : role.role ===
                                                                    "premium"
                                                                  ? "bg-amber-500"
                                                                  : "bg-slate-400"
                                                        }`}
                                                    />
                                                    <div className="min-w-0 flex-1">
                                                        {getRoleBadge(
                                                            role.role,
                                                        )}
                                                    </div>
                                                    <span className="text-muted-foreground text-xs tabular-nums">
                                                        {share}%
                                                    </span>
                                                    <span className="min-w-8 text-right text-sm font-semibold tabular-nums">
                                                        {role.count}
                                                    </span>
                                                </div>
                                            );
                                        })}
                                    </div>

                                    <div className="border-border/50 mt-5 border-t pt-5">
                                        <div className="flex items-end justify-between gap-3">
                                            <div>
                                                <p className="text-muted-foreground text-[10px] font-medium uppercase">
                                                    Activated members
                                                </p>
                                                <p className="mt-1 text-2xl font-semibold tabular-nums">
                                                    {
                                                        memberInsights.summary
                                                            .usersWithMonitors
                                                    }
                                                </p>
                                            </div>
                                            <p className="text-muted-foreground pb-1 text-xs tabular-nums">
                                                {
                                                    memberInsights.summary
                                                        .activationRate
                                                }
                                                % of total
                                            </p>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            <div className="border-border/60 bg-card overflow-hidden rounded-xl border shadow-sm">
                                <div className="border-border/50 flex items-start justify-between gap-4 border-b px-5 py-4 sm:px-6">
                                    <div>
                                        <p className="text-foreground text-sm font-semibold">
                                            Newest members
                                        </p>
                                        <p className="text-muted-foreground mt-0.5 text-xs">
                                            Recent signups and their activation
                                            status.
                                        </p>
                                    </div>
                                    <Badge
                                        variant="outline"
                                        className="rounded-full px-2.5 text-[10px]"
                                    >
                                        {memberInsights.recentMembers.length}{" "}
                                        latest
                                    </Badge>
                                </div>
                                {memberInsights.recentMembers.length > 0 ? (
                                    <div className="bg-border/50 grid gap-px sm:grid-cols-2 xl:grid-cols-4">
                                        {memberInsights.recentMembers.map(
                                            (member) => {
                                                const memberLabel =
                                                    member.name ??
                                                    member.email ??
                                                    "Unknown member";

                                                return (
                                                    <div
                                                        key={member.id}
                                                        className="bg-card hover:bg-muted/20 min-w-0 p-4 transition-colors"
                                                    >
                                                        <div className="flex items-start gap-3">
                                                            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-sky-500/20 to-violet-500/20 text-xs font-semibold text-sky-700 dark:text-sky-300">
                                                                {memberLabel
                                                                    .charAt(0)
                                                                    .toUpperCase()}
                                                            </span>
                                                            <div className="min-w-0 flex-1">
                                                                <p className="truncate text-sm font-medium">
                                                                    {member.name ??
                                                                        "Unknown member"}
                                                                </p>
                                                                <p className="text-muted-foreground truncate text-[11px]">
                                                                    {member.email ??
                                                                        "No email"}
                                                                </p>
                                                            </div>
                                                        </div>
                                                        <div className="mt-4 flex flex-wrap items-center gap-1.5">
                                                            {getRoleBadge(
                                                                member.role,
                                                            )}
                                                            <Badge
                                                                variant="outline"
                                                                className={`rounded-md text-[9px] ${
                                                                    member.monitorCount >
                                                                    0
                                                                        ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                                                                        : "text-muted-foreground"
                                                                }`}
                                                            >
                                                                {member.monitorCount >
                                                                0
                                                                    ? `${member.monitorCount} monitor${member.monitorCount === 1 ? "" : "s"}`
                                                                    : "Not activated"}
                                                            </Badge>
                                                        </div>
                                                        <p className="text-muted-foreground mt-3 text-[10px] tabular-nums">
                                                            Joined{" "}
                                                            {formatCreatedAt(
                                                                member.createdAt
                                                                    ? new Date(
                                                                          member.createdAt,
                                                                      )
                                                                    : null,
                                                            )}
                                                        </p>
                                                    </div>
                                                );
                                            },
                                        )}
                                    </div>
                                ) : (
                                    <div className="text-muted-foreground px-6 py-10 text-center text-sm">
                                        No recent members with a known signup
                                        date.
                                    </div>
                                )}
                            </div>
                        </>
                    ) : null}
                </div>
            ) : null}

            {activeTab === "monitors" ? (
                <div className="space-y-4">
                    <div
                        className="border-border/60 bg-card rounded-lg border p-5"
                        data-testid="inactive-member-automation"
                    >
                        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                            <div className="flex items-start gap-3">
                                <div className="bg-muted text-muted-foreground flex size-10 shrink-0 items-center justify-center rounded-lg">
                                    <TimerReset className="size-5" />
                                </div>
                                <div>
                                    <div className="flex flex-wrap items-center gap-2">
                                        <p className="text-sm font-semibold">
                                            Inactive Member Automation
                                        </p>
                                        <Badge
                                            variant={
                                                inactivePolicyState.policy
                                                    .enabled
                                                    ? "default"
                                                    : "secondary"
                                            }
                                            className="rounded-md text-[10px] uppercase"
                                        >
                                            {inactivePolicyState.policy.enabled
                                                ? inactivePolicyState.status ===
                                                  "active"
                                                    ? "Worker confirmed"
                                                    : "Confirmation pending"
                                                : "Disabled"}
                                        </Badge>
                                    </div>
                                    <p className="text-muted-foreground mt-1 max-w-2xl text-xs leading-5">
                                        Pause abandoned monitors without
                                        affecting members who keep Vintrack open
                                        and active. Admin accounts are always
                                        excluded.
                                    </p>
                                </div>
                            </div>
                            <label className="border-border/60 bg-background/50 flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 text-sm font-medium">
                                <input
                                    type="checkbox"
                                    checked={inactivePolicyDraft.enabled}
                                    onChange={(event) =>
                                        setInactivePolicyDraft((current) => ({
                                            ...current,
                                            enabled: event.target.checked,
                                        }))
                                    }
                                    className="size-4 accent-current"
                                />
                                Enable automation
                            </label>
                        </div>

                        <div className="mt-5 grid gap-4 xl:grid-cols-[1fr_1fr_1.2fr]">
                            <div>
                                <Label className="text-xs">
                                    Inactive after
                                </Label>
                                <div className="mt-2 grid grid-cols-[1fr_1.2fr] gap-2">
                                    <Input
                                        type="number"
                                        min={1}
                                        value={inactivePolicyDraft.duration}
                                        onChange={(event) =>
                                            setInactivePolicyDraft(
                                                (current) => ({
                                                    ...current,
                                                    duration: Number(
                                                        event.target.value,
                                                    ),
                                                }),
                                            )
                                        }
                                    />
                                    <select
                                        className="border-input bg-background h-9 rounded-md border px-3 text-sm"
                                        value={inactivePolicyDraft.durationUnit}
                                        onChange={(event) =>
                                            setInactivePolicyDraft(
                                                (current) => ({
                                                    ...current,
                                                    durationUnit: event.target
                                                        .value as InactivityDurationUnit,
                                                }),
                                            )
                                        }
                                    >
                                        <option value="days">Days</option>
                                        <option value="weeks">Weeks</option>
                                        <option value="months">Months</option>
                                    </select>
                                </div>
                            </div>
                            <div>
                                <Label className="text-xs">Monitor scope</Label>
                                <select
                                    className="border-input bg-background mt-2 h-9 w-full rounded-md border px-3 text-sm"
                                    value={inactivePolicyDraft.monitorScope}
                                    onChange={(event) =>
                                        setInactivePolicyDraft((current) => ({
                                            ...current,
                                            monitorScope: event.target
                                                .value as InactivityMonitorScope,
                                        }))
                                    }
                                >
                                    <option value="free_proxy">
                                        Free Proxy Pool only
                                    </option>
                                    <option value="all">All monitors</option>
                                </select>
                            </div>
                            <div>
                                <Label className="text-xs">Member roles</Label>
                                <div className="mt-2 flex h-9 gap-2">
                                    {(["free", "premium"] as const).map(
                                        (role) => (
                                            <label
                                                key={role}
                                                className="border-input bg-background flex flex-1 cursor-pointer items-center gap-2 rounded-md border px-3 text-sm capitalize"
                                            >
                                                <input
                                                    type="checkbox"
                                                    checked={inactivePolicyDraft.roles.includes(
                                                        role,
                                                    )}
                                                    onChange={(event) =>
                                                        setInactivePolicyDraft(
                                                            (current) => ({
                                                                ...current,
                                                                roles: event
                                                                    .target
                                                                    .checked
                                                                    ? [
                                                                          ...current.roles,
                                                                          role,
                                                                      ]
                                                                    : current.roles.filter(
                                                                          (
                                                                              value,
                                                                          ) =>
                                                                              value !==
                                                                              role,
                                                                      ),
                                                            }),
                                                        )
                                                    }
                                                />
                                                {role}
                                            </label>
                                        ),
                                    )}
                                </div>
                            </div>
                        </div>

                        <div className="border-border/60 bg-muted/20 mt-4 flex flex-col gap-3 rounded-lg border px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                            <div className="text-xs">
                                <p className="font-medium">
                                    Current impact:{" "}
                                    {inactivePolicyPreview.memberCount} member
                                    {inactivePolicyPreview.memberCount === 1
                                        ? ""
                                        : "s"}{" "}
                                    · {inactivePolicyPreview.monitorCount}{" "}
                                    active monitor
                                    {inactivePolicyPreview.monitorCount === 1
                                        ? ""
                                        : "s"}
                                </p>
                                <p className="text-muted-foreground mt-1">
                                    {inactivePolicyState.inactivityPausedCount}{" "}
                                    currently paused · Last evaluation:{" "}
                                    {inactivePolicyState.runtime
                                        ? formatMetricDate(
                                              new Date(
                                                  inactivePolicyState.runtime
                                                      .lastEvaluatedAt,
                                              ),
                                          )
                                        : "No worker confirmation"}
                                </p>
                            </div>
                            <div className="flex gap-2">
                                <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    onClick={refreshInactivePolicyPreview}
                                >
                                    Preview impact
                                </Button>
                                <Button
                                    type="button"
                                    size="sm"
                                    disabled={isSavingInactivePolicy}
                                    onClick={handleSaveInactivePolicy}
                                >
                                    {isSavingInactivePolicy
                                        ? "Saving..."
                                        : "Save automation"}
                                </Button>
                            </div>
                        </div>
                    </div>

                    <div className="border-border/60 bg-card overflow-hidden rounded-lg border">
                        <div className="border-border/60 flex flex-col gap-4 border-b px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
                            <div>
                                <div className="flex flex-wrap items-center gap-2">
                                    <p className="text-foreground text-sm font-semibold">
                                        Active Member Monitors
                                    </p>
                                    <Badge className="bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">
                                        {runningMonitors} running
                                    </Badge>
                                </div>
                                <p className="text-muted-foreground mt-1 text-xs">
                                    {activeMonitorsLoaded
                                        ? `${activeMonitorMembers.length} member${activeMonitorMembers.length === 1 ? "" : "s"} currently have active monitors.`
                                        : activeMonitorsLoadFailed
                                          ? "Running monitor details are currently unavailable."
                                          : "Loading running monitor details..."}
                                </p>
                            </div>
                            <div className="flex w-full flex-col gap-2 sm:flex-row lg:max-w-xl">
                                <div className="relative flex-1">
                                    <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" />
                                    <Input
                                        value={monitorSearchQuery}
                                        onChange={(event) => {
                                            setMonitorSearchQuery(
                                                event.target.value,
                                            );
                                            setCollapsedMonitorSearchUserIds(
                                                new Set(),
                                            );
                                        }}
                                        placeholder="Search members, monitors, queries or regions..."
                                        aria-label="Search running monitors"
                                        className="h-10 pl-9"
                                    />
                                </div>
                                {normalizedMonitorQuery ? (
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        className="h-10 self-start px-3 text-xs sm:self-auto"
                                        onClick={() => {
                                            setMonitorSearchQuery("");
                                            setCollapsedMonitorSearchUserIds(
                                                new Set(),
                                            );
                                        }}
                                    >
                                        Clear search
                                    </Button>
                                ) : null}
                            </div>
                        </div>

                        {!activeMonitorsLoaded ? (
                            <div className="px-5 py-14 text-center">
                                <div className="bg-muted text-muted-foreground mx-auto flex h-11 w-11 items-center justify-center rounded-full">
                                    {activeMonitorsLoadFailed ? (
                                        <AlertTriangle className="h-5 w-5" />
                                    ) : (
                                        <Activity className="h-5 w-5 animate-pulse" />
                                    )}
                                </div>
                                <p className="text-foreground mt-3 text-sm font-medium">
                                    {activeMonitorsLoadFailed
                                        ? "Running monitors could not be loaded"
                                        : "Loading running monitors"}
                                </p>
                                <p className="text-muted-foreground mt-1 text-xs">
                                    {activeMonitorsLoadFailed
                                        ? "The rest of the admin panel remains available."
                                        : "Monitor details load separately to keep the admin panel fast."}
                                </p>
                                {activeMonitorsLoadFailed ? (
                                    <Button
                                        type="button"
                                        variant="outline"
                                        size="sm"
                                        className="mt-4"
                                        onClick={loadActiveMonitors}
                                        disabled={isLoadingActiveMonitors}
                                    >
                                        Retry
                                    </Button>
                                ) : null}
                            </div>
                        ) : filteredActiveMonitorMembers.length > 0 ? (
                            <div className="divide-border/60 divide-y">
                                {filteredActiveMonitorMembers.map(
                                    ({ user, monitors }) => {
                                        const isExpanded =
                                            normalizedMonitorQuery
                                                ? !collapsedMonitorSearchUserIds.has(
                                                      user.id,
                                                  )
                                                : expandedMonitorUserIds.has(
                                                      user.id,
                                                  );
                                        const contentId = `active-monitors-${user.id}`;

                                        return (
                                            <section
                                                key={user.id}
                                                data-testid="active-monitor-member"
                                            >
                                                <button
                                                    type="button"
                                                    data-testid="active-monitor-member-toggle"
                                                    aria-expanded={isExpanded}
                                                    aria-controls={contentId}
                                                    className="bg-muted/20 hover:bg-muted/40 flex w-full items-center justify-between gap-4 px-5 py-3 text-left transition-colors"
                                                    onClick={() =>
                                                        toggleMonitorMember(
                                                            user.id,
                                                        )
                                                    }
                                                >
                                                    <span className="flex min-w-0 items-center gap-3">
                                                        {user.image ? (
                                                            <img
                                                                src={user.image}
                                                                alt=""
                                                                className="h-9 w-9 shrink-0 rounded-full object-cover"
                                                            />
                                                        ) : (
                                                            <span className="bg-muted text-muted-foreground flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-bold">
                                                                {user.name?.[0]?.toUpperCase() ??
                                                                    "?"}
                                                            </span>
                                                        )}
                                                        <span className="min-w-0">
                                                            <span className="flex flex-wrap items-center gap-2">
                                                                <span className="text-foreground truncate text-sm font-semibold">
                                                                    {user.name ??
                                                                        "Unknown"}
                                                                </span>
                                                                {getRoleBadge(
                                                                    user.role,
                                                                )}
                                                            </span>
                                                            <span className="text-muted-foreground block truncate text-xs">
                                                                {user.email ??
                                                                    "No email"}
                                                            </span>
                                                        </span>
                                                    </span>
                                                    <span className="flex shrink-0 items-center gap-2">
                                                        <Badge
                                                            variant="outline"
                                                            className="rounded-md"
                                                        >
                                                            {monitors.length}{" "}
                                                            monitor
                                                            {monitors.length ===
                                                            1
                                                                ? ""
                                                                : "s"}
                                                        </Badge>
                                                        <span className="text-muted-foreground hidden text-xs sm:inline">
                                                            {isExpanded
                                                                ? "Hide"
                                                                : "Show"}
                                                        </span>
                                                        <ChevronDown
                                                            className={`text-muted-foreground h-4 w-4 transition-transform ${
                                                                isExpanded
                                                                    ? "rotate-180"
                                                                    : ""
                                                            }`}
                                                        />
                                                    </span>
                                                </button>
                                                {isExpanded ? (
                                                    <div
                                                        id={contentId}
                                                        data-testid="active-monitor-content"
                                                        className="border-border/60 border-t"
                                                    >
                                                        <div className="border-border/40 bg-muted/10 flex items-center justify-between gap-3 border-b px-5 py-2.5">
                                                            <p className="text-muted-foreground text-xs">
                                                                {
                                                                    monitors.length
                                                                }{" "}
                                                                currently
                                                                running
                                                            </p>
                                                            <Button
                                                                variant="ghost"
                                                                size="sm"
                                                                className="h-8 px-2 text-xs"
                                                                onClick={() =>
                                                                    openUserDetails(
                                                                        user,
                                                                    )
                                                                }
                                                            >
                                                                Member details
                                                                <ChevronRight className="ml-1 h-3.5 w-3.5" />
                                                            </Button>
                                                        </div>
                                                        <div className="divide-border/40 divide-y">
                                                            {monitors.map(
                                                                (monitor) => (
                                                                    <div
                                                                        key={
                                                                            monitor.id
                                                                        }
                                                                        data-testid="active-monitor-row"
                                                                        className="grid gap-3 px-5 py-4 md:grid-cols-2 lg:grid-cols-[minmax(220px,1.4fr)_minmax(170px,1fr)_minmax(190px,1fr)_auto] lg:items-center"
                                                                    >
                                                                        <div className="min-w-0">
                                                                            <div className="flex items-center gap-2">
                                                                                <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-500" />
                                                                                <p className="text-foreground truncate text-sm font-medium">
                                                                                    {
                                                                                        monitor.name
                                                                                    }
                                                                                </p>
                                                                                <Badge
                                                                                    variant="outline"
                                                                                    className="shrink-0 rounded-md text-[10px]"
                                                                                >
                                                                                    #
                                                                                    {
                                                                                        monitor.id
                                                                                    }
                                                                                </Badge>
                                                                            </div>
                                                                            <p className="text-muted-foreground mt-1 truncate pl-4 text-xs">
                                                                                Query:{" "}
                                                                                {
                                                                                    monitor.query
                                                                                }
                                                                            </p>
                                                                        </div>

                                                                        <div className="text-muted-foreground space-y-1 text-xs">
                                                                            <p className="text-foreground inline-flex items-center gap-1.5 font-medium">
                                                                                <Globe className="h-3.5 w-3.5" />
                                                                                {getRegionLabel(
                                                                                    monitor.region,
                                                                                )}
                                                                            </p>
                                                                            <p className="truncate">
                                                                                {monitorProxyLabel(
                                                                                    monitor,
                                                                                )}
                                                                            </p>
                                                                        </div>

                                                                        <div className="text-muted-foreground flex flex-wrap gap-x-3 gap-y-1 text-xs lg:block lg:space-y-1">
                                                                            <p className="inline-flex items-center gap-1.5">
                                                                                <Clock3 className="h-3.5 w-3.5" />
                                                                                {
                                                                                    monitor.query_delay_ms
                                                                                }{" "}
                                                                                ms
                                                                                delay
                                                                            </p>
                                                                            <p className="inline-flex items-center gap-1.5">
                                                                                <Boxes className="h-3.5 w-3.5" />
                                                                                {
                                                                                    monitor
                                                                                        ._count
                                                                                        .items
                                                                                }{" "}
                                                                                items
                                                                            </p>
                                                                            <p className="inline-flex items-center gap-1.5">
                                                                                <Webhook className="h-3.5 w-3.5" />
                                                                                {[
                                                                                    monitor.discord_configured &&
                                                                                    monitor.webhook_active
                                                                                        ? "Discord"
                                                                                        : null,
                                                                                    monitor.telegram_active
                                                                                        ? "Telegram"
                                                                                        : null,
                                                                                ]
                                                                                    .filter(
                                                                                        Boolean,
                                                                                    )
                                                                                    .join(
                                                                                        " + ",
                                                                                    ) ||
                                                                                    "Notifications off"}
                                                                            </p>
                                                                        </div>

                                                                        <Button
                                                                            variant="outline"
                                                                            size="sm"
                                                                            className="h-8 justify-self-start text-xs text-amber-700 hover:text-amber-800 md:justify-self-end"
                                                                            onClick={() =>
                                                                                handleStopSingleMonitor(
                                                                                    user.id,
                                                                                    monitor.id,
                                                                                )
                                                                            }
                                                                            disabled={
                                                                                stoppingMonitorId ===
                                                                                monitor.id
                                                                            }
                                                                        >
                                                                            <PauseCircle className="mr-1.5 h-3.5 w-3.5" />
                                                                            Stop
                                                                        </Button>
                                                                    </div>
                                                                ),
                                                            )}
                                                        </div>
                                                    </div>
                                                ) : null}
                                            </section>
                                        );
                                    },
                                )}
                            </div>
                        ) : (
                            <div className="px-5 py-14 text-center">
                                <div className="bg-muted text-muted-foreground mx-auto flex h-11 w-11 items-center justify-center rounded-full">
                                    {normalizedMonitorQuery ? (
                                        <Search className="h-5 w-5" />
                                    ) : (
                                        <Monitor className="h-5 w-5" />
                                    )}
                                </div>
                                <p className="text-foreground mt-3 text-sm font-medium">
                                    {normalizedMonitorQuery
                                        ? "No running monitors match your search"
                                        : "No monitors are currently running"}
                                </p>
                                <p className="text-muted-foreground mt-1 text-xs">
                                    {normalizedMonitorQuery
                                        ? "Try another member, monitor name, query, or region."
                                        : "Active member monitors will appear here automatically."}
                                </p>
                            </div>
                        )}

                        {activeMonitorsLoaded &&
                        normalizedMonitorQuery &&
                        filteredActiveMonitorMembers.length > 0 ? (
                            <div className="border-border/60 text-muted-foreground border-t px-5 py-3 text-xs">
                                Showing {filteredActiveMonitorCount} running
                                monitor
                                {filteredActiveMonitorCount === 1
                                    ? ""
                                    : "s"}{" "}
                                across {filteredActiveMonitorMembers.length}{" "}
                                member
                                {filteredActiveMonitorMembers.length === 1
                                    ? ""
                                    : "s"}
                            </div>
                        ) : null}
                    </div>
                </div>
            ) : null}

            {activeTab === "users" ? (
                <div className="border-border/60 bg-card overflow-hidden rounded-lg border">
                    <div className="border-border/60 flex flex-col gap-3 border-b px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
                        <div>
                            <p className="text-foreground text-sm font-semibold">
                                Team Members
                            </p>
                            <p className="text-muted-foreground text-xs">
                                {userPagination.total} matching users
                            </p>
                        </div>
                        <div className="flex w-full flex-col gap-2 sm:flex-row lg:max-w-xl">
                            <div className="relative flex-1">
                                <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" />
                                <Input
                                    value={searchQuery}
                                    onChange={(event) => {
                                        setSearchQuery(event.target.value);
                                        setUserPage(1);
                                    }}
                                    placeholder="Search by name, email or role..."
                                    className="h-10 pl-9"
                                />
                            </div>
                            {normalizedQuery ? (
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-10 self-start px-3 text-xs sm:self-auto"
                                    onClick={() => setSearchQuery("")}
                                >
                                    Clear search
                                </Button>
                            ) : null}
                        </div>
                    </div>
                    <div className="overflow-x-auto">
                        <table className="w-full">
                            <thead className="bg-muted/30">
                                <tr className="border-border border-b">
                                    <th className="text-muted-foreground px-5 py-3 text-left text-[11px] font-medium tracking-wider uppercase">
                                        User
                                    </th>
                                    <th className="text-muted-foreground px-5 py-3 text-left text-[11px] font-medium tracking-wider uppercase">
                                        Role
                                    </th>
                                    <th className="text-muted-foreground px-5 py-3 text-center text-[11px] font-medium tracking-wider uppercase">
                                        Runtime
                                    </th>
                                    <th className="text-muted-foreground px-5 py-3 text-center text-[11px] font-medium tracking-wider uppercase">
                                        Monitors
                                    </th>
                                    <th className="text-muted-foreground px-5 py-3 text-center text-[11px] font-medium tracking-wider uppercase">
                                        24h Activity
                                    </th>
                                    <th className="text-muted-foreground px-5 py-3 text-center text-[11px] font-medium tracking-wider uppercase">
                                        Limit
                                    </th>
                                    <th className="text-muted-foreground px-5 py-3 text-center text-[11px] font-medium tracking-wider uppercase">
                                        Proxy Groups
                                    </th>
                                    <th className="text-muted-foreground px-5 py-3 text-right text-[11px] font-medium tracking-wider uppercase">
                                        Actions
                                    </th>
                                </tr>
                            </thead>
                            <tbody className="divide-border/50 divide-y">
                                {paginatedUsers.map((user) => {
                                    const effectiveLimit =
                                        getEffectiveLimit(user);
                                    return (
                                        <tr
                                            key={user.id}
                                            className="hover:bg-muted/40 cursor-pointer transition-colors"
                                            onClick={() =>
                                                openUserDetails(user)
                                            }
                                        >
                                            <td className="px-5 py-3.5">
                                                <div className="flex items-center gap-3">
                                                    {user.image ? (
                                                        <img
                                                            src={user.image}
                                                            alt=""
                                                            className="h-10 w-10 rounded-full object-cover"
                                                        />
                                                    ) : (
                                                        <div className="bg-muted text-muted-foreground flex h-10 w-10 items-center justify-center rounded-full text-xs font-bold">
                                                            {user.name?.[0]?.toUpperCase() ??
                                                                "?"}
                                                        </div>
                                                    )}
                                                    <div className="min-w-0">
                                                        <p className="text-foreground truncate text-sm font-medium">
                                                            {user.name ??
                                                                "Unknown"}
                                                        </p>
                                                        <p className="text-muted-foreground truncate text-xs">
                                                            {user.email ?? "—"}
                                                        </p>
                                                    </div>
                                                </div>
                                            </td>
                                            <td className="px-5 py-3.5">
                                                {getRoleBadge(user.role)}
                                            </td>
                                            <td className="px-5 py-3.5 text-center">
                                                <div className="flex flex-col items-center gap-1">
                                                    <span className="text-foreground inline-flex items-center gap-1 text-sm font-medium tabular-nums">
                                                        <Clock3 className="text-muted-foreground h-3.5 w-3.5" />
                                                        {formatRuntime(
                                                            user.metrics
                                                                .totalRuntimeSeconds,
                                                        )}
                                                    </span>
                                                    <span className="text-muted-foreground text-[10px] uppercase">
                                                        {user.metrics
                                                            .oldestActiveSince
                                                            ? `${formatRuntime((nowMs - new Date(user.metrics.oldestActiveSince).getTime()) / 1000)} longest open`
                                                            : "No open session"}
                                                    </span>
                                                </div>
                                            </td>
                                            <td className="px-5 py-3.5 text-center">
                                                <div className="flex flex-col items-center gap-1">
                                                    <span className="text-foreground inline-flex items-center gap-1 text-sm">
                                                        <Monitor className="text-muted-foreground h-3.5 w-3.5" />
                                                        {user._count.monitors}
                                                    </span>
                                                    <span className="text-muted-foreground text-[10px] uppercase">
                                                        {
                                                            user.metrics
                                                                .runningMonitors
                                                        }{" "}
                                                        running
                                                    </span>
                                                </div>
                                            </td>
                                            <td className="px-5 py-3.5 text-center">
                                                <div className="flex flex-col items-center gap-1">
                                                    <span className="text-foreground inline-flex items-center gap-1 text-sm">
                                                        <Activity className="text-muted-foreground h-3.5 w-3.5" />
                                                        {user.metrics.checks24h}{" "}
                                                        checks
                                                    </span>
                                                    <span
                                                        className={`text-[10px] uppercase ${
                                                            user.metrics
                                                                .failedChecks24h >
                                                            0
                                                                ? "text-amber-600 dark:text-amber-400"
                                                                : "text-muted-foreground"
                                                        }`}
                                                    >
                                                        {
                                                            user.metrics
                                                                .newItems24h
                                                        }{" "}
                                                        items /{" "}
                                                        {
                                                            user.metrics
                                                                .failedChecks24h
                                                        }{" "}
                                                        failed
                                                    </span>
                                                </div>
                                            </td>
                                            <td className="px-5 py-3.5 text-center">
                                                <div className="flex flex-col items-center gap-1">
                                                    <span className="text-foreground text-sm">
                                                        {formatLimit(
                                                            effectiveLimit.value,
                                                        )}
                                                    </span>
                                                    <span className="text-muted-foreground text-[10px] uppercase">
                                                        {effectiveLimit.source}
                                                    </span>
                                                </div>
                                            </td>
                                            <td className="px-5 py-3.5 text-center">
                                                <span className="text-foreground inline-flex items-center gap-1 text-sm">
                                                    <Globe className="text-muted-foreground h-3.5 w-3.5" />
                                                    {user._count.proxy_groups}
                                                </span>
                                            </td>
                                            <td className="px-5 py-3.5 text-right">
                                                <div className="flex items-center justify-end gap-2">
                                                    {user.id ===
                                                    currentUserId ? (
                                                        <Badge
                                                            variant="outline"
                                                            className="rounded-full text-[10px] tracking-wide uppercase"
                                                        >
                                                            You
                                                        </Badge>
                                                    ) : (
                                                        <Button
                                                            variant="outline"
                                                            size="sm"
                                                            className="h-8 rounded-lg text-xs"
                                                            onClick={(
                                                                event,
                                                            ) => {
                                                                event.stopPropagation();
                                                                openRoleDialog(
                                                                    user,
                                                                );
                                                            }}
                                                        >
                                                            Change Role
                                                        </Button>
                                                    )}
                                                    <Button
                                                        variant="ghost"
                                                        size="sm"
                                                        className="text-muted-foreground h-8 rounded-lg px-2 text-xs"
                                                        onClick={(event) => {
                                                            event.stopPropagation();
                                                            openUserDetails(
                                                                user,
                                                            );
                                                        }}
                                                    >
                                                        Details
                                                        <ChevronRight className="ml-1 h-3.5 w-3.5" />
                                                    </Button>
                                                </div>
                                            </td>
                                        </tr>
                                    );
                                })}
                                {paginatedUsers.length === 0 ? (
                                    <tr>
                                        <td
                                            colSpan={8}
                                            className="px-5 py-12 text-center"
                                        >
                                            <div className="mx-auto flex max-w-sm flex-col items-center gap-2">
                                                <div className="bg-muted text-muted-foreground rounded-full p-3">
                                                    <Search className="h-5 w-5" />
                                                </div>
                                                <p className="text-foreground text-sm font-medium">
                                                    No users match your search
                                                </p>
                                                <p className="text-muted-foreground text-sm">
                                                    Try a different name, email
                                                    address, or role.
                                                </p>
                                            </div>
                                        </td>
                                    </tr>
                                ) : null}
                            </tbody>
                        </table>
                    </div>
                    <div className="border-border/60 flex flex-col gap-3 border-t px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                        <div className="text-muted-foreground text-xs">
                            Showing {shownUserStart}-{shownUserEnd} of{" "}
                            {userPagination.total} users
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                            <label className="text-muted-foreground flex items-center gap-2 text-xs">
                                Rows
                                <select
                                    value={usersPerPage}
                                    onChange={(event) => {
                                        setUsersPerPage(
                                            Number(
                                                event.target.value,
                                            ) as (typeof USER_PAGE_SIZES)[number],
                                        );
                                        setUserPage(1);
                                    }}
                                    className="border-input bg-background h-9 rounded-md border px-2 text-sm"
                                >
                                    {USER_PAGE_SIZES.map((size) => (
                                        <option key={size} value={size}>
                                            {size}
                                        </option>
                                    ))}
                                </select>
                            </label>
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="h-9 w-9 p-0"
                                onClick={() =>
                                    setUserPage((page) => Math.max(1, page - 1))
                                }
                                disabled={currentUserPage === 1}
                                aria-label="Previous user page"
                            >
                                <ChevronLeft className="h-4 w-4" />
                            </Button>
                            <span className="text-muted-foreground min-w-20 text-center text-xs">
                                Page {currentUserPage} / {totalUserPages}
                            </span>
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="h-9 w-9 p-0"
                                onClick={() =>
                                    setUserPage((page) =>
                                        Math.min(totalUserPages, page + 1),
                                    )
                                }
                                disabled={currentUserPage === totalUserPages}
                                aria-label="Next user page"
                            >
                                <ChevronRight className="h-4 w-4" />
                            </Button>
                        </div>
                    </div>
                </div>
            ) : null}

            {activeTab === "roles" ? (
                <>
                    <div className="grid gap-4 md:grid-cols-3">
                        {ROLES.map((role) => {
                            const count =
                                role.value === "free"
                                    ? freeUsers
                                    : role.value === "premium"
                                      ? premiumUsers
                                      : adminUsers;
                            const Icon = role.icon;

                            return (
                                <Card key={role.value} className="py-0">
                                    <CardHeader className="pt-3 pb-3">
                                        <div className="flex items-center justify-between">
                                            <CardDescription>
                                                {role.label}
                                            </CardDescription>
                                            <div className="bg-muted text-muted-foreground rounded-lg p-2">
                                                <Icon className="h-4 w-4" />
                                            </div>
                                        </div>
                                        <CardTitle className="text-3xl">
                                            {count}
                                        </CardTitle>
                                    </CardHeader>
                                    <CardContent className="text-muted-foreground pb-6 text-xs">
                                        {role.value === "free" &&
                                            "Standard accounts with personal proxy requirements."}
                                        {role.value === "premium" &&
                                            "Accounts with shared server proxy access."}
                                        {role.value === "admin" &&
                                            "Accounts with full dashboard and admin access."}
                                    </CardContent>
                                </Card>
                            );
                        })}
                    </div>

                    <div className="border-border/60 bg-card rounded-lg border p-5">
                        <div className="mb-4 flex items-center justify-between gap-3">
                            <div>
                                <p className="text-foreground text-sm font-semibold">
                                    Active Monitor Limits
                                </p>
                                <p className="text-muted-foreground text-xs">
                                    Empty values mean unlimited. Existing
                                    running monitors are not paused
                                    automatically.
                                </p>
                            </div>
                            <div className="bg-primary/10 text-primary rounded-lg p-2">
                                <Gauge className="h-4 w-4" />
                            </div>
                        </div>

                        <div className="grid gap-3 lg:grid-cols-4">
                            <div className="space-y-2">
                                <Label htmlFor="global-monitor-limit">
                                    Global default
                                </Label>
                                <div className="flex gap-2">
                                    <Input
                                        id="global-monitor-limit"
                                        type="number"
                                        min={0}
                                        value={globalLimitInput}
                                        onChange={(event) =>
                                            setGlobalLimitInput(
                                                event.target.value,
                                            )
                                        }
                                        placeholder="Unlimited"
                                    />
                                    <Button
                                        type="button"
                                        variant="outline"
                                        onClick={handleSaveGlobalLimit}
                                    >
                                        Save
                                    </Button>
                                </div>
                            </div>

                            {LIMIT_ROLES.map((role) => (
                                <div key={role.value} className="space-y-2">
                                    <Label
                                        htmlFor={`role-monitor-limit-${role.value}`}
                                    >
                                        {role.label}
                                    </Label>
                                    <div className="flex gap-2">
                                        <Input
                                            id={`role-monitor-limit-${role.value}`}
                                            type="number"
                                            min={0}
                                            value={
                                                roleLimitInputs[role.value] ??
                                                ""
                                            }
                                            onChange={(event) =>
                                                setRoleLimitInputs((prev) => ({
                                                    ...prev,
                                                    [role.value]:
                                                        event.target.value,
                                                }))
                                            }
                                            placeholder="Global"
                                        />
                                        <Button
                                            type="button"
                                            variant="outline"
                                            onClick={() =>
                                                handleSaveRoleLimit(role.value)
                                            }
                                        >
                                            Save
                                        </Button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>

                    <div className="border-border/60 bg-card rounded-lg border p-5">
                        <div className="mb-4 flex items-center justify-between gap-3">
                            <div>
                                <p className="text-foreground text-sm font-semibold">
                                    Running Free Proxy Monitor Limits
                                </p>
                                <p className="text-muted-foreground text-xs">
                                    Empty role values inherit the global
                                    default. Lowering a limit pauses the newest
                                    excess Free Proxy Pool monitors
                                    automatically.
                                </p>
                            </div>
                            <div className="bg-primary/10 text-primary rounded-lg p-2">
                                <Gauge className="h-4 w-4" />
                            </div>
                        </div>

                        <div className="grid gap-3 lg:grid-cols-4">
                            <div className="space-y-2">
                                <Label htmlFor="global-free-proxy-monitor-limit">
                                    Global default
                                </Label>
                                <div className="flex gap-2">
                                    <Input
                                        id="global-free-proxy-monitor-limit"
                                        type="number"
                                        min={0}
                                        value={globalFreeProxyLimitInput}
                                        onChange={(event) =>
                                            setGlobalFreeProxyLimitInput(
                                                event.target.value,
                                            )
                                        }
                                        placeholder="Unlimited"
                                    />
                                    <Button
                                        type="button"
                                        variant="outline"
                                        onClick={handleSaveGlobalFreeProxyLimit}
                                    >
                                        Save
                                    </Button>
                                </div>
                            </div>

                            {LIMIT_ROLES.map((role) => (
                                <div key={role.value} className="space-y-2">
                                    <Label
                                        htmlFor={`role-free-proxy-monitor-limit-${role.value}`}
                                    >
                                        {role.label}
                                    </Label>
                                    <div className="flex gap-2">
                                        <Input
                                            id={`role-free-proxy-monitor-limit-${role.value}`}
                                            type="number"
                                            min={0}
                                            value={
                                                roleFreeProxyLimitInputs[
                                                    role.value
                                                ] ?? ""
                                            }
                                            onChange={(event) =>
                                                setRoleFreeProxyLimitInputs(
                                                    (current) => ({
                                                        ...current,
                                                        [role.value]:
                                                            event.target.value,
                                                    }),
                                                )
                                            }
                                            placeholder="Global"
                                        />
                                        <Button
                                            type="button"
                                            variant="outline"
                                            onClick={() =>
                                                handleSaveRoleFreeProxyLimit(
                                                    role.value,
                                                )
                                            }
                                        >
                                            Save
                                        </Button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                </>
            ) : null}

            {activeTab === "logs" ? (
                <div className="space-y-4">
                    {operationsSummary ? (
                        <>
                            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                                {[
                                    {
                                        label: "Delivered (24h)",
                                        value: operationsSummary.sent,
                                        detail:
                                            operationsSummary.successRate ===
                                            null
                                                ? "No terminal deliveries"
                                                : `${operationsSummary.successRate.toFixed(2)}% success`,
                                    },
                                    {
                                        label: "Pending / retrying",
                                        value: operationsSummary.pending,
                                        detail: operationsSummary.oldestPendingAt
                                            ? `${operationsSummary.retrying} retrying · oldest ${formatMetricDate(operationsSummary.oldestPendingAt)}`
                                            : `${operationsSummary.retrying} waiting for retry`,
                                    },
                                    {
                                        label: "Failed (24h)",
                                        value: operationsSummary.failed,
                                        detail: "Terminal failures only",
                                    },
                                    {
                                        label: "Deduplicated (24h)",
                                        value: operationsSummary.deduplicated,
                                        detail: "Expected duplicate suppression",
                                    },
                                    {
                                        label: "Open proxy incidents",
                                        value: operationsSummary.proxyIncidents
                                            .open,
                                        detail: `${operationsSummary.proxyIncidents.brief} brief recoveries`,
                                    },
                                    {
                                        label: "Enrichment queue",
                                        value:
                                            operationsSummary.enrichment
                                                ?.queueAgeMs ?? 0,
                                        detail: operationsSummary.enrichment
                                            ? `${operationsSummary.enrichment.remoteP95Ms}ms remote p95 · ${operationsSummary.enrichment.timeouts} timeouts`
                                            : "Worker metrics not reported",
                                        suffix: "ms",
                                    },
                                    {
                                        label: "Enrichment cache",
                                        value:
                                            operationsSummary.enrichment
                                                ?.cacheHitRate ?? 0,
                                        detail: operationsSummary.enrichment
                                            ? `${operationsSummary.enrichment.cacheHits.toLocaleString()} hits · ${operationsSummary.enrichment.cacheMisses.toLocaleString()} misses`
                                            : "Worker metrics not reported",
                                        suffix: "%",
                                    },
                                    {
                                        label: "Notification latency",
                                        value:
                                            operationsSummary
                                                .notificationLatency.p95Ms ?? 0,
                                        detail: `p50 ${Math.round(operationsSummary.notificationLatency.p50Ms ?? 0)}ms · p99 ${Math.round(operationsSummary.notificationLatency.p99Ms ?? 0)}ms`,
                                        suffix: "ms p95",
                                    },
                                ].map((metric) => (
                                    <div
                                        key={metric.label}
                                        className="border-border/60 bg-card rounded-lg border px-4 py-3"
                                    >
                                        <p className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
                                            {metric.label}
                                        </p>
                                        <p className="text-foreground mt-1 text-2xl font-semibold">
                                            {metric.value.toLocaleString()}
                                            {"suffix" in metric && metric.suffix
                                                ? ` ${metric.suffix}`
                                                : ""}
                                        </p>
                                        <p className="text-muted-foreground mt-1 text-xs">
                                            {metric.detail}
                                        </p>
                                    </div>
                                ))}
                            </div>
                            <div className="border-border/60 bg-card grid gap-4 rounded-lg border p-4 lg:grid-cols-3">
                                <div>
                                    <p className="text-foreground text-sm font-semibold">
                                        Channel health
                                    </p>
                                    <div className="mt-3 space-y-2">
                                        {["discord", "telegram"].map(
                                            (channel) => {
                                                const health = operationsSummary
                                                    .byChannel[channel] ?? {
                                                    sent: 0,
                                                    failed: 0,
                                                    deduplicated: 0,
                                                };
                                                return (
                                                    <div
                                                        key={channel}
                                                        className="bg-muted/30 flex items-center justify-between rounded-md px-3 py-2 text-xs"
                                                    >
                                                        <span className="font-medium capitalize">
                                                            {channel}
                                                        </span>
                                                        <span className="text-muted-foreground">
                                                            {health.sent.toLocaleString()}{" "}
                                                            sent ·{" "}
                                                            {health.failed.toLocaleString()}{" "}
                                                            failed
                                                        </span>
                                                    </div>
                                                );
                                            },
                                        )}
                                    </div>
                                </div>
                                <div>
                                    <p className="text-foreground text-sm font-semibold">
                                        Top failure reasons
                                    </p>
                                    <div className="mt-3 space-y-2">
                                        {operationsSummary.topFailures.length >
                                        0 ? (
                                            operationsSummary.topFailures
                                                .slice(0, 4)
                                                .map((failure) => (
                                                    <div
                                                        key={`${failure.channel}-${failure.reasonCode}`}
                                                        className="bg-muted/30 flex items-center justify-between rounded-md px-3 py-2 text-xs"
                                                    >
                                                        <span>
                                                            {failure.channel} ·{" "}
                                                            {failure.reasonCode}
                                                        </span>
                                                        <span className="font-semibold">
                                                            {failure.count.toLocaleString()}
                                                        </span>
                                                    </div>
                                                ))
                                        ) : (
                                            <p className="text-muted-foreground text-xs">
                                                No terminal delivery failures in
                                                this window.
                                            </p>
                                        )}
                                    </div>
                                </div>
                                <div>
                                    <p className="text-foreground text-sm font-semibold">
                                        Brief proxy recoveries
                                    </p>
                                    <div className="mt-3 space-y-2">
                                        {operationsSummary.proxyIncidents
                                            .briefGroups.length > 0 ? (
                                            operationsSummary.proxyIncidents.briefGroups
                                                .slice(0, 4)
                                                .map((group) => (
                                                    <div
                                                        key={`${group.domain}-${group.proxySource}`}
                                                        className="bg-muted/30 flex items-center justify-between rounded-md px-3 py-2 text-xs"
                                                    >
                                                        <span>
                                                            {group.domain} ·{" "}
                                                            {group.proxySource}
                                                        </span>
                                                        <span className="font-semibold">
                                                            {group.incidents.toLocaleString()}{" "}
                                                            ·{" "}
                                                            {group.waits.toLocaleString()}{" "}
                                                            waits
                                                        </span>
                                                    </div>
                                                ))
                                        ) : (
                                            <p className="text-muted-foreground text-xs">
                                                No brief proxy recoveries in
                                                this window.
                                            </p>
                                        )}
                                    </div>
                                </div>
                                <p className="text-muted-foreground text-[11px] lg:col-span-3">
                                    Tracked since{" "}
                                    {operationsSummary.trackedSince
                                        ? formatMetricDate(
                                              new Date(
                                                  operationsSummary.trackedSince,
                                              ),
                                          )
                                        : "deployment"}
                                    . Dispatcher heartbeat{" "}
                                    {operationsSummary.dispatcherHeartbeat
                                        ? formatMetricDate(
                                              new Date(
                                                  operationsSummary.dispatcherHeartbeat,
                                              ),
                                          )
                                        : "not reported yet"}
                                    .
                                </p>
                            </div>
                        </>
                    ) : null}

                    <div className="border-border/60 bg-card overflow-hidden rounded-lg border">
                        <div className="border-border/60 flex flex-col gap-1 border-b px-5 py-4">
                            <div className="flex flex-wrap items-center justify-between gap-3">
                                <div>
                                    <p className="text-foreground text-sm font-semibold">
                                        Operations
                                    </p>
                                    <p className="text-muted-foreground text-xs">
                                        Actual failures, relevant incidents and
                                        audit activity without
                                        successful-delivery noise.
                                    </p>
                                </div>
                                <div className="flex flex-wrap gap-1">
                                    {(
                                        [
                                            "all",
                                            "delivery",
                                            "proxy",
                                            "monitor",
                                            "audit",
                                        ] as AdminOperationFilter[]
                                    ).map((filter) => (
                                        <Button
                                            key={filter}
                                            type="button"
                                            size="sm"
                                            variant={
                                                operationFilter === filter
                                                    ? "secondary"
                                                    : "ghost"
                                            }
                                            className="h-7 capitalize"
                                            onClick={() => {
                                                setLogsLoaded(false);
                                                loadAdminLogs(filter);
                                            }}
                                        >
                                            {filter}
                                        </Button>
                                    ))}
                                </div>
                            </div>
                        </div>
                        {isLoadingLogs ? (
                            <div className="text-muted-foreground px-5 py-12 text-center text-sm">
                                Loading admin logs...
                            </div>
                        ) : adminLogs.length > 0 ? (
                            <div className="overflow-x-auto">
                                <table className="w-full">
                                    <thead className="bg-muted/30">
                                        <tr className="border-border border-b">
                                            <th className="text-muted-foreground px-5 py-3 text-left text-[11px] font-medium tracking-wider uppercase">
                                                Event
                                            </th>
                                            <th className="text-muted-foreground px-5 py-3 text-left text-[11px] font-medium tracking-wider uppercase">
                                                Subject
                                            </th>
                                            <th className="text-muted-foreground px-5 py-3 text-left text-[11px] font-medium tracking-wider uppercase">
                                                Actor
                                            </th>
                                            <th className="text-muted-foreground px-5 py-3 text-left text-[11px] font-medium tracking-wider uppercase">
                                                Status
                                            </th>
                                            <th className="text-muted-foreground px-5 py-3 text-right text-[11px] font-medium tracking-wider uppercase">
                                                Time
                                            </th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-border/50 divide-y">
                                        {adminLogs.map((log) => (
                                            <tr key={log.id}>
                                                <td className="px-5 py-3.5">
                                                    <div className="space-y-1">
                                                        <div className="flex flex-wrap items-center gap-2">
                                                            <Badge
                                                                variant="outline"
                                                                className="rounded-md text-[10px] uppercase"
                                                            >
                                                                {log.type}
                                                            </Badge>
                                                            <p className="text-foreground text-sm font-medium">
                                                                {log.title}
                                                            </p>
                                                        </div>
                                                        {log.detail ? (
                                                            <p className="text-muted-foreground max-w-xl truncate text-xs">
                                                                {log.detail}
                                                            </p>
                                                        ) : null}
                                                    </div>
                                                </td>
                                                <td className="text-muted-foreground px-5 py-3.5 text-sm">
                                                    {log.subject ?? "-"}
                                                </td>
                                                <td className="text-muted-foreground px-5 py-3.5 text-sm">
                                                    {log.actor ?? "-"}
                                                </td>
                                                <td className="px-5 py-3.5">
                                                    <Badge
                                                        variant="secondary"
                                                        className="rounded-md text-[10px] uppercase"
                                                    >
                                                        {log.status}
                                                    </Badge>
                                                </td>
                                                <td className="text-muted-foreground px-5 py-3.5 text-right text-xs">
                                                    {formatMetricDate(
                                                        log.createdAt,
                                                    )}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        ) : (
                            <div className="text-muted-foreground px-5 py-12 text-center text-sm">
                                No admin logs found yet.
                            </div>
                        )}
                        {operationNextCursor && !isLoadingLogs ? (
                            <div className="border-border/60 border-t p-3 text-center">
                                <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    onClick={() =>
                                        loadAdminLogs(operationFilter, true)
                                    }
                                >
                                    Load more
                                </Button>
                            </div>
                        ) : null}
                    </div>
                </div>
            ) : null}

            {activeTab === "announcements" ? (
                <div className="space-y-4">
                    <div className="border-border/60 bg-card rounded-lg border p-5">
                        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                            <div className="flex items-start gap-3">
                                <div className="bg-muted text-muted-foreground rounded-lg p-2">
                                    <Megaphone className="h-4 w-4" />
                                </div>
                                <div className="space-y-1">
                                    <p className="text-foreground text-sm font-semibold">
                                        Member Announcement
                                    </p>
                                    <p className="text-muted-foreground max-w-2xl text-xs">
                                        Publish one targeted notice across the
                                        member area. Saved changes receive a new
                                        revision and reappear for members who
                                        dismissed the previous version.
                                    </p>
                                </div>
                            </div>
                            <Badge
                                variant={
                                    memberAnnouncement.enabled
                                        ? "secondary"
                                        : "outline"
                                }
                                className="self-start rounded-md text-[10px] uppercase"
                            >
                                {memberAnnouncement.enabled
                                    ? "Enabled"
                                    : "Disabled"}
                            </Badge>
                        </div>

                        <div className="mt-5 flex flex-col gap-6">
                            <div className="space-y-5">
                                <div className="grid gap-3 sm:grid-cols-2">
                                    <label className="border-border/60 flex items-start gap-3 rounded-lg border px-4 py-3">
                                        <input
                                            type="checkbox"
                                            aria-label="Enable member announcement"
                                            checked={memberAnnouncement.enabled}
                                            onChange={(event) =>
                                                setMemberAnnouncement(
                                                    (current) => ({
                                                        ...current,
                                                        enabled:
                                                            event.target
                                                                .checked,
                                                    }),
                                                )
                                            }
                                            className="mt-1"
                                        />
                                        <span>
                                            <span className="text-sm font-medium">
                                                Publish announcement
                                            </span>
                                            <span className="text-muted-foreground block text-xs">
                                                Turn off to hide it everywhere.
                                            </span>
                                        </span>
                                    </label>
                                    <label className="border-border/60 flex items-start gap-3 rounded-lg border px-4 py-3">
                                        <input
                                            type="checkbox"
                                            aria-label="Allow members to dismiss"
                                            checked={
                                                memberAnnouncement.dismissible
                                            }
                                            onChange={(event) =>
                                                setMemberAnnouncement(
                                                    (current) => ({
                                                        ...current,
                                                        dismissible:
                                                            event.target
                                                                .checked,
                                                    }),
                                                )
                                            }
                                            className="mt-1"
                                        />
                                        <span>
                                            <span className="text-sm font-medium">
                                                Allow dismissal
                                            </span>
                                            <span className="text-muted-foreground block text-xs">
                                                Adds an X and remembers it on
                                                this browser.
                                            </span>
                                        </span>
                                    </label>
                                </div>

                                <div className="grid gap-4 sm:grid-cols-[180px_minmax(0,1fr)]">
                                    <div className="space-y-2">
                                        <Label htmlFor="announcement-variant">
                                            Variant
                                        </Label>
                                        <select
                                            id="announcement-variant"
                                            value={memberAnnouncement.variant}
                                            onChange={(event) =>
                                                setMemberAnnouncement(
                                                    (current) => ({
                                                        ...current,
                                                        variant: event.target
                                                            .value as MemberAnnouncement["variant"],
                                                    }),
                                                )
                                            }
                                            className="border-input bg-background focus-visible:ring-ring h-9 w-full rounded-md border px-3 text-sm focus-visible:ring-2 focus-visible:outline-none"
                                        >
                                            {MEMBER_ANNOUNCEMENT_VARIANTS.map(
                                                (variant) => (
                                                    <option
                                                        key={variant}
                                                        value={variant}
                                                    >
                                                        {variant
                                                            .charAt(0)
                                                            .toUpperCase() +
                                                            variant.slice(1)}
                                                    </option>
                                                ),
                                            )}
                                        </select>
                                    </div>
                                    <div className="space-y-2">
                                        <div className="flex items-center justify-between gap-3">
                                            <Label htmlFor="announcement-title">
                                                Title
                                            </Label>
                                            <span className="text-muted-foreground text-[11px]">
                                                {
                                                    memberAnnouncement.title
                                                        .length
                                                }
                                                /80
                                            </span>
                                        </div>
                                        <Input
                                            id="announcement-title"
                                            maxLength={80}
                                            value={memberAnnouncement.title}
                                            onChange={(event) =>
                                                setMemberAnnouncement(
                                                    (current) => ({
                                                        ...current,
                                                        title: event.target
                                                            .value,
                                                    }),
                                                )
                                            }
                                            placeholder="Important update"
                                        />
                                    </div>
                                </div>

                                <div className="space-y-2">
                                    <div className="flex items-center justify-between gap-3">
                                        <Label htmlFor="announcement-message">
                                            Message
                                        </Label>
                                        <span className="text-muted-foreground text-[11px]">
                                            {memberAnnouncement.message.length}
                                            /500
                                        </span>
                                    </div>
                                    <textarea
                                        id="announcement-message"
                                        maxLength={500}
                                        rows={4}
                                        value={memberAnnouncement.message}
                                        onChange={(event) =>
                                            setMemberAnnouncement(
                                                (current) => ({
                                                    ...current,
                                                    message: event.target.value,
                                                }),
                                            )
                                        }
                                        placeholder="Write a concise member update..."
                                        className="border-input bg-background ring-offset-background placeholder:text-muted-foreground focus-visible:ring-ring min-h-24 w-full resize-y rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
                                    />
                                    <p className="text-muted-foreground text-[11px]">
                                        Plain text only. Line breaks are
                                        preserved.
                                    </p>
                                </div>

                                <div className="border-border/60 rounded-lg border p-4">
                                    <label className="flex items-center gap-2 text-sm font-medium">
                                        <input
                                            type="checkbox"
                                            aria-label="Enable announcement call to action"
                                            checked={
                                                memberAnnouncement.cta !== null
                                            }
                                            onChange={(event) =>
                                                setMemberAnnouncement(
                                                    (current) => ({
                                                        ...current,
                                                        cta: event.target
                                                            .checked
                                                            ? {
                                                                  label: "Learn more",
                                                                  url: "",
                                                              }
                                                            : null,
                                                    }),
                                                )
                                            }
                                        />
                                        Call to action
                                    </label>
                                    {memberAnnouncement.cta ? (
                                        <div className="mt-3 grid gap-3 sm:grid-cols-[180px_minmax(0,1fr)]">
                                            <div className="space-y-2">
                                                <Label htmlFor="announcement-cta-label">
                                                    Button label
                                                </Label>
                                                <Input
                                                    id="announcement-cta-label"
                                                    maxLength={40}
                                                    value={
                                                        memberAnnouncement.cta
                                                            .label
                                                    }
                                                    onChange={(event) =>
                                                        setMemberAnnouncement(
                                                            (current) => ({
                                                                ...current,
                                                                cta: current.cta
                                                                    ? {
                                                                          ...current.cta,
                                                                          label: event
                                                                              .target
                                                                              .value,
                                                                      }
                                                                    : null,
                                                            }),
                                                        )
                                                    }
                                                />
                                            </div>
                                            <div className="space-y-2">
                                                <Label htmlFor="announcement-cta-url">
                                                    Internal or HTTPS URL
                                                </Label>
                                                <Input
                                                    id="announcement-cta-url"
                                                    value={
                                                        memberAnnouncement.cta
                                                            .url
                                                    }
                                                    onChange={(event) =>
                                                        setMemberAnnouncement(
                                                            (current) => ({
                                                                ...current,
                                                                cta: current.cta
                                                                    ? {
                                                                          ...current.cta,
                                                                          url: event
                                                                              .target
                                                                              .value,
                                                                      }
                                                                    : null,
                                                            }),
                                                        )
                                                    }
                                                    placeholder="/guide or https://..."
                                                />
                                            </div>
                                        </div>
                                    ) : null}
                                </div>

                                <div className="grid gap-4 lg:grid-cols-2">
                                    <fieldset className="border-border/60 rounded-lg border p-4">
                                        <legend className="px-1 text-sm font-medium">
                                            Audience
                                        </legend>
                                        <label className="mb-3 flex items-center gap-2 text-xs font-medium">
                                            <input
                                                type="checkbox"
                                                aria-label="All member roles"
                                                checked={MEMBER_ANNOUNCEMENT_AUDIENCES.every(
                                                    (audience) =>
                                                        memberAnnouncement.audiences.includes(
                                                            audience,
                                                        ),
                                                )}
                                                onChange={(event) =>
                                                    setMemberAnnouncement(
                                                        (current) => ({
                                                            ...current,
                                                            audiences: event
                                                                .target.checked
                                                                ? [
                                                                      ...MEMBER_ANNOUNCEMENT_AUDIENCES,
                                                                  ]
                                                                : [],
                                                        }),
                                                    )
                                                }
                                            />
                                            All roles
                                        </label>
                                        <div className="space-y-2">
                                            {MEMBER_ANNOUNCEMENT_AUDIENCES.map(
                                                (audience) => (
                                                    <label
                                                        key={audience}
                                                        className="flex items-center gap-2 text-sm"
                                                    >
                                                        <input
                                                            type="checkbox"
                                                            checked={memberAnnouncement.audiences.includes(
                                                                audience,
                                                            )}
                                                            onChange={(event) =>
                                                                setMemberAnnouncement(
                                                                    (
                                                                        current,
                                                                    ) => ({
                                                                        ...current,
                                                                        audiences:
                                                                            event
                                                                                .target
                                                                                .checked
                                                                                ? [
                                                                                      ...current.audiences,
                                                                                      audience,
                                                                                  ]
                                                                                : current.audiences.filter(
                                                                                      (
                                                                                          value,
                                                                                      ) =>
                                                                                          value !==
                                                                                          audience,
                                                                                  ),
                                                                    }),
                                                                )
                                                            }
                                                        />
                                                        {
                                                            ANNOUNCEMENT_AUDIENCE_LABELS[
                                                                audience
                                                            ]
                                                        }
                                                    </label>
                                                ),
                                            )}
                                        </div>
                                    </fieldset>

                                    <fieldset className="border-border/60 rounded-lg border p-4">
                                        <legend className="px-1 text-sm font-medium">
                                            Page areas
                                        </legend>
                                        <label className="mb-3 flex items-center gap-2 text-xs font-medium">
                                            <input
                                                type="checkbox"
                                                aria-label="All page areas"
                                                checked={MEMBER_ANNOUNCEMENT_PLACEMENTS.every(
                                                    (placement) =>
                                                        memberAnnouncement.placements.includes(
                                                            placement,
                                                        ),
                                                )}
                                                onChange={(event) =>
                                                    setMemberAnnouncement(
                                                        (current) => ({
                                                            ...current,
                                                            placements: event
                                                                .target.checked
                                                                ? [
                                                                      ...MEMBER_ANNOUNCEMENT_PLACEMENTS,
                                                                  ]
                                                                : [],
                                                        }),
                                                    )
                                                }
                                            />
                                            All page areas
                                        </label>
                                        <div className="space-y-2.5">
                                            {MEMBER_ANNOUNCEMENT_PLACEMENTS.map(
                                                (placement) => (
                                                    <label
                                                        key={placement}
                                                        className="flex items-start gap-2 text-sm"
                                                    >
                                                        <input
                                                            type="checkbox"
                                                            className="mt-1"
                                                            checked={memberAnnouncement.placements.includes(
                                                                placement,
                                                            )}
                                                            onChange={(event) =>
                                                                setMemberAnnouncement(
                                                                    (
                                                                        current,
                                                                    ) => ({
                                                                        ...current,
                                                                        placements:
                                                                            event
                                                                                .target
                                                                                .checked
                                                                                ? [
                                                                                      ...current.placements,
                                                                                      placement,
                                                                                  ]
                                                                                : current.placements.filter(
                                                                                      (
                                                                                          value,
                                                                                      ) =>
                                                                                          value !==
                                                                                          placement,
                                                                                  ),
                                                                    }),
                                                                )
                                                            }
                                                        />
                                                        <span>
                                                            <span className="block font-medium">
                                                                {
                                                                    ANNOUNCEMENT_PLACEMENT_LABELS[
                                                                        placement
                                                                    ].label
                                                                }
                                                            </span>
                                                            <span className="text-muted-foreground block text-[11px]">
                                                                {
                                                                    ANNOUNCEMENT_PLACEMENT_LABELS[
                                                                        placement
                                                                    ]
                                                                        .description
                                                                }
                                                            </span>
                                                        </span>
                                                    </label>
                                                ),
                                            )}
                                        </div>
                                    </fieldset>
                                </div>

                                <fieldset className="border-border/60 rounded-lg border p-4">
                                    <legend className="px-1 text-sm font-medium">
                                        Optional schedule
                                    </legend>
                                    <div className="grid gap-3 sm:grid-cols-2">
                                        <div className="space-y-2">
                                            <Label htmlFor="announcement-starts-at">
                                                Starts at
                                            </Label>
                                            <Input
                                                id="announcement-starts-at"
                                                type="datetime-local"
                                                value={announcementDateTimeValue(
                                                    memberAnnouncement.startsAt,
                                                )}
                                                onChange={(event) =>
                                                    setMemberAnnouncement(
                                                        (current) => ({
                                                            ...current,
                                                            startsAt:
                                                                announcementDateTimeIso(
                                                                    event.target
                                                                        .value,
                                                                ),
                                                        }),
                                                    )
                                                }
                                            />
                                        </div>
                                        <div className="space-y-2">
                                            <Label htmlFor="announcement-ends-at">
                                                Ends at
                                            </Label>
                                            <Input
                                                id="announcement-ends-at"
                                                type="datetime-local"
                                                value={announcementDateTimeValue(
                                                    memberAnnouncement.endsAt,
                                                )}
                                                onChange={(event) =>
                                                    setMemberAnnouncement(
                                                        (current) => ({
                                                            ...current,
                                                            endsAt: announcementDateTimeIso(
                                                                event.target
                                                                    .value,
                                                            ),
                                                        }),
                                                    )
                                                }
                                            />
                                        </div>
                                    </div>
                                    <p className="text-muted-foreground mt-2 text-[11px]">
                                        Times use your local timezone and are
                                        saved as UTC.
                                    </p>
                                </fieldset>
                            </div>

                            <div className="border-border/60 bg-muted/15 order-first space-y-3 rounded-xl border p-4">
                                <div className="flex flex-wrap items-start justify-between gap-3">
                                    <div>
                                        <p className="text-sm font-semibold">
                                            Live preview
                                        </p>
                                        <p className="text-muted-foreground text-xs">
                                            Full dashboard width · links and
                                            dismissal are disabled here.
                                        </p>
                                    </div>
                                    <Badge
                                        variant="outline"
                                        className="rounded-md text-[10px] uppercase"
                                    >
                                        Dashboard preview
                                    </Badge>
                                </div>
                                <MemberAnnouncementBanner
                                    announcement={memberAnnouncement}
                                    preview
                                />
                                <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
                                    <div className="border-border/60 bg-background/60 rounded-lg border px-3.5 py-3 text-xs">
                                        <p className="font-medium">
                                            Delivery summary
                                        </p>
                                        <p className="text-muted-foreground mt-1 leading-5">
                                            {memberAnnouncement.enabled
                                                ? `${memberAnnouncement.audiences.length} role group${memberAnnouncement.audiences.length === 1 ? "" : "s"} · ${memberAnnouncement.placements.length} page area${memberAnnouncement.placements.length === 1 ? "" : "s"}`
                                                : "Hidden for all members"}
                                            {memberAnnouncement.dismissible
                                                ? " · Dismissible"
                                                : " · Persistent"}
                                        </p>
                                        <p className="text-muted-foreground mt-1 font-mono text-[10px] break-all">
                                            Revision:{" "}
                                            {memberAnnouncement.revision}
                                        </p>
                                    </div>
                                    <Button
                                        type="button"
                                        className="h-9 w-full md:w-auto md:min-w-56"
                                        onClick={handleSaveMemberAnnouncement}
                                        disabled={isSavingMemberAnnouncement}
                                    >
                                        {isSavingMemberAnnouncement
                                            ? "Publishing..."
                                            : "Publish Announcement"}
                                    </Button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            ) : null}

            {activeTab === "settings" ? (
                <div className="space-y-4">
                    <div className="border-border/60 bg-card flex flex-col gap-3 rounded-lg border px-5 py-4 md:flex-row md:items-center md:justify-between">
                        <div className="flex items-center gap-3">
                            <div className="bg-muted text-muted-foreground rounded-lg p-2">
                                <Server className="h-4 w-4" />
                            </div>
                            <div>
                                <p className="text-sm font-semibold">
                                    Server Proxies
                                </p>
                                <p className="text-muted-foreground text-xs">
                                    Premium/admin infrastructure ·{" "}
                                    {serverProxyLineCount} active line
                                    {serverProxyLineCount === 1 ? "" : "s"} ·
                                    refreshed every worker sync.
                                </p>
                            </div>
                        </div>
                        <Button
                            type="button"
                            variant="outline"
                            className="h-9 self-start rounded-lg md:self-auto"
                            onClick={() => setIsProxyDialogOpen(true)}
                        >
                            <Server className="mr-2 h-4 w-4" />
                            Manage
                        </Button>
                    </div>

                    <div className="border-border/60 bg-card rounded-lg border p-5">
                        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                            <div className="space-y-1">
                                <p className="text-foreground text-sm font-semibold">
                                    Free Proxy Pool
                                </p>
                                <p className="text-muted-foreground text-xs">
                                    Shared free proxies for monitor catalog
                                    fetching. Account actions stay off this
                                    pool.
                                </p>
                            </div>
                            <Badge
                                variant={
                                    freeProxySettings.enabled
                                        ? "secondary"
                                        : "outline"
                                }
                                className="self-start rounded-md text-[10px] uppercase"
                            >
                                {freeProxySettings.enabled
                                    ? "Enabled"
                                    : "Disabled"}
                            </Badge>
                        </div>

                        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
                            {[
                                ["Active", freeProxyState.counts.active],
                                ["Pending", freeProxyState.counts.pending],
                                ["Cooldown", freeProxyState.counts.quarantined],
                                ["Total", freeProxyState.counts.total],
                                ["Dead", deadFreeProxyHealthCount],
                            ].map(([label, count]) => (
                                <div
                                    key={label}
                                    className="border-border/60 rounded-lg border px-3 py-3"
                                >
                                    <p className="text-muted-foreground text-[10px] font-medium tracking-widest uppercase">
                                        {label}
                                    </p>
                                    <p className="mt-1 text-xl font-semibold">
                                        {count}
                                    </p>
                                </div>
                            ))}
                        </div>

                        <div className="border-border/60 bg-muted/20 mt-4 grid gap-3 rounded-lg border p-3 sm:grid-cols-2 xl:grid-cols-4">
                            <div>
                                <p className="text-muted-foreground text-[10px] font-medium tracking-widest uppercase">
                                    Maintainer
                                </p>
                                <p className="mt-1 text-sm font-semibold capitalize">
                                    {freeProxyState.maintainerRuntime?.status ??
                                        "No heartbeat"}
                                </p>
                                <p className="text-muted-foreground text-[11px]">
                                    {freeProxyState.maintainerRuntime
                                        ? `Heartbeat ${formatMetricDate(new Date(freeProxyState.maintainerRuntime.heartbeatAt))}`
                                        : "Deploy the proxy-maintainer to publish runtime state"}
                                </p>
                            </div>
                            <div>
                                <p className="text-muted-foreground text-[10px] font-medium tracking-widest uppercase">
                                    Effective slots
                                </p>
                                <p className="mt-1 text-sm font-semibold">
                                    {freeProxyState.maintainerRuntime
                                        ? `${freeProxyState.maintainerRuntime.concurrency} global · ${freeProxyState.maintainerRuntime.perRegionConcurrency}/region`
                                        : "—"}
                                </p>
                                <p className="text-muted-foreground text-[11px]">
                                    Actual prod runtime, including overrides
                                </p>
                            </div>
                            <div>
                                <p className="text-muted-foreground text-[10px] font-medium tracking-widest uppercase">
                                    Last cycle
                                </p>
                                <p className="mt-1 text-sm font-semibold">
                                    {freeProxyState.maintainerRuntime
                                        ? `${freeProxyState.maintainerRuntime.checked} checked · ${freeProxyState.maintainerRuntime.passed} passed`
                                        : "—"}
                                </p>
                                <p className="text-muted-foreground text-[11px]">
                                    {freeProxyState.maintainerRuntime
                                        ? `${Math.round(freeProxyState.maintainerRuntime.durationMs / 1000)}s · ${freeProxyState.maintainerRuntime.canceled} canceled`
                                        : "Waiting for the first cycle"}
                                </p>
                            </div>
                            <div>
                                <p className="text-muted-foreground text-[10px] font-medium tracking-widest uppercase">
                                    Live demand
                                </p>
                                <p className="mt-1 text-sm font-semibold">
                                    {totalFreeProxyMonitors} free monitors
                                </p>
                                <p className="text-muted-foreground text-[11px]">
                                    Shared by region; no cross-region failover
                                </p>
                            </div>
                        </div>

                        <details className="border-border/70 mt-4 rounded-lg border">
                            <summary className="hover:bg-muted/40 flex cursor-pointer list-none items-center justify-between rounded-lg px-4 py-3 transition-colors [&::-webkit-details-marker]:hidden">
                                <span>
                                    <span className="block text-sm font-semibold">
                                        Pool configuration
                                    </span>
                                    <span className="text-muted-foreground block text-xs">
                                        Import, validation and regional target
                                        settings
                                    </span>
                                </span>
                                <Settings2 className="text-muted-foreground size-4" />
                            </summary>
                            <div className="border-border/60 border-t p-4">
                                <div className="grid gap-3 sm:grid-cols-2">
                                    <label className="border-border/60 flex items-start gap-3 rounded-lg border px-4 py-3">
                                        <input
                                            type="checkbox"
                                            checked={freeProxySettings.enabled}
                                            onChange={(event) =>
                                                setFreeProxySettings(
                                                    (prev) => ({
                                                        ...prev,
                                                        enabled:
                                                            event.target
                                                                .checked,
                                                    }),
                                                )
                                            }
                                            className="mt-1"
                                        />
                                        <span>
                                            <span className="text-sm font-medium">
                                                Enable for users
                                            </span>
                                            <span className="text-muted-foreground block text-xs">
                                                Shows Free Proxy Pool in monitor
                                                proxy selection.
                                            </span>
                                        </span>
                                    </label>
                                    <label className="border-border/60 flex items-start gap-3 rounded-lg border px-4 py-3">
                                        <input
                                            type="checkbox"
                                            checked={
                                                freeProxySettings.autoImportEnabled
                                            }
                                            onChange={(event) =>
                                                setFreeProxySettings(
                                                    (prev) => ({
                                                        ...prev,
                                                        autoImportEnabled:
                                                            event.target
                                                                .checked,
                                                    }),
                                                )
                                            }
                                            className="mt-1"
                                        />
                                        <span>
                                            <span className="text-sm font-medium">
                                                Auto import
                                            </span>
                                            <span className="text-muted-foreground block text-xs">
                                                Worker refreshes the configured
                                                source periodically.
                                            </span>
                                        </span>
                                    </label>
                                </div>

                                <div className="mt-5 grid gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(420px,0.9fr)]">
                                    <div className="rounded-lg border p-4">
                                        <div className="mb-4">
                                            <p className="text-sm font-semibold">
                                                Import Source
                                            </p>
                                            <p className="text-muted-foreground text-xs">
                                                Imported proxies stay pending
                                                until Vintrack validates them
                                                against Vinted per starter
                                                region.
                                            </p>
                                        </div>
                                        <div className="grid gap-3 lg:grid-cols-[220px_minmax(0,1fr)]">
                                            <div className="space-y-2">
                                                <Label htmlFor="free-proxy-source">
                                                    Source
                                                </Label>
                                                <select
                                                    id="free-proxy-source"
                                                    value={
                                                        freeProxySettings.importSource
                                                    }
                                                    onChange={(event) => {
                                                        const selected =
                                                            FREE_PROXY_SOURCE_OPTIONS.find(
                                                                (option) =>
                                                                    option.value ===
                                                                    event.target
                                                                        .value,
                                                            );
                                                        setFreeProxySettings(
                                                            (prev) => ({
                                                                ...prev,
                                                                importSource:
                                                                    event.target
                                                                        .value,
                                                                importUrl:
                                                                    selected?.url ||
                                                                    prev.importUrl,
                                                            }),
                                                        );
                                                    }}
                                                    className="border-input bg-background h-10 w-full rounded-md border px-3 text-sm"
                                                >
                                                    {FREE_PROXY_SOURCE_OPTIONS.map(
                                                        (option) => (
                                                            <option
                                                                key={
                                                                    option.value
                                                                }
                                                                value={
                                                                    option.value
                                                                }
                                                            >
                                                                {option.label}
                                                            </option>
                                                        ),
                                                    )}
                                                </select>
                                            </div>
                                            <div className="space-y-2">
                                                <Label htmlFor="free-proxy-import-url">
                                                    Import URL
                                                </Label>
                                                <Input
                                                    id="free-proxy-import-url"
                                                    value={
                                                        freeProxySettings.importUrl
                                                    }
                                                    onChange={(event) =>
                                                        setFreeProxySettings(
                                                            (prev) => ({
                                                                ...prev,
                                                                importSource:
                                                                    "custom",
                                                                importUrl:
                                                                    event.target
                                                                        .value,
                                                            }),
                                                        )
                                                    }
                                                />
                                            </div>
                                        </div>
                                        <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(0,1fr)_130px]">
                                            <div className="space-y-2">
                                                <div className="flex items-center justify-between gap-3">
                                                    <Label>
                                                        Starter regions
                                                    </Label>
                                                    <span className="text-muted-foreground text-[11px]">
                                                        {starterRegionSet.size}{" "}
                                                        selected
                                                    </span>
                                                </div>
                                                <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-4">
                                                    {REGIONS.map((region) => {
                                                        const selected =
                                                            starterRegionSet.has(
                                                                region.code,
                                                            );
                                                        const health = selected
                                                            ? freeProxyHealthByRegion.get(
                                                                  region.code,
                                                              )
                                                            : undefined;
                                                        return (
                                                            <button
                                                                key={
                                                                    region.code
                                                                }
                                                                type="button"
                                                                onClick={() =>
                                                                    toggleStarterRegion(
                                                                        region.code,
                                                                    )
                                                                }
                                                                aria-pressed={
                                                                    selected
                                                                }
                                                                className={`flex min-w-0 items-center justify-between gap-2 rounded-md border px-2.5 py-2 text-left text-xs transition-colors ${
                                                                    selected
                                                                        ? "border-primary bg-primary/5 text-foreground"
                                                                        : "border-border/70 bg-background text-muted-foreground hover:bg-muted/50"
                                                                }`}
                                                            >
                                                                <span className="flex min-w-0 items-center gap-1.5">
                                                                    <span>
                                                                        {
                                                                            region.flag
                                                                        }
                                                                    </span>
                                                                    <span className="truncate">
                                                                        {
                                                                            region.label
                                                                        }
                                                                    </span>
                                                                </span>
                                                                <span
                                                                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                                                                        health?.healthy
                                                                            ? "bg-emerald-500"
                                                                            : health
                                                                              ? "bg-amber-500"
                                                                              : "bg-muted-foreground/30"
                                                                    }`}
                                                                    title={
                                                                        health?.healthy
                                                                            ? `${health.active + health.warming} usable proxies`
                                                                            : health
                                                                              ? "Pool is degraded"
                                                                              : "No pool checks yet"
                                                                    }
                                                                />
                                                            </button>
                                                        );
                                                    })}
                                                </div>
                                            </div>
                                            <div className="space-y-2">
                                                <Label htmlFor="free-proxy-inventory-limit">
                                                    Inventory limit
                                                </Label>
                                                <Input
                                                    id="free-proxy-inventory-limit"
                                                    type="number"
                                                    min={1000}
                                                    value={
                                                        freeProxySettings.inventoryLimit
                                                    }
                                                    onChange={(event) =>
                                                        setFreeProxySettings(
                                                            (prev) => ({
                                                                ...prev,
                                                                inventoryLimit:
                                                                    Number(
                                                                        event
                                                                            .target
                                                                            .value,
                                                                    ),
                                                            }),
                                                        )
                                                    }
                                                />
                                            </div>
                                        </div>
                                    </div>

                                    <div className="rounded-lg border p-4">
                                        <div className="mb-4">
                                            <p className="text-sm font-semibold">
                                                Validation Rules
                                            </p>
                                            <p className="text-muted-foreground text-xs">
                                                Two successful Vinted checks are
                                                needed before a proxy enters
                                                rotation.
                                            </p>
                                        </div>
                                        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
                                            <div className="space-y-2">
                                                <Label htmlFor="free-proxy-failures">
                                                    Failures
                                                </Label>
                                                <Input
                                                    id="free-proxy-failures"
                                                    type="number"
                                                    min={1}
                                                    value={
                                                        freeProxySettings.failureThreshold
                                                    }
                                                    onChange={(event) =>
                                                        setFreeProxySettings(
                                                            (prev) => ({
                                                                ...prev,
                                                                failureThreshold:
                                                                    Number(
                                                                        event
                                                                            .target
                                                                            .value,
                                                                    ),
                                                            }),
                                                        )
                                                    }
                                                />
                                            </div>
                                            <div className="space-y-2">
                                                <Label htmlFor="free-proxy-quarantine">
                                                    Cooldown
                                                </Label>
                                                <Input
                                                    id="free-proxy-quarantine"
                                                    type="number"
                                                    min={1}
                                                    value={
                                                        freeProxySettings.quarantineMinutes
                                                    }
                                                    onChange={(event) =>
                                                        setFreeProxySettings(
                                                            (prev) => ({
                                                                ...prev,
                                                                quarantineMinutes:
                                                                    Number(
                                                                        event
                                                                            .target
                                                                            .value,
                                                                    ),
                                                            }),
                                                        )
                                                    }
                                                />
                                            </div>
                                            <div className="space-y-2">
                                                <Label htmlFor="free-proxy-min-active">
                                                    Min ready
                                                </Label>
                                                <Input
                                                    id="free-proxy-min-active"
                                                    type="number"
                                                    min={1}
                                                    value={
                                                        freeProxySettings.minActivePerRegion
                                                    }
                                                    onChange={(event) =>
                                                        setFreeProxySettings(
                                                            (prev) => ({
                                                                ...prev,
                                                                minActivePerRegion:
                                                                    Number(
                                                                        event
                                                                            .target
                                                                            .value,
                                                                    ),
                                                            }),
                                                        )
                                                    }
                                                />
                                            </div>
                                            <div className="space-y-2">
                                                <Label htmlFor="free-proxy-target-active">
                                                    Target reserve
                                                </Label>
                                                <Input
                                                    id="free-proxy-target-active"
                                                    type="number"
                                                    min={
                                                        freeProxySettings.minActivePerRegion
                                                    }
                                                    value={
                                                        freeProxySettings.targetActivePerRegion
                                                    }
                                                    onChange={(event) =>
                                                        setFreeProxySettings(
                                                            (prev) => ({
                                                                ...prev,
                                                                targetActivePerRegion:
                                                                    Number(
                                                                        event
                                                                            .target
                                                                            .value,
                                                                    ),
                                                            }),
                                                        )
                                                    }
                                                />
                                            </div>
                                            <div className="space-y-2">
                                                <Label htmlFor="free-proxy-max-latency">
                                                    Max ms
                                                </Label>
                                                <Input
                                                    id="free-proxy-max-latency"
                                                    type="number"
                                                    min={500}
                                                    value={
                                                        freeProxySettings.maxLatencyMs
                                                    }
                                                    onChange={(event) =>
                                                        setFreeProxySettings(
                                                            (prev) => ({
                                                                ...prev,
                                                                maxLatencyMs:
                                                                    Number(
                                                                        event
                                                                            .target
                                                                            .value,
                                                                    ),
                                                            }),
                                                        )
                                                    }
                                                />
                                            </div>
                                        </div>
                                    </div>
                                </div>

                                <div className="mt-5 rounded-lg border p-4">
                                    <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                                        <div>
                                            <p className="text-sm font-semibold">
                                                Regional pool scaling
                                            </p>
                                            <p className="text-muted-foreground text-xs">
                                                Used regions build 50 ready
                                                clients plus a target-validated
                                                replacement reserve.
                                            </p>
                                        </div>
                                        <label className="flex items-center gap-2 text-xs">
                                            <input
                                                type="checkbox"
                                                checked={
                                                    freeProxySettings.emergencyRecoveryEnabled
                                                }
                                                onChange={(event) =>
                                                    setFreeProxySettings(
                                                        (prev) => ({
                                                            ...prev,
                                                            emergencyRecoveryEnabled:
                                                                event.target
                                                                    .checked,
                                                        }),
                                                    )
                                                }
                                            />
                                            Emergency recovery
                                        </label>
                                    </div>
                                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                                        {[
                                            {
                                                id: "free-proxy-active-window",
                                                label: "Used candidates",
                                                value: freeProxySettings.activeCandidateLimit,
                                                min: 1000,
                                                key: "activeCandidateLimit" as const,
                                            },
                                            {
                                                id: "free-proxy-idle-window",
                                                label: "Idle candidates",
                                                value: freeProxySettings.idleCandidateLimit,
                                                min: 1000,
                                                key: "idleCandidateLimit" as const,
                                            },
                                            {
                                                id: "free-proxy-ready-target",
                                                label: "Ready target",
                                                value: freeProxySettings.readyTarget,
                                                min: 1,
                                                key: "readyTarget" as const,
                                            },
                                            {
                                                id: "free-proxy-reserve-target",
                                                label: "Reserve target",
                                                value: freeProxySettings.reserveTarget,
                                                min: 1,
                                                key: "reserveTarget" as const,
                                            },
                                            {
                                                id: "free-proxy-idle-target",
                                                label: "Idle target",
                                                value: freeProxySettings.idleTarget,
                                                min: 1,
                                                key: "idleTarget" as const,
                                            },
                                        ].map((field) => (
                                            <div
                                                key={field.id}
                                                className="space-y-2"
                                            >
                                                <Label htmlFor={field.id}>
                                                    {field.label}
                                                </Label>
                                                <Input
                                                    id={field.id}
                                                    type="number"
                                                    min={field.min}
                                                    value={field.value}
                                                    onChange={(event) =>
                                                        setFreeProxySettings(
                                                            (prev) => ({
                                                                ...prev,
                                                                [field.key]:
                                                                    Number(
                                                                        event
                                                                            .target
                                                                            .value,
                                                                    ),
                                                            }),
                                                        )
                                                    }
                                                />
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            </div>
                        </details>

                        {freeProxySettings.enabled &&
                        freeProxyState.degradationReason ===
                            "host_egress_limited" ? (
                            <div className="mt-5 flex gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100">
                                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                                <div>
                                    <p className="text-sm font-semibold">
                                        Host egress limited
                                    </p>
                                    <p className="mt-0.5 text-xs">
                                        Most checks fail during the initial
                                        proxy warmup from this server. The
                                        maintainer is backing off globally and
                                        prioritizing routes that work here. If
                                        this persists, use a different
                                        maintainer egress or controlled proxy
                                        capacity.
                                    </p>
                                </div>
                            </div>
                        ) : null}

                        <div className="mt-4 rounded-lg border">
                            <div className="border-border/60 flex items-center justify-between border-b px-4 py-3">
                                <div>
                                    <p className="text-sm font-semibold">
                                        Region Health
                                    </p>
                                    <p className="text-muted-foreground text-xs">
                                        Compact live view. Open a region for
                                        source and failure diagnostics.
                                    </p>
                                </div>
                            </div>
                            <div className="divide-border/60 divide-y">
                                {displayedFreeProxyRegions.length > 0 ? (
                                    displayedFreeProxyRegions.map((region) => {
                                        const used =
                                            region.activeMonitorCount > 0;
                                        const readyTarget = used
                                            ? freeProxySettings.readyTarget
                                            : freeProxySettings.idleTarget;
                                        const reserveTarget = used
                                            ? freeProxySettings.reserveTarget
                                            : freeProxySettings.idleTarget;
                                        const usable =
                                            region.active +
                                            region.reserve +
                                            region.warming;
                                        const readyProgress = Math.min(
                                            100,
                                            (usable /
                                                Math.max(1, readyTarget)) *
                                                100,
                                        );
                                        const reserveProgress = Math.min(
                                            100,
                                            (region.reserve /
                                                Math.max(1, reserveTarget)) *
                                                100,
                                        );
                                        const status = region.initializing
                                            ? "Waiting"
                                            : region.recoveryMode
                                              ? "Recovery"
                                              : region.stalled
                                                ? "Stalled"
                                                : freeProxySettings.enabled &&
                                                    freeProxyState.degradationReason ===
                                                        "host_egress_limited"
                                                  ? "Egress limited"
                                                  : usable === 0 && used
                                                    ? "Outage"
                                                    : usable < readyTarget
                                                      ? "Building"
                                                      : used
                                                        ? "Ready"
                                                        : "Standby";
                                        return (
                                            <button
                                                key={region.region}
                                                type="button"
                                                onClick={() =>
                                                    void openFreeProxyRegion(
                                                        region.region,
                                                    )
                                                }
                                                className="hover:bg-muted/30 grid w-full gap-3 px-4 py-3 text-left text-sm transition-colors lg:grid-cols-[170px_minmax(220px,1fr)_130px_125px_130px_20px] lg:items-center"
                                            >
                                                <div className="flex items-center gap-2">
                                                    <span className="font-semibold">
                                                        {getRegionLabel(
                                                            region.region,
                                                        )}
                                                    </span>
                                                    <Badge
                                                        variant={
                                                            status ===
                                                                "Ready" ||
                                                            status === "Standby"
                                                                ? "secondary"
                                                                : "outline"
                                                        }
                                                        className="rounded-md text-[9px] uppercase"
                                                    >
                                                        {status}
                                                    </Badge>
                                                </div>
                                                <div className="grid gap-2 sm:grid-cols-2">
                                                    <div>
                                                        <div className="mb-1 flex justify-between text-[11px]">
                                                            <span>Usable</span>
                                                            <span className="font-medium">
                                                                {usable}/
                                                                {readyTarget}
                                                            </span>
                                                        </div>
                                                        <div className="bg-muted h-1.5 overflow-hidden rounded-full">
                                                            <div
                                                                className="h-full rounded-full bg-emerald-500"
                                                                style={{
                                                                    width: `${readyProgress}%`,
                                                                }}
                                                            />
                                                        </div>
                                                    </div>
                                                    <div>
                                                        <div className="mb-1 flex justify-between text-[11px]">
                                                            <span>Reserve</span>
                                                            <span className="font-medium">
                                                                {region.reserve}
                                                                /{reserveTarget}
                                                            </span>
                                                        </div>
                                                        <div className="bg-muted h-1.5 overflow-hidden rounded-full">
                                                            <div
                                                                className="bg-primary h-full rounded-full"
                                                                style={{
                                                                    width: `${reserveProgress}%`,
                                                                }}
                                                            />
                                                        </div>
                                                    </div>
                                                </div>
                                                <div>
                                                    <p className="font-medium">
                                                        {
                                                            region.activeMonitorCount
                                                        }{" "}
                                                        monitors
                                                    </p>
                                                    <p className="text-muted-foreground text-[11px]">
                                                        {region.candidateWindow.toLocaleString()}{" "}
                                                        candidates
                                                    </p>
                                                </div>
                                                <div>
                                                    <p className="font-medium">
                                                        {region.checkedLastHour}
                                                        /h checked
                                                    </p>
                                                    <p className="text-muted-foreground text-[11px]">
                                                        {
                                                            region.promotedLastHour
                                                        }{" "}
                                                        had success
                                                    </p>
                                                </div>
                                                <div>
                                                    <p className="font-medium">
                                                        {region.successRate ===
                                                        null
                                                            ? "n/a"
                                                            : `${region.successRate}%`}{" "}
                                                        pass rate
                                                    </p>
                                                    <p className="text-muted-foreground text-[11px]">
                                                        {region.dueNow} due ·{" "}
                                                        {region.neverChecked}{" "}
                                                        unchecked
                                                    </p>
                                                </div>
                                                <ChevronRight className="text-muted-foreground hidden size-4 lg:block" />
                                            </button>
                                        );
                                    })
                                ) : (
                                    <p className="text-muted-foreground px-4 py-6 text-sm">
                                        No region health checks yet. Import
                                        proxies and let the worker validate
                                        them.
                                    </p>
                                )}
                            </div>
                        </div>

                        <div className="mt-4 flex flex-wrap gap-2">
                            <Button
                                type="button"
                                onClick={handleSaveFreeProxySettings}
                                disabled={isSavingFreeProxySettings}
                            >
                                {isSavingFreeProxySettings
                                    ? "Saving..."
                                    : "Save Settings"}
                            </Button>
                            <Button
                                type="button"
                                variant="outline"
                                onClick={handleImportFreeProxies}
                                disabled={isImportingFreeProxies}
                            >
                                {isImportingFreeProxies
                                    ? "Importing..."
                                    : "Import Now"}
                            </Button>
                            <Button
                                type="button"
                                variant="outline"
                                onClick={handleClearFreeProxyQuarantine}
                                disabled={
                                    isClearingFreeProxyQuarantine ||
                                    freeProxyState.counts.quarantined === 0
                                }
                            >
                                {isClearingFreeProxyQuarantine
                                    ? "Restoring..."
                                    : "Clear Quarantine"}
                            </Button>
                        </div>

                        <details className="border-border/70 mt-5 rounded-lg border">
                            <summary className="hover:bg-muted/40 flex cursor-pointer list-none items-center justify-between rounded-lg px-4 py-3 transition-colors [&::-webkit-details-marker]:hidden">
                                <span>
                                    <span className="block text-sm font-semibold">
                                        Advanced diagnostics
                                    </span>
                                    <span className="text-muted-foreground block text-xs">
                                        Manual proxy input and recent raw pool
                                        entries.
                                    </span>
                                </span>
                            </summary>
                            <div className="border-border/60 grid gap-4 border-t p-4 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
                                <div className="space-y-3">
                                    <div>
                                        <p className="text-sm font-semibold">
                                            Manual Add
                                        </p>
                                        <p className="text-muted-foreground text-xs">
                                            One proxy per line. Supports URL,
                                            host:port, and authenticated
                                            formats.
                                        </p>
                                    </div>
                                    <textarea
                                        value={manualFreeProxies}
                                        onChange={(event) =>
                                            setManualFreeProxies(
                                                event.target.value,
                                            )
                                        }
                                        spellCheck={false}
                                        placeholder="http://host:port&#10;host:port"
                                        className="border-input bg-background ring-offset-background placeholder:text-muted-foreground focus-visible:ring-ring min-h-40 w-full rounded-md border px-3 py-2 font-mono text-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
                                    />
                                    <Button
                                        type="button"
                                        variant="outline"
                                        onClick={handleAddFreeProxies}
                                        disabled={
                                            isAddingFreeProxies ||
                                            manualFreeProxies.trim().length ===
                                                0
                                        }
                                    >
                                        {isAddingFreeProxies
                                            ? "Adding..."
                                            : "Add Proxies"}
                                    </Button>
                                </div>

                                <div className="space-y-3">
                                    <div>
                                        <p className="text-sm font-semibold">
                                            Recent Pool Entries
                                        </p>
                                        <p className="text-muted-foreground text-xs">
                                            Latest imported, checked, or
                                            quarantined proxies.
                                        </p>
                                    </div>
                                    <div className="border-border/60 max-h-72 overflow-auto rounded-lg border">
                                        {freeProxyState.recent.length > 0 ? (
                                            <div className="divide-border/60 divide-y">
                                                {freeProxyState.recent.map(
                                                    (proxy) => (
                                                        <div
                                                            key={proxy.id}
                                                            className="px-3 py-2"
                                                        >
                                                            <div className="flex items-center gap-2">
                                                                <span className="font-mono text-xs">
                                                                    {
                                                                        proxy.proxy_url
                                                                    }
                                                                </span>
                                                                <Badge
                                                                    variant="outline"
                                                                    className="ml-auto rounded-md text-[10px] uppercase"
                                                                >
                                                                    {
                                                                        proxy.status
                                                                    }
                                                                </Badge>
                                                            </div>
                                                            <p className="text-muted-foreground mt-1 text-[11px]">
                                                                {proxy.source} ·{" "}
                                                                {proxy.protocol}{" "}
                                                                ·{" "}
                                                                {
                                                                    proxy.success_count
                                                                }{" "}
                                                                ok /{" "}
                                                                {
                                                                    proxy.failure_count
                                                                }{" "}
                                                                fail · checked{" "}
                                                                {formatMetricDate(
                                                                    proxy.last_checked_at,
                                                                )}
                                                            </p>
                                                            {proxy.last_error ? (
                                                                <p className="text-muted-foreground mt-1 truncate text-[11px]">
                                                                    {
                                                                        proxy.last_error
                                                                    }
                                                                </p>
                                                            ) : null}
                                                        </div>
                                                    ),
                                                )}
                                            </div>
                                        ) : (
                                            <p className="text-muted-foreground px-4 py-8 text-center text-sm">
                                                No free proxies added yet.
                                            </p>
                                        )}
                                    </div>
                                </div>
                            </div>
                        </details>
                    </div>
                </div>
            ) : null}

            <Dialog
                open={selectedFreeProxyRegion !== null}
                onOpenChange={(open) => {
                    if (!open) setSelectedFreeProxyRegion(null);
                }}
            >
                <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-4xl">
                    <DialogHeader>
                        <DialogTitle>
                            {selectedFreeProxyRegion
                                ? getRegionLabel(selectedFreeProxyRegion)
                                : "Proxy region"}
                        </DialogTitle>
                        <DialogDescription>
                            Regional capacity, backlog and source yield. Source
                            diagnostics are loaded only when this view opens.
                        </DialogDescription>
                    </DialogHeader>

                    {selectedFreeProxyHealth ? (
                        <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
                            {[
                                ["Ready", selectedFreeProxyHealth.active],
                                ["Reserve", selectedFreeProxyHealth.reserve],
                                [
                                    "Monitors",
                                    selectedFreeProxyHealth.activeMonitorCount,
                                ],
                                [
                                    "Checked 1h",
                                    selectedFreeProxyHealth.checkedLastHour,
                                ],
                                ["Due now", selectedFreeProxyHealth.dueNow],
                                [
                                    "Unchecked",
                                    selectedFreeProxyHealth.neverChecked,
                                ],
                            ].map(([label, value]) => (
                                <div
                                    key={label}
                                    className="border-border/60 rounded-lg border px-3 py-2"
                                >
                                    <p className="text-muted-foreground text-[10px] uppercase">
                                        {label}
                                    </p>
                                    <p className="mt-1 text-lg font-semibold">
                                        {value}
                                    </p>
                                </div>
                            ))}
                        </div>
                    ) : null}

                    <div className="rounded-lg border">
                        <div className="border-border/60 border-b px-4 py-3">
                            <p className="text-sm font-semibold">
                                Source and protocol yield · last hour
                            </p>
                            <p className="text-muted-foreground text-xs">
                                Regional validation outcomes; this is not the
                                member request success rate.
                            </p>
                        </div>
                        {isLoadingFreeProxySources &&
                        !selectedFreeProxySources ? (
                            <div className="text-muted-foreground flex items-center gap-2 px-4 py-8 text-sm">
                                <Activity className="size-4 animate-pulse" />
                                Loading regional diagnostics…
                            </div>
                        ) : selectedFreeProxySources &&
                          selectedFreeProxySources.length > 0 ? (
                            <div className="divide-border/60 divide-y">
                                {selectedFreeProxySources.map((diagnostic) => (
                                    <div
                                        key={`${diagnostic.source}:${diagnostic.protocol}`}
                                        className="grid gap-2 px-4 py-3 text-xs md:grid-cols-[minmax(140px,1fr)_70px_100px_150px_minmax(160px,1fr)] md:items-center"
                                    >
                                        <span className="font-medium">
                                            {diagnostic.source}
                                        </span>
                                        <span className="uppercase">
                                            {diagnostic.protocol}
                                        </span>
                                        <span>
                                            {diagnostic.successful}/
                                            {diagnostic.checked} ok ·{" "}
                                            {diagnostic.successRate === null
                                                ? "n/a"
                                                : `${diagnostic.successRate}%`}
                                        </span>
                                        <span>
                                            {diagnostic.active} ready ·{" "}
                                            {diagnostic.reserve} reserve ·{" "}
                                            {diagnostic.neverChecked} unchecked
                                        </span>
                                        <span className="text-muted-foreground">
                                            {diagnostic.topErrorCode
                                                ? `${diagnostic.topErrorCode}${diagnostic.topErrorStage ? ` · ${diagnostic.topErrorStage}` : ""}`
                                                : "No recent error class"}
                                        </span>
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <p className="text-muted-foreground px-4 py-8 text-sm">
                                No source diagnostics in the last hour.
                            </p>
                        )}
                    </div>
                </DialogContent>
            </Dialog>

            <Dialog
                open={maintenanceDialogMode !== null}
                onOpenChange={(open) => {
                    if (!open && !isSavingMaintenance) {
                        setMaintenanceDialogMode(null);
                    }
                }}
            >
                <DialogContent className="sm:max-w-lg">
                    <DialogHeader>
                        <DialogTitle>
                            {maintenanceDialogMode === "disable"
                                ? "End monitor maintenance?"
                                : maintenanceDialogMode === "update"
                                  ? "Update maintenance notice"
                                  : "Enable monitor maintenance?"}
                        </DialogTitle>
                        <DialogDescription>
                            {maintenanceDialogMode === "disable"
                                ? `${monitorMaintenanceState.maintenancePausedCount} monitor${monitorMaintenanceState.maintenancePausedCount === 1 ? "" : "s"} paused by maintenance will resume automatically.`
                                : maintenanceDialogMode === "update"
                                  ? "Update the member-facing message and optional ETA. The ETA is informational only."
                                  : `${monitorMaintenanceState.activeMonitorCount} active monitor${monitorMaintenanceState.activeMonitorCount === 1 ? "" : "s"} will be paused and all new starts will be blocked.`}
                        </DialogDescription>
                    </DialogHeader>

                    {maintenanceDialogMode !== "disable" ? (
                        <div className="space-y-4 py-2">
                            <div className="space-y-2">
                                <div className="flex items-center justify-between gap-3">
                                    <Label htmlFor="maintenance-message">
                                        Member message
                                    </Label>
                                    <span className="text-muted-foreground text-[11px]">
                                        {maintenanceMessage.length}/300
                                    </span>
                                </div>
                                <textarea
                                    id="maintenance-message"
                                    rows={4}
                                    maxLength={300}
                                    value={maintenanceMessage}
                                    onChange={(event) =>
                                        setMaintenanceMessage(
                                            event.target.value,
                                        )
                                    }
                                    className="border-input bg-background focus-visible:ring-ring w-full resize-y rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:outline-none"
                                />
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="maintenance-estimated-end">
                                    Estimated completion (optional)
                                </Label>
                                <Input
                                    id="maintenance-estimated-end"
                                    type="datetime-local"
                                    value={maintenanceEstimatedEndAt}
                                    onChange={(event) =>
                                        setMaintenanceEstimatedEndAt(
                                            event.target.value,
                                        )
                                    }
                                />
                                <p className="text-muted-foreground text-xs">
                                    Saved and displayed as UTC; maintenance
                                    never ends automatically.
                                </p>
                            </div>
                        </div>
                    ) : (
                        <div className="border-border/60 bg-muted/30 rounded-lg border p-4 text-sm">
                            <p className="font-medium">
                                Resume only maintenance-paused monitors
                            </p>
                            <p className="text-muted-foreground mt-1 text-xs leading-5">
                                Monitors that were already manually paused stay
                                paused. No Discord or Telegram status flood will
                                be sent.
                            </p>
                        </div>
                    )}

                    <DialogFooter>
                        <Button
                            type="button"
                            variant="outline"
                            disabled={isSavingMaintenance}
                            onClick={() => setMaintenanceDialogMode(null)}
                        >
                            Cancel
                        </Button>
                        <Button
                            type="button"
                            variant={
                                maintenanceDialogMode === "enable"
                                    ? "destructive"
                                    : "default"
                            }
                            disabled={
                                isSavingMaintenance ||
                                (maintenanceDialogMode !== "disable" &&
                                    !maintenanceMessage.trim())
                            }
                            onClick={handleMaintenanceAction}
                        >
                            {isSavingMaintenance
                                ? "Saving..."
                                : maintenanceDialogMode === "disable"
                                  ? `Resume ${monitorMaintenanceState.maintenancePausedCount} monitor${monitorMaintenanceState.maintenancePausedCount === 1 ? "" : "s"} & end maintenance`
                                  : maintenanceDialogMode === "update"
                                    ? "Update maintenance notice"
                                    : `Pause ${monitorMaintenanceState.activeMonitorCount} monitor${monitorMaintenanceState.activeMonitorCount === 1 ? "" : "s"} & enable maintenance`}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <Dialog open={isOpen} onOpenChange={setIsOpen}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>Change Role</DialogTitle>
                        <DialogDescription>
                            Update role for{" "}
                            <strong>{selected?.name ?? "User"}</strong>
                        </DialogDescription>
                    </DialogHeader>

                    <div className="grid gap-2 py-4">
                        {ROLES.map((role) => (
                            <button
                                key={role.value}
                                onClick={() => setPendingRole(role.value)}
                                className={`flex items-center gap-3 rounded-lg border px-4 py-3 text-left transition-colors ${
                                    pendingRole === role.value
                                        ? "border-primary bg-primary/10"
                                        : "border-border hover:border-primary/50 hover:bg-muted"
                                }`}
                            >
                                <role.icon
                                    className={`h-5 w-5 ${
                                        pendingRole === role.value
                                            ? "text-primary"
                                            : "text-muted-foreground"
                                    }`}
                                />
                                <div>
                                    <p className="text-foreground text-sm font-medium">
                                        {role.label}
                                    </p>
                                    <p className="text-muted-foreground text-xs">
                                        {role.value === "free" &&
                                            "Standard access, must use own proxies"}
                                        {role.value === "premium" &&
                                            "Can use server proxies"}
                                        {role.value === "admin" &&
                                            "Full access + user management"}
                                    </p>
                                </div>
                                {pendingRole === role.value && (
                                    <div className="bg-primary ml-auto h-2 w-2 rounded-full" />
                                )}
                            </button>
                        ))}
                    </div>

                    <DialogFooter>
                        <Button
                            variant="outline"
                            onClick={() => setIsOpen(false)}
                        >
                            Cancel
                        </Button>
                        <Button onClick={handleSave}>Save</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <Dialog
                open={isProxyDialogOpen}
                onOpenChange={setIsProxyDialogOpen}
            >
                <DialogContent className="sm:max-w-2xl">
                    <DialogHeader>
                        <DialogTitle>Server Proxies</DialogTitle>
                        <DialogDescription>
                            Used by premium and admin monitors when they select
                            Server Proxies. One proxy per line.
                        </DialogDescription>
                    </DialogHeader>

                    <div className="space-y-3">
                        <textarea
                            value={serverProxies}
                            onChange={(event) =>
                                setServerProxies(event.target.value)
                            }
                            spellCheck={false}
                            placeholder="http://user:pass@host:port&#10;host:port:user:pass"
                            className="border-input bg-background ring-offset-background placeholder:text-muted-foreground focus-visible:ring-ring min-h-72 w-full rounded-md border px-3 py-2 font-mono text-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                        />
                        <p className="text-muted-foreground text-xs">
                            Current input contains {serverProxyLineCount}{" "}
                            non-empty lines. The worker refreshes this setting
                            every sync cycle.
                        </p>
                    </div>

                    <DialogFooter>
                        <Button
                            variant="outline"
                            onClick={() => setIsProxyDialogOpen(false)}
                        >
                            Close
                        </Button>
                        <Button
                            type="button"
                            onClick={handleSaveServerProxies}
                            disabled={isSavingServerProxies}
                        >
                            {isSavingServerProxies
                                ? "Saving..."
                                : "Save Proxies"}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <Dialog open={isDetailsOpen} onOpenChange={setIsDetailsOpen}>
                <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl">
                    <DialogHeader>
                        <DialogTitle>User Details</DialogTitle>
                        <DialogDescription>
                            Overview, monitor activity, and quick admin actions
                            for <strong>{selected?.name ?? "User"}</strong>.
                        </DialogDescription>
                    </DialogHeader>

                    {selected ? (
                        <div className="space-y-6">
                            <div className="border-border/60 bg-muted/20 flex flex-col gap-4 rounded-lg border p-4 sm:flex-row sm:items-start sm:justify-between">
                                <div className="flex items-center gap-3">
                                    {selected.image ? (
                                        <img
                                            src={selected.image}
                                            alt=""
                                            className="h-14 w-14 rounded-full object-cover"
                                        />
                                    ) : (
                                        <div className="bg-muted text-muted-foreground flex h-14 w-14 items-center justify-center rounded-full text-base font-bold">
                                            {selected.name?.[0]?.toUpperCase() ??
                                                "?"}
                                        </div>
                                    )}
                                    <div className="space-y-1">
                                        <div className="flex flex-wrap items-center gap-2">
                                            <p className="text-foreground text-lg font-semibold">
                                                {selected.name ?? "Unknown"}
                                            </p>
                                            {getRoleBadge(selected.role)}
                                            {selected.id === currentUserId ? (
                                                <Badge
                                                    variant="outline"
                                                    className="rounded-full text-[10px] tracking-wide uppercase"
                                                >
                                                    You
                                                </Badge>
                                            ) : null}
                                        </div>
                                        <p className="text-muted-foreground text-sm">
                                            {selected.email ?? "No email"}
                                        </p>
                                        <p className="text-muted-foreground text-xs">
                                            User ID: {selected.id}
                                        </p>
                                    </div>
                                </div>

                                <div className="flex flex-wrap items-center gap-2">
                                    {selected.id !== currentUserId ? (
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            className="h-9 rounded-lg text-xs"
                                            onClick={() =>
                                                openRoleDialog(selected)
                                            }
                                        >
                                            Change Role
                                        </Button>
                                    ) : null}
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        className="h-9 rounded-lg text-xs text-amber-700 hover:text-amber-800"
                                        onClick={handleStopUserMonitors}
                                        disabled={
                                            isLoadingSelectedDetails ||
                                            selectedRunningMonitors === 0 ||
                                            isStoppingMonitors
                                        }
                                    >
                                        <PauseCircle className="mr-1.5 h-3.5 w-3.5" />
                                        Stop Running Monitors
                                    </Button>
                                </div>
                            </div>

                            <div className="border-border/60 bg-card rounded-lg border px-4 py-4 sm:px-5">
                                <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_minmax(260px,320px)] md:items-center">
                                    <div className="min-w-0 space-y-3">
                                        <div>
                                            <p className="text-foreground text-sm font-semibold">
                                                Active Monitor Limit
                                            </p>
                                            <p className="text-muted-foreground mt-1 text-xs">
                                                Empty override uses the role or
                                                global fallback.
                                            </p>
                                        </div>
                                        <div className="flex flex-wrap gap-2">
                                            <Badge
                                                variant="outline"
                                                className="rounded-md px-2 py-1 text-[11px]"
                                            >
                                                Effective:{" "}
                                                {formatLimit(
                                                    selectedEffectiveLimit.value,
                                                )}
                                            </Badge>
                                            <Badge
                                                variant="secondary"
                                                className="rounded-md px-2 py-1 text-[11px]"
                                            >
                                                Source:{" "}
                                                {selectedEffectiveLimit.source}
                                            </Badge>
                                            <Badge
                                                variant="secondary"
                                                className="rounded-md px-2 py-1 text-[11px]"
                                            >
                                                Running:{" "}
                                                {selectedRunningMonitors}
                                            </Badge>
                                        </div>
                                    </div>
                                    {selected.role === "admin" ? (
                                        <div className="border-border/60 bg-muted/30 text-muted-foreground rounded-lg border px-3 py-2 text-xs">
                                            Admin accounts are always unlimited.
                                        </div>
                                    ) : (
                                        <div className="space-y-2">
                                            <Label
                                                htmlFor="user-monitor-limit"
                                                className="text-xs"
                                            >
                                                User override
                                            </Label>
                                            <div className="flex gap-2">
                                                <Input
                                                    id="user-monitor-limit"
                                                    type="number"
                                                    min={0}
                                                    className="h-10"
                                                    value={userLimitInput}
                                                    onChange={(event) =>
                                                        setUserLimitInput(
                                                            event.target.value,
                                                        )
                                                    }
                                                    placeholder="Role/global"
                                                />
                                                <Button
                                                    type="button"
                                                    variant="outline"
                                                    className="h-10 shrink-0 px-4"
                                                    onClick={
                                                        handleSaveUserLimit
                                                    }
                                                >
                                                    Save
                                                </Button>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </div>

                            <div className="border-border/60 bg-card rounded-lg border px-4 py-4 sm:px-5">
                                <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_minmax(260px,320px)] md:items-center">
                                    <div className="min-w-0 space-y-3">
                                        <div>
                                            <p className="text-foreground text-sm font-semibold">
                                                Running Free Proxy Monitor Limit
                                            </p>
                                            <p className="text-muted-foreground mt-1 text-xs">
                                                Empty override uses the role or
                                                global fallback. Lower limits
                                                pause the newest excess
                                                monitors.
                                            </p>
                                        </div>
                                        <div className="flex flex-wrap gap-2">
                                            <Badge
                                                variant="outline"
                                                className="rounded-md px-2 py-1 text-[11px]"
                                            >
                                                Effective:{" "}
                                                {formatLimit(
                                                    selectedEffectiveFreeProxyLimit.value,
                                                )}
                                            </Badge>
                                            <Badge
                                                variant="secondary"
                                                className="rounded-md px-2 py-1 text-[11px]"
                                            >
                                                Source:{" "}
                                                {
                                                    selectedEffectiveFreeProxyLimit.source
                                                }
                                            </Badge>
                                            <Badge
                                                variant="secondary"
                                                className="rounded-md px-2 py-1 text-[11px]"
                                            >
                                                Running Free Pool:{" "}
                                                {
                                                    selectedRunningFreeProxyMonitors
                                                }
                                            </Badge>
                                        </div>
                                    </div>
                                    {selected.role === "admin" ? (
                                        <div className="border-border/60 bg-muted/30 text-muted-foreground rounded-lg border px-3 py-2 text-xs">
                                            Admin accounts are always unlimited.
                                        </div>
                                    ) : (
                                        <div className="space-y-2">
                                            <Label
                                                htmlFor="user-free-proxy-monitor-limit"
                                                className="text-xs"
                                            >
                                                User override
                                            </Label>
                                            <div className="flex gap-2">
                                                <Input
                                                    id="user-free-proxy-monitor-limit"
                                                    type="number"
                                                    min={0}
                                                    className="h-10"
                                                    value={
                                                        userFreeProxyLimitInput
                                                    }
                                                    onChange={(event) =>
                                                        setUserFreeProxyLimitInput(
                                                            event.target.value,
                                                        )
                                                    }
                                                    placeholder="Role/global"
                                                />
                                                <Button
                                                    type="button"
                                                    variant="outline"
                                                    className="h-10 shrink-0 px-4"
                                                    onClick={
                                                        handleSaveUserFreeProxyLimit
                                                    }
                                                >
                                                    Save
                                                </Button>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </div>

                            <div className="border-border/60 bg-card rounded-lg border p-4 sm:p-5">
                                <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                                    <div>
                                        <p className="text-sm font-semibold">
                                            Monitor Runtime
                                        </p>
                                        <p className="text-muted-foreground text-xs">
                                            Aggregate monitor-hours for this
                                            member.
                                        </p>
                                    </div>
                                    <span className="text-muted-foreground text-[10px] uppercase">
                                        {overviewState?.runtime.trackedSince
                                            ? `Tracked since ${new Intl.DateTimeFormat("de-DE", { dateStyle: "medium" }).format(new Date(overviewState.runtime.trackedSince))}`
                                            : "Tracking from feature launch"}
                                    </span>
                                </div>
                                <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                                    {[
                                        [
                                            "Total",
                                            selected.metrics
                                                .totalRuntimeSeconds,
                                        ],
                                        [
                                            "Open sessions",
                                            selected.metrics
                                                .currentRuntimeSeconds,
                                        ],
                                        [
                                            "Last 7 days",
                                            selected.runtimeDetails
                                                ?.runtimeSeconds7d ?? 0,
                                        ],
                                        [
                                            "Average session",
                                            selected.runtimeDetails
                                                ?.averageSessionSeconds ?? 0,
                                        ],
                                    ].map(([label, value]) => (
                                        <div
                                            key={String(label)}
                                            className="bg-muted/30 rounded-lg px-4 py-3"
                                        >
                                            <p className="text-muted-foreground text-[10px] uppercase">
                                                {label}
                                            </p>
                                            <p className="mt-1 text-xl font-semibold tabular-nums">
                                                {isLoadingSelectedDetails
                                                    ? "—"
                                                    : formatRuntime(
                                                          Number(value),
                                                      )}
                                            </p>
                                        </div>
                                    ))}
                                </div>
                            </div>

                            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                                <Card className="py-0">
                                    <CardHeader className="pt-3 pb-2">
                                        <CardDescription>
                                            Total Monitors
                                        </CardDescription>
                                        <CardTitle className="text-2xl">
                                            {selected._count.monitors}
                                        </CardTitle>
                                    </CardHeader>
                                </Card>
                                <Card className="py-0">
                                    <CardHeader className="pt-3 pb-2">
                                        <CardDescription>
                                            Running Now
                                        </CardDescription>
                                        <CardTitle className="text-2xl text-emerald-600">
                                            {selectedRunningMonitors}
                                        </CardTitle>
                                    </CardHeader>
                                </Card>
                                <Card className="py-0">
                                    <CardHeader className="pt-3 pb-2">
                                        <CardDescription>
                                            Paused Monitors
                                        </CardDescription>
                                        <CardTitle className="text-2xl">
                                            {selected.metrics.pausedMonitors}
                                        </CardTitle>
                                    </CardHeader>
                                </Card>
                                <Card className="py-0">
                                    <CardHeader className="pt-3 pb-2">
                                        <CardDescription>
                                            Found Items
                                        </CardDescription>
                                        <CardTitle className="text-2xl">
                                            {selectedItems}
                                        </CardTitle>
                                    </CardHeader>
                                </Card>
                                <Card className="py-0">
                                    <CardHeader className="pt-3 pb-2">
                                        <CardDescription>
                                            New Items 24h
                                        </CardDescription>
                                        <CardTitle className="text-2xl text-sky-600">
                                            {selected.metrics.newItems24h}
                                        </CardTitle>
                                    </CardHeader>
                                </Card>
                                <Card className="py-0">
                                    <CardHeader className="pt-3 pb-2">
                                        <CardDescription>
                                            Canonical checks 24h
                                        </CardDescription>
                                        <CardTitle className="text-2xl">
                                            {selected.metrics.checks24h}
                                        </CardTitle>
                                    </CardHeader>
                                </Card>
                                <Card className="py-0">
                                    <CardHeader className="pt-3 pb-2">
                                        <CardDescription>
                                            Success Rate
                                        </CardDescription>
                                        <CardTitle className="flex items-center gap-2 text-2xl">
                                            <CheckCircle2 className="h-5 w-5 text-emerald-600" />
                                            {formatSuccessRate(
                                                selected.metrics.successRate24h,
                                            )}
                                        </CardTitle>
                                    </CardHeader>
                                </Card>
                                <Card className="py-0">
                                    <CardHeader className="pt-3 pb-2">
                                        <CardDescription>
                                            Failed Checks
                                        </CardDescription>
                                        <CardTitle className="flex items-center gap-2 text-2xl">
                                            <AlertTriangle
                                                className={`h-5 w-5 ${
                                                    selected.metrics
                                                        .failedChecks24h > 0
                                                        ? "text-amber-600"
                                                        : "text-muted-foreground"
                                                }`}
                                            />
                                            {selected.metrics.failedChecks24h}
                                        </CardTitle>
                                    </CardHeader>
                                </Card>
                                <Card className="py-0">
                                    <CardHeader className="pt-3 pb-2">
                                        <CardDescription>
                                            Avg Duration
                                        </CardDescription>
                                        <CardTitle className="text-2xl">
                                            {formatDuration(
                                                selected.metrics
                                                    .avgDurationMs24h,
                                            )}
                                        </CardTitle>
                                    </CardHeader>
                                </Card>
                            </div>

                            <div className="border-border/60 bg-card rounded-lg border px-4 py-3">
                                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                                    <div>
                                        <p className="text-foreground text-sm font-semibold">
                                            24h Monitor Health
                                        </p>
                                        <p className="text-muted-foreground text-xs">
                                            Last check:{" "}
                                            {formatMetricDate(
                                                selected.metrics.lastCheckAt,
                                            )}
                                        </p>
                                    </div>
                                    <Badge
                                        variant={
                                            selected.metrics.failedChecks24h > 0
                                                ? "outline"
                                                : "secondary"
                                        }
                                        className="self-start sm:self-auto"
                                    >
                                        {selected.metrics.failedChecks24h > 0
                                            ? `${selected.metrics.failedChecks24h} failures`
                                            : "No recent failures"}
                                    </Badge>
                                </div>
                                {selected.metrics.latestError24h ? (
                                    <AdminMonitorError
                                        message={
                                            selected.metrics.latestError24h
                                        }
                                    />
                                ) : null}
                            </div>

                            <div className="border-border/60 bg-card rounded-lg border">
                                <div className="flex items-center justify-between px-4 py-3">
                                    <div>
                                        <p className="text-foreground text-sm font-semibold">
                                            Running Monitors
                                        </p>
                                        <p className="text-muted-foreground text-xs">
                                            {selectedRunningMonitors} currently
                                            active
                                        </p>
                                    </div>
                                </div>
                                <Separator />
                                {isLoadingSelectedDetails ? (
                                    <div className="text-muted-foreground px-4 py-8 text-center text-sm">
                                        Loading monitor details...
                                    </div>
                                ) : selectedActiveMonitors.length > 0 ? (
                                    <div className="divide-border/50 divide-y">
                                        {selectedActiveMonitors.map(
                                            (monitor) => (
                                                <div
                                                    key={monitor.id}
                                                    className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
                                                >
                                                    <div className="min-w-0 space-y-1">
                                                        <div className="flex flex-wrap items-center gap-2">
                                                            <p className="text-foreground text-sm font-medium">
                                                                {monitor.name}
                                                            </p>
                                                            <Badge className="bg-emerald-50 text-emerald-700">
                                                                Running
                                                            </Badge>
                                                            <Badge variant="outline">
                                                                #{monitor.id}
                                                            </Badge>
                                                        </div>
                                                        <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                                                            <span>
                                                                Query:{" "}
                                                                {monitor.query}
                                                            </span>
                                                            <span>
                                                                {getRegionLabel(
                                                                    monitor.region,
                                                                )}
                                                            </span>
                                                            <span>
                                                                {
                                                                    monitor.query_delay_ms
                                                                }{" "}
                                                                ms delay
                                                            </span>
                                                            <span>
                                                                {
                                                                    monitor
                                                                        ._count
                                                                        .items
                                                                }{" "}
                                                                items
                                                            </span>
                                                            <span>
                                                                {monitorProxyLabel(
                                                                    monitor,
                                                                )}
                                                            </span>
                                                            <span className="inline-flex items-center gap-1 font-medium text-emerald-600 dark:text-emerald-400">
                                                                <Clock3 className="h-3.5 w-3.5" />
                                                                Running for{" "}
                                                                {formatRuntime(
                                                                    monitor.active_since
                                                                        ? (nowMs -
                                                                              new Date(
                                                                                  monitor.active_since,
                                                                              ).getTime()) /
                                                                              1000
                                                                        : 0,
                                                                )}{" "}
                                                                ·{" "}
                                                                {formatRuntime(
                                                                    monitorRuntimeSeconds(
                                                                        monitor,
                                                                        nowMs,
                                                                    ),
                                                                )}{" "}
                                                                total
                                                            </span>
                                                            {monitor.price_max ? (
                                                                <span>
                                                                    Max{" "}
                                                                    {
                                                                        monitor.price_max
                                                                    }{" "}
                                                                    EUR
                                                                </span>
                                                            ) : null}
                                                            <span>
                                                                {[
                                                                    monitor.discord_webhook &&
                                                                    monitor.webhook_active
                                                                        ? "Discord"
                                                                        : null,
                                                                    monitor.telegram_active
                                                                        ? "Telegram"
                                                                        : null,
                                                                ]
                                                                    .filter(
                                                                        Boolean,
                                                                    )
                                                                    .join(
                                                                        " + ",
                                                                    ) ||
                                                                    "Notifications off"}
                                                            </span>
                                                        </div>
                                                    </div>
                                                    <Button
                                                        variant="outline"
                                                        size="sm"
                                                        className="h-8 shrink-0 text-xs text-amber-700 hover:text-amber-800"
                                                        onClick={() =>
                                                            handleStopSingleMonitor(
                                                                selected.id,
                                                                monitor.id,
                                                            )
                                                        }
                                                        disabled={
                                                            stoppingMonitorId ===
                                                            monitor.id
                                                        }
                                                    >
                                                        <PauseCircle className="mr-1.5 h-3.5 w-3.5" />
                                                        Stop Monitor
                                                    </Button>
                                                </div>
                                            ),
                                        )}
                                    </div>
                                ) : (
                                    <div className="text-muted-foreground px-4 py-8 text-center text-sm">
                                        This user has no running monitors.
                                    </div>
                                )}
                            </div>

                            <div className="border-border/60 bg-card rounded-lg border">
                                <div className="px-4 py-3">
                                    <p className="text-foreground text-sm font-semibold">
                                        All Monitors
                                    </p>
                                    <p className="text-muted-foreground text-xs">
                                        Running and paused monitors with key
                                        details.
                                    </p>
                                </div>
                                <Separator />
                                {isLoadingSelectedDetails ? (
                                    <div className="text-muted-foreground px-4 py-8 text-center text-sm">
                                        Loading monitor details...
                                    </div>
                                ) : selected.monitors.length > 0 ? (
                                    <div className="divide-border/50 divide-y">
                                        {[
                                            ...selectedActiveMonitors,
                                            ...selectedPausedMonitors,
                                        ].map((monitor) => (
                                            <div
                                                key={monitor.id}
                                                className="flex flex-col gap-3 px-4 py-3 lg:flex-row lg:items-center lg:justify-between"
                                            >
                                                <div className="min-w-0 space-y-1">
                                                    <div className="flex flex-wrap items-center gap-2">
                                                        <p className="text-foreground text-sm font-medium">
                                                            {monitor.name}
                                                        </p>
                                                        <Badge
                                                            variant={
                                                                monitor.status ===
                                                                "active"
                                                                    ? "default"
                                                                    : "secondary"
                                                            }
                                                            className={
                                                                monitor.status ===
                                                                "active"
                                                                    ? "bg-emerald-50 text-emerald-700"
                                                                    : ""
                                                            }
                                                        >
                                                            {monitor.status ===
                                                            "active"
                                                                ? "Running"
                                                                : "Paused"}
                                                        </Badge>
                                                        <Badge variant="outline">
                                                            #{monitor.id}
                                                        </Badge>
                                                    </div>
                                                    <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                                                        <span>
                                                            Query:{" "}
                                                            {monitor.query}
                                                        </span>
                                                        <span className="inline-flex items-center gap-1">
                                                            <Clock3 className="h-3.5 w-3.5" />
                                                            {formatCreatedAt(
                                                                monitor.created_at,
                                                            )}
                                                        </span>
                                                        <span className="inline-flex items-center gap-1">
                                                            <Boxes className="h-3.5 w-3.5" />
                                                            {
                                                                monitor._count
                                                                    .items
                                                            }{" "}
                                                            items
                                                        </span>
                                                        <span>
                                                            {getRegionLabel(
                                                                monitor.region,
                                                            )}
                                                        </span>
                                                        <span>
                                                            {
                                                                monitor.query_delay_ms
                                                            }{" "}
                                                            ms delay
                                                        </span>
                                                        <span>
                                                            {monitorProxyLabel(
                                                                monitor,
                                                            )}
                                                        </span>
                                                        <span className="inline-flex items-center gap-1 font-medium">
                                                            <Clock3 className="h-3.5 w-3.5" />
                                                            {formatRuntime(
                                                                monitorRuntimeSeconds(
                                                                    monitor,
                                                                    nowMs,
                                                                ),
                                                            )}{" "}
                                                            total
                                                            {monitor.status ===
                                                                "active" &&
                                                            monitor.active_since
                                                                ? ` · ${formatRuntime((nowMs - new Date(monitor.active_since).getTime()) / 1000)} running`
                                                                : ""}
                                                        </span>
                                                        {monitor.price_min ||
                                                        monitor.price_max ? (
                                                            <span>
                                                                Price{" "}
                                                                {monitor.price_min ??
                                                                    0}
                                                                -
                                                                {monitor.price_max ??
                                                                    "any"}{" "}
                                                                EUR
                                                            </span>
                                                        ) : null}
                                                        <span className="inline-flex items-center gap-1">
                                                            <Webhook className="h-3.5 w-3.5" />
                                                            {[
                                                                monitor.discord_webhook
                                                                    ? monitor.webhook_active
                                                                        ? "Discord active"
                                                                        : "Discord paused"
                                                                    : null,
                                                                monitor.telegram_active
                                                                    ? "Telegram active"
                                                                    : null,
                                                            ]
                                                                .filter(Boolean)
                                                                .join(" / ") ||
                                                                "No notifications"}
                                                        </span>
                                                    </div>
                                                </div>
                                                <Badge
                                                    variant="outline"
                                                    className="shrink-0"
                                                >
                                                    {monitor.status === "active"
                                                        ? "Running"
                                                        : "Paused"}
                                                </Badge>
                                            </div>
                                        ))}
                                    </div>
                                ) : (
                                    <div className="text-muted-foreground px-4 py-8 text-center text-sm">
                                        This user has not created any monitors
                                        yet.
                                    </div>
                                )}
                            </div>
                        </div>
                    ) : null}

                    <DialogFooter>
                        <Button
                            variant="outline"
                            onClick={() => setIsDetailsOpen(false)}
                        >
                            Close
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
