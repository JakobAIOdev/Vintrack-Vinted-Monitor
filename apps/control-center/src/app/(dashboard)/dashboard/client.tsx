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
import {
    startAllMonitors,
    stopAllMonitors,
    toggleMonitor,
    updateMonitorWebhook,
    setMonitorWebhookStatus,
    toggleTelegramStatus,
} from "@/actions/dashboard-actions";
import { testDiscordWebhook } from "@/actions/monitor";
import { updateMonitorAlertDedupe } from "@/actions/account";
import { getBrandLabels } from "@/lib/brands";
import { getColorLabels } from "@/lib/colors";
import { getSizeLabels } from "@/lib/sizes";
import {
    getRegionLabel,
    getRegionFlags,
    getStatusLocaleForRegionCodes,
} from "@/lib/regions";
import { getStatusLabels } from "@/lib/statuses";
import { formatQueryDelay } from "@/lib/monitor-delay";
import {
    FirstMonitorQuickStart,
    type QuickStartPool,
} from "@/components/monitors/first-monitor-quick-start";
import { DEMO_MONITOR_DURATION_MS } from "@/lib/demo-monitor";

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
    status: string;
    price_max: number | null;
    catalog_ids: string | null;
    category_labels: string[];
    brand_ids: string | null;
    color_ids: string | null;
    status_ids: string | null;
    size_id: string | null;
    region: string;
    allowed_countries: string | null;
    discord_webhook: string | null;
    webhook_active: boolean;
    telegram_active: boolean;
    proxy_source: string;
    proxy_group_name: string | null;
    demo_expires_at: string | null;
    _count: { items: number };
    created_at: string;
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
    if (h.proxy_state === "waiting_for_proxy" || h.proxy_state === "unavailable")
        return true;
    if (h.consecutive_errors === -1 || h.consecutive_errors >= 3) return true;
    return false;
}

function formatTimestamp(value: string) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "not yet";
    return date.toLocaleString();
}

