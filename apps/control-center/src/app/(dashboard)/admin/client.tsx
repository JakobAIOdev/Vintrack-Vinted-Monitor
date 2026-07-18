"use client";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
    Activity,
    AlertTriangle,
    BarChart3,
    CheckCircle2,
    ChevronDown,
    ChevronLeft,
    ChevronRight,
    Shield,
    Crown,
    User,
    Monitor,
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
    setRoleActiveMonitorLimit,
    setUserRole,
    setUserActiveMonitorLimit,
    getAdminActiveMonitors,
    getAdminUsersState,
    getAdminLogs,
    getFreeProxyAdminState,
    getAdminUserDetails,
    addFreeProxies,
    clearFreeProxyQuarantine,
    importFreeProxiesNow,
    updateFreeProxySettings,
    updateServerProxies,
    stopSingleUserMonitor,
    stopUserActiveMonitors,
} from "@/actions/admin";
import { getRegionLabel, REGIONS } from "@/lib/regions";

type UserMonitor = {
    id: number;
    name: string;
    query: string;
    query_delay_ms: number;
    status: string | null;
    region: string;
    created_at: Date | null;
    price_min: number | null;
    price_max: number | null;
    discord_webhook: string | null;
    webhook_active: boolean;
    telegram_active: boolean;
    proxy_group: { name: string } | null;
    _count: { items: number };
};

type ActiveMonitor = Omit<UserMonitor, "discord_webhook"> & {
    discord_configured: boolean;
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
};

type AdminTab =
    | "overview"
    | "monitors"
    | "users"
    | "roles"
    | "logs"
    | "settings";

type AdminLogRow = {
    id: string;
    type: "audit" | "monitor" | "alert";
    title: string;
    detail: string | null;
    status: string;
    subject: string | null;
    actor: string | null;
    createdAt: Date;
};

type MonitorLimits = {
    global: number | null;
    roles: Record<string, number | null>;
    users: Record<string, number | null>;
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
        warming: number;
        pending: number;
        cooldown: number;
        dead: number;
        successRate: number | null;
        medianLatencyMs: number | null;
        lastCheckedAt: Date | null;
        healthy: boolean;
    }[];
    recent: FreeProxyRow[];
};

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
        value: "monitors",
        label: "Running Monitors",
        icon: Monitor,
        description: "All currently running monitors, grouped by member.",
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

function limitInputValue(value: number | null | undefined) {
    return value === null || value === undefined ? "" : String(value);
}

