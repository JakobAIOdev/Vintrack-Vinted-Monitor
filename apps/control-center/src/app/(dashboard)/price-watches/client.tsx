"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
    Bell,
    BellOff,
    CheckCircle2,
    Clock3,
    Eye,
    Gauge,
    History,
    Loader2,
    MoreHorizontal,
    Pause,
    Pencil,
    Play,
    PlayCircle,
    Plus,
    Search,
    Server,
    StopCircle,
    Trash2,
    TrendingDown,
} from "lucide-react";
import { toast } from "sonner";
import {
    createPriceWatch,
    deletePriceWatch,
    setPriceWatchStatus,
    startAllPriceWatches,
    stopAllPriceWatches,
    updatePriceWatch,
    type PriceWatchSettingsInput,
} from "@/actions/price-watch";
import {
    PERSONAL_PRICE_WATCH_INTERVALS,
    SHARED_PRICE_WATCH_INTERVALS,
} from "@/lib/price-watch-config";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
import { getRegionLabel, REGIONS } from "@/lib/regions";
import { cn } from "@/lib/utils";

export type PriceWatchView = {
    id: string;
    status: string;
    notificationsEnabled: boolean;
    discordWebhook: string;
    webhookActive: boolean;
    telegramActive: boolean;
    initialPriceMinor: string | null;
    armedAt: string | null;
    stoppedReason: string | null;
    createdAt: string;
    pollIntervalSeconds: number;
    transportKind: string;
    proxyGroupId: number | null;
    proxyGroupName: string | null;
    target: {
        region: string;
        itemId: string;
        canonicalUrl: string;
        title: string | null;
        imageUrl: string | null;
        currentPriceMinor: string | null;
        currencyCode: string | null;
        availability: string;
        lastCheckedAt: string | null;
        nextCheckAt: string;
        lastErrorCode: string | null;
        events: Array<{
            id: string;
            previousPriceMinor: string;
            newPriceMinor: string;
            currencyCode: string;
            observedAt: string;
        }>;
    };
};

export type PriceWatchProxyGroup = {
    id: number;
    name: string;
    checkStatus: string;
    checkRegion: string | null;
    working: number;
    bandwidthReached: boolean;
};

type SettingsState = PriceWatchSettingsInput;
type WatchFilter = "all" | "active" | "paused" | "attention";

const SELECT_CLASS =
    "border-input bg-background ring-offset-background focus-visible:ring-ring h-9 w-full rounded-md border px-3 text-sm shadow-xs outline-none focus-visible:ring-2";

const emptySettings = (hasTelegramConnection: boolean): SettingsState => ({
    notificationsEnabled: true,
    discordWebhook: "",
    webhookActive: false,
    telegramActive: hasTelegramConnection,
    pollIntervalSeconds: 120,
    proxyGroupId: null,
});

function formatPrice(value: string | null, currency: string | null) {
    if (!value || !currency) return "—";
    const amount = Number(BigInt(value)) / 100;
    try {
        return new Intl.NumberFormat(undefined, {
            style: "currency",
            currency,
        }).format(amount);
    } catch {
        return `${amount.toFixed(2)} ${currency}`;
    }
}

function formatTime(value: string | null) {
    if (!value) return "Not checked yet";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "Not checked yet" : date.toLocaleString();
}

function formatInterval(seconds: number) {
    return seconds < 60 ? `${seconds} sec` : `${seconds / 60} min`;
}

function proxyGroupUnavailableReason(
    group: PriceWatchProxyGroup,
    region: string | null,
) {
    if (group.bandwidthReached) return "bandwidth limit reached";
    if (group.checkStatus === "pending" || group.checkStatus === "running") {
        return "verification running";
    }
    if (!region) return "paste an item URL first";
    if (group.checkStatus !== "completed" || !group.checkRegion) {
        return `verify for ${getRegionLabel(region)}`;
    }
    if (group.checkRegion !== region) {
        return `verified for ${getRegionLabel(group.checkRegion)}`;
    }
    if (group.working < 1) return "no working proxies";
    return null;
}