function getMonitorFilterLabels(monitor: Monitor): string[] {
    const labels = [...monitor.category_labels];

    if (monitor.brand_ids) {
        labels.push(...getBrandLabels(monitor.brand_ids));
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
    if (monitor.allowed_countries) {
        labels.push(
            `From ${getRegionFlags(monitor.allowed_countries).join(" ")}`,
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
    quickStartEligible,
    initialQuickStartOpen,
    quickStartPool,
    initialNow,
}: {
    initialMonitors: Monitor[];
    userName: string;
    initialDedupeMonitorAlerts: boolean;
    quickStartEligible: boolean;
    initialQuickStartOpen: boolean;
    quickStartPool: QuickStartPool | null;
    initialNow: string;
}) {
    const [selectedMonitor, setSelectedMonitor] = useState<Monitor | null>(
        null,
    );
    const [webhookInput, setWebhookInput] = useState("");
    const [isWebhookOpen, setIsWebhookOpen] = useState(false);
    const [isWebhookActive, setIsWebhookActive] = useState(true);
    const [isUpdatingWebhookStatus, setIsUpdatingWebhookStatus] =
        useState(false);
    const [isTelegramActive, setIsTelegramActive] = useState(false);
    const [isTestingWebhook, setIsTestingWebhook] = useState(false);
    const [isTestingTelegram, setIsTestingTelegram] = useState(false);
    const [isCreatingTelegramCode, setIsCreatingTelegramCode] = useState(false);
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);
    const [telegramConnection, setTelegramConnection] =
        useState<TelegramConnectionState | null>(null);
    const [telegramConnectCode, setTelegramConnectCode] =
        useState<TelegramConnectCode | null>(null);
    const [monitors, setMonitors] = useState<Monitor[]>(initialMonitors);
    const [dedupeMonitorAlerts, setDedupeMonitorAlerts] = useState(
        initialDedupeMonitorAlerts,
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
        if (
            !isWebhookOpen ||
            !telegramConnectCode ||
            telegramConnection?.connected
        ) {
            return;
        }

        const interval = setInterval(fetchTelegramConnection, 2_000);
        return () => clearInterval(interval);
    }, [
        fetchTelegramConnection,
        isWebhookOpen,
        telegramConnectCode,
        telegramConnection?.connected,
    ]);

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

    const handleStopAll = async () => {
        setMonitors((prev) => prev.map((m) => ({ ...m, status: "paused" })));
        toast.promise(stopAllMonitors(), {
            loading: "Stopping all monitors...",
            success: "All monitors stopped",
            error: "Failed to stop monitors",
        });
    };

    const handleStartAll = async () => {
        toast.promise(startAllMonitors(), {
            loading: "Starting monitors...",
            success: (result) => {
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
                return result.message;
            },
            error: (error) =>
                error instanceof Error
                    ? error.message
                    : "Failed to start monitors",
        });
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

        toast.promise(toggleMonitor(id, currentStatus), {
            loading: "Updating...",
            success: (result) => {
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
                return `Monitor ${actionText}`;
            },
            error: (error) => {
                setMonitors((prev) =>
                    prev.map((m) =>
                        m.id === id && currentMonitor ? currentMonitor : m,
                    ),
                );
                return error instanceof Error
                    ? error.message
                    : "Failed to update monitor";
            },
        });
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
    const pausedCount = monitors.filter((m) => m.status === "paused").length;
    const totalItems = monitors.reduce((sum, m) => sum + m._count.items, 0);

    return (
        <div className="space-y-8">
            {quickStartEligible && (
                <FirstMonitorQuickStart
                    open={isQuickStartOpen}
                    onOpenChange={setIsQuickStartOpen}
                    initialPool={quickStartPool}
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
                    {pausedCount > 0 && (
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
                    <Link href="/monitors/new" className="flex-1 sm:flex-none">
                        <Button size="sm" className="w-full gap-1.5">
                            <Plus className="h-3.5 w-3.5" /> New Monitor
                        </Button>
                    </Link>
                </div>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
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
                            >
                                <Rocket className="h-3.5 w-3.5" /> Quick start
                            </Button>
                        )}
                        <Link href="/monitors/new">
                            <Button
                                size="sm"
                                variant={
                                    quickStartEligible ? "outline" : "default"
                                }
                                className="gap-1.5"
                            >
                                <Plus className="h-3.5 w-3.5" /> Create manually
                            </Button>
                        </Link>
                    </div>
                </div>
            ) : (
                <div className="space-y-4">
                    <h2 className="text-base font-semibold">Your monitors</h2>
                    <div className="grid auto-rows-fr grid-cols-1 gap-4 md:grid-cols-2 2xl:grid-cols-3">
                        {sortedMonitors.map((m) => (
                            <Card
                                key={m.id}
                                data-testid="monitor-card"
                                className="group border-border/70 bg-card hover:border-foreground/20 h-full overflow-hidden rounded-lg py-0 shadow-none transition-colors"
                            >
                                <CardContent className="flex h-full flex-1 flex-col p-0">
                                    <div className="flex items-start justify-between gap-3 p-5 pb-4">
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
                                        <div className="flex shrink-0 items-center gap-0.5">
                                            <Link
                                                href={`/monitors/${m.id}/edit?from=dashboard`}
                                                className="text-muted-foreground hover:bg-accent hover:text-accent-foreground flex size-8 items-center justify-center rounded-md transition-colors"
                                                title="Edit monitor"
                                                aria-label="Edit monitor"
                                            >
                                                <Pencil className="h-3.5 w-3.5" />
                                            </Link>
                                            <button
                                                type="button"
                                                onClick={() =>
                                                    openWebhookDialog(m)
                                                }
                                                className="text-muted-foreground hover:bg-accent hover:text-accent-foreground flex size-8 items-center justify-center rounded-md transition-colors"
                                                title="Configure notifications"
                                                aria-label="Configure notifications"
                                            >
                                                <Webhook
                                                    className={`h-3.5 w-3.5 ${
                                                        (m.discord_webhook &&
                                                            m.webhook_active) ||
                                                        m.telegram_active
                                                            ? "text-indigo-600 dark:text-indigo-400"
                                                            : ""
                                                    }`}
                                                />
                                            </button>
                                        </div>
                                    </div>

                                    <div className="px-5 pb-4">
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

                                    <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-2 px-5 pb-4 text-xs">
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

                                    <div className="flex px-5 pb-5 [&>span]:hidden">
                                        <div className="text-muted-foreground flex min-w-0 items-center gap-2 text-xs">
                                            <SlidersHorizontal className="text-muted-foreground size-3.5" />
                                            <span className="shrink-0">
                                                {
                                                    getMonitorFilterLabels(m)
                                                        .length
                                                }{" "}
                                                filters
                                            </span>
                                            {getMonitorFilterLabels(m).length >
                                                0 && (
                                                <span className="truncate">
                                                    ·{" "}
                                                    {getMonitorFilterLabels(m)
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
                                            getBrandLabels(m.brand_ids).map(
                                                (label) => (
                                                    <span
                                                        key={`brand-${label}`}
                                                        className="border-border/60 bg-muted/50 text-muted-foreground inline-flex items-center rounded-md border px-2 py-0.5 text-[10px] font-medium"
                                                    >
                                                        {label}
                                                    </span>
                                                ),
                                            )}
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

                                    <div className="border-border/60 text-muted-foreground flex flex-wrap items-center gap-x-5 gap-y-2 border-t px-5 py-4">
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
                                        <div className="min-w-0">
                                            <p className="hidden">Alerts</p>
                                            <p className="flex min-w-0 items-center gap-1.5 text-xs">
                                                <Bell className="text-muted-foreground size-3.5 shrink-0" />
                                                <span className="truncate">
                                                    {m.discord_webhook &&
                                                    m.webhook_active &&
                                                    m.telegram_active
                                                        ? "Discord + Telegram"
                                                        : m.discord_webhook &&
                                                            m.webhook_active
                                                          ? "Discord"
                                                          : m.telegram_active
                                                            ? "Telegram"
                                                            : "Off"}
                                                </span>
                                            </p>
                                        </div>
                                    </div>

                                    <div className="border-border/60 bg-muted/10 flex items-center gap-2 border-t px-3 py-2.5">
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            onClick={() =>
                                                handleToggle(m.id, m.status)
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
                                                    Resume
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
                                        Enable Notifications
                                    </Label>
                                    <span className="text-muted-foreground text-[12px]">
                                        Pause notifications without deleting the
                                        URL.
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
                                    <Button
                                        type="button"
                                        variant="outline"
                                        onClick={handleTestTelegram}
                                        disabled={isTestingTelegram}
                                        className="shrink-0 gap-2"
                                    >
                                        <MessageCircle className="h-4 w-4" />
                                        {isTestingTelegram
                                            ? "Testing..."
                                            : "Test"}
                                    </Button>
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

                            {!telegramConnection?.connected &&
                                telegramConnectCode && (
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
                                                /connect{" "}
                                                {telegramConnectCode.code}
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
                                            Use the open button to jump directly
                                            to the bot. The dashboard will
                                            detect the connection automatically
                                            after you send it.
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
                            Cancel
                        </Button>
                        <Button onClick={handleSaveWebhook}>Save</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
