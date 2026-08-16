"use client";

import {
    useState,
    useMemo,
    useEffect,
    useCallback,
    useTransition,
} from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
    Bell,
    PauseCircle,
    PlayCircle,
    Plus,
    StopCircle,
    Webhook,
    MessageCircle,
    CheckCircle2,
    Copy,
    ExternalLink,
    Radio,
    Package,
    ArrowRight,
    Globe,
    Zap,
    AlertTriangle,
    Pencil,
    Send,
    Search,
    SlidersHorizontal,
    Timer,
    Settings,
    Trash2,
    UserX,
    Rocket,
    Clock3,
    ListChecks,
    Loader2,
    RefreshCw,
    Wrench,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import {
    startAllMonitors,
    stopAllMonitors,
    toggleMonitor,
    updateMonitorWebhook,
    setMonitorWebhookStatus,
    setMonitorNotificationsEnabled,
    toggleTelegramStatus,
    bulkUpdateMonitors,
    type BulkMonitorUpdateInput,
} from "@/actions/dashboard-actions";
import { testDiscordWebhook } from "@/actions/monitor";
import {
    updateDiscordMessageStyle,
    updateMonitorAlertDedupe,
    updateTelegramMessageStyle,
} from "@/actions/account";
import type { NotificationMessageStyle } from "@/lib/notification-message-style";
import { getBrandLabels } from "@/lib/brands";
import { getColorLabels } from "@/lib/colors";
import { getSizeLabels } from "@/lib/sizes";
import {
    getRegionLabel,
    getRegionFlags,
    getRegionTimezone,
    getStatusLocaleForRegionCodes,
    REGIONS,
} from "@/lib/regions";
import { getStatusLabels } from "@/lib/statuses";
import { getVideoGamePlatformLabels } from "@/lib/video-game-platforms";
import {
    formatQueryDelay,
    MAX_QUERY_DELAY_MS,
    MIN_QUERY_DELAY_MS,
} from "@/lib/monitor-delay";
import {
    DEFAULT_QUIET_HOURS_DELAY_MS,
    DEFAULT_QUIET_HOURS_END_MINUTE,
    DEFAULT_QUIET_HOURS_START_MINUTE,
    DEFAULT_QUIET_HOURS_TIMEZONE,
    minuteOfDayToTime,
} from "@/lib/monitor-schedule";
import {
    FirstMonitorQuickStart,
    type QuickStartPool,
} from "@/components/monitors/first-monitor-quick-start";
import { DEMO_MONITOR_DURATION_MS } from "@/lib/demo-monitor";
import { cn } from "@/lib/utils";
import { useMonitorMaintenance } from "@/components/maintenance/monitor-maintenance-context";
import {
    CreateMonitorLink,
    MONITOR_CREATION_MAINTENANCE_TITLE,
} from "@/components/maintenance/create-monitor-link";
import { FreePoolLimitDialog } from "@/components/free-pool-limit-dialog";
import type { MonitorActivationBlock } from "@/lib/monitor-limits";

type MonitorHealth = {
    monitor_id: number;
    total_checks: number;
    total_errors: number;
    consecutive_errors: number;
    last_error?: string;
    last_error_code?: string;
    proxy_state?: string;
    retry_at?: string;
    proxy_label?: string;
    updated_at: string;
};

export type Monitor = {
    id: number;
    name: string;
    query: string;
    query_delay_ms: number;
    quiet_hours_enabled: boolean;
    quiet_hours_start_minute: number;
    quiet_hours_end_minute: number;
    quiet_hours_mode: "pause" | "slow";
    quiet_hours_delay_ms: number;
    quiet_hours_timezone: string;
    status: string;
    price_max: number | null;
    catalog_ids: string | null;
    category_labels: string[];
    brand_ids: string | null;
    color_ids: string | null;
    status_ids: string | null;
    video_game_platform_ids: string | null;
    size_id: string | null;
    region: string;
    allowed_countries: string | null;
    min_seller_rating: number | null;
    min_seller_rating_count: number | null;
    discord_webhook: string | null;
    webhook_active: boolean;
    telegram_active: boolean;
    notifications_enabled: boolean;
    proxy_source: string;
    proxy_group_name: string | null;
    demo_expires_at: string | null;
    _count: { items: number };
    created_at: string;
};

export type FreePoolUsageSummary = {
    activeCount: number;
    limit: number;
    tier: string;
    limitReached: boolean;
};

type TelegramConnectionState = {
    connected: boolean;
    botUsername: string | null;
    connection: {
        chat_type: string | null;
        chat_title: string | null;
        username: string | null;
        updated_at: string;
    } | null;
};

type TelegramConnectCode = {
    code: string;
    expiresAt: string;
    botUsername: string | null;
    botLink: string | null;
};

type SellerBan = {
    id: string;
    seller_id: string;
    seller_login: string | null;
    seller_profile_url: string | null;
    created_at: string;
};

type BulkDiscordMode = "unchanged" | "enable" | "disable" | "replace";
type BulkTelegramMode = "unchanged" | "enable" | "disable";
type BulkNotificationsMode = "unchanged" | "enable" | "disable";

function getMonitorNotificationChannels(monitor: Monitor): string {
    const channels: string[] = [];
    if (monitor.discord_webhook && monitor.webhook_active) {
        channels.push("Discord");
    }
    if (monitor.telegram_active) {
        channels.push("Telegram");
    }
    return channels.join(" + ");
}

function hasActiveNotificationChannel(monitor: Monitor): boolean {
    return getMonitorNotificationChannels(monitor).length > 0;
}

async function readApiError(res: Response, fallback: string) {
    try {
        const data = await res.json();
        return data.error || fallback;
    } catch {
        return `${fallback} (${res.status})`;
    }
}

function hasProxyWarning(h?: MonitorHealth): boolean {
    if (!h) return false;
    if (
        h.proxy_state === "waiting_for_proxy" ||
        h.proxy_state === "unavailable"
    )
        return true;
    if (h.consecutive_errors === -1 || h.consecutive_errors >= 3) return true;
    return false;
}

function formatTimestamp(value: string) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "not yet";
    return date.toLocaleString();
}

function getMonitorFilterLabels(
    monitor: Monitor,
    memberBrandLabels: Record<string, string>,
): string[] {
    const labels = [...monitor.category_labels];

    if (monitor.brand_ids) {
        labels.push(...getBrandLabels(monitor.brand_ids, memberBrandLabels));
    }
    if (monitor.size_id) {
        labels.push(
            ...getSizeLabels(monitor.size_id).map((label) => `Size ${label}`),
        );
    }
    if (monitor.status_ids) {
        labels.push(
            ...getStatusLabels(
                monitor.status_ids,
                getStatusLocaleForRegionCodes(
                    monitor.allowed_countries,
                    monitor.region,
                ),
            ),
        );
    }
    if (monitor.color_ids) {
        labels.push(...getColorLabels(monitor.color_ids));
    }
    if (monitor.video_game_platform_ids) {
        labels.push(
            ...getVideoGamePlatformLabels(monitor.video_game_platform_ids),
        );
    }
    if (monitor.allowed_countries) {
        labels.push(
            `From ${getRegionFlags(monitor.allowed_countries).join(" ")}`,
        );
    }
    if (
        monitor.min_seller_rating != null &&
        monitor.min_seller_rating_count != null
    ) {
        labels.unshift(
            `Seller ≥ ${monitor.min_seller_rating.toFixed(1)}★ · ${monitor.min_seller_rating_count}+ ratings`,
        );
    }

    return Array.from(new Set(labels));
}

function getMonitorProxyLabel(monitor: Monitor): string {
    if (monitor.proxy_source === "free") return "Free Proxy Pool";
    if (monitor.proxy_group_name) return monitor.proxy_group_name;
    return "Server Proxies";
}

function getDemoMonitorLabel(monitor: Monitor, now: number) {
    if (!monitor.demo_expires_at) return null;
    const remaining = new Date(monitor.demo_expires_at).getTime() - now;
    if (remaining <= 0) return "Demo ended";
    if (monitor.status !== "active") return "Demo paused";
    return `Demo · ${Math.max(1, Math.ceil(remaining / 60_000))}m`;
}

