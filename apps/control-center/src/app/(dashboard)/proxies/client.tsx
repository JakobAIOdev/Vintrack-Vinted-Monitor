"use client";

import {
    createProxyGroup,
    deleteProxyGroup,
    getProxyGroupCheckStatus,
    resetProxyGroupBandwidth,
    startProxyGroupCheck,
    type ProxyCheckSnapshot,
    updateProxyGroup,
} from "@/actions/proxy-groups";
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
import { getRegionLabel, REGIONS } from "@/lib/regions";
import {
    Activity,
    ArrowRight,
    CheckCircle2,
    ChevronDown,
    ChevronUp,
    Globe,
    HardDriveDownload,
    HardDriveUpload,
    LoaderCircle,
    Plus,
    RotateCcw,
    Server,
    Shield,
    Trash2,
    XCircle,
} from "lucide-react";
import { CreateMonitorLink } from "@/components/maintenance/create-monitor-link";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

export type ProxyGroup = {
    id: number;
    name: string;
    proxies: string;
    monitorCount: number;
    bandwidthRxBytes: string;
    bandwidthTxBytes: string;
    bandwidthLimitBytes: string | null;
    bandwidthResetAt: string | null;
    proxyCheck: ProxyCheckSnapshot;
    created_at: string;
};

export type FreeProxyPoolOverview = {
    enabled: boolean;
    minActivePerRegion: number;
    regions: {
        region: string;
        usable: number;
        medianLatencyMs: number | null;
        healthy: boolean;
    }[];
};

function formatBytes(value: bigint) {
    const units = ["B", "KB", "MB", "GB", "TB"];
    let size = Number(value);
    let unitIndex = 0;
    while (size >= 1024 && unitIndex < units.length - 1) {
        size /= 1024;
        unitIndex++;
    }
    const digits = size >= 100 || unitIndex === 0 ? 0 : size >= 10 ? 1 : 2;
    return `${size.toFixed(digits)} ${units[unitIndex]}`;
}

function getErrorMessage(error: unknown, fallback: string) {
    if (error instanceof Error && error.message) {
        return error.message;
    }
    return fallback;
}

function formatLimitInput(value: string | null) {
    if (!value) {
        return "";
    }

    const limitGb = Number(value) / (1024 * 1024 * 1024);
    return Number.isInteger(limitGb) ? String(limitGb) : limitGb.toFixed(2);
}

function emptyProxyCheck(): ProxyCheckSnapshot {
    return {
        status: "idle",
        region: null,
        total: 0,
        checked: 0,
        working: 0,
        slow: 0,
        failed: 0,
        results: [],
        error: null,
        requestedAt: null,
        startedAt: null,
        completedAt: null,
    };
}

function proxyCheckErrorLabel(errorCode: string | null) {
    switch (errorCode) {
        case "timeout":
            return "Timeout";
        case "connect":
            return "Connection failed";
        case "proxy_handshake":
            return "Proxy authentication/handshake";
        case "tls":
            return "TLS failed";
        case "vinted_401":
        case "vinted_403":
            return "Blocked by Vinted";
        case "vinted_429":
            return "Rate limited";
        case "latency":
            return "Too slow";
        case "invalid_config":
            return "Invalid configuration";
        default:
            return errorCode ?? "Unknown error";
    }
}