function formatLimit(value: number | null) {
    return value === null ? "Unlimited" : `${value} active`;
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
    freeProxyState: initialFreeProxyState,
    monitorLimits: initialMonitorLimits,
}: {
    users: UserRow[];
    logs: AdminLogRow[];
    initialTab?: string;
    currentUserId: string;
    serverProxies: string;
    freeProxyState: FreeProxyState;
    monitorLimits: MonitorLimits;
}) {
    const [users, setUsers] = useState<UserRow[]>(initialUsers);
    const [adminLogs, setAdminLogs] = useState<AdminLogRow[]>(logs);
    const [logsLoaded, setLogsLoaded] = useState(logs.length > 0);
    const [isLoadingLogs, setIsLoadingLogs] = useState(false);
    const [usersLoaded, setUsersLoaded] = useState(initialUsers.length > 0);
    const [isLoadingUsers, setIsLoadingUsers] = useState(false);
    const [usersLoadFailed, setUsersLoadFailed] = useState(false);
    const usersLoadedRef = useRef(initialUsers.length > 0);
    const usersRequestRef = useRef<Promise<boolean> | null>(null);
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
    const [serverProxies, setServerProxies] = useState(initialServerProxies);
    const [isSavingServerProxies, setIsSavingServerProxies] = useState(false);
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
    const starterRegionSet = new Set(
        freeProxySettings.starterRegions
            .split(",")
            .map((region) => region.trim().toLowerCase())
            .filter(Boolean),
    );
    const freeProxyHealthByRegion = new Map(
        freeProxyState.regions.map((region) => [region.region, region]),
    );
    const displayedFreeProxyRegions = REGIONS.filter((region) =>
        starterRegionSet.has(region.code),
    ).map((region) => {
        const health = freeProxyHealthByRegion.get(region.code);
        return health
            ? { ...health, initializing: false }
            : {
                  region: region.code,
                  active: 0,
                  warming: 0,
                  pending: 0,
                  cooldown: 0,
                  dead: 0,
                  successRate: null,
                  medianLatencyMs: null,
                  lastCheckedAt: null,
                  healthy: false,
                  initializing: true,
              };
    });

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

    const loadAdminLogs = () => {
        if (logsLoaded || isLoadingLogs) return;

        setIsLoadingLogs(true);
        getAdminLogs()
            .then((nextLogs) => {
                setAdminLogs(nextLogs);
                setLogsLoaded(true);
            })
            .catch(() => {
                toast.error("Failed to load admin logs");
            })
            .finally(() => setIsLoadingLogs(false));
    };

    const loadAdminUsers = () => {
        if (usersLoadedRef.current) return Promise.resolve(true);
        if (usersRequestRef.current) return usersRequestRef.current;

        setIsLoadingUsers(true);
        setUsersLoadFailed(false);

        const request = getAdminUsersState()
            .then((state) => {
                setUsers((currentUsers) => {
                    const activeMonitorsByUser = new Map(
                        currentUsers.map((user) => [
                            user.id,
                            user.activeMonitors,
                        ]),
                    );

                    return state.users.map((user) => ({
                        ...user,
                        activeMonitors: activeMonitorsByUser.get(user.id) ?? [],
                    }));
                });
                setMonitorLimits((current) => ({
                    ...current,
                    users: state.userLimits,
                }));
                usersLoadedRef.current = true;
                setUsersLoaded(true);
                return true;
            })
            .catch(() => {
                setUsersLoadFailed(true);
                toast.error("Failed to load member metrics");
                return false;
            })
            .finally(() => {
                usersRequestRef.current = null;
                setIsLoadingUsers(false);
            });

        usersRequestRef.current = request;
        return request;
    };

    const loadActiveMonitors = () => {
        if (activeMonitorsLoaded || activeMonitorsRequestRef.current) return;

        setIsLoadingActiveMonitors(true);
        setActiveMonitorsLoadFailed(false);

        const request = loadAdminUsers()
            .then((loaded) =>
                loaded ? getAdminActiveMonitors() : Promise.resolve(null),
            )
            .then((monitors) => {
                if (!monitors) {
                    setActiveMonitorsLoadFailed(true);
                    return;
                }
                const monitorsByUser = new Map<string, ActiveMonitor[]>();

                for (const { userId, ...monitor } of monitors) {
                    const current = monitorsByUser.get(userId) ?? [];
                    current.push(monitor);
                    monitorsByUser.set(userId, current);
                }

                setUsers((currentUsers) =>
                    currentUsers.map((user) => ({
                        ...user,
                        activeMonitors: monitorsByUser.get(user.id) ?? [],
                    })),
                );
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
        void loadAdminUsers();
        if (tab === "logs") loadAdminLogs();
        if (tab === "monitors") loadActiveMonitors();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const switchTab = (tab: AdminTab) => {
        setActiveTab(tab);
        const url = new URL(window.location.href);
        url.searchParams.set("tab", tab);
        window.history.replaceState(null, "", url.toString());

        if (["overview", "monitors", "users", "roles"].includes(tab)) {
            void loadAdminUsers();
        }
        if (tab === "logs") loadAdminLogs();
        if (tab === "monitors") loadActiveMonitors();
    };

    const normalizedQuery = searchQuery.trim().toLowerCase();
    const filteredUsers = users.filter((user) => {
        if (!normalizedQuery) return true;

        const searchable = [user.name ?? "", user.email ?? "", user.role]
            .join(" ")
            .toLowerCase();

        return searchable.includes(normalizedQuery);
    });
    const totalUserPages = Math.max(
        1,
        Math.ceil(filteredUsers.length / usersPerPage),
    );
    const currentUserPage = Math.min(userPage, totalUserPages);
    const userPageStart = (currentUserPage - 1) * usersPerPage;
    const paginatedUsers = filteredUsers.slice(
        userPageStart,
        userPageStart + usersPerPage,
    );
    const shownUserStart = filteredUsers.length === 0 ? 0 : userPageStart + 1;
    const shownUserEnd = Math.min(
        userPageStart + usersPerPage,
        filteredUsers.length,
    );

    const normalizedMonitorQuery = monitorSearchQuery.trim().toLowerCase();
    const activeMonitorMembers = users.filter(
        (user) => user.activeMonitors.length > 0,
    );
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
                          monitor.proxy_group?.name ?? "Server Proxies",
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

    const totalUsers = users.length;
    const freeUsers = users.filter((u) => u.role === "free").length;
    const premiumUsers = users.filter((u) => u.role === "premium").length;
    const adminUsers = users.filter((u) => u.role === "admin").length;
    const runningMonitors = users.reduce(
        (sum, user) => sum + user.metrics.runningMonitors,
        0,
    );
    const newItems24h = users.reduce(
        (sum, user) => sum + user.metrics.newItems24h,
        0,
    );
    const failedChecks24h = users.reduce(
        (sum, user) => sum + user.metrics.failedChecks24h,
        0,
    );
    const totalMonitors = users.reduce(
        (sum, user) => sum + user._count.monitors,
        0,
    );
    const pausedMonitors = users.reduce(
        (sum, user) => sum + user.metrics.pausedMonitors,
        0,
    );
    const checks24h = users.reduce(
        (sum, user) => sum + user.metrics.checks24h,
        0,
    );
    const successfulChecks24h = users.reduce(
        (sum, user) => sum + user.metrics.successfulChecks24h,
        0,
    );
    const successRate24h =
        checks24h > 0
            ? Math.round((successfulChecks24h / checks24h) * 100)
            : null;
    const topUsers = [...users]
        .sort(
            (a, b) =>
                b.metrics.runningMonitors - a.metrics.runningMonitors ||
                b.metrics.newItems24h - a.metrics.newItems24h ||
                b._count.monitors - a._count.monitors,
        )
        .slice(0, 5);
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
    const limitedUsers = users.filter((user) => {
        const limit = getEffectiveLimit(user);
        return (
            limit.value !== null && user.metrics.runningMonitors >= limit.value
        );
    });
    const userOverrides = users.filter(
        (user) =>
            monitorLimits.users[user.id] !== null &&
            monitorLimits.users[user.id] !== undefined,
    ).length;
    const roleLimitsConfigured = Object.values(monitorLimits.roles).filter(
        (value) => value !== null && value !== undefined,
    ).length;
    const activeMonitorShare =
        totalMonitors > 0
            ? Math.round((runningMonitors / totalMonitors) * 100)
            : 0;

    const hydrateUserDetails = async (user: UserRow) => {
        if (user.monitors.length > 0 || user._count.monitors === 0) {
            return user;
        }

        setLoadingUserDetailsId(user.id);
        const monitors = await getAdminUserDetails(user.id);
        const hydratedUser = {
            ...user,
            monitors,
            metrics: {
                ...user.metrics,
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

        toast.promise(setUserRole(selected.id, pendingRole), {
            loading: "Updating role...",
            success: `${selected.name ?? "User"} is now ${pendingRole}`,
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
        });
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
    const selectedItems = selected?.metrics.totalItems ?? 0;
    const selectedEffectiveLimit = selected
        ? getEffectiveLimit(selected)
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
    const hasOperationalIssues = successRate24h !== null && successRate24h < 90;

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
                                hasOperationalIssues
                                    ? "bg-amber-500"
                                    : "bg-emerald-500"
                            }`}
                        />
                        <span className="font-medium">
                            {hasOperationalIssues
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
                            Retry member metrics
                        </button>
                    ) : (
                        <span className="text-muted-foreground">
                            {usersLoaded
                                ? `${runningMonitors} running monitors`
                                : "Loading member metrics..."}
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
                            value={runningMonitors}
                            detail={`${pausedMonitors} paused monitors`}
                            icon={Activity}
                            iconClassName="bg-emerald-500/10 text-emerald-600"
                        />
                        <OverviewMetric
                            label="Canonical checks 24h"
                            value={checks24h}
                            detail={`${formatSuccessRate(successRate24h)} successful`}
                            icon={Gauge}
                            iconClassName="bg-sky-500/10 text-sky-600"
                        />
                        <OverviewMetric
                            label="New items 24h"
                            value={newItems24h}
                            detail="From completed monitor checks"
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
                                    {failedChecks24h > 0
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
                                        {pausedMonitors}
                                    </p>
                                </div>
                                <div className="border-border/60 rounded-lg border px-4 py-3">
                                    <p className="text-muted-foreground text-[11px] font-medium tracking-widest uppercase">
                                        Canonical checks 24h
                                    </p>
                                    <p className="mt-1 text-2xl font-semibold">
                                        {checks24h}
                                    </p>
                                </div>
                                <div className="border-border/60 rounded-lg border px-4 py-3">
                                    <p className="text-muted-foreground text-[11px] font-medium tracking-widest uppercase">
                                        Success rate
                                    </p>
                                    <p className="mt-1 text-2xl font-semibold">
                                        {formatSuccessRate(successRate24h)}
                                    </p>
                                </div>
                            </div>

                            <div className="mt-4 grid gap-3 sm:grid-cols-3">
                                <div className="bg-muted/30 rounded-lg px-4 py-3">
                                    <p className="text-muted-foreground text-xs">
                                        Successful checks
                                    </p>
                                    <p className="mt-1 text-xl font-semibold">
                                        {successfulChecks24h}
                                    </p>
                                </div>
                                <div className="bg-muted/30 rounded-lg px-4 py-3">
                                    <p className="text-muted-foreground text-xs">
                                        New items 24h
                                    </p>
                                    <p className="mt-1 text-xl font-semibold">
                                        {newItems24h}
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
                                    ["Users at limit", limitedUsers.length],
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
                            {limitedUsers.length > 0 ? (
                                <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 dark:border-amber-500/20 dark:bg-amber-500/10">
                                    <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
                                        {limitedUsers.length} user
                                        {limitedUsers.length === 1
                                            ? ""
                                            : "s"}{" "}
                                        at active monitor capacity
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
                                    Top Active Users
                                </p>
                                <p className="text-muted-foreground text-xs">
                                    Sorted by running monitors and 24h item
                                    output.
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
                                                {user.metrics.runningMonitors}{" "}
                                                running
                                            </p>
                                            <p className="text-muted-foreground">
                                                {user.metrics.newItems24h} items
                                                / 24h
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

            {activeTab === "monitors" ? (
                <div className="space-y-4">
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
                                                                                {monitor
                                                                                    .proxy_group
                                                                                    ?.name ??
                                                                                    "Server Proxies"}
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
                                {filteredUsers.length} of {totalUsers} users
                                shown
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
                                            colSpan={7}
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
                            {filteredUsers.length} users
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
                </>
            ) : null}

            {activeTab === "logs" ? (
                <div className="border-border/60 bg-card overflow-hidden rounded-lg border">
                    <div className="border-border/60 flex flex-col gap-1 border-b px-5 py-4">
                        <p className="text-foreground text-sm font-semibold">
                            Admin Logs
                        </p>
                        <p className="text-muted-foreground text-xs">
                            Latest audit, monitor, and alert events.
                        </p>
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

                        <div className="mt-5 grid gap-3 sm:grid-cols-2">
                            <label className="border-border/60 flex items-start gap-3 rounded-lg border px-4 py-3">
                                <input
                                    type="checkbox"
                                    checked={freeProxySettings.enabled}
                                    onChange={(event) =>
                                        setFreeProxySettings((prev) => ({
                                            ...prev,
                                            enabled: event.target.checked,
                                        }))
                                    }
                                    className="mt-1"
                                />
                                <span>
                                    <span className="text-sm font-medium">
                                        Enable for users
                                    </span>
                                    <span className="text-muted-foreground block text-xs">
                                        Shows Free Proxy Pool in monitor proxy
                                        selection.
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
                                        setFreeProxySettings((prev) => ({
                                            ...prev,
                                            autoImportEnabled:
                                                event.target.checked,
                                        }))
                                    }
                                    className="mt-1"
                                />
                                <span>
                                    <span className="text-sm font-medium">
                                        Auto import
                                    </span>
                                    <span className="text-muted-foreground block text-xs">
                                        Worker refreshes the configured source
                                        periodically.
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
                                        Imported proxies stay pending until
                                        Vintrack validates them against Vinted
                                        per starter region.
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
                                                            event.target.value,
                                                    );
                                                setFreeProxySettings(
                                                    (prev) => ({
                                                        ...prev,
                                                        importSource:
                                                            event.target.value,
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
                                                        key={option.value}
                                                        value={option.value}
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
                                            value={freeProxySettings.importUrl}
                                            onChange={(event) =>
                                                setFreeProxySettings(
                                                    (prev) => ({
                                                        ...prev,
                                                        importSource: "custom",
                                                        importUrl:
                                                            event.target.value,
                                                    }),
                                                )
                                            }
                                        />
                                    </div>
                                </div>
                                <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(0,1fr)_130px]">
                                    <div className="space-y-2">
                                        <div className="flex items-center justify-between gap-3">
                                            <Label>Starter regions</Label>
                                            <span className="text-muted-foreground text-[11px]">
                                                {starterRegionSet.size} selected
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
                                                        key={region.code}
                                                        type="button"
                                                        onClick={() =>
                                                            toggleStarterRegion(
                                                                region.code,
                                                            )
                                                        }
                                                        aria-pressed={selected}
                                                        className={`flex min-w-0 items-center justify-between gap-2 rounded-md border px-2.5 py-2 text-left text-xs transition-colors ${
                                                            selected
                                                                ? "border-primary bg-primary/5 text-foreground"
                                                                : "border-border/70 bg-background text-muted-foreground hover:bg-muted/50"
                                                        }`}
                                                    >
                                                        <span className="flex min-w-0 items-center gap-1.5">
                                                            <span>
                                                                {region.flag}
                                                            </span>
                                                            <span className="truncate">
                                                                {region.label}
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
                                        <Label htmlFor="free-proxy-max-pool">
                                            Max pool
                                        </Label>
                                        <Input
                                            id="free-proxy-max-pool"
                                            type="number"
                                            min={1}
                                            value={
                                                freeProxySettings.maxPoolSize
                                            }
                                            onChange={(event) =>
                                                setFreeProxySettings(
                                                    (prev) => ({
                                                        ...prev,
                                                        maxPoolSize: Number(
                                                            event.target.value,
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
                                        Two successful Vinted checks are needed
                                        before a proxy enters rotation.
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
                                                                event.target
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
                                                                event.target
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
                                                                event.target
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
                                                                event.target
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
                                                        maxLatencyMs: Number(
                                                            event.target.value,
                                                        ),
                                                    }),
                                                )
                                            }
                                        />
                                    </div>
                                </div>
                            </div>
                        </div>

                        <div className="mt-5 rounded-lg border">
                            <div className="border-border/60 flex items-center justify-between border-b px-4 py-3">
                                <div>
                                    <p className="text-sm font-semibold">
                                        Region Health
                                    </p>
                                    <p className="text-muted-foreground text-xs">
                                        Regions become usable at Min ready and
                                        keep validating until Target reserve is
                                        reached.
                                    </p>
                                </div>
                            </div>
                            <div className="divide-border/60 divide-y">
                                {displayedFreeProxyRegions.length > 0 ? (
                                    displayedFreeProxyRegions.map((region) => (
                                        <div
                                            key={region.region}
                                            className="grid gap-3 px-4 py-3 text-sm sm:grid-cols-[150px_1fr_90px_90px_110px]"
                                        >
                                            <div className="font-semibold">
                                                {getRegionLabel(region.region)}
                                            </div>
                                            <div className="flex flex-wrap gap-2 text-xs">
                                                <Badge
                                                    variant={
                                                        region.healthy
                                                            ? "secondary"
                                                            : "outline"
                                                    }
                                                    className="rounded-md uppercase"
                                                >
                                                    {region.initializing
                                                        ? "Waiting"
                                                        : !region.healthy
                                                          ? "Degraded"
                                                          : region.active +
                                                                  region.warming <
                                                              freeProxySettings.targetActivePerRegion
                                                            ? "Building"
                                                            : "Ready"}
                                                </Badge>
                                                <span className="text-muted-foreground">
                                                    {region.initializing
                                                        ? "Waiting for the worker to assign candidates"
                                                        : `${region.active + region.warming} usable / ${freeProxySettings.targetActivePerRegion} target / ${region.active} active / ${region.warming} warming / ${region.pending} pending / ${region.cooldown} cooldown / ${region.dead} dead`}
                                                </span>
                                            </div>
                                            <div className="text-muted-foreground">
                                                {region.successRate === null
                                                    ? "n/a"
                                                    : `${region.successRate}%`}{" "}
                                                24h ok
                                            </div>
                                            <div className="text-muted-foreground">
                                                {region.medianLatencyMs === null
                                                    ? "n/a"
                                                    : `${region.medianLatencyMs}ms`}
                                            </div>
                                            <div className="text-muted-foreground text-xs">
                                                {formatMetricDate(
                                                    region.lastCheckedAt,
                                                )}
                                            </div>
                                        </div>
                                    ))
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
                                    <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-200">
                                        {selected.metrics.latestError24h}
                                    </p>
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
                                                                {monitor
                                                                    .proxy_group
                                                                    ?.name ??
                                                                    "Server Proxies"}
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
                                                            {monitor.proxy_group
                                                                ?.name ??
                                                                "Server Proxies"}
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