export function DashboardClient({
    initialMonitors,
    userName,
    initialDedupeMonitorAlerts,
    initialTelegramMessageStyle,
    initialDiscordMessageStyle,
    quickStartEligible,
    initialQuickStartOpen,
    quickStartPool,
    initialNow,
    memberBrandLabels,
    freePoolUsage,
}: {
    initialMonitors: Monitor[];
    userName: string;
    initialDedupeMonitorAlerts: boolean;
    initialTelegramMessageStyle: NotificationMessageStyle;
    initialDiscordMessageStyle: NotificationMessageStyle;
    quickStartEligible: boolean;
    initialQuickStartOpen: boolean;
    quickStartPool: QuickStartPool | null;
    initialNow: string;
    memberBrandLabels: Record<string, string>;
    freePoolUsage: FreePoolUsageSummary | null;
}) {
    const { maintenance } = useMonitorMaintenance();
    const maintenanceEnabled = maintenance.enabled;
    const [selectedMonitor, setSelectedMonitor] = useState<Monitor | null>(
        null,
    );
    const [webhookInput, setWebhookInput] = useState("");
    const [isWebhookOpen, setIsWebhookOpen] = useState(false);
    const [isWebhookActive, setIsWebhookActive] = useState(true);
    const [isUpdatingWebhookStatus, setIsUpdatingWebhookStatus] =
        useState(false);
    const [isTelegramActive, setIsTelegramActive] = useState(false);
    const [activationBlock, setActivationBlock] =
        useState<MonitorActivationBlock | null>(null);
    const [isTestingWebhook, setIsTestingWebhook] = useState(false);
    const [isTestingTelegram, setIsTestingTelegram] = useState(false);
    const [isCreatingTelegramCode, setIsCreatingTelegramCode] = useState(false);
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);
    const [telegramConnection, setTelegramConnection] =
        useState<TelegramConnectionState | null>(null);
    const [telegramConnectCode, setTelegramConnectCode] =
        useState<TelegramConnectCode | null>(null);
    const [monitors, setMonitors] = useState<Monitor[]>(initialMonitors);
    const [selectedMonitorIds, setSelectedMonitorIds] = useState<number[]>([]);
    const [isBulkEditOpen, setIsBulkEditOpen] = useState(false);
    const [isBulkSaving, setIsBulkSaving] = useState(false);
    const [bulkDiscordMode, setBulkDiscordMode] =
        useState<BulkDiscordMode>("unchanged");
    const [bulkWebhookUrl, setBulkWebhookUrl] = useState("");
    const [bulkTelegramMode, setBulkTelegramMode] =
        useState<BulkTelegramMode>("unchanged");
    const [bulkNotificationsMode, setBulkNotificationsMode] =
        useState<BulkNotificationsMode>("unchanged");
    const [notificationToggleIds, setNotificationToggleIds] = useState<
        Set<number>
    >(new Set());
    const [bulkApplyQueryDelay, setBulkApplyQueryDelay] = useState(false);
    const [bulkQueryDelayMs, setBulkQueryDelayMs] = useState("1500");
    const [bulkApplyQuietHours, setBulkApplyQuietHours] = useState(false);
    const [bulkQuietHoursEnabled, setBulkQuietHoursEnabled] = useState(false);
    const [bulkQuietHoursStart, setBulkQuietHoursStart] = useState(
        minuteOfDayToTime(DEFAULT_QUIET_HOURS_START_MINUTE),
    );
    const [bulkQuietHoursEnd, setBulkQuietHoursEnd] = useState(
        minuteOfDayToTime(DEFAULT_QUIET_HOURS_END_MINUTE),
    );
    const [bulkQuietHoursMode, setBulkQuietHoursMode] = useState<
        "pause" | "slow"
    >("pause");
    const [bulkQuietHoursDelayMs, setBulkQuietHoursDelayMs] = useState(
        String(DEFAULT_QUIET_HOURS_DELAY_MS),
    );
    const [bulkQuietHoursTimezone, setBulkQuietHoursTimezone] = useState(
        DEFAULT_QUIET_HOURS_TIMEZONE,
    );
    const [dedupeMonitorAlerts, setDedupeMonitorAlerts] = useState(
        initialDedupeMonitorAlerts,
    );
    const [telegramMessageStyle, setTelegramMessageStyle] = useState(
        initialTelegramMessageStyle,
    );
    const [discordMessageStyle, setDiscordMessageStyle] = useState(
        initialDiscordMessageStyle,
    );
    const [sellerBans, setSellerBans] = useState<SellerBan[]>([]);
    const [isSellerBansLoading, setIsSellerBansLoading] = useState(true);
    const [removingSellerId, setRemovingSellerId] = useState<string | null>(
        null,
    );
    const [healthMap, setHealthMap] = useState<Record<number, MonitorHealth>>(
        {},
    );
    const [isDedupePending, startDedupeTransition] = useTransition();
    const [isTelegramStylePending, startTelegramStyleTransition] =
        useTransition();
    const [isDiscordStylePending, startDiscordStyleTransition] =
        useTransition();
    const [isQuickStartOpen, setIsQuickStartOpen] = useState(
        initialQuickStartOpen,
    );
    const [demoNow, setDemoNow] = useState(() =>
        new Date(initialNow).getTime(),
    );
    const hasDemoMonitors = useMemo(
        () => monitors.some((monitor) => monitor.demo_expires_at),
        [monitors],
    );

    useEffect(() => {
        if (!hasDemoMonitors) return;
        const interval = window.setInterval(() => {
            const nextNow = Date.now();
            setDemoNow(nextNow);
            setMonitors((current) =>
                current.map((monitor) =>
                    monitor.status === "active" &&
                    monitor.demo_expires_at &&
                    new Date(monitor.demo_expires_at).getTime() <= nextNow
                        ? { ...monitor, status: "paused" }
                        : monitor,
                ),
            );
        }, 15_000);
        return () => window.clearInterval(interval);
    }, [hasDemoMonitors]);

    const handleTestWebhook = async () => {
        if (!webhookInput) {
            toast.error("Please enter a webhook URL first");
            return;
        }
        setIsTestingWebhook(true);
        const result = await testDiscordWebhook(webhookInput);
        setIsTestingWebhook(false);

        if (result.error) {
            toast.error(result.error);
        } else {
            toast.success("Test webhook sent successfully!");
        }
    };

    const fetchTelegramConnection = useCallback(async () => {
        try {
            const res = await fetch("/api/telegram/connection", {
                cache: "no-store",
            });
            if (!res.ok) return;
            const data = (await res.json()) as TelegramConnectionState;
            setTelegramConnection(data);
            if (data.connected) {
                setTelegramConnectCode(null);
            }
        } catch {
            setTelegramConnection(null);
        }
    }, []);

    const handleCreateTelegramCode = async () => {
        setIsCreatingTelegramCode(true);
        try {
            const res = await fetch("/api/telegram/connect-code", {
                method: "POST",
            });
            if (!res.ok) {
                toast.error(
                    await readApiError(
                        res,
                        "Failed to create Telegram connect code",
                    ),
                );
                return;
            }
            const data = await res.json();
            setTelegramConnectCode(data);
            toast.success("Telegram connect code created");
        } catch (error) {
            toast.error(
                error instanceof Error
                    ? error.message
                    : "Failed to create Telegram connect code",
            );
        } finally {
            setIsCreatingTelegramCode(false);
        }
    };

    const handleCopyTelegramCode = async () => {
        if (!telegramConnectCode) return;
        try {
            await navigator.clipboard.writeText(
                `/connect ${telegramConnectCode.code}`,
            );
            toast.success("Telegram command copied");
        } catch {
            toast.error("Failed to copy Telegram command");
        }
    };

    const handleTestTelegram = async () => {
        setIsTestingTelegram(true);
        try {
            const res = await fetch("/api/telegram/test", { method: "POST" });
            if (!res.ok) {
                toast.error(
                    await readApiError(res, "Failed to send Telegram test"),
                );
                return;
            }
            toast.success("Test Telegram message sent successfully!");
        } catch (error) {
            toast.error(
                error instanceof Error
                    ? error.message
                    : "Failed to send Telegram test",
            );
        } finally {
            setIsTestingTelegram(false);
        }
    };

    const fetchHealth = useCallback(async () => {
        try {
            const res = await fetch("/api/monitors/health");
            if (res.ok) {
                const data = await res.json();
                setHealthMap(data);
            }
        } catch {}
    }, []);

    useEffect(() => {
        const timeout = window.setTimeout(fetchHealth, 0);
        const interval = setInterval(fetchHealth, 10_000);
        return () => {
            window.clearTimeout(timeout);
            clearInterval(interval);
        };
    }, [fetchHealth]);

    useEffect(() => {
        let cancelled = false;
        setIsSellerBansLoading(true);
        fetch("/api/seller-bans", { cache: "no-store" })
            .then((res) => (res.ok ? res.json() : []))
            .then((data) => {
                if (!cancelled && Array.isArray(data)) {
                    setSellerBans(data);
                }
            })
            .catch(() => {
                if (!cancelled) {
                    setSellerBans([]);
                }
            })
            .finally(() => {
                if (!cancelled) {
                    setIsSellerBansLoading(false);
                }
            });
        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        if (!isWebhookOpen) return;
        fetchTelegramConnection();
    }, [fetchTelegramConnection, isWebhookOpen]);

    useEffect(() => {
        if (!isWebhookOpen || !telegramConnectCode) return;
        let checking = false;
        const checkCode = async () => {
            if (checking) return;
            checking = true;
            try {
                const params = new URLSearchParams({
                    code: telegramConnectCode.code,
                });
                const res = await fetch(
                    `/api/telegram/connect-code?${params}`,
                    {
                        cache: "no-store",
                    },
                );
                if (!res.ok) return;
                const status = (await res.json()) as {
                    used: boolean;
                    expired: boolean;
                };
                if (status.used) {
                    setTelegramConnectCode(null);
                    await fetchTelegramConnection();
                    toast.success("Telegram reconnected successfully");
                } else if (status.expired) {
                    setTelegramConnectCode(null);
                    toast.error("Telegram connect code expired");
                }
            } finally {
                checking = false;
            }
        };
        void checkCode();
        const interval = window.setInterval(checkCode, 2_000);
        return () => window.clearInterval(interval);
    }, [fetchTelegramConnection, isWebhookOpen, telegramConnectCode]);

    const openWebhookDialog = (monitor: Monitor) => {
        setSelectedMonitor(monitor);
        setWebhookInput(monitor.discord_webhook || "");
        setIsWebhookActive(
            monitor.discord_webhook ? monitor.webhook_active : true,
        );
        setIsTelegramActive(monitor.telegram_active);
        setTelegramConnectCode(null);
        setIsWebhookOpen(true);
    };

    const sortedMonitors = useMemo(() => {
        return [...monitors].sort((a, b) => {
            if (a.status === "active" && b.status !== "active") return -1;
            if (a.status !== "active" && b.status === "active") return 1;
            return (
                new Date(b.created_at).getTime() -
                new Date(a.created_at).getTime()
            );
        });
    }, [monitors]);

    const selectedMonitorIdSet = useMemo(
        () => new Set(selectedMonitorIds),
        [selectedMonitorIds],
    );
    const allMonitorsSelected =
        monitors.length > 0 && selectedMonitorIds.length === monitors.length;
    const hasBulkChanges =
        bulkNotificationsMode !== "unchanged" ||
        bulkDiscordMode !== "unchanged" ||
        bulkTelegramMode !== "unchanged" ||
        bulkApplyQueryDelay ||
        bulkApplyQuietHours;

    const toggleMonitorSelection = (monitorId: number) => {
        setSelectedMonitorIds((current) =>
            current.includes(monitorId)
                ? current.filter((id) => id !== monitorId)
                : [...current, monitorId],
        );
    };

    const toggleAllMonitorSelection = () => {
        setSelectedMonitorIds(
            allMonitorsSelected ? [] : monitors.map((monitor) => monitor.id),
        );
    };

    const openBulkEditDialog = () => {
        const firstSelected = monitors.find((monitor) =>
            selectedMonitorIdSet.has(monitor.id),
        );
        if (!firstSelected) return;

        setBulkDiscordMode("unchanged");
        setBulkWebhookUrl(firstSelected.discord_webhook ?? "");
        setBulkTelegramMode("unchanged");
        setBulkNotificationsMode("unchanged");
        setBulkApplyQueryDelay(false);
        setBulkQueryDelayMs(String(firstSelected.query_delay_ms));
        setBulkApplyQuietHours(false);
        setBulkQuietHoursEnabled(firstSelected.quiet_hours_enabled);
        setBulkQuietHoursStart(
            minuteOfDayToTime(firstSelected.quiet_hours_start_minute),
        );
        setBulkQuietHoursEnd(
            minuteOfDayToTime(firstSelected.quiet_hours_end_minute),
        );
        setBulkQuietHoursMode(firstSelected.quiet_hours_mode);
        setBulkQuietHoursDelayMs(String(firstSelected.quiet_hours_delay_ms));
        setBulkQuietHoursTimezone(firstSelected.quiet_hours_timezone);
        setIsBulkEditOpen(true);
        void fetchTelegramConnection();
    };

    const handleBulkSave = async () => {
        if (selectedMonitorIds.length === 0 || !hasBulkChanges) return;

        const input: BulkMonitorUpdateInput = {
            monitorIds: selectedMonitorIds,
            ...(bulkApplyQueryDelay ? { queryDelayMs: bulkQueryDelayMs } : {}),
            ...(bulkApplyQuietHours
                ? {
                      quietHours: {
                          enabled: bulkQuietHoursEnabled,
                          start: bulkQuietHoursStart,
                          end: bulkQuietHoursEnd,
                          mode: bulkQuietHoursMode,
                          delayMs: bulkQuietHoursDelayMs,
                          timezone: bulkQuietHoursTimezone,
                      },
                  }
                : {}),
            ...(bulkDiscordMode !== "unchanged"
                ? {
                      discord: {
                          mode: bulkDiscordMode,
                          ...(bulkDiscordMode === "replace"
                              ? { webhookUrl: bulkWebhookUrl }
                              : {}),
                      },
                  }
                : {}),
            ...(bulkTelegramMode !== "unchanged"
                ? { telegram: bulkTelegramMode }
                : {}),
            ...(bulkNotificationsMode !== "unchanged"
                ? { notifications: bulkNotificationsMode }
                : {}),
        };

        setIsBulkSaving(true);
        try {
            const result = await bulkUpdateMonitors(input);
            const updatedById = new Map(
                result.monitors.map((monitor) => [monitor.id, monitor]),
            );
            setMonitors((current) =>
                current.map((monitor) => {
                    const updated = updatedById.get(monitor.id);
                    if (!updated) return monitor;
                    return {
                        ...monitor,
                        ...updated,
                        quiet_hours_mode:
                            updated.quiet_hours_mode === "slow"
                                ? "slow"
                                : "pause",
                    };
                }),
            );
            setIsBulkEditOpen(false);
            setSelectedMonitorIds([]);
            toast.success(
                `${result.updatedCount} monitor${result.updatedCount === 1 ? "" : "s"} updated`,
            );
        } catch (error) {
            toast.error(
                error instanceof Error
                    ? error.message
                    : "Failed to update monitors",
            );
        } finally {
            setIsBulkSaving(false);
        }
    };

    const handleStopAll = async () => {
        setMonitors((prev) => prev.map((m) => ({ ...m, status: "paused" })));
        toast.promise(stopAllMonitors(), {
            loading: "Stopping all monitors...",
            success: "All monitors stopped",
            error: "Failed to stop monitors",
        });
    };

    const handleStartAll = async () => {
        const toastId = toast.loading("Starting monitors...");
        try {
            const result = await startAllMonitors();
            if (!result.success && result.block) {
                toast.dismiss(toastId);
                if (result.block.code === "free_proxy_limit") {
                    setActivationBlock(result.block);
                } else {
                    toast.error(result.block.message);
                }
                return;
            }
            const startedIds = new Set(result.startedMonitorIds);
            setMonitors((prev) =>
                prev.map((m) =>
                    startedIds.has(m.id)
                        ? {
                              ...m,
                              status: "active",
                              demo_expires_at:
                                  result.demoExpirations[m.id] ??
                                  m.demo_expires_at,
                          }
                        : m,
                ),
            );
            toast.success(result.message, { id: toastId });
        } catch (error) {
            toast.error(
                error instanceof Error
                    ? error.message
                    : "Failed to start monitors",
                { id: toastId },
            );
        }
    };

    const handleToggle = async (id: number, currentStatus: string) => {
        const newStatus = currentStatus === "active" ? "paused" : "active";
        const actionText = newStatus === "active" ? "Resumed" : "Paused";
        const currentMonitor = monitors.find((monitor) => monitor.id === id);
        const optimisticDemoExpiry =
            newStatus === "active" && currentMonitor?.demo_expires_at
                ? new Date(Date.now() + DEMO_MONITOR_DURATION_MS).toISOString()
                : currentMonitor?.demo_expires_at;

        setMonitors((prev) =>
            prev.map((m) =>
                m.id === id
                    ? {
                          ...m,
                          status: newStatus,
                          demo_expires_at:
                              optimisticDemoExpiry ?? m.demo_expires_at,
                      }
                    : m,
            ),
        );

        const toastId = toast.loading("Updating...");
        try {
            const result = await toggleMonitor(id, currentStatus);
            if (!result.success) {
                setMonitors((prev) =>
                    prev.map((m) =>
                        m.id === id && currentMonitor ? currentMonitor : m,
                    ),
                );
                toast.dismiss(toastId);
                if (result.block?.code === "free_proxy_limit") {
                    setActivationBlock(result.block);
                } else {
                    toast.error(
                        result.block?.message ?? "Failed to update monitor",
                    );
                }
                return;
            }

            setMonitors((prev) =>
                prev.map((monitor) =>
                    monitor.id === id
                        ? {
                              ...monitor,
                              demo_expires_at: result.demoExpiresAt,
                          }
                        : monitor,
                ),
            );
            toast.success(
                result.rewardNotice
                    ? `${result.rewardNotice.title}: ${result.rewardNotice.message}`
                    : `Monitor ${actionText}`,
                { id: toastId },
            );
        } catch (error) {
            setMonitors((prev) =>
                prev.map((m) =>
                    m.id === id && currentMonitor ? currentMonitor : m,
                ),
            );
            toast.error(
                error instanceof Error
                    ? error.message
                    : "Failed to update monitor",
                { id: toastId },
            );
        }
    };

    const handleDedupeChange = (checked: boolean) => {
        setDedupeMonitorAlerts(checked);
        startDedupeTransition(async () => {
            const result = await updateMonitorAlertDedupe(checked);
            if ("error" in result) {
                setDedupeMonitorAlerts(!checked);
                toast.error(result.error);
                return;
            }
            toast.success(
                checked
                    ? "Duplicate item alerts are collapsed"
                    : "Monitor alerts are independent again",
            );
        });
    };

    const handleTelegramMessageStyleChange = (
        style: NotificationMessageStyle,
    ) => {
        const previous = telegramMessageStyle;
        setTelegramMessageStyle(style);
        startTelegramStyleTransition(async () => {
            const result = await updateTelegramMessageStyle(style);
            if ("error" in result) {
                setTelegramMessageStyle(previous);
                toast.error(result.error);
                return;
            }
            toast.success(`Telegram alerts set to ${style}`);
        });
    };

    const handleDiscordMessageStyleChange = (
        style: NotificationMessageStyle,
    ) => {
        const previous = discordMessageStyle;
        setDiscordMessageStyle(style);
        startDiscordStyleTransition(async () => {
            const result = await updateDiscordMessageStyle(style);
            if ("error" in result) {
                setDiscordMessageStyle(previous);
                toast.error(result.error);
                return;
            }
            toast.success(`Discord alerts set to ${style}`);
        });
    };

    const handleRemoveSellerBan = async (sellerId: string) => {
        setRemovingSellerId(sellerId);
        try {
            const res = await fetch(`/api/seller-bans/${sellerId}`, {
                method: "DELETE",
            });
            if (!res.ok) {
                toast.error(await readApiError(res, "Failed to unban seller"));
                return;
            }
            setSellerBans((current) =>
                current.filter((ban) => ban.seller_id !== sellerId),
            );
            toast.success("Seller unbanned");
        } catch {
            toast.error("Network error — could not unban seller");
        } finally {
            setRemovingSellerId(null);
        }
    };

    const handleNotificationsToggle = async (
        monitor: Monitor,
        checked: boolean,
    ) => {
        if (notificationToggleIds.has(monitor.id)) return;

        const previousStatus = monitor.notifications_enabled;
        const updateStatus = (enabled: boolean) => {
            setMonitors((current) =>
                current.map((entry) =>
                    entry.id === monitor.id
                        ? { ...entry, notifications_enabled: enabled }
                        : entry,
                ),
            );
            setSelectedMonitor((current) =>
                current?.id === monitor.id
                    ? { ...current, notifications_enabled: enabled }
                    : current,
            );
        };

        setNotificationToggleIds((current) => {
            const next = new Set(current);
            next.add(monitor.id);
            return next;
        });
        updateStatus(checked);

        try {
            const result = await setMonitorNotificationsEnabled(
                monitor.id,
                checked,
            );
            updateStatus(result.notificationsEnabled);
            toast.success(checked ? "Alerts enabled" : "Alerts muted");
        } catch (error) {
            updateStatus(previousStatus);
            toast.error(
                error instanceof Error
                    ? error.message
                    : "Failed to update alerts",
            );
        } finally {
            setNotificationToggleIds((current) => {
                const next = new Set(current);
                next.delete(monitor.id);
                return next;
            });
        }
    };

    const handleSaveWebhook = async () => {
        if (!selectedMonitor) return;
        const webhookActive = Boolean(webhookInput.trim() && isWebhookActive);
        const previousMonitor = selectedMonitor;

        setMonitors((prev) =>
            prev.map((m) =>
                m.id === selectedMonitor.id
                    ? {
                          ...m,
                          discord_webhook: webhookInput.trim() || null,
                          webhook_active: webhookActive,
                      }
                    : m,
            ),
        );
        setSelectedMonitor((monitor) =>
            monitor
                ? {
                      ...monitor,
                      discord_webhook: webhookInput.trim() || null,
                      webhook_active: webhookActive,
                  }
                : monitor,
        );
        toast.promise(
            updateMonitorWebhook(
                selectedMonitor.id,
                webhookInput,
                webhookActive,
            ),
            {
                loading: "Saving...",
                success: () => {
                    setIsWebhookOpen(false);
                    return "Discord webhook saved";
                },
                error: (error) => {
                    setMonitors((prev) =>
                        prev.map((monitor) =>
                            monitor.id === previousMonitor.id
                                ? previousMonitor
                                : monitor,
                        ),
                    );
                    setSelectedMonitor(previousMonitor);
                    return error instanceof Error
                        ? error.message
                        : "Failed to save Discord webhook";
                },
            },
        );
    };

    const handleWebhookStatusChange = async (checked: boolean) => {
        if (!selectedMonitor || isUpdatingWebhookStatus) return;

        const monitorId = selectedMonitor.id;
        const previousStatus = isWebhookActive;
        setIsWebhookActive(checked);
        setIsUpdatingWebhookStatus(true);
        setSelectedMonitor((monitor) =>
            monitor ? { ...monitor, webhook_active: checked } : monitor,
        );
        setMonitors((prev) =>
            prev.map((monitor) =>
                monitor.id === monitorId
                    ? { ...monitor, webhook_active: checked }
                    : monitor,
            ),
        );

        try {
            await setMonitorWebhookStatus(monitorId, checked);
            toast.success(
                checked ? "Webhook activated" : "Webhook deactivated",
            );
        } catch (error) {
            setIsWebhookActive(previousStatus);
            setSelectedMonitor((monitor) =>
                monitor
                    ? { ...monitor, webhook_active: previousStatus }
                    : monitor,
            );
            setMonitors((prev) =>
                prev.map((monitor) =>
                    monitor.id === monitorId
                        ? { ...monitor, webhook_active: previousStatus }
                        : monitor,
                ),
            );
            toast.error(
                error instanceof Error
                    ? error.message
                    : "Failed to toggle webhook",
            );
        } finally {
            setIsUpdatingWebhookStatus(false);
        }
    };

    const activeCount = monitors.filter((m) => m.status === "active").length;
    const pausedCount = monitors.filter((m) => m.status !== "active").length;
    const totalItems = monitors.reduce((sum, m) => sum + m._count.items, 0);

    return (
        <div className="space-y-8">
            {quickStartEligible && (
                <FirstMonitorQuickStart
                    open={isQuickStartOpen}
                    onOpenChange={setIsQuickStartOpen}
                    initialPool={quickStartPool}
                    maintenanceEnabled={maintenanceEnabled}
                />
            )}

            <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
                <div>
                    <h1 className="text-2xl font-bold tracking-tight">
                        Welcome back, {userName}
                    </h1>
                    <p className="text-muted-foreground mt-0.5 text-sm">
                        Manage and monitor your Vinted scrapers.
                    </p>
                </div>

                <div className="flex w-full items-center gap-2 sm:w-auto">
                    {pausedCount > 0 && !maintenanceEnabled && (
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={handleStartAll}
                            className="flex-1 gap-1.5 border-emerald-200 text-emerald-700 hover:bg-emerald-50 hover:text-emerald-800 sm:flex-none dark:border-emerald-500/20 dark:bg-transparent dark:text-emerald-400 dark:hover:bg-emerald-500/10"
                        >
                            <PlayCircle className="h-3.5 w-3.5" /> Start All
                        </Button>
                    )}
                    {activeCount > 0 && (
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={handleStopAll}
                            className="flex-1 gap-1.5 border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700 sm:flex-none dark:border-red-500/20 dark:bg-transparent dark:text-red-400 dark:hover:bg-red-500/10"
                        >
                            <StopCircle className="h-3.5 w-3.5" /> Stop All
                        </Button>
                    )}
                    <Button
                        type="button"
                        variant="outline"
                        size="icon-sm"
                        onClick={() => setIsSettingsOpen(true)}
                        title="Dashboard settings"
                        aria-label="Dashboard settings"
                    >
                        <Settings className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                        asChild
                        size="sm"
                        className="flex-1 gap-1.5 sm:flex-none"
                    >
                        <CreateMonitorLink>
                            <Plus className="h-3.5 w-3.5" /> New Monitor
                        </CreateMonitorLink>
                    </Button>
                </div>
            </div>

            <div
                className={cn(
                    "grid grid-cols-1 gap-4 sm:grid-cols-2",
                    freePoolUsage ? "xl:grid-cols-4" : "xl:grid-cols-3",
                )}
            >
                <div className="border-border/70 bg-card rounded-lg border px-5 py-4">
                    <p className="text-muted-foreground text-[11px] font-medium tracking-wider uppercase">
                        Total Monitors
                    </p>
                    <p className="text-foreground mt-1 text-2xl font-bold">
                        {monitors.length}
                    </p>
                </div>
                <div className="border-border/70 bg-card rounded-lg border px-5 py-4">
                    <p className="text-muted-foreground text-[11px] font-medium tracking-wider uppercase">
                        Active
                    </p>
                    <div className="mt-1 flex items-center gap-2">
                        <p className="text-foreground text-2xl font-bold">
                            {activeCount}
                        </p>
                        {activeCount > 0 && (
                            <span className="relative flex h-2 w-2">
                                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                            </span>
                        )}
                    </div>
                </div>
                <div className="border-border/70 bg-card rounded-lg border px-5 py-4">
                    <p className="text-muted-foreground text-[11px] font-medium tracking-wider uppercase">
                        Items Found
                    </p>
                    <p className="text-foreground mt-1 text-2xl font-bold">
                        {totalItems.toLocaleString()}
                    </p>
                </div>
                {freePoolUsage ? (
                    <Link
                        href="/account"
                        className={cn(
                            "border-border/70 bg-card group hover:border-foreground/20 hover:bg-muted/25 rounded-lg border px-5 py-4 transition-colors",
                            freePoolUsage.limitReached && "border-amber-500/30",
                        )}
                    >
                        <div className="flex items-center justify-between gap-3">
                            <p className="text-muted-foreground text-[11px] font-medium tracking-wider uppercase">
                                Free Pool
                            </p>
                            <span className="text-muted-foreground flex items-center gap-1 text-[11px] font-medium">
                                {freePoolUsage.tier}
                                <ArrowRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5" />
                            </span>
                        </div>
                        <div className="mt-1 flex items-end justify-between gap-3">
                            <p className="text-foreground text-2xl font-bold tabular-nums">
                                {freePoolUsage.activeCount}
                                <span className="text-muted-foreground text-sm font-medium">
                                    /{freePoolUsage.limit}
                                </span>
                            </p>
                            <p
                                className={cn(
                                    "text-muted-foreground pb-0.5 text-[11px]",
                                    freePoolUsage.limitReached &&
                                        "font-medium text-amber-700 dark:text-amber-300",
                                )}
                            >
                                {freePoolUsage.limitReached
                                    ? "Limit reached"
                                    : `${freePoolUsage.limit - freePoolUsage.activeCount} left`}
                            </p>
                        </div>
                        <div className="bg-muted mt-2 h-1 overflow-hidden rounded-full">
                            <div
                                className={cn(
                                    "h-full rounded-full transition-[width]",
                                    freePoolUsage.limitReached
                                        ? "bg-amber-500"
                                        : "bg-foreground/70",
                                )}
                                style={{
                                    width: `${Math.min(100, (freePoolUsage.activeCount / freePoolUsage.limit) * 100)}%`,
                                }}
                            />
                        </div>
                    </Link>
                ) : null}
            </div>

            {monitors.length === 0 ? (
                <div className="border-border/80 bg-card/60 flex flex-col items-center justify-center rounded-lg border border-dashed py-20">
                    <div className="bg-muted mb-4 rounded-md p-3">
                        {quickStartEligible ? (
                            <Rocket className="text-muted-foreground h-6 w-6" />
                        ) : (
                            <Radio className="text-muted-foreground h-6 w-6" />
                        )}
                    </div>
                    <h3 className="text-foreground text-base font-semibold">
                        {quickStartEligible
                            ? "Start finding listings in seconds"
                            : "No monitors yet"}
                    </h3>
                    <p className="text-muted-foreground mt-1 mb-4 max-w-md px-5 text-center text-sm">
                        {quickStartEligible
                            ? "Choose a ready-made search or configure every detail yourself."
                            : "Create your first monitor to start finding deals."}
                    </p>
                    <div className="flex flex-col gap-2 sm:flex-row">
                        {quickStartEligible && (
                            <Button
                                size="sm"
                                className="gap-1.5"
                                onClick={() => setIsQuickStartOpen(true)}
                                disabled={maintenanceEnabled}
                                title={
                                    maintenanceEnabled
                                        ? MONITOR_CREATION_MAINTENANCE_TITLE
                                        : undefined
                                }
                            >
                                <Rocket className="h-3.5 w-3.5" /> Quick start
                            </Button>
                        )}
                        <Button
                            asChild
                            size="sm"
                            variant={quickStartEligible ? "outline" : "default"}
                            className="gap-1.5"
                        >
                            <CreateMonitorLink>
                                <Plus className="h-3.5 w-3.5" /> Create manually
                            </CreateMonitorLink>
                        </Button>
                    </div>
                </div>
            ) : (
                <div className="space-y-4">
                    <div
                        className={`flex flex-col gap-3 rounded-lg border px-4 py-3 transition-colors sm:flex-row sm:items-center sm:justify-between ${
                            selectedMonitorIds.length > 0
                                ? "border-primary/30 bg-primary/[0.035]"
                                : "border-border/70 bg-card"
                        }`}
                    >
                        <div className="flex items-center gap-3">
                            <Checkbox
                                checked={allMonitorsSelected}
                                onCheckedChange={toggleAllMonitorSelection}
                                aria-label="Select all monitors"
                            />
                            <div>
                                <h2 className="text-sm font-semibold">
                                    {selectedMonitorIds.length > 0
                                        ? `${selectedMonitorIds.length} selected`
                                        : "Your monitors"}
                                </h2>
                                <p className="text-muted-foreground text-xs">
                                    {selectedMonitorIds.length > 0
                                        ? "Choose the settings to update together"
                                        : `${monitors.length} total`}
                                </p>
                            </div>
                        </div>
                        <div className="flex items-center gap-2">
                            {selectedMonitorIds.length > 0 && (
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => setSelectedMonitorIds([])}
                                    className="text-muted-foreground h-8 text-xs"
                                >
                                    Clear
                                </Button>
                            )}
                            <Button
                                type="button"
                                size="sm"
                                variant={
                                    selectedMonitorIds.length > 0
                                        ? "default"
                                        : "outline"
                                }
                                disabled={selectedMonitorIds.length === 0}
                                onClick={openBulkEditDialog}
                                className="h-8 gap-1.5 text-xs"
                            >
                                <ListChecks className="size-3.5" />
                                {selectedMonitorIds.length > 0
                                    ? "Edit selected"
                                    : "Bulk edit"}
                            </Button>
                        </div>
                    </div>
                    <div className="grid auto-rows-fr grid-cols-1 gap-4 md:grid-cols-2 2xl:grid-cols-3">
                        {sortedMonitors.map((m) => (
                            <Card
                                key={m.id}
                                data-testid="monitor-card"
                                className={`group hover:border-foreground/20 h-full overflow-hidden rounded-lg py-0 shadow-none transition-colors ${
                                    selectedMonitorIdSet.has(m.id)
                                        ? "border-primary/45 bg-primary/[0.025] ring-primary/10 ring-2"
                                        : "border-border/70 bg-card"
                                }`}
                            >
                                <CardContent className="flex h-full flex-1 flex-col p-0">
                                    <div className="flex items-start justify-between gap-3 p-4 pb-3">
                                        <Checkbox
                                            checked={selectedMonitorIdSet.has(
                                                m.id,
                                            )}
                                            onCheckedChange={() =>
                                                toggleMonitorSelection(m.id)
                                            }
                                            aria-label={`Select ${m.name}`}
                                            className="mt-0.5"
                                        />
                                        <div className="min-w-0 flex-1">
                                            <h3
                                                className="text-foreground truncate text-[15px] font-semibold"
                                                title={m.name}
                                            >
                                                {m.name}
                                            </h3>
                                            <div className="mt-1.5 flex flex-wrap items-center gap-2">
                                                <Badge
                                                    variant="outline"
                                                    className={`text-[10px] font-medium ${
                                                        m.status === "active"
                                                            ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                                                            : m.status ===
                                                                "error"
                                                              ? "border-red-500/25 bg-red-500/10 text-red-700 dark:text-red-400"
                                                              : "bg-muted/60 text-muted-foreground"
                                                    }`}
                                                >
                                                    {m.status === "active" ? (
                                                        <span className="flex items-center gap-1">
                                                            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                                                            Running
                                                        </span>
                                                    ) : m.status ===
                                                      "maintenance_paused" ? (
                                                        <span className="flex items-center gap-1">
                                                            <Wrench className="h-3 w-3" />
                                                            Maintenance
                                                        </span>
                                                    ) : m.status ===
                                                      "inactivity_paused" ? (
                                                        <span className="flex items-center gap-1">
                                                            <Clock3 className="h-3 w-3" />
                                                            Paused due to
                                                            inactivity
                                                        </span>
                                                    ) : m.status === "error" ? (
                                                        <span className="flex items-center gap-1">
                                                            <AlertTriangle className="h-3 w-3" />
                                                            Proxy Error
                                                        </span>
                                                    ) : (
                                                        "Paused"
                                                    )}
                                                </Badge>
                                                {m.demo_expires_at && (
                                                    <Badge
                                                        variant="outline"
                                                        className="border-amber-500/25 bg-amber-500/10 text-[10px] font-medium text-amber-700 dark:text-amber-300"
                                                    >
                                                        <Clock3 className="size-3" />
                                                        {getDemoMonitorLabel(
                                                            m,
                                                            demoNow,
                                                        )}
                                                    </Badge>
                                                )}
                                                {m.status === "active" &&
                                                    hasProxyWarning(
                                                        healthMap[m.id],
                                                    ) && (
                                                        <Badge
                                                            variant="outline"
                                                            className="border-red-500/25 bg-red-500/10 text-red-700 dark:text-red-400"
                                                        >
                                                            <AlertTriangle className="size-3" />
                                                            Proxy issue
                                                        </Badge>
                                                    )}
                                            </div>
                                        </div>
                                        <div className="flex shrink-0 items-center">
                                            <Link
                                                href={`/monitors/${m.id}/edit?from=dashboard`}
                                                className="text-muted-foreground hover:bg-accent hover:text-accent-foreground flex size-8 items-center justify-center rounded-md transition-colors"
                                                title="Edit monitor"
                                                aria-label="Edit monitor"
                                            >
                                                <Pencil className="h-3.5 w-3.5" />
                                            </Link>
                                        </div>
                                    </div>

                                    <div className="px-4 pb-3">
                                        <div className="flex min-w-0 items-center gap-2">
                                            <Search className="text-muted-foreground size-3.5 shrink-0" />
                                            <p
                                                className="truncate text-sm font-medium"
                                                title={m.query}
                                            >
                                                {m.query || "All listings"}
                                            </p>
                                        </div>
                                    </div>

                                    <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-2 px-4 pb-3 text-xs">
                                        <span
                                            className="inline-flex min-w-0 items-center gap-1.5"
                                            title={getRegionLabel(m.region)}
                                        >
                                            <Globe className="size-3.5 shrink-0" />
                                            <span className="truncate">
                                                {getRegionLabel(m.region)}
                                            </span>
                                        </span>
                                        <span className="inline-flex items-center gap-1.5">
                                            <Timer className="size-3.5" />
                                            {formatQueryDelay(m.query_delay_ms)}
                                        </span>
                                        <span>
                                            {m.price_max
                                                ? "Max " + m.price_max + " EUR"
                                                : "No price limit"}
                                        </span>
                                    </div>

                                    <div className="flex px-4 pb-4 [&>span]:hidden">
                                        <div className="text-muted-foreground flex min-w-0 items-center gap-2 text-xs">
                                            <SlidersHorizontal className="text-muted-foreground size-3.5" />
                                            <span className="shrink-0">
                                                {
                                                    getMonitorFilterLabels(
                                                        m,
                                                        memberBrandLabels,
                                                    ).length
                                                }{" "}
                                                filters
                                            </span>
                                            {getMonitorFilterLabels(
                                                m,
                                                memberBrandLabels,
                                            ).length > 0 && (
                                                <span className="truncate">
                                                    ·{" "}
                                                    {getMonitorFilterLabels(
                                                        m,
                                                        memberBrandLabels,
                                                    )
                                                        .slice(0, 2)
                                                        .join(" · ")}
                                                </span>
                                            )}
                                        </div>
                                        {m.allowed_countries && (
                                            <span
                                                className="border-border/60 bg-muted/50 text-muted-foreground inline-flex items-center rounded-md border px-2 py-0.5 text-[10px] font-medium"
                                                title={`Only items from: ${m.allowed_countries}`}
                                            >
                                                {getRegionFlags(
                                                    m.allowed_countries,
                                                ).join(" ")}
                                            </span>
                                        )}
                                        {m.category_labels.map((label) => (
                                            <span
                                                key={`cat-${label}`}
                                                className="border-border/60 bg-muted/50 text-muted-foreground inline-flex items-center rounded-md border px-2 py-0.5 text-[10px] font-medium"
                                            >
                                                {label}
                                            </span>
                                        ))}
                                        {m.brand_ids &&
                                            getBrandLabels(
                                                m.brand_ids,
                                                memberBrandLabels,
                                            ).map((label) => (
                                                <span
                                                    key={`brand-${label}`}
                                                    className="border-border/60 bg-muted/50 text-muted-foreground inline-flex items-center rounded-md border px-2 py-0.5 text-[10px] font-medium"
                                                >
                                                    {label}
                                                </span>
                                            ))}
                                        {m.color_ids &&
                                            getColorLabels(m.color_ids).map(
                                                (label) => (
                                                    <span
                                                        key={`color-${label}`}
                                                        className="border-border/60 bg-muted/50 text-muted-foreground inline-flex items-center rounded-md border px-2 py-0.5 text-[10px] font-medium"
                                                    >
                                                        {label}
                                                    </span>
                                                ),
                                            )}
                                        {m.status_ids &&
                                            getStatusLabels(
                                                m.status_ids,
                                                getStatusLocaleForRegionCodes(
                                                    m.allowed_countries,
                                                    m.region,
                                                ),
                                            ).map((label) => (
                                                <span
                                                    key={`status-${label}`}
                                                    className="border-border/60 bg-muted/50 text-muted-foreground inline-flex items-center rounded-md border px-2 py-0.5 text-[10px] font-medium"
                                                    title={label}
                                                >
                                                    {label}
                                                </span>
                                            ))}
                                        {m.video_game_platform_ids &&
                                            getVideoGamePlatformLabels(
                                                m.video_game_platform_ids,
                                            ).map((label) => (
                                                <span
                                                    key={`platform-${label}`}
                                                    className="border-border/60 bg-muted/50 text-muted-foreground inline-flex items-center rounded-md border px-2 py-0.5 text-[10px] font-medium"
                                                >
                                                    {label}
                                                </span>
                                            ))}
                                        {m.size_id &&
                                            getSizeLabels(m.size_id).map(
                                                (label) => (
                                                    <span
                                                        key={`size-${label}`}
                                                        className="border-border/60 bg-muted/50 text-muted-foreground inline-flex items-center rounded-md border px-2 py-0.5 text-[10px] font-medium"
                                                    >
                                                        {label}
                                                    </span>
                                                ),
                                            )}
                                    </div>

                                    <div className="flex-1" />

                                    <div className="border-border/60 text-muted-foreground flex flex-wrap items-center gap-x-5 gap-y-2 border-t px-4 py-3">
                                        <div className="min-w-0">
                                            <p className="hidden">Results</p>
                                            <p className="flex items-center gap-1.5 text-xs">
                                                <Package className="text-muted-foreground size-3.5" />
                                                {m._count.items.toLocaleString()}{" "}
                                                items found
                                            </p>
                                        </div>
                                        <div className="min-w-0">
                                            <p className="hidden">Proxy</p>
                                            <p
                                                className="flex min-w-0 items-center gap-1.5 text-xs"
                                                title={getMonitorProxyLabel(m)}
                                            >
                                                {m.proxy_source === "server" ? (
                                                    <Zap className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
                                                ) : (
                                                    <Globe
                                                        className={
                                                            m.proxy_source ===
                                                            "free"
                                                                ? "size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400"
                                                                : "text-muted-foreground size-3.5 shrink-0"
                                                        }
                                                    />
                                                )}
                                                <span className="truncate">
                                                    {getMonitorProxyLabel(m)}
                                                </span>
                                            </p>
                                        </div>
                                    </div>

                                    <div className="border-border/60 flex items-center justify-between gap-3 border-t px-4 py-3">
                                        <div className="flex min-w-0 items-center gap-2.5">
                                            <div
                                                className={`flex size-8 shrink-0 items-center justify-center rounded-md ${
                                                    hasActiveNotificationChannel(
                                                        m,
                                                    ) && m.notifications_enabled
                                                        ? "bg-indigo-500/10 text-indigo-600 dark:text-indigo-400"
                                                        : "bg-muted text-muted-foreground"
                                                }`}
                                            >
                                                <Bell className="size-3.5" />
                                            </div>
                                            <div className="min-w-0">
                                                {hasActiveNotificationChannel(
                                                    m,
                                                ) ? (
                                                    <>
                                                        <p className="text-foreground text-xs font-medium">
                                                            {m.notifications_enabled
                                                                ? "Alerts on"
                                                                : "Alerts muted"}
                                                        </p>
                                                        <p className="text-muted-foreground truncate text-[11px]">
                                                            {getMonitorNotificationChannels(
                                                                m,
                                                            )}
                                                        </p>
                                                    </>
                                                ) : (
                                                    <button
                                                        type="button"
                                                        onClick={() =>
                                                            openWebhookDialog(m)
                                                        }
                                                        className="text-left"
                                                    >
                                                        <span className="text-foreground block text-xs font-medium">
                                                            Set up alerts
                                                        </span>
                                                        <span className="text-muted-foreground block text-[11px]">
                                                            Discord or Telegram
                                                        </span>
                                                    </button>
                                                )}
                                            </div>
                                        </div>
                                        <div className="flex shrink-0 items-center gap-1.5">
                                            {hasActiveNotificationChannel(
                                                m,
                                            ) && (
                                                <Switch
                                                    size="sm"
                                                    checked={
                                                        m.notifications_enabled
                                                    }
                                                    disabled={notificationToggleIds.has(
                                                        m.id,
                                                    )}
                                                    onCheckedChange={(
                                                        checked,
                                                    ) =>
                                                        void handleNotificationsToggle(
                                                            m,
                                                            checked,
                                                        )
                                                    }
                                                    aria-label={`Notifications for ${m.name}`}
                                                />
                                            )}
                                            <button
                                                type="button"
                                                onClick={() =>
                                                    openWebhookDialog(m)
                                                }
                                                className="text-muted-foreground hover:bg-accent hover:text-accent-foreground flex size-8 items-center justify-center rounded-md transition-colors"
                                                title="Configure notifications"
                                                aria-label={`Configure notifications for ${m.name}`}
                                            >
                                                <Webhook className="size-3.5" />
                                            </button>
                                        </div>
                                    </div>

                                    <div className="border-border/60 bg-muted/10 flex items-center gap-2 border-t px-3 py-2.5">
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            onClick={() =>
                                                handleToggle(m.id, m.status)
                                            }
                                            disabled={
                                                maintenanceEnabled &&
                                                m.status !== "active"
                                            }
                                            title={
                                                maintenanceEnabled &&
                                                m.status !== "active"
                                                    ? "Paused for maintenance"
                                                    : undefined
                                            }
                                            className={`h-8 px-3 text-xs font-medium ${
                                                m.status === "active"
                                                    ? "text-amber-700 hover:bg-amber-50 hover:text-amber-800 dark:text-amber-400 dark:hover:bg-amber-500/10 dark:hover:text-amber-300"
                                                    : "text-emerald-600 hover:bg-emerald-50 hover:text-emerald-700 dark:text-emerald-400 dark:hover:bg-emerald-500/10 dark:hover:text-emerald-300"
                                            }`}
                                        >
                                            {m.status === "active" ? (
                                                <>
                                                    <PauseCircle className="h-3.5 w-3.5" />
                                                    Pause
                                                </>
                                            ) : (
                                                <>
                                                    <PlayCircle className="h-3.5 w-3.5" />
                                                    {maintenanceEnabled
                                                        ? "Paused for maintenance"
                                                        : "Resume"}
                                                </>
                                            )}
                                        </Button>
                                        <div className="flex-1" />
                                        <Link href={`/monitors/${m.id}`}>
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                className="text-muted-foreground hover:text-foreground h-8 gap-1 px-3 text-xs font-medium"
                                            >
                                                View monitor
                                                <ArrowRight className="h-3 w-3" />
                                            </Button>
                                        </Link>
                                    </div>
                                </CardContent>
                            </Card>
                        ))}
                    </div>
                </div>
            )}

            <Dialog
                open={isBulkEditOpen}
                onOpenChange={(open) => {
                    if (!isBulkSaving) setIsBulkEditOpen(open);
                }}
            >
                <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
                    <DialogHeader>
                        <DialogTitle>
                            Bulk edit {selectedMonitorIds.length} monitor
                            {selectedMonitorIds.length === 1 ? "" : "s"}
                        </DialogTitle>
                        <DialogDescription>
                            Only settings explicitly changed below will be
                            applied. Queries, filters, regions, and proxies stay
                            untouched.
                        </DialogDescription>
                    </DialogHeader>

                    <div className="space-y-4 py-2">
                        <div className="border-border/80 space-y-4 rounded-lg border p-4">
                            <div>
                                <h3 className="text-sm font-semibold">
                                    Notifications
                                </h3>
                                <p className="text-muted-foreground mt-1 text-xs">
                                    Control the master alert state without
                                    changing delivery channels.
                                </p>
                            </div>

                            <div className="bg-muted/30 grid gap-2 rounded-md p-3 sm:grid-cols-[1fr_220px] sm:items-center">
                                <div>
                                    <Label
                                        htmlFor="bulk-notifications-mode"
                                        className="text-sm font-medium"
                                    >
                                        Alert status
                                    </Label>
                                    <p className="text-muted-foreground mt-1 text-xs">
                                        Muting preserves every monitor&apos;s
                                        Discord and Telegram choices.
                                    </p>
                                </div>
                                <select
                                    id="bulk-notifications-mode"
                                    value={bulkNotificationsMode}
                                    onChange={(event) =>
                                        setBulkNotificationsMode(
                                            event.target
                                                .value as BulkNotificationsMode,
                                        )
                                    }
                                    className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
                                >
                                    <option value="unchanged">
                                        Leave unchanged
                                    </option>
                                    <option value="enable">
                                        Unmute alerts
                                    </option>
                                    <option value="disable">Mute alerts</option>
                                </select>
                            </div>

                            <div className="border-border/70 border-t pt-4">
                                <p className="text-xs font-medium">
                                    Delivery channels
                                </p>
                                <p className="text-muted-foreground mt-1 text-xs">
                                    Optional channel changes are applied
                                    independently of the master status.
                                </p>
                            </div>

                            <div className="grid gap-4 sm:grid-cols-2">
                                <div className="space-y-2">
                                    <Label
                                        htmlFor="bulk-discord-mode"
                                        className="text-xs"
                                    >
                                        Discord
                                    </Label>
                                    <select
                                        id="bulk-discord-mode"
                                        value={bulkDiscordMode}
                                        onChange={(event) =>
                                            setBulkDiscordMode(
                                                event.target
                                                    .value as BulkDiscordMode,
                                            )
                                        }
                                        className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
                                    >
                                        <option value="unchanged">
                                            Leave unchanged
                                        </option>
                                        <option value="enable">
                                            Enable existing webhooks
                                        </option>
                                        <option value="disable">
                                            Disable Discord
                                        </option>
                                        <option value="replace">
                                            Replace webhook
                                        </option>
                                    </select>
                                </div>

                                <div className="space-y-2">
                                    <Label
                                        htmlFor="bulk-telegram-mode"
                                        className="text-xs"
                                    >
                                        Telegram
                                    </Label>
                                    <select
                                        id="bulk-telegram-mode"
                                        value={bulkTelegramMode}
                                        onChange={(event) =>
                                            setBulkTelegramMode(
                                                event.target
                                                    .value as BulkTelegramMode,
                                            )
                                        }
                                        className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
                                    >
                                        <option value="unchanged">
                                            Leave unchanged
                                        </option>
                                        <option value="enable">Enable</option>
                                        <option value="disable">Disable</option>
                                    </select>
                                </div>
                            </div>

                            {bulkDiscordMode === "replace" && (
                                <div className="space-y-2">
                                    <Label
                                        htmlFor="bulk-webhook-url"
                                        className="text-xs"
                                    >
                                        Discord webhook for all selected
                                        monitors
                                    </Label>
                                    <Input
                                        id="bulk-webhook-url"
                                        type="url"
                                        value={bulkWebhookUrl}
                                        onChange={(event) =>
                                            setBulkWebhookUrl(
                                                event.target.value,
                                            )
                                        }
                                        placeholder="https://discord.com/api/webhooks/..."
                                    />
                                </div>
                            )}

                            {bulkTelegramMode === "enable" &&
                                telegramConnection &&
                                !telegramConnection.connected && (
                                    <p className="text-destructive text-xs">
                                        Connect Telegram in Dashboard settings
                                        before enabling it.
                                    </p>
                                )}
                        </div>

                        <div className="border-border/80 rounded-lg border p-4">
                            <div className="flex items-start justify-between gap-4">
                                <div>
                                    <Label
                                        htmlFor="bulk-apply-query-delay"
                                        className="text-sm font-semibold"
                                    >
                                        Query delay
                                    </Label>
                                    <p className="text-muted-foreground mt-1 text-xs">
                                        Apply one polling delay to all selected
                                        monitors.
                                    </p>
                                </div>
                                <Switch
                                    id="bulk-apply-query-delay"
                                    checked={bulkApplyQueryDelay}
                                    onCheckedChange={setBulkApplyQueryDelay}
                                    aria-label="Apply query delay"
                                />
                            </div>

                            {bulkApplyQueryDelay && (
                                <div className="mt-4 space-y-2">
                                    <Label
                                        htmlFor="bulk-query-delay"
                                        className="text-xs"
                                    >
                                        Delay in milliseconds
                                    </Label>
                                    <Input
                                        id="bulk-query-delay"
                                        type="number"
                                        min={MIN_QUERY_DELAY_MS}
                                        max={MAX_QUERY_DELAY_MS}
                                        step={100}
                                        value={bulkQueryDelayMs}
                                        onChange={(event) =>
                                            setBulkQueryDelayMs(
                                                event.target.value,
                                            )
                                        }
                                    />
                                </div>
                            )}
                        </div>

                        <div className="border-border/80 rounded-lg border p-4">
                            <div className="flex items-start justify-between gap-4">
                                <div>
                                    <Label
                                        htmlFor="bulk-apply-quiet-hours"
                                        className="text-sm font-semibold"
                                    >
                                        Quiet hours
                                    </Label>
                                    <p className="text-muted-foreground mt-1 text-xs">
                                        Apply the complete quiet-hours schedule
                                        below.
                                    </p>
                                </div>
                                <Switch
                                    id="bulk-apply-quiet-hours"
                                    checked={bulkApplyQuietHours}
                                    onCheckedChange={setBulkApplyQuietHours}
                                    aria-label="Apply quiet hours"
                                />
                            </div>

                            {bulkApplyQuietHours && (
                                <div className="mt-4 space-y-4">
                                    <div className="bg-muted/30 flex items-center justify-between gap-4 rounded-md p-3">
                                        <div>
                                            <Label
                                                htmlFor="bulk-quiet-enabled"
                                                className="text-xs font-medium"
                                            >
                                                Enable quiet hours
                                            </Label>
                                            <p className="text-muted-foreground mt-1 text-xs">
                                                Turn this off to disable the
                                                schedule on every selection.
                                            </p>
                                        </div>
                                        <Switch
                                            id="bulk-quiet-enabled"
                                            checked={bulkQuietHoursEnabled}
                                            onCheckedChange={
                                                setBulkQuietHoursEnabled
                                            }
                                        />
                                    </div>

                                    {bulkQuietHoursEnabled && (
                                        <>
                                            <div className="grid gap-4 sm:grid-cols-2">
                                                <div className="space-y-2">
                                                    <Label
                                                        htmlFor="bulk-quiet-start"
                                                        className="text-xs"
                                                    >
                                                        Start
                                                    </Label>
                                                    <Input
                                                        id="bulk-quiet-start"
                                                        type="time"
                                                        value={
                                                            bulkQuietHoursStart
                                                        }
                                                        onChange={(event) =>
                                                            setBulkQuietHoursStart(
                                                                event.target
                                                                    .value,
                                                            )
                                                        }
                                                    />
                                                </div>
                                                <div className="space-y-2">
                                                    <Label
                                                        htmlFor="bulk-quiet-end"
                                                        className="text-xs"
                                                    >
                                                        End
                                                    </Label>
                                                    <Input
                                                        id="bulk-quiet-end"
                                                        type="time"
                                                        value={
                                                            bulkQuietHoursEnd
                                                        }
                                                        onChange={(event) =>
                                                            setBulkQuietHoursEnd(
                                                                event.target
                                                                    .value,
                                                            )
                                                        }
                                                    />
                                                </div>
                                            </div>

                                            <div className="space-y-2">
                                                <Label
                                                    htmlFor="bulk-quiet-mode"
                                                    className="text-xs"
                                                >
                                                    During quiet hours
                                                </Label>
                                                <select
                                                    id="bulk-quiet-mode"
                                                    value={bulkQuietHoursMode}
                                                    onChange={(event) =>
                                                        setBulkQuietHoursMode(
                                                            event.target
                                                                .value as
                                                                | "pause"
                                                                | "slow",
                                                        )
                                                    }
                                                    className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
                                                >
                                                    <option value="pause">
                                                        Pause all checks
                                                    </option>
                                                    <option value="slow">
                                                        Use a slower delay
                                                    </option>
                                                </select>
                                            </div>

                                            {bulkQuietHoursMode === "slow" && (
                                                <div className="space-y-2">
                                                    <Label
                                                        htmlFor="bulk-quiet-delay"
                                                        className="text-xs"
                                                    >
                                                        Quiet-hours delay in
                                                        milliseconds
                                                    </Label>
                                                    <Input
                                                        id="bulk-quiet-delay"
                                                        type="number"
                                                        min={MIN_QUERY_DELAY_MS}
                                                        max={MAX_QUERY_DELAY_MS}
                                                        step={100}
                                                        value={
                                                            bulkQuietHoursDelayMs
                                                        }
                                                        onChange={(event) =>
                                                            setBulkQuietHoursDelayMs(
                                                                event.target
                                                                    .value,
                                                            )
                                                        }
                                                    />
                                                </div>
                                            )}

                                            <div className="space-y-2">
                                                <Label
                                                    htmlFor="bulk-quiet-timezone"
                                                    className="text-xs"
                                                >
                                                    Timezone
                                                </Label>
                                                <select
                                                    id="bulk-quiet-timezone"
                                                    value={
                                                        bulkQuietHoursTimezone
                                                    }
                                                    onChange={(event) =>
                                                        setBulkQuietHoursTimezone(
                                                            event.target.value,
                                                        )
                                                    }
                                                    className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
                                                >
                                                    {!REGIONS.some(
                                                        (region) =>
                                                            getRegionTimezone(
                                                                region.code,
                                                            ) ===
                                                            bulkQuietHoursTimezone,
                                                    ) && (
                                                        <option
                                                            value={
                                                                bulkQuietHoursTimezone
                                                            }
                                                        >
                                                            {
                                                                bulkQuietHoursTimezone
                                                            }
                                                        </option>
                                                    )}
                                                    {REGIONS.map((region) => (
                                                        <option
                                                            key={region.code}
                                                            value={getRegionTimezone(
                                                                region.code,
                                                            )}
                                                        >
                                                            {region.flag}{" "}
                                                            {region.label} —{" "}
                                                            {getRegionTimezone(
                                                                region.code,
                                                            )}
                                                        </option>
                                                    ))}
                                                </select>
                                            </div>
                                        </>
                                    )}
                                </div>
                            )}
                        </div>
                    </div>

                    <DialogFooter>
                        <Button
                            type="button"
                            variant="outline"
                            disabled={isBulkSaving}
                            onClick={() => setIsBulkEditOpen(false)}
                        >
                            Cancel
                        </Button>
                        <Button
                            type="button"
                            disabled={
                                isBulkSaving ||
                                !hasBulkChanges ||
                                selectedMonitorIds.length === 0
                            }
                            onClick={handleBulkSave}
                            className="gap-1.5"
                        >
                            {isBulkSaving && (
                                <Loader2 className="size-3.5 animate-spin" />
                            )}
                            Apply to {selectedMonitorIds.length} monitor
                            {selectedMonitorIds.length === 1 ? "" : "s"}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <FreePoolLimitDialog
                block={activationBlock}
                onOpenChange={(open) => {
                    if (!open) setActivationBlock(null);
                }}
            />

            <Dialog open={isSettingsOpen} onOpenChange={setIsSettingsOpen}>
                <DialogContent className="sm:max-w-2xl">
                    <DialogHeader>
                        <DialogTitle>Dashboard settings</DialogTitle>
                        <DialogDescription>
                            Adjust global monitor behavior and seller filters.
                        </DialogDescription>
                    </DialogHeader>

                    <div className="space-y-4 py-4">
                        <div className="border-border/80 bg-muted/30 flex items-center justify-between gap-4 rounded-lg border p-3">
                            <div className="space-y-0.5">
                                <div className="flex items-center gap-2">
                                    <Label
                                        htmlFor="dedupe-monitor-alerts"
                                        className="text-sm font-medium"
                                    >
                                        Dedupe monitor alerts
                                    </Label>
                                    <Badge
                                        variant="outline"
                                        className="bg-background text-[10px]"
                                    >
                                        {dedupeMonitorAlerts ? "On" : "Off"}
                                    </Badge>
                                </div>
                                <p className="text-muted-foreground text-[12px]">
                                    Send one Discord or Telegram alert when
                                    multiple monitors find the same item.
                                </p>
                            </div>
                            <Switch
                                id="dedupe-monitor-alerts"
                                aria-label="Toggle duplicate monitor alerts"
                                checked={dedupeMonitorAlerts}
                                disabled={isDedupePending}
                                onCheckedChange={handleDedupeChange}
                            />
                        </div>

                        <div className="border-border/80 rounded-lg border">
                            <div className="border-border/80 border-b p-3">
                                <h3 className="text-sm font-medium">
                                    Notification message style
                                </h3>
                                <p className="text-muted-foreground mt-0.5 text-[12px]">
                                    Choose how much space item alerts use. These
                                    settings apply to every monitor and can be
                                    different per channel.
                                </p>
                            </div>
                            <div className="grid gap-3 p-3 sm:grid-cols-2">
                                <div className="space-y-2">
                                    <Label
                                        htmlFor="telegram-message-style"
                                        className="text-xs"
                                    >
                                        Telegram
                                    </Label>
                                    <select
                                        id="telegram-message-style"
                                        value={telegramMessageStyle}
                                        disabled={isTelegramStylePending}
                                        onChange={(event) =>
                                            handleTelegramMessageStyleChange(
                                                event.target
                                                    .value as NotificationMessageStyle,
                                            )
                                        }
                                        className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
                                    >
                                        <option value="rich">
                                            Rich — image and details
                                        </option>
                                        <option value="compact">
                                            Compact — small preview and details
                                        </option>
                                    </select>
                                    <p className="text-muted-foreground text-[11px] leading-4">
                                        Compact requests a small preview when
                                        Telegram supports it and keeps size,
                                        condition, region, rating and the item
                                        link.
                                    </p>
                                </div>

                                <div className="space-y-2">
                                    <Label
                                        htmlFor="discord-message-style"
                                        className="text-xs"
                                    >
                                        Discord
                                    </Label>
                                    <select
                                        id="discord-message-style"
                                        value={discordMessageStyle}
                                        disabled={isDiscordStylePending}
                                        onChange={(event) =>
                                            handleDiscordMessageStyleChange(
                                                event.target
                                                    .value as NotificationMessageStyle,
                                            )
                                        }
                                        className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
                                    >
                                        <option value="rich">
                                            Rich — gallery and details
                                        </option>
                                        <option value="compact">
                                            Compact — thumbnail and details
                                        </option>
                                    </select>
                                    <p className="text-muted-foreground text-[11px] leading-4">
                                        Compact uses one clean embed with a
                                        thumbnail and the important item and
                                        seller details.
                                    </p>
                                </div>
                            </div>
                        </div>

                        <div className="border-border/80 rounded-lg border">
                            <div className="border-border/80 flex items-start justify-between gap-3 border-b p-3">
                                <div>
                                    <div className="flex items-center gap-2">
                                        <h3 className="text-sm font-medium">
                                            Banned sellers
                                        </h3>
                                        <Badge
                                            variant="outline"
                                            className="bg-background text-[10px]"
                                        >
                                            {sellerBans.length}
                                        </Badge>
                                    </div>
                                    <p className="text-muted-foreground mt-0.5 text-[12px]">
                                        Hidden from all your monitor feeds and
                                        future alerts.
                                    </p>
                                </div>
                            </div>

                            <div className="max-h-80 overflow-y-auto">
                                {isSellerBansLoading ? (
                                    <div className="p-3">
                                        <div className="bg-muted h-12 animate-pulse rounded-md" />
                                    </div>
                                ) : sellerBans.length === 0 ? (
                                    <div className="flex items-center gap-3 p-4 text-sm">
                                        <UserX className="text-muted-foreground h-4 w-4" />
                                        <span className="text-muted-foreground">
                                            No sellers banned.
                                        </span>
                                    </div>
                                ) : (
                                    <div className="divide-border divide-y">
                                        {sellerBans.map((ban) => {
                                            const label = ban.seller_login
                                                ? `@${ban.seller_login}`
                                                : `Seller ${ban.seller_id}`;
                                            return (
                                                <div
                                                    key={ban.seller_id}
                                                    className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between"
                                                >
                                                    <div className="min-w-0">
                                                        <div className="flex items-center gap-2">
                                                            <p className="truncate text-sm font-medium">
                                                                {label}
                                                            </p>
                                                            <span className="text-muted-foreground text-xs">
                                                                #{ban.seller_id}
                                                            </span>
                                                        </div>
                                                        <p className="text-muted-foreground mt-1 text-xs">
                                                            Banned{" "}
                                                            {formatTimestamp(
                                                                ban.created_at,
                                                            )}
                                                        </p>
                                                    </div>
                                                    <div className="flex items-center gap-2">
                                                        {ban.seller_profile_url ? (
                                                            <Button
                                                                asChild
                                                                variant="outline"
                                                                size="sm"
                                                                className="h-8 gap-1.5"
                                                            >
                                                                <a
                                                                    href={
                                                                        ban.seller_profile_url
                                                                    }
                                                                    target="_blank"
                                                                    rel="noopener noreferrer"
                                                                >
                                                                    Profile
                                                                    <ExternalLink className="h-3.5 w-3.5" />
                                                                </a>
                                                            </Button>
                                                        ) : null}
                                                        <Button
                                                            type="button"
                                                            variant="outline"
                                                            size="sm"
                                                            onClick={() =>
                                                                handleRemoveSellerBan(
                                                                    ban.seller_id,
                                                                )
                                                            }
                                                            disabled={
                                                                removingSellerId ===
                                                                ban.seller_id
                                                            }
                                                            className="h-8 gap-1.5 border-red-200 text-red-600 hover:bg-red-50 dark:border-red-500/20 dark:text-red-400 dark:hover:bg-red-500/10"
                                                        >
                                                            <Trash2 className="h-3.5 w-3.5" />
                                                            Unban
                                                        </Button>
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>

                    <DialogFooter>
                        <Button
                            variant="outline"
                            onClick={() => setIsSettingsOpen(false)}
                        >
                            Close
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <Dialog open={isWebhookOpen} onOpenChange={setIsWebhookOpen}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Notifications</DialogTitle>
                        <DialogDescription>
                            Configure notifications for{" "}
                            <strong>
                                {selectedMonitor?.name &&
                                selectedMonitor.name.length > 50
                                    ? selectedMonitor.name.slice(0, 50) + "..."
                                    : selectedMonitor?.name}
                            </strong>
                            .
                        </DialogDescription>
                    </DialogHeader>

                    <div className="grid gap-5 py-4">
                        {selectedMonitor && (
                            <div
                                className={`flex items-center justify-between gap-4 rounded-lg border p-3 ${
                                    selectedMonitor.notifications_enabled
                                        ? "border-indigo-500/20 bg-indigo-500/[0.06]"
                                        : "border-amber-500/25 bg-amber-500/[0.06]"
                                }`}
                            >
                                <div className="flex min-w-0 items-start gap-2.5">
                                    <Bell
                                        className={`mt-0.5 size-4 shrink-0 ${
                                            selectedMonitor.notifications_enabled
                                                ? "text-indigo-600 dark:text-indigo-400"
                                                : "text-amber-600 dark:text-amber-400"
                                        }`}
                                    />
                                    <div>
                                        <Label
                                            htmlFor="notifications-enabled"
                                            className="cursor-pointer text-sm font-medium"
                                        >
                                            Master alerts
                                        </Label>
                                        <p className="text-muted-foreground mt-0.5 text-[12px]">
                                            {!hasActiveNotificationChannel(
                                                selectedMonitor,
                                            )
                                                ? "Enable a delivery channel below to use alerts."
                                                : selectedMonitor.notifications_enabled
                                                  ? "External alerts are allowed for the active channels below."
                                                  : "All external alerts are muted. Your channel settings are preserved."}
                                        </p>
                                    </div>
                                </div>
                                <Switch
                                    id="notifications-enabled"
                                    checked={
                                        selectedMonitor.notifications_enabled
                                    }
                                    disabled={
                                        notificationToggleIds.has(
                                            selectedMonitor.id,
                                        ) ||
                                        !hasActiveNotificationChannel(
                                            selectedMonitor,
                                        )
                                    }
                                    onCheckedChange={(checked) =>
                                        void handleNotificationsToggle(
                                            selectedMonitor,
                                            checked,
                                        )
                                    }
                                    aria-label={`Notifications for ${selectedMonitor.name}`}
                                />
                            </div>
                        )}

                        <div className="border-border/80 bg-muted/25 flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2">
                            <p className="text-muted-foreground text-[12px]">
                                Message styles are account-wide and can be
                                changed in Dashboard settings.
                            </p>
                            <div className="flex items-center gap-1.5">
                                <Badge
                                    variant="outline"
                                    className="bg-background text-[10px] capitalize"
                                >
                                    Discord: {discordMessageStyle}
                                </Badge>
                                <Badge
                                    variant="outline"
                                    className="bg-background text-[10px] capitalize"
                                >
                                    Telegram: {telegramMessageStyle}
                                </Badge>
                            </div>
                        </div>

                        <div className="grid gap-2">
                            <Label htmlFor="webhook">Discord Webhook URL</Label>
                            <div className="flex gap-2">
                                <Input
                                    id="webhook"
                                    placeholder="https://discord.com/api/webhooks/..."
                                    value={webhookInput}
                                    onChange={(e) =>
                                        setWebhookInput(e.target.value)
                                    }
                                    className="flex-1"
                                />
                                <Button
                                    type="button"
                                    variant="outline"
                                    onClick={handleTestWebhook}
                                    disabled={isTestingWebhook || !webhookInput}
                                    className="shrink-0 gap-2"
                                >
                                    <Send className="h-4 w-4" />
                                    {isTestingWebhook ? "Testing..." : "Test"}
                                </Button>
                            </div>
                        </div>

                        {webhookInput.length > 0 && (
                            <div className="border-border/80 bg-muted/45 flex items-center justify-between space-x-2 rounded-lg border p-3">
                                <div className="flex flex-col space-y-0.5">
                                    <Label
                                        htmlFor="active-mode"
                                        className="cursor-pointer text-sm font-medium"
                                    >
                                        Enable Discord
                                    </Label>
                                    <span className="text-muted-foreground text-[12px]">
                                        Keep this webhook configured while
                                        controlling the Discord channel.
                                    </span>
                                </div>
                                <Switch
                                    id="active-mode"
                                    checked={isWebhookActive}
                                    disabled={isUpdatingWebhookStatus}
                                    onCheckedChange={handleWebhookStatusChange}
                                />
                            </div>
                        )}

                        <div className="border-border/80 bg-muted/25 grid gap-3 rounded-lg border p-3">
                            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                                <div className="space-y-1">
                                    <Label className="text-sm">Telegram</Label>
                                    {telegramConnection?.connected ? (
                                        <p className="text-muted-foreground flex items-center gap-1.5 text-[12px]">
                                            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                                            Connected to{" "}
                                            {telegramConnection.connection
                                                ?.chat_title || "Telegram"}
                                        </p>
                                    ) : (
                                        <p className="text-muted-foreground text-[12px]">
                                            Connect your Telegram once, then
                                            enable it per monitor.
                                        </p>
                                    )}
                                </div>
                                {telegramConnection?.connected ? (
                                    <div className="flex shrink-0 gap-2">
                                        <Button
                                            type="button"
                                            variant="outline"
                                            onClick={handleTestTelegram}
                                            disabled={isTestingTelegram}
                                            className="gap-2"
                                        >
                                            <MessageCircle className="h-4 w-4" />
                                            {isTestingTelegram
                                                ? "Testing..."
                                                : "Test"}
                                        </Button>
                                        <Button
                                            type="button"
                                            variant="outline"
                                            onClick={handleCreateTelegramCode}
                                            disabled={isCreatingTelegramCode}
                                            className="gap-2"
                                        >
                                            <RefreshCw className="h-4 w-4" />
                                            {isCreatingTelegramCode
                                                ? "Creating..."
                                                : "Reconnect"}
                                        </Button>
                                    </div>
                                ) : (
                                    <Button
                                        type="button"
                                        variant="outline"
                                        onClick={handleCreateTelegramCode}
                                        disabled={isCreatingTelegramCode}
                                        className="shrink-0 gap-2"
                                    >
                                        <MessageCircle className="h-4 w-4" />
                                        {isCreatingTelegramCode
                                            ? "Creating..."
                                            : "Connect Telegram"}
                                    </Button>
                                )}
                            </div>

                            {telegramConnectCode && (
                                <div className="border-border/80 bg-background rounded-md border p-3 text-[12px]">
                                    <p className="text-foreground font-medium">
                                        Send this command to{" "}
                                        {telegramConnectCode.botUsername ? (
                                            <span>
                                                @
                                                {
                                                    telegramConnectCode.botUsername
                                                }
                                            </span>
                                        ) : (
                                            "the Vintrack bot"
                                        )}
                                        :
                                    </p>
                                    <div className="mt-2 flex items-center gap-2">
                                        <code className="bg-muted text-foreground flex-1 rounded-md px-2 py-1.5">
                                            /connect {telegramConnectCode.code}
                                        </code>
                                        <Button
                                            type="button"
                                            variant="outline"
                                            size="icon"
                                            className="h-8 w-8 shrink-0"
                                            onClick={handleCopyTelegramCode}
                                            title="Copy command"
                                        >
                                            <Copy className="h-3.5 w-3.5" />
                                        </Button>
                                        {telegramConnectCode.botLink && (
                                            <a
                                                href={
                                                    telegramConnectCode.botLink
                                                }
                                                target="_blank"
                                                rel="noreferrer"
                                                className="border-input bg-background text-muted-foreground hover:bg-muted hover:text-foreground inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border transition-colors"
                                                title="Open Telegram"
                                            >
                                                <ExternalLink className="h-3.5 w-3.5" />
                                            </a>
                                        )}
                                    </div>
                                    <p className="text-muted-foreground mt-2">
                                        Use the open button to jump directly to
                                        the bot. Sending the command will
                                        {telegramConnection?.connected
                                            ? " replace the current Telegram destination."
                                            : " connect Telegram."}{" "}
                                        The dashboard detects it automatically.
                                    </p>
                                </div>
                            )}
                        </div>

                        {telegramConnection?.connected && (
                            <div className="border-border/80 bg-muted/45 flex items-center justify-between space-x-2 rounded-lg border p-3">
                                <div className="flex flex-col space-y-0.5">
                                    <Label
                                        htmlFor="telegram-active-mode"
                                        className="cursor-pointer text-sm font-medium"
                                    >
                                        Enable Telegram
                                    </Label>
                                    <span className="text-muted-foreground text-[12px]">
                                        Send new item and monitor status
                                        notifications to Telegram.
                                    </span>
                                </div>
                                <Switch
                                    id="telegram-active-mode"
                                    checked={isTelegramActive}
                                    onCheckedChange={async (checked) => {
                                        setIsTelegramActive(checked);
                                        setSelectedMonitor((monitor) =>
                                            monitor
                                                ? {
                                                      ...monitor,
                                                      telegram_active: checked,
                                                  }
                                                : monitor,
                                        );
                                        setMonitors((prev) =>
                                            prev.map((m) =>
                                                selectedMonitor &&
                                                m.id === selectedMonitor.id
                                                    ? {
                                                          ...m,
                                                          telegram_active:
                                                              checked,
                                                      }
                                                    : m,
                                            ),
                                        );
                                        if (selectedMonitor) {
                                            toast.promise(
                                                toggleTelegramStatus(
                                                    selectedMonitor.id,
                                                    !checked,
                                                ),
                                                {
                                                    success: checked
                                                        ? "Telegram activated"
                                                        : "Telegram deactivated",
                                                    error: "Failed to toggle Telegram",
                                                },
                                            );
                                        }
                                    }}
                                />
                            </div>
                        )}
                    </div>

                    <DialogFooter>
                        <Button
                            variant="outline"
                            onClick={() => setIsWebhookOpen(false)}
                        >
                            Close
                        </Button>
                        <Button onClick={handleSaveWebhook}>Save</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