function watchStatus(watch: PriceWatchView) {
    if (watch.status === "paused") {
        return {
            label: "Paused",
            className:
                "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
        };
    }
    if (watch.status === "stopped") {
        return {
            label: "Stopped",
            className:
                "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
        };
    }
    if (watch.target.lastErrorCode) {
        return {
            label: "Retrying",
            className:
                "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
        };
    }
    if (!watch.armedAt || watch.target.availability === "pending") {
        return {
            label: "Validating",
            className:
                "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300",
        };
    }
    return {
        label: "Watching",
        className:
            "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    };
}

function regionFromItemUrl(rawUrl: string) {
    try {
        const hostname = new URL(rawUrl).hostname.replace(/^www\./, "");
        return REGIONS.find((region) => region.domain === hostname)?.code ?? null;
    } catch {
        return null;
    }
}

function SettingsFields({
    value,
    onChange,
    hasTelegramConnection,
    proxyGroups,
    region,
    idPrefix,
}: {
    value: SettingsState;
    onChange: (value: SettingsState) => void;
    hasTelegramConnection: boolean;
    proxyGroups: PriceWatchProxyGroup[];
    region: string | null;
    idPrefix: string;
}) {
    const personal = value.proxyGroupId !== null;
    const intervals = personal
        ? PERSONAL_PRICE_WATCH_INTERVALS
        : SHARED_PRICE_WATCH_INTERVALS;
    const groupsWithAvailability = proxyGroups.map((group) => ({
        group,
        unavailableReason: proxyGroupUnavailableReason(group, region),
    }));
    const eligibleGroups = groupsWithAvailability.filter(
        ({ unavailableReason }) => unavailableReason === null,
    );
    return (
        <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-2">
                    <Label htmlFor={`${idPrefix}-transport`}>Connection</Label>
                    <select
                        id={`${idPrefix}-transport`}
                        className={SELECT_CLASS}
                        value={value.proxyGroupId ?? "shared"}
                        onChange={(event) => {
                            const proxyGroupId =
                                event.target.value === "shared"
                                    ? null
                                    : Number(event.target.value);
                            onChange({
                                ...value,
                                proxyGroupId,
                                pollIntervalSeconds: proxyGroupId ? 60 : 120,
                            });
                        }}
                    >
                        <option value="shared">Vintrack Shared</option>
                        {groupsWithAvailability.map(({ group, unavailableReason }) => (
                            <option
                                key={group.id}
                                value={group.id}
                                disabled={unavailableReason !== null}
                            >
                                {group.name} · {unavailableReason ?? `${group.working} working`}
                            </option>
                        ))}
                    </select>
                    <p className="text-muted-foreground text-xs">
                        {personal
                            ? "Your group is isolated and never falls back to Vintrack traffic."
                            : "Shared items are deduplicated across members."}
                    </p>
                </div>
                <div className="space-y-2">
                    <Label htmlFor={`${idPrefix}-interval`}>Check every</Label>
                    <select
                        id={`${idPrefix}-interval`}
                        className={SELECT_CLASS}
                        value={value.pollIntervalSeconds}
                        onChange={(event) =>
                            onChange({
                                ...value,
                                pollIntervalSeconds: Number(event.target.value),
                            })
                        }
                    >
                        {intervals.map((seconds) => (
                            <option key={seconds} value={seconds}>
                                {formatInterval(seconds)}
                            </option>
                        ))}
                    </select>
                    <p className="text-muted-foreground text-xs">
                        Shared starts at 2m. Verified personal proxies unlock 30s.
                    </p>
                </div>
            </div>

            {region && proxyGroups.length > 0 && eligibleGroups.length === 0 && (
                <div className="border-amber-500/25 bg-amber-500/8 rounded-lg border px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                    <p>
                        None of your {proxyGroups.length} proxy groups currently has a
                        successful {getRegionLabel(region)} check with a working proxy.
                    </p>
                    <Link
                        href="/proxies"
                        className="mt-1.5 inline-flex font-semibold underline underline-offset-2"
                    >
                        Verify a group in Proxy Groups
                    </Link>
                </div>
            )}

            <div className="flex items-center justify-between gap-4 rounded-xl border p-3.5">
                <div>
                    <Label htmlFor={`${idPrefix}-notifications`}>Notifications</Label>
                    <p className="text-muted-foreground mt-1 text-xs">
                        Alert when Vinted lowers the item price.
                    </p>
                </div>
                <Switch
                    id={`${idPrefix}-notifications`}
                    checked={value.notificationsEnabled}
                    onCheckedChange={(checked) =>
                        onChange({ ...value, notificationsEnabled: checked })
                    }
                />
            </div>

            <div className="space-y-2 rounded-xl border p-3.5">
                <div className="flex items-center justify-between gap-4">
                    <div>
                        <Label htmlFor={`${idPrefix}-discord`}>Discord</Label>
                        <p className="text-muted-foreground mt-1 text-xs">
                            Use a webhook dedicated to this item.
                        </p>
                    </div>
                    <Switch
                        checked={value.webhookActive}
                        disabled={!value.notificationsEnabled}
                        onCheckedChange={(checked) =>
                            onChange({ ...value, webhookActive: checked })
                        }
                        aria-label="Enable Discord"
                    />
                </div>
                <Input
                    id={`${idPrefix}-discord`}
                    value={value.discordWebhook}
                    onChange={(event) =>
                        onChange({
                            ...value,
                            discordWebhook: event.target.value,
                            webhookActive:
                                value.webhookActive || Boolean(event.target.value),
                        })
                    }
                    placeholder="https://discord.com/api/webhooks/..."
                    type="url"
                    autoComplete="off"
                    disabled={!value.notificationsEnabled}
                />
            </div>

            <div className="flex items-center justify-between gap-4 rounded-xl border p-3.5">
                <div>
                    <Label>Telegram</Label>
                    <p className="text-muted-foreground mt-1 text-xs">
                        {hasTelegramConnection
                            ? "Send the alert to your connected chat."
                            : "Connect Telegram from Account first."}
                    </p>
                </div>
                <Switch
                    checked={value.telegramActive}
                    disabled={!value.notificationsEnabled || !hasTelegramConnection}
                    onCheckedChange={(checked) =>
                        onChange({ ...value, telegramActive: checked })
                    }
                    aria-label="Enable Telegram"
                />
            </div>
        </div>
    );
}

export function PriceWatchesClient({
    initialWatches,
    hasTelegramConnection,
    activeCount,
    activeLimit,
    activeLimitSource,
    focusedWatchId,
    proxyGroups,
}: {
    initialWatches: PriceWatchView[];
    hasTelegramConnection: boolean;
    activeCount: number;
    activeLimit: number | null;
    activeLimitSource: string | null;
    focusedWatchId: string | null;
    proxyGroups: PriceWatchProxyGroup[];
}) {
    const router = useRouter();
    const [itemUrl, setItemUrl] = useState("");
    const [settings, setSettings] = useState<SettingsState>(() =>
        emptySettings(hasTelegramConnection),
    );
    const [addOpen, setAddOpen] = useState(false);
    const [search, setSearch] = useState("");
    const [filter, setFilter] = useState<WatchFilter>("all");
    const [editing, setEditing] = useState<PriceWatchView | null>(null);
    const [editSettings, setEditSettings] = useState<SettingsState>(() =>
        emptySettings(hasTelegramConnection),
    );
    const [deleting, setDeleting] = useState<PriceWatchView | null>(null);
    const [historyWatch, setHistoryWatch] = useState<PriceWatchView | null>(null);
    const [openMenuId, setOpenMenuId] = useState<string | null>(null);
    const [isPending, startTransition] = useTransition();

    const hasPendingWatch = initialWatches.some(
        (watch) => watch.status === "active" && !watch.armedAt,
    );
    useEffect(() => {
        if (!hasPendingWatch) return;
        const timer = window.setInterval(() => router.refresh(), 5_000);
        return () => window.clearInterval(timer);
    }, [hasPendingWatch, router]);
    useEffect(() => {
        if (!focusedWatchId) return;
        document
            .getElementById(`price-watch-${focusedWatchId}`)
            ?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, [focusedWatchId]);
    useEffect(() => {
        const fragment = new URLSearchParams(window.location.hash.slice(1));
        const handoffUrl = fragment.get("vintrack-vinted-item");
        if (!handoffUrl) return;

        const cleanUrl = `${window.location.pathname}${window.location.search}`;
        window.history.replaceState(window.history.state, "", cleanUrl);
        const timer = window.setTimeout(() => {
            setItemUrl(handoffUrl);
            setAddOpen(true);
            toast.success(
                "Vinted item imported. Review the settings before adding it.",
            );
        }, 0);
        return () => window.clearTimeout(timer);
    }, []);

    const limitReached = activeLimit !== null && activeCount >= activeLimit;
    const totalDrops = initialWatches.reduce(
        (total, watch) => total + watch.target.events.length,
        0,
    );
    const attentionCount = initialWatches.filter(
        (watch) => Boolean(watch.target.lastErrorCode) || watch.status === "stopped",
    ).length;
    const inactiveCount = initialWatches.filter(
        (watch) => watch.status !== "active",
    ).length;
    const filteredWatches = useMemo(() => {
        const query = search.trim().toLowerCase();
        return initialWatches.filter((watch) => {
            const matchesQuery =
                !query ||
                (watch.target.title || "").toLowerCase().includes(query) ||
                watch.target.itemId.includes(query) ||
                getRegionLabel(watch.target.region).toLowerCase().includes(query);
            const needsAttention =
                Boolean(watch.target.lastErrorCode) || watch.status === "stopped";
            return (
                matchesQuery &&
                (filter === "all" ||
                    (filter === "active" &&
                        watch.status === "active" &&
                        !needsAttention) ||
                    (filter === "paused" && watch.status === "paused") ||
                    (filter === "attention" && needsAttention))
            );
        });
    }, [filter, initialWatches, search]);

    const submitCreate = () => {
        startTransition(async () => {
            const result = await createPriceWatch(itemUrl, settings);
            if (!result.ok) {
                toast.error(result.message);
                return;
            }
            toast.success("Price Watch created and queued for validation.");
            setItemUrl("");
            setSettings(emptySettings(hasTelegramConnection));
            setAddOpen(false);
            router.refresh();
        });
    };

    const runStatusChange = (watch: PriceWatchView) => {
        setOpenMenuId(null);
        const nextStatus = watch.status === "active" ? "paused" : "active";
        startTransition(async () => {
            const result = await setPriceWatchStatus(watch.id, nextStatus);
            if (!result.ok) {
                toast.error(result.message);
                return;
            }
            toast.success(nextStatus === "active" ? "Price Watch resumed." : "Price Watch paused.");
            router.refresh();
        });
    };

    const runStartAll = () => {
        startTransition(async () => {
            const result = await startAllPriceWatches();
            if (!result.ok) {
                toast.error(result.message);
                return;
            }
            if (result.skippedCount > 0) {
                toast.warning(result.message);
            } else {
                toast.success(result.message);
            }
            router.refresh();
        });
    };

    const runStopAll = () => {
        startTransition(async () => {
            const result = await stopAllPriceWatches();
            if (!result.ok) {
                toast.error(result.message);
                return;
            }
            toast.success(result.message);
            router.refresh();
        });
    };

    const openEdit = (watch: PriceWatchView) => {
        setOpenMenuId(null);
        setEditing(watch);
        setEditSettings({
            notificationsEnabled: watch.notificationsEnabled,
            discordWebhook: watch.discordWebhook,
            webhookActive: watch.webhookActive,
            telegramActive: watch.telegramActive,
            pollIntervalSeconds: watch.pollIntervalSeconds,
            proxyGroupId: watch.proxyGroupId,
        });
    };

    const submitEdit = () => {
        if (!editing) return;
        startTransition(async () => {
            const result = await updatePriceWatch(editing.id, editSettings);
            if (!result.ok) {
                toast.error(result.message);
                return;
            }
            toast.success("Price Watch updated.");
            setEditing(null);
            router.refresh();
        });
    };

    const confirmDelete = () => {
        if (!deleting) return;
        startTransition(async () => {
            const result = await deletePriceWatch(deleting.id);
            if (!result.ok) {
                toast.error(result.message);
                return;
            }
            toast.success("Price Watch deleted.");
            setDeleting(null);
            router.refresh();
        });
    };

    const createRegion = regionFromItemUrl(itemUrl);

    return (
        <div className="space-y-5">
            <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
                <div>
                    <div className="mb-2 flex items-center gap-2">
                        <div className="bg-primary/10 text-primary flex h-9 w-9 items-center justify-center rounded-xl">
                            <TrendingDown className="h-4.5 w-4.5" />
                        </div>
                        <Badge variant="outline">Individual items</Badge>
                    </div>
                    <h1 className="text-2xl font-semibold tracking-tight">Price Watch</h1>
                    <p className="text-muted-foreground mt-1 text-sm">
                        Track individual Vinted prices with shared or personal proxies.
                    </p>
                </div>
                <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
                    {inactiveCount > 0 && (
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={runStartAll}
                            disabled={isPending}
                            className="flex-1 gap-1.5 border-emerald-200 text-emerald-700 hover:bg-emerald-50 hover:text-emerald-800 sm:flex-none dark:border-emerald-500/20 dark:bg-transparent dark:text-emerald-400 dark:hover:bg-emerald-500/10"
                        >
                            <PlayCircle className="h-3.5 w-3.5" /> Start All
                        </Button>
                    )}
                    {activeCount > 0 && (
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={runStopAll}
                            disabled={isPending}
                            className="flex-1 gap-1.5 border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700 sm:flex-none dark:border-red-500/20 dark:bg-transparent dark:text-red-400 dark:hover:bg-red-500/10"
                        >
                            <StopCircle className="h-3.5 w-3.5" /> Stop All
                        </Button>
                    )}
                    <Button
                        size="sm"
                        onClick={() => setAddOpen(true)}
                        disabled={limitReached || isPending}
                        className="flex-1 sm:flex-none"
                    >
                        <Plus className="mr-2 h-4 w-4" />
                        Add watch
                    </Button>
                </div>
            </div>

            <div className="border-border/70 bg-card flex flex-wrap items-center gap-x-6 gap-y-3 rounded-xl border px-4 py-3 shadow-sm">
                <div className="flex items-center gap-2">
                    <Eye className="text-primary h-4 w-4" />
                    <span className="text-sm font-medium">{activeCount} active</span>
                    <span className="text-muted-foreground text-xs">
                        / {activeLimit ?? "unlimited"}
                    </span>
                </div>
                <div className="flex items-center gap-2 text-sm">
                    <TrendingDown className="h-4 w-4 text-emerald-500" />
                    {totalDrops} drops
                </div>
                <div className="flex items-center gap-2 text-sm">
                    <Gauge className="h-4 w-4 text-amber-500" />
                    {attentionCount} need attention
                </div>
                <div className="text-muted-foreground ml-auto text-xs">
                    {activeLimitSource === "github_star"
                        ? "GitHub Star tier"
                        : activeLimitSource === "donation"
                          ? "Sponsor tier"
                          : activeLimitSource === "policy_default"
                            ? "Star Vintrack for more slots"
                            : "Shared from 2m · personal from 30s"}
                </div>
            </div>

            <div className="flex flex-col justify-between gap-3 lg:flex-row lg:items-center">
                <div>
                    <h2 className="font-semibold">Watched items</h2>
                    <p className="text-muted-foreground text-xs">
                        Compact view · fastest schedules first
                    </p>
                </div>
                {initialWatches.length > 0 && (
                    <div className="flex flex-col gap-2 sm:flex-row">
                        <div className="relative">
                            <Search className="text-muted-foreground absolute top-2.5 left-3 h-4 w-4" />
                            <Input
                                value={search}
                                onChange={(event) => setSearch(event.target.value)}
                                placeholder="Search watches"
                                aria-label="Search watched items"
                                className="pl-9 sm:w-64"
                            />
                        </div>
                        <div className="bg-muted/60 flex rounded-lg p-1">
                            {(["all", "active", "paused", "attention"] as const).map(
                                (option) => (
                                    <Button
                                        key={option}
                                        size="sm"
                                        variant={filter === option ? "secondary" : "ghost"}
                                        className="h-7 px-2.5 text-xs capitalize"
                                        onClick={() => setFilter(option)}
                                    >
                                        {option}
                                    </Button>
                                ),
                            )}
                        </div>
                    </div>
                )}
            </div>

            {initialWatches.length === 0 ? (
                <Card className="border-dashed">
                    <CardContent className="flex flex-col items-center py-12 text-center">
                        <TrendingDown className="text-muted-foreground/45 mb-3 h-9 w-9" />
                        <p className="font-medium">No watched items yet</p>
                        <p className="text-muted-foreground mt-1 max-w-md text-sm">
                            Paste a Vinted item link and choose how often Vintrack checks it.
                        </p>
                        <Button className="mt-5" onClick={() => setAddOpen(true)}>
                            <Plus className="mr-2 h-4 w-4" /> Add your first watch
                        </Button>
                    </CardContent>
                </Card>
            ) : filteredWatches.length === 0 ? (
                <Card className="border-dashed">
                    <CardContent className="py-10 text-center text-sm">
                        No watches match these filters.
                    </CardContent>
                </Card>
            ) : (
                <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">
                    {filteredWatches.map((watch) => {
                        const status = watchStatus(watch);
                        const latestDrop = watch.target.events[0];
                        return (
                            <Card
                                key={watch.id}
                                id={`price-watch-${watch.id}`}
                                className={cn(
                                    "scroll-mt-6 overflow-visible transition-shadow",
                                    focusedWatchId === watch.id &&
                                        "ring-primary/50 ring-2 shadow-lg",
                                )}
                            >
                                <CardContent className="p-3">
                                    <div className="flex min-w-0 gap-3">
                                        <a
                                            href={watch.target.canonicalUrl}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="bg-muted relative h-28 w-24 shrink-0 overflow-hidden rounded-lg border"
                                        >
                                            {watch.target.imageUrl ? (
                                                <img
                                                    src={watch.target.imageUrl}
                                                    alt=""
                                                    className="h-full w-full object-contain p-1"
                                                />
                                            ) : (
                                                <span className="text-muted-foreground flex h-full items-center justify-center">
                                                    <Eye className="h-7 w-7 opacity-30" />
                                                </span>
                                            )}
                                        </a>
                                        <div className="min-w-0 flex-1">
                                            <div className="flex items-start gap-2">
                                                <div className="min-w-0 flex-1">
                                                    <Badge
                                                        variant="outline"
                                                        className={cn("h-5 px-1.5 text-[10px]", status.className)}
                                                    >
                                                        {status.label}
                                                    </Badge>
                                                    <a
                                                        href={watch.target.canonicalUrl}
                                                        target="_blank"
                                                        rel="noopener noreferrer"
                                                        className="mt-1.5 block line-clamp-2 text-sm font-semibold leading-5 hover:underline"
                                                    >
                                                        {watch.target.title ||
                                                            `Vinted item ${watch.target.itemId}`}
                                                    </a>
                                                </div>
                                                <div className="relative">
                                                    <button
                                                        type="button"
                                                        className="text-muted-foreground hover:bg-muted rounded-md p-1.5"
                                                        onClick={() =>
                                                            setOpenMenuId(
                                                                openMenuId === watch.id
                                                                    ? null
                                                                    : watch.id,
                                                            )
                                                        }
                                                        aria-label="Price Watch actions"
                                                    >
                                                        <MoreHorizontal className="h-4 w-4" />
                                                    </button>
                                                    {openMenuId === watch.id && (
                                                        <div className="border-border bg-popover absolute top-8 right-0 z-20 w-40 rounded-lg border p-1 shadow-xl">
                                                            {[
                                                                {
                                                                    label: "Edit watch",
                                                                    icon: Pencil,
                                                                    run: () => openEdit(watch),
                                                                },
                                                                {
                                                                    label:
                                                                        watch.status === "active"
                                                                            ? "Pause"
                                                                            : "Resume",
                                                                    icon:
                                                                        watch.status === "active"
                                                                            ? Pause
                                                                            : Play,
                                                                    run: () => runStatusChange(watch),
                                                                },
                                                                {
                                                                    label: "Price history",
                                                                    icon: History,
                                                                    run: () => {
                                                                        setHistoryWatch(watch);
                                                                        setOpenMenuId(null);
                                                                    },
                                                                },
                                                            ].map((action) => (
                                                                <button
                                                                    key={action.label}
                                                                    type="button"
                                                                    onClick={action.run}
                                                                    className="hover:bg-muted flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs"
                                                                >
                                                                    <action.icon className="h-3.5 w-3.5" />
                                                                    {action.label}
                                                                </button>
                                                            ))}
                                                            <button
                                                                type="button"
                                                                onClick={() => {
                                                                    setDeleting(watch);
                                                                    setOpenMenuId(null);
                                                                }}
                                                                className="hover:bg-destructive/10 text-destructive flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs"
                                                            >
                                                                <Trash2 className="h-3.5 w-3.5" /> Delete
                                                            </button>
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                            <div className="mt-2 flex items-end gap-2">
                                                <span className="text-lg font-semibold">
                                                    {formatPrice(
                                                        watch.target.currentPriceMinor,
                                                        watch.target.currencyCode,
                                                    )}
                                                </span>
                                                {watch.initialPriceMinor && (
                                                    <span className="text-muted-foreground pb-0.5 text-xs line-through">
                                                        {formatPrice(
                                                            watch.initialPriceMinor,
                                                            watch.target.currencyCode,
                                                        )}
                                                    </span>
                                                )}
                                            </div>
                                            <div className="text-muted-foreground mt-2 flex flex-wrap gap-1.5 text-[10px]">
                                                <span className="bg-muted rounded px-1.5 py-1">
                                                    <Clock3 className="mr-1 inline h-3 w-3" />
                                                    {formatInterval(watch.pollIntervalSeconds)}
                                                </span>
                                                <span className="bg-muted rounded px-1.5 py-1">
                                                    <Server className="mr-1 inline h-3 w-3" />
                                                    {watch.proxyGroupName ?? "Shared"}
                                                </span>
                                                <span className="bg-muted rounded px-1.5 py-1">
                                                    {getRegionLabel(watch.target.region)}
                                                </span>
                                            </div>
                                        </div>
                                    </div>
                                    <div className="border-border/60 mt-3 border-t pt-2.5 text-[11px]">
                                        <span className="text-muted-foreground flex min-w-0 items-center truncate">
                                            <span className="mr-1.5 shrink-0">
                                                {watch.notificationsEnabled ? (
                                                    <Bell className="mr-1 inline h-3 w-3" />
                                                ) : (
                                                    <BellOff className="mr-1 inline h-3 w-3" />
                                                )}
                                                {watch.notificationsEnabled
                                                    ? "Alerts on"
                                                    : "Alerts off"}
                                            </span>
                                            <span className="truncate">
                                                · {latestDrop
                                                ? `${formatPrice(latestDrop.previousPriceMinor, latestDrop.currencyCode)} → ${formatPrice(latestDrop.newPriceMinor, latestDrop.currencyCode)}`
                                                : `Checked ${formatTime(watch.target.lastCheckedAt)}`}
                                            </span>
                                        </span>
                                    </div>
                                </CardContent>
                            </Card>
                        );
                    })}
                </div>
            )}

            <Dialog open={addOpen} onOpenChange={setAddOpen}>
                <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
                    <DialogHeader>
                        <DialogTitle>Add Price Watch</DialogTitle>
                        <DialogDescription>
                            Paste a direct Vinted item URL, then choose speed and delivery.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4 py-2">
                        <div className="space-y-2">
                            <Label htmlFor="price-watch-url">Vinted item URL</Label>
                            <Input
                                id="price-watch-url"
                                value={itemUrl}
                                onChange={(event) => setItemUrl(event.target.value)}
                                placeholder="https://www.vinted.de/items/..."
                                type="url"
                                autoComplete="off"
                            />
                            {createRegion && (
                                <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
                                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                                    {getRegionLabel(createRegion)} detected
                                </p>
                            )}
                        </div>
                        <SettingsFields
                            value={settings}
                            onChange={setSettings}
                            hasTelegramConnection={hasTelegramConnection}
                            proxyGroups={proxyGroups}
                            region={createRegion}
                            idPrefix="create-price-watch"
                        />
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setAddOpen(false)}>
                            Cancel
                        </Button>
                        <Button onClick={submitCreate} disabled={isPending || !itemUrl.trim()}>
                            {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                            Start watching
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <Dialog open={Boolean(editing)} onOpenChange={(open) => !open && setEditing(null)}>
                <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
                    <DialogHeader>
                        <DialogTitle>Edit Price Watch</DialogTitle>
                        <DialogDescription className="line-clamp-1">
                            {editing?.target.title}
                        </DialogDescription>
                    </DialogHeader>
                    {editing && (
                        <SettingsFields
                            value={editSettings}
                            onChange={setEditSettings}
                            hasTelegramConnection={hasTelegramConnection}
                            proxyGroups={proxyGroups}
                            region={editing.target.region}
                            idPrefix="edit-price-watch"
                        />
                    )}
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setEditing(null)}>
                            Cancel
                        </Button>
                        <Button onClick={submitEdit} disabled={isPending}>
                            {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                            Save changes
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <Dialog open={Boolean(historyWatch)} onOpenChange={(open) => !open && setHistoryWatch(null)}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>Recent price drops</DialogTitle>
                        <DialogDescription className="line-clamp-1">
                            {historyWatch?.target.title}
                        </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-2">
                        {historyWatch?.target.events.length ? (
                            historyWatch.target.events.map((event) => (
                                <div key={event.id} className="flex items-center justify-between rounded-lg border px-3 py-2.5">
                                    <span className="text-sm">
                                        <span className="text-muted-foreground line-through">
                                            {formatPrice(event.previousPriceMinor, event.currencyCode)}
                                        </span>{" "}
                                        → <strong>{formatPrice(event.newPriceMinor, event.currencyCode)}</strong>
                                    </span>
                                    <span className="text-muted-foreground text-xs">
                                        {formatTime(event.observedAt)}
                                    </span>
                                </div>
                            ))
                        ) : (
                            <p className="text-muted-foreground py-8 text-center text-sm">
                                No price drops recorded yet.
                            </p>
                        )}
                    </div>
                </DialogContent>
            </Dialog>

            <Dialog open={Boolean(deleting)} onOpenChange={(open) => !open && setDeleting(null)}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Delete Price Watch?</DialogTitle>
                        <DialogDescription>
                            This removes the watch and its notification history from your account.
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setDeleting(null)}>
                            Cancel
                        </Button>
                        <Button variant="destructive" onClick={confirmDelete} disabled={isPending}>
                            Delete watch
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