export function ProxiesClient({
    initialGroups,
    userRole,
    freeProxyPool,
}: {
    initialGroups: ProxyGroup[];
    userRole: string;
    freeProxyPool: FreeProxyPoolOverview;
}) {
    const [groups, setGroups] = useState<ProxyGroup[]>(initialGroups);
    const [isCreateOpen, setIsCreateOpen] = useState(false);
    const [expandedId, setExpandedId] = useState<number | null>(null);
    const [editingId, setEditingId] = useState<number | null>(null);
    const [editName, setEditName] = useState("");
    const [editProxies, setEditProxies] = useState("");
    const [editBandwidthLimitGb, setEditBandwidthLimitGb] = useState("");
    const [startingCheckId, setStartingCheckId] = useState<number | null>(null);
    const [checkRegions, setCheckRegions] = useState<Record<number, string>>(
        () =>
            Object.fromEntries(
                initialGroups.map((group) => [
                    group.id,
                    group.proxyCheck.region ?? "de",
                ]),
            ),
    );

    const handleCreate = async (formData: FormData) => {
        try {
            await createProxyGroup(formData);
            setIsCreateOpen(false);
            toast.success("Proxy group created");
            // Refresh page to get updated data
            window.location.reload();
        } catch (error: unknown) {
            toast.error(getErrorMessage(error, "Failed to create proxy group"));
        }
    };

    const handleDelete = async (id: number) => {
        try {
            const result = await deleteProxyGroup(id);
            setGroups((prev) => prev.filter((g) => g.id !== id));
            if (result.pausedMonitorCount > 0) {
                toast.success(
                    `Proxy group deleted. ${result.pausedMonitorCount} monitor${
                        result.pausedMonitorCount === 1 ? "" : "s"
                    } paused until a new proxy group is selected.`,
                );
            } else if (result.affectedMonitorCount > 0) {
                toast.success(
                    `Proxy group deleted. ${result.affectedMonitorCount} monitor${
                        result.affectedMonitorCount === 1 ? "" : "s"
                    } switched to server proxies.`,
                );
            } else {
                toast.success("Proxy group deleted");
            }
        } catch (error: unknown) {
            toast.error(getErrorMessage(error, "Failed to delete proxy group"));
        }
    };

    const handleUpdate = async (id: number) => {
        try {
            const formData = new FormData();
            formData.set("name", editName);
            formData.set("proxies", editProxies);
            formData.set("bandwidth_limit_gb", editBandwidthLimitGb);
            await updateProxyGroup(id, formData);
            setGroups((prev) =>
                prev.map((g) =>
                    g.id === id
                        ? {
                              ...g,
                              name: editName,
                              proxies: editProxies,
                              bandwidthLimitBytes:
                                  editBandwidthLimitGb.trim().length > 0
                                      ? BigInt(
                                            Math.round(
                                                Number(editBandwidthLimitGb) *
                                                    1024 *
                                                    1024 *
                                                    1024,
                                            ),
                                        ).toString()
                                      : null,
                              proxyCheck: emptyProxyCheck(),
                          }
                        : g,
                ),
            );
            setEditingId(null);
            toast.success("Proxy group updated");
        } catch (error: unknown) {
            toast.error(getErrorMessage(error, "Failed to update proxy group"));
        }
    };

    const handleResetBandwidth = async (id: number) => {
        try {
            await resetProxyGroupBandwidth(id);
            setGroups((prev) =>
                prev.map((g) =>
                    g.id === id
                        ? {
                              ...g,
                              bandwidthRxBytes: "0",
                              bandwidthTxBytes: "0",
                              bandwidthResetAt: new Date().toISOString(),
                          }
                        : g,
                ),
            );
            toast.success("Bandwidth reset");
        } catch (error: unknown) {
            toast.error(getErrorMessage(error, "Failed to reset bandwidth"));
        }
    };

    const updateProxyCheck = useCallback(
        (id: number, proxyCheck: ProxyCheckSnapshot) => {
            setGroups((current) =>
                current.map((group) =>
                    group.id === id ? { ...group, proxyCheck } : group,
                ),
            );
        },
        [],
    );

    const handleStartProxyCheck = async (id: number) => {
        setStartingCheckId(id);
        try {
            const snapshot = await startProxyGroupCheck(
                id,
                checkRegions[id] ?? "de",
            );
            updateProxyCheck(id, snapshot);
            toast.success("Proxy check queued");
        } catch (error: unknown) {
            toast.error(getErrorMessage(error, "Failed to start proxy check"));
        } finally {
            setStartingCheckId(null);
        }
    };

    const activeCheckIds = groups
        .filter(
            (group) =>
                group.proxyCheck.status === "pending" ||
                group.proxyCheck.status === "running",
        )
        .map((group) => group.id)
        .join(",");

    useEffect(() => {
        if (!activeCheckIds) return;

        const ids = activeCheckIds
            .split(",")
            .map(Number)
            .filter(Number.isInteger);
        let canceled = false;
        const poll = async () => {
            const snapshots = await Promise.allSettled(
                ids.map(async (id) => ({
                    id,
                    snapshot: await getProxyGroupCheckStatus(id),
                })),
            );
            if (canceled) return;
            for (const result of snapshots) {
                if (result.status === "fulfilled") {
                    updateProxyCheck(result.value.id, result.value.snapshot);
                }
            }
        };

        void poll();
        const interval = window.setInterval(poll, 1_500);
        return () => {
            canceled = true;
            window.clearInterval(interval);
        };
    }, [activeCheckIds, updateProxyCheck]);

    const getProxyCount = (proxies: string) =>
        proxies.split("\n").filter((l) => l.trim().length > 0).length;

    const readyRegionCount = freeProxyPool.regions.filter(
        (region) => region.healthy,
    ).length;
    const usableProxyCount = freeProxyPool.regions.reduce(
        (total, region) => total + region.usable,
        0,
    );

    return (
        <div className="mx-auto max-w-5xl space-y-6">
            <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
                <div>
                    <h1 className="text-2xl font-bold tracking-tight">
                        Proxy Infrastructure
                    </h1>
                    <p className="text-muted-foreground mt-0.5 text-sm">
                        Use the shared starter pool or manage dedicated proxy
                        groups.
                    </p>
                </div>
                <Button
                    onClick={() => setIsCreateOpen(true)}
                    size="sm"
                    className="w-full gap-1.5 sm:w-auto"
                >
                    <Plus className="h-4 w-4" /> New Group
                </Button>
            </div>

            <section className="border-border/70 overflow-hidden rounded-lg border">
                <div className="flex flex-col gap-4 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex min-w-0 items-start gap-3">
                        <span className="bg-muted flex size-9 shrink-0 items-center justify-center rounded-md">
                            <Globe className="text-muted-foreground size-4" />
                        </span>
                        <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                                <h2 className="text-sm font-semibold">
                                    Free Proxy Pool
                                </h2>
                                <Badge
                                    variant="outline"
                                    className={
                                        freeProxyPool.enabled
                                            ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                                            : "text-muted-foreground"
                                    }
                                >
                                    <span
                                        className={
                                            freeProxyPool.enabled
                                                ? "size-1.5 rounded-full bg-emerald-500"
                                                : "bg-muted-foreground size-1.5 rounded-full"
                                        }
                                    />
                                    {freeProxyPool.enabled
                                        ? "Online"
                                        : "Unavailable"}
                                </Badge>
                            </div>
                            <p className="text-muted-foreground mt-1 text-xs leading-5">
                                Shared, health-checked proxies for catalog
                                monitors. No proxy purchase required in Ready
                                regions.
                            </p>
                        </div>
                    </div>
                    <Button asChild size="sm" className="shrink-0">
                        <CreateMonitorLink>
                            Create monitor
                            <ArrowRight />
                        </CreateMonitorLink>
                    </Button>
                </div>

                {freeProxyPool.enabled ? (
                    <>
                        <div className="border-border/70 bg-muted/20 grid border-y sm:grid-cols-3">
                            <div className="border-border/70 px-5 py-3 sm:border-r">
                                <p className="text-muted-foreground text-[11px] font-medium uppercase">
                                    Ready regions
                                </p>
                                <p className="mt-1 text-lg font-semibold">
                                    {readyRegionCount}
                                    <span className="text-muted-foreground ml-1 text-xs font-normal">
                                        of {freeProxyPool.regions.length}
                                    </span>
                                </p>
                            </div>
                            <div className="border-border/70 border-t px-5 py-3 sm:border-t-0 sm:border-r">
                                <p className="text-muted-foreground text-[11px] font-medium uppercase">
                                    Usable candidates
                                </p>
                                <p className="mt-1 text-lg font-semibold">
                                    {usableProxyCount.toLocaleString()}
                                </p>
                            </div>
                            <div className="border-border/70 border-t px-5 py-3 sm:border-t-0">
                                <p className="text-muted-foreground text-[11px] font-medium uppercase">
                                    Pool management
                                </p>
                                <p className="mt-1 flex items-center gap-1.5 text-sm font-medium">
                                    <Activity className="size-3.5 text-emerald-600" />
                                    Automatic rotation
                                </p>
                            </div>
                        </div>

                        {freeProxyPool.regions.length > 0 ? (
                            <div className="bg-muted/10 p-3 sm:p-4">
                                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                                    {freeProxyPool.regions.map((region) => (
                                        <div
                                            key={region.region}
                                            className="border-border/70 bg-background flex min-w-0 items-center justify-between gap-3 rounded-md border px-3 py-2.5"
                                        >
                                            <div className="min-w-0">
                                                <p className="truncate text-xs font-medium">
                                                    {getRegionLabel(
                                                        region.region,
                                                    )}
                                                </p>
                                                <p className="text-muted-foreground mt-0.5 text-[11px]">
                                                    {region.usable.toLocaleString()}{" "}
                                                    usable
                                                    {region.medianLatencyMs !==
                                                        null && (
                                                        <span>
                                                            {" · "}
                                                            {
                                                                region.medianLatencyMs
                                                            }{" "}
                                                            ms
                                                        </span>
                                                    )}
                                                </p>
                                            </div>
                                            <Badge
                                                variant="outline"
                                                className={
                                                    region.healthy
                                                        ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                                                        : "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-400"
                                                }
                                            >
                                                {region.healthy
                                                    ? "Ready"
                                                    : "Recovering"}
                                            </Badge>
                                        </div>
                                    ))}
                                </div>
                                <p className="text-muted-foreground mt-3 px-1 text-[11px] leading-5">
                                    Pool availability is live and best-effort.
                                    Every configured region remains selectable;
                                    monitors wait and resume automatically while
                                    the pool recovers.
                                </p>
                            </div>
                        ) : (
                            <div className="px-5 py-6 text-center">
                                <p className="text-sm font-medium">
                                    Region validation is starting
                                </p>
                                <p className="text-muted-foreground mt-1 text-xs">
                                    Ready regions will appear here
                                    automatically.
                                </p>
                            </div>
                        )}
                    </>
                ) : (
                    <div className="border-border/70 bg-muted/20 border-t px-5 py-5">
                        <p className="text-muted-foreground text-sm">
                            The shared pool is currently unavailable. Personal
                            proxy groups continue to work normally.
                        </p>
                    </div>
                )}
            </section>

            {(userRole === "premium" || userRole === "admin") && (
                <Card className="border-amber-200 bg-amber-50 dark:border-amber-500/20 dark:bg-amber-500/10">
                    <CardContent className="flex items-center gap-3 p-4">
                        <Shield className="h-5 w-5 shrink-0 text-amber-600" />
                        <div>
                            <p className="text-[13px] font-medium text-amber-900 dark:text-amber-200">
                                Server Proxy Access
                            </p>
                            <p className="text-[12px] text-amber-700 dark:text-amber-300">
                                You can use server proxies when creating
                                monitors, or use your own proxy groups.
                            </p>
                        </div>
                    </CardContent>
                </Card>
            )}

            <div className="flex items-end justify-between gap-4 pt-2">
                <div>
                    <h2 className="text-base font-semibold">
                        Personal Proxy Groups
                    </h2>
                    <p className="text-muted-foreground mt-0.5 text-xs">
                        Dedicated proxy lists available only to your account.
                    </p>
                </div>
            </div>

            {groups.length === 0 ? (
                <Card className="border-dashed">
                    <CardContent className="p-10 text-center">
                        <Globe className="text-muted-foreground/40 mx-auto mb-3 h-10 w-10" />
                        <p className="text-muted-foreground text-[15px] font-medium">
                            No personal proxy groups yet
                        </p>
                        <p className="text-muted-foreground mt-1 text-[13px]">
                            Use a Ready Free Pool region, or create a dedicated
                            group for your own proxies.
                        </p>
                        <Button
                            onClick={() => setIsCreateOpen(true)}
                            size="sm"
                            className="mt-4 gap-1.5"
                            variant="outline"
                        >
                            <Plus className="h-4 w-4" /> Create your first group
                        </Button>
                    </CardContent>
                </Card>
            ) : (
                <div className="space-y-3">
                    {groups.map((group) => {
                        const rxBytes = BigInt(group.bandwidthRxBytes);
                        const txBytes = BigInt(group.bandwidthTxBytes);
                        const totalBytes = rxBytes + txBytes;
                        const limitBytes = group.bandwidthLimitBytes
                            ? BigInt(group.bandwidthLimitBytes)
                            : null;
                        const usagePercent =
                            limitBytes && limitBytes > BigInt(0)
                                ? Math.min(
                                      100,
                                      Number(
                                          (totalBytes * BigInt(100)) /
                                              limitBytes,
                                      ),
                                  )
                                : null;
                        const checkRunning =
                            group.proxyCheck.status === "pending" ||
                            group.proxyCheck.status === "running";
                        const checkProgress =
                            group.proxyCheck.total > 0
                                ? Math.min(
                                      100,
                                      Math.round(
                                          (group.proxyCheck.checked /
                                              group.proxyCheck.total) *
                                              100,
                                      ),
                                  )
                                : 0;

                        return (
                            <Card key={group.id} className="border-input/60">
                                <CardContent className="p-0">
                                    <div
                                        className="hover:bg-muted/50 flex cursor-pointer items-center justify-between px-5 py-4 transition-colors"
                                        onClick={() =>
                                            setExpandedId(
                                                expandedId === group.id
                                                    ? null
                                                    : group.id,
                                            )
                                        }
                                    >
                                        <div className="flex items-center gap-3">
                                            <Server className="text-muted-foreground h-4 w-4" />
                                            <div>
                                                <p className="text-foreground text-[14px] font-medium">
                                                    {group.name}
                                                </p>
                                                <div className="mt-0.5 flex items-center gap-2">
                                                    <span className="text-muted-foreground text-[12px]">
                                                        {getProxyCount(
                                                            group.proxies,
                                                        )}{" "}
                                                        proxies
                                                    </span>
                                                    <span className="text-muted-foreground/40">
                                                        ·
                                                    </span>
                                                    <span className="text-muted-foreground text-[12px]">
                                                        {group.monitorCount}{" "}
                                                        monitor
                                                        {group.monitorCount !==
                                                        1
                                                            ? "s"
                                                            : ""}
                                                    </span>
                                                    <span className="text-muted-foreground/40">
                                                        ·
                                                    </span>
                                                    <span className="text-muted-foreground text-[12px]">
                                                        {formatBytes(
                                                            totalBytes,
                                                        )}{" "}
                                                        traffic
                                                    </span>
                                                </div>
                                                {limitBytes &&
                                                    limitBytes > BigInt(0) && (
                                                        <div className="mt-2 w-full max-w-xs">
                                                            <div className="text-muted-foreground mb-1 flex items-center justify-between text-[11px]">
                                                                <span>
                                                                    {formatBytes(
                                                                        totalBytes,
                                                                    )}{" "}
                                                                    /{" "}
                                                                    {formatBytes(
                                                                        limitBytes,
                                                                    )}
                                                                </span>
                                                                <span>
                                                                    {
                                                                        usagePercent
                                                                    }
                                                                    %
                                                                </span>
                                                            </div>
                                                            <div className="bg-muted h-1.5 overflow-hidden rounded-full">
                                                                <div
                                                                    className="bg-foreground h-full rounded-full transition-all"
                                                                    style={{
                                                                        width: `${usagePercent}%`,
                                                                    }}
                                                                />
                                                            </div>
                                                        </div>
                                                    )}
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                className="text-muted-foreground h-8 w-8 hover:text-red-500"
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    handleDelete(group.id);
                                                }}
                                            >
                                                <Trash2 className="h-3.5 w-3.5" />
                                            </Button>
                                            {expandedId === group.id ? (
                                                <ChevronUp className="text-muted-foreground h-4 w-4" />
                                            ) : (
                                                <ChevronDown className="text-muted-foreground h-4 w-4" />
                                            )}
                                        </div>
                                    </div>

                                    {expandedId === group.id && (
                                        <div className="border-border space-y-3 border-t px-5 py-4">
                                            <div className="border-border bg-muted/20 space-y-3 rounded-lg border p-3">
                                                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                                                    <div>
                                                        <div className="flex items-center gap-2">
                                                            <p className="text-sm font-medium">
                                                                Proxy health
                                                                check
                                                            </p>
                                                            {checkRunning && (
                                                                <Badge
                                                                    variant="outline"
                                                                    className="gap-1"
                                                                >
                                                                    <LoaderCircle className="h-3 w-3 animate-spin" />
                                                                    {group
                                                                        .proxyCheck
                                                                        .status ===
                                                                    "pending"
                                                                        ? "Queued"
                                                                        : `${group.proxyCheck.checked}/${group.proxyCheck.total}`}
                                                                </Badge>
                                                            )}
                                                        </div>
                                                        <p className="text-muted-foreground mt-0.5 text-[11px]">
                                                            Tests up to 100
                                                            proxies directly
                                                            against the selected
                                                            Vinted region.
                                                        </p>
                                                    </div>
                                                    <div className="flex gap-2">
                                                        <select
                                                            value={
                                                                checkRegions[
                                                                    group.id
                                                                ] ??
                                                                group.proxyCheck
                                                                    .region ??
                                                                "de"
                                                            }
                                                            onChange={(event) =>
                                                                setCheckRegions(
                                                                    (
                                                                        current,
                                                                    ) => ({
                                                                        ...current,
                                                                        [group.id]:
                                                                            event
                                                                                .target
                                                                                .value,
                                                                    }),
                                                                )
                                                            }
                                                            disabled={
                                                                checkRunning
                                                            }
                                                            className="border-input bg-background h-8 rounded-md border px-2 text-xs"
                                                        >
                                                            {REGIONS.map(
                                                                (region) => (
                                                                    <option
                                                                        key={
                                                                            region.code
                                                                        }
                                                                        value={
                                                                            region.code
                                                                        }
                                                                    >
                                                                        {
                                                                            region.flag
                                                                        }{" "}
                                                                        {
                                                                            region.label
                                                                        }
                                                                    </option>
                                                                ),
                                                            )}
                                                        </select>
                                                        <Button
                                                            size="sm"
                                                            variant="outline"
                                                            className="gap-1.5"
                                                            disabled={
                                                                checkRunning ||
                                                                startingCheckId ===
                                                                    group.id
                                                            }
                                                            onClick={() =>
                                                                handleStartProxyCheck(
                                                                    group.id,
                                                                )
                                                            }
                                                        >
                                                            {checkRunning ||
                                                            startingCheckId ===
                                                                group.id ? (
                                                                <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                                                            ) : (
                                                                <Activity className="h-3.5 w-3.5" />
                                                            )}
                                                            {group.proxyCheck
                                                                .completedAt
                                                                ? "Check again"
                                                                : "Check proxies"}
                                                        </Button>
                                                    </div>
                                                </div>

                                                {checkRunning && (
                                                    <div className="bg-muted h-1.5 overflow-hidden rounded-full">
                                                        <div
                                                            className="bg-foreground h-full rounded-full transition-all"
                                                            style={{
                                                                width: `${checkProgress}%`,
                                                            }}
                                                        />
                                                    </div>
                                                )}

                                                {group.proxyCheck.status ===
                                                    "failed" && (
                                                    <p className="text-destructive text-xs">
                                                        {group.proxyCheck
                                                            .error ??
                                                            "The proxy check failed. Please try again."}
                                                    </p>
                                                )}

                                                {group.proxyCheck.status ===
                                                    "completed" && (
                                                    <>
                                                        <div className="grid grid-cols-3 gap-2">
                                                            <div className="border-border bg-background rounded-md border p-2.5">
                                                                <p className="flex items-center gap-1 text-[11px] text-emerald-600">
                                                                    <CheckCircle2 className="h-3.5 w-3.5" />
                                                                    Working
                                                                </p>
                                                                <p className="mt-1 text-lg font-semibold">
                                                                    {
                                                                        group
                                                                            .proxyCheck
                                                                            .working
                                                                    }
                                                                </p>
                                                            </div>
                                                            <div className="border-border bg-background rounded-md border p-2.5">
                                                                <p className="flex items-center gap-1 text-[11px] text-amber-600">
                                                                    <Activity className="h-3.5 w-3.5" />
                                                                    Slow
                                                                </p>
                                                                <p className="mt-1 text-lg font-semibold">
                                                                    {
                                                                        group
                                                                            .proxyCheck
                                                                            .slow
                                                                    }
                                                                </p>
                                                            </div>
                                                            <div className="border-border bg-background rounded-md border p-2.5">
                                                                <p className="text-destructive flex items-center gap-1 text-[11px]">
                                                                    <XCircle className="h-3.5 w-3.5" />
                                                                    Failed
                                                                </p>
                                                                <p className="mt-1 text-lg font-semibold">
                                                                    {
                                                                        group
                                                                            .proxyCheck
                                                                            .failed
                                                                    }
                                                                </p>
                                                            </div>
                                                        </div>
                                                        <div className="border-border bg-background max-h-52 divide-y overflow-y-auto rounded-md border">
                                                            {group.proxyCheck.results.map(
                                                                (result) => (
                                                                    <div
                                                                        key={`${result.index}:${result.label}`}
                                                                        className="flex items-center justify-between gap-3 px-3 py-2 text-[11px]"
                                                                    >
                                                                        <span className="min-w-0 truncate font-mono">
                                                                            {
                                                                                result.label
                                                                            }
                                                                        </span>
                                                                        <span className="text-muted-foreground flex shrink-0 items-center gap-2">
                                                                            {result.latencyMs !==
                                                                                null &&
                                                                                `${result.latencyMs}ms`}
                                                                            <Badge
                                                                                variant="outline"
                                                                                className={
                                                                                    result.status ===
                                                                                    "working"
                                                                                        ? "border-emerald-500/25 text-emerald-600"
                                                                                        : result.status ===
                                                                                            "slow"
                                                                                          ? "border-amber-500/25 text-amber-600"
                                                                                          : "border-red-500/25 text-red-600"
                                                                                }
                                                                            >
                                                                                {result.status ===
                                                                                "working"
                                                                                    ? "Working"
                                                                                    : proxyCheckErrorLabel(
                                                                                          result.errorCode,
                                                                                      )}
                                                                            </Badge>
                                                                        </span>
                                                                    </div>
                                                                ),
                                                            )}
                                                        </div>
                                                    </>
                                                )}
                                            </div>
                                            <div className="grid gap-3 sm:grid-cols-3">
                                                <div className="border-border bg-muted/40 rounded-lg border p-3">
                                                    <div className="text-muted-foreground flex items-center gap-2 text-[12px]">
                                                        <Server className="h-3.5 w-3.5" />
                                                        Total
                                                    </div>
                                                    <p className="text-foreground mt-1 text-sm font-medium">
                                                        {formatBytes(
                                                            BigInt(
                                                                group.bandwidthRxBytes,
                                                            ) +
                                                                BigInt(
                                                                    group.bandwidthTxBytes,
                                                                ),
                                                        )}
                                                    </p>
                                                </div>
                                                <div className="border-border bg-muted/40 rounded-lg border p-3">
                                                    <div className="text-muted-foreground flex items-center gap-2 text-[12px]">
                                                        <HardDriveDownload className="h-3.5 w-3.5" />
                                                        Download
                                                    </div>
                                                    <p className="text-foreground mt-1 text-sm font-medium">
                                                        {formatBytes(
                                                            BigInt(
                                                                group.bandwidthRxBytes,
                                                            ),
                                                        )}
                                                    </p>
                                                </div>
                                                <div className="border-border bg-muted/40 rounded-lg border p-3">
                                                    <div className="text-muted-foreground flex items-center gap-2 text-[12px]">
                                                        <HardDriveUpload className="h-3.5 w-3.5" />
                                                        Upload
                                                    </div>
                                                    <p className="text-foreground mt-1 text-sm font-medium">
                                                        {formatBytes(
                                                            BigInt(
                                                                group.bandwidthTxBytes,
                                                            ),
                                                        )}
                                                    </p>
                                                </div>
                                            </div>
                                            <div className="border-border bg-muted/30 rounded-lg border p-3">
                                                <div className="flex items-center justify-between gap-3">
                                                    <div>
                                                        <p className="text-muted-foreground text-[12px]">
                                                            Bandwidth limit
                                                        </p>
                                                        <p className="text-foreground mt-1 text-sm font-medium">
                                                            {limitBytes &&
                                                            limitBytes >
                                                                BigInt(0)
                                                                ? formatBytes(
                                                                      limitBytes,
                                                                  )
                                                                : "No limit"}
                                                        </p>
                                                    </div>
                                                    {limitBytes &&
                                                        limitBytes >
                                                            BigInt(0) && (
                                                            <p className="text-muted-foreground text-[12px]">
                                                                Remaining:{" "}
                                                                {formatBytes(
                                                                    limitBytes -
                                                                        totalBytes >
                                                                        BigInt(
                                                                            0,
                                                                        )
                                                                        ? limitBytes -
                                                                              totalBytes
                                                                        : BigInt(
                                                                              0,
                                                                          ),
                                                                )}
                                                            </p>
                                                        )}
                                                </div>
                                            </div>
                                            <div className="border-border bg-background flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
                                                <p className="text-muted-foreground text-[12px]">
                                                    {group.bandwidthResetAt
                                                        ? `Last reset: ${new Date(group.bandwidthResetAt).toLocaleString()}`
                                                        : "No reset yet"}
                                                </p>
                                                <Button
                                                    size="sm"
                                                    variant="outline"
                                                    className="gap-1.5"
                                                    onClick={() =>
                                                        handleResetBandwidth(
                                                            group.id,
                                                        )
                                                    }
                                                >
                                                    <RotateCcw className="h-3.5 w-3.5" />
                                                    Reset traffic
                                                </Button>
                                            </div>
                                            {editingId === group.id ? (
                                                <>
                                                    <div className="space-y-2">
                                                        <Label className="text-[12px]">
                                                            Name
                                                        </Label>
                                                        <Input
                                                            value={editName}
                                                            onChange={(e) =>
                                                                setEditName(
                                                                    e.target
                                                                        .value,
                                                                )
                                                            }
                                                            className="text-[13px]"
                                                        />
                                                    </div>
                                                    <div className="space-y-2">
                                                        <Label className="text-[12px]">
                                                            Proxies (one per
                                                            line)
                                                        </Label>
                                                        <textarea
                                                            value={editProxies}
                                                            onChange={(e) =>
                                                                setEditProxies(
                                                                    e.target
                                                                        .value,
                                                                )
                                                            }
                                                            rows={6}
                                                            className="border-input bg-background text-foreground placeholder:text-muted-foreground focus:ring-ring w-full rounded-md border px-3 py-2 font-mono text-[12px] focus:ring-2 focus:ring-offset-1 focus:outline-none"
                                                            placeholder="http://user:pass@host:port"
                                                        />
                                                    </div>
                                                    <div className="space-y-2">
                                                        <Label className="text-[12px]">
                                                            Bandwidth Limit (GB)
                                                        </Label>
                                                        <Input
                                                            type="number"
                                                            min="0"
                                                            step="0.1"
                                                            value={
                                                                editBandwidthLimitGb
                                                            }
                                                            onChange={(e) =>
                                                                setEditBandwidthLimitGb(
                                                                    e.target
                                                                        .value,
                                                                )
                                                            }
                                                            className="text-[13px]"
                                                            placeholder="Leave empty for no limit"
                                                        />
                                                    </div>
                                                    <div className="flex gap-2">
                                                        <Button
                                                            size="sm"
                                                            onClick={() =>
                                                                handleUpdate(
                                                                    group.id,
                                                                )
                                                            }
                                                        >
                                                            Save
                                                        </Button>
                                                        <Button
                                                            size="sm"
                                                            variant="outline"
                                                            onClick={() =>
                                                                setEditingId(
                                                                    null,
                                                                )
                                                            }
                                                        >
                                                            Cancel
                                                        </Button>
                                                    </div>
                                                </>
                                            ) : (
                                                <>
                                                    <div className="bg-muted rounded-lg p-3">
                                                        <pre className="text-muted-foreground max-h-40 overflow-y-auto font-mono text-[11px] break-all whitespace-pre-wrap">
                                                            {group.proxies
                                                                .split("\n")
                                                                .filter((l) =>
                                                                    l.trim(),
                                                                )
                                                                .map((line) => {
                                                                    // Mask proxy credentials
                                                                    try {
                                                                        const url =
                                                                            new URL(
                                                                                line.trim(),
                                                                            );
                                                                        if (
                                                                            url.username
                                                                        ) {
                                                                            return `${url.protocol}//${url.username}:****@${url.host}`;
                                                                        }
                                                                    } catch {}
                                                                    return line.replace(
                                                                        /:[^:@]+@/,
                                                                        ":****@",
                                                                    );
                                                                })
                                                                .join("\n")}
                                                        </pre>
                                                    </div>
                                                    <Button
                                                        size="sm"
                                                        variant="outline"
                                                        onClick={() => {
                                                            setEditingId(
                                                                group.id,
                                                            );
                                                            setEditName(
                                                                group.name,
                                                            );
                                                            setEditProxies(
                                                                group.proxies,
                                                            );
                                                            setEditBandwidthLimitGb(
                                                                formatLimitInput(
                                                                    group.bandwidthLimitBytes,
                                                                ),
                                                            );
                                                        }}
                                                    >
                                                        Edit
                                                    </Button>
                                                </>
                                            )}
                                        </div>
                                    )}
                                </CardContent>
                            </Card>
                        );
                    })}
                </div>
            )}

            <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
                <DialogContent className="sm:max-w-lg">
                    <DialogHeader>
                        <DialogTitle>Create Proxy Group</DialogTitle>
                        <DialogDescription>
                            Add a group of proxies to use with your monitors.
                        </DialogDescription>
                    </DialogHeader>
                    <form action={handleCreate} className="space-y-4">
                        <div className="space-y-2">
                            <Label htmlFor="name" className="text-[13px]">
                                Group Name
                            </Label>
                            <Input
                                name="name"
                                id="name"
                                placeholder="e.g. Residential EU"
                                required
                            />
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="proxies" className="text-[13px]">
                                Proxies
                            </Label>
                            <textarea
                                name="proxies"
                                id="proxies"
                                rows={8}
                                required
                                className="border-input bg-background text-foreground placeholder:text-muted-foreground focus:ring-ring w-full rounded-md border px-3 py-2 font-mono text-[13px] focus:ring-2 focus:ring-offset-1 focus:outline-none"
                                placeholder={
                                    "http://user:pass@host:port\nhttp://user:pass@host:port\n\nSupported formats:\nhttp://user:pass@host:port\nsocks5://user:pass@host:port\nhost:port:user:pass"
                                }
                            />
                            <p className="text-muted-foreground text-[12px]">
                                One proxy per line. Supports HTTP, HTTPS, and
                                SOCKS5.
                            </p>
                        </div>
                        <div className="space-y-2">
                            <Label
                                htmlFor="bandwidth_limit_gb"
                                className="text-[13px]"
                            >
                                Bandwidth Limit (GB)
                            </Label>
                            <Input
                                name="bandwidth_limit_gb"
                                id="bandwidth_limit_gb"
                                type="number"
                                min="0"
                                step="0.1"
                                placeholder="Optional"
                            />
                            <p className="text-muted-foreground text-[12px]">
                                Optional. Monitors using this group will pause
                                automatically once the limit is reached.
                            </p>
                        </div>
                        <DialogFooter>
                            <Button
                                type="button"
                                variant="outline"
                                onClick={() => setIsCreateOpen(false)}
                            >
                                Cancel
                            </Button>
                            <Button type="submit">Create Group</Button>
                        </DialogFooter>
                    </form>
                </DialogContent>
            </Dialog>
        </div>
    );
}
