"use client";

import { Badge } from "@/components/ui/badge";
import { REGIONS } from "@/lib/regions";
import { cn } from "@/lib/utils";
import { Activity, ChevronDown, type LucideIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

export type FreeProxyRegionHealth = {
    region: string;
    active: number;
    reserve: number;
    warming: number;
    usable: number;
    serving: boolean;
    mature: number;
    runtimeSuccessRate: number | null;
    runtimeSampleCount: number;
    canaryState: "building" | "collecting" | "passed" | "failed" | null;
    canarySampleCount: number;
    canarySuccessRate: number | null;
    canaryWindowMinutes: number;
    canaryLastProbeAt: string | Date | null;
    readinessReason: string | null;
    pending: number;
    cooldown: number;
    dead: number;
    successRate: number | null;
    medianLatencyMs: number | null;
    lastCheckedAt: string | Date | null;
    healthy: boolean;
};

export type FreeProxyOption = {
    enabled: boolean;
    activeCount: number;
    minActivePerRegion: number;
    regions: Record<string, FreeProxyRegionHealth>;
    usage?: {
        activeCount: number;
        activeLimit: number | null;
        activeSlots: number | null;
        limitSource: "user" | "role" | "global" | null;
        limitReached: boolean;
    };
};

export function getFreeProxyRegionHealth(
    freeProxy: FreeProxyOption,
    region: string,
) {
    return freeProxy.regions?.[region] ?? null;
}

export function FormSection({
    id,
    compact = false,
    title,
    description,
    defaultOpen = true,
    children,
    summary,
    icon: Icon,
}: {
    id?: string;
    compact?: boolean;
    title: string;
    description?: string;
    defaultOpen?: boolean;
    children: ReactNode;
    summary?: ReactNode;
    icon?: LucideIcon;
}) {
    const [isOpen, setIsOpen] = useState(defaultOpen);

    return (
        <details
            id={id}
            className="group border-border/70 bg-background min-w-0 scroll-mt-20 rounded-lg border [overflow-wrap:anywhere]"
            open={isOpen}
            onToggle={(event) => setIsOpen(event.currentTarget.open)}
        >
            <summary
                className={cn(
                    "hover:bg-muted/40 focus-visible:ring-ring flex cursor-pointer list-none items-center justify-between gap-3 rounded-lg transition-colors focus-visible:ring-2 focus-visible:outline-none [&::-webkit-details-marker]:hidden",
                    compact ? "px-3 py-2.5" : "px-4 py-3.5",
                )}
            >
                <span className="flex min-w-0 items-start gap-3">
                    {Icon && (
                        <span
                            className={cn(
                                "border-border/70 bg-muted/40 mt-0.5 flex shrink-0 items-center justify-center rounded-md border",
                                compact ? "hidden size-7 sm:flex" : "size-8",
                            )}
                        >
                            <Icon className="text-muted-foreground h-4 w-4" />
                        </span>
                    )}
                    <span className="min-w-0">
                        <span className="block text-sm font-semibold">
                            {title}
                        </span>
                        {description && (
                            <span
                                className={cn(
                                    "text-muted-foreground mt-0.5 text-xs",
                                    compact
                                        ? "hidden group-open:block sm:block"
                                        : "block",
                                )}
                            >
                                {description}
                            </span>
                        )}
                    </span>
                </span>
                <span className="flex shrink-0 items-center gap-2">
                    {summary && (
                        <span className="border-border/70 bg-muted/40 text-muted-foreground hidden rounded-md border px-2 py-1 text-[11px] font-medium sm:inline-flex">
                            {summary}
                        </span>
                    )}
                    <ChevronDown className="text-muted-foreground h-4 w-4 transition-transform group-open:rotate-180" />
                </span>
            </summary>
            <div
                className={cn(
                    "border-border/60 border-t",
                    compact ? "space-y-4 p-3" : "space-y-5 px-4 py-4",
                )}
            >
                {children}
            </div>
        </details>
    );
}

export function RegionPoolStatus({
    compact = false,
    freeProxy,
    selectedRegion,
    onSelectRegion,
}: {
    compact?: boolean;
    freeProxy: FreeProxyOption;
    selectedRegion: string;
    onSelectRegion?: (region: string) => void;
}) {
    const regionHealth = getFreeProxyRegionHealth(freeProxy, selectedRegion);
    const mature = regionHealth?.mature ?? regionHealth?.active ?? 0;
    const min = freeProxy.minActivePerRegion;
    const percentage = Math.min(100, Math.round((mature / min) * 100));
    const isHealthy = Boolean(
        freeProxy.enabled && regionHealth?.healthy && regionHealth?.serving,
    );
    const poolRegions = REGIONS.map((region) => ({
        ...region,
        health: freeProxy.regions?.[region.code],
    })).filter((region) => region.health);
    const readyRegionCount = poolRegions.filter(
        (region) => freeProxy.enabled && region.health?.healthy,
    ).length;

    return (
        <div
            className={cn(
                compact
                    ? "min-w-0 [overflow-wrap:anywhere]"
                    : "rounded-lg border p-4",
                !compact &&
                    (isHealthy
                        ? "border-emerald-500/25 bg-emerald-500/5"
                        : "border-amber-500/25 bg-amber-500/5"),
            )}
        >
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex min-w-0 items-start gap-3">
                    {!compact && (
                        <div
                            className={cn(
                                "mt-0.5 rounded-lg p-2",
                                isHealthy
                                    ? "bg-emerald-500/10 text-emerald-600"
                                    : "bg-amber-500/10 text-amber-600",
                            )}
                        >
                            <Activity className="h-4 w-4" />
                        </div>
                    )}
                    <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                            <p className="text-sm font-semibold">
                                Free Proxy Pool · {selectedRegion.toUpperCase()}
                            </p>
                            <Badge
                                variant={isHealthy ? "secondary" : "outline"}
                                className="rounded-md uppercase"
                            >
                                {isHealthy
                                    ? "Ready"
                                    : freeProxy.enabled
                                      ? "Recovering"
                                      : "Disabled"}
                            </Badge>
                            {freeProxy.usage ? (
                                <Badge
                                    variant={
                                        freeProxy.usage.limitReached
                                            ? "destructive"
                                            : "outline"
                                    }
                                    className="rounded-md"
                                >
                                    {freeProxy.usage.activeCount}/
                                    {freeProxy.usage.activeLimit ?? "∞"} running
                                </Badge>
                            ) : null}
                        </div>
                        <p className="text-muted-foreground mt-1 text-xs">
                            {freeProxy.enabled
                                ? isHealthy
                                    ? `${mature} mature proxies are serving this region. Runtime success: ${regionHealth?.runtimeSuccessRate === null || regionHealth?.runtimeSuccessRate === undefined ? "collecting" : `${Math.round(regionHealth.runtimeSuccessRate)}%`}.`
                                    : `${mature} mature of ${min} required. The pool is rebuilding automatically; active monitors wait safely.`
                                : "Free Proxy Pool is currently disabled by admin."}
                        </p>
                    </div>
                </div>
                <div className="text-muted-foreground text-xs sm:text-right">
                    <p>
                        {regionHealth?.medianLatencyMs
                            ? `${regionHealth.medianLatencyMs}ms median`
                            : "No latency yet"}
                    </p>
                    <p>
                        {regionHealth?.successRate === null ||
                        regionHealth?.successRate === undefined
                            ? "No checks yet"
                            : `${regionHealth.successRate}% check success`}
                    </p>
                </div>
            </div>
            <div className="bg-muted mt-4 h-2 overflow-hidden rounded-full">
                <div
                    className={cn(
                        "h-full rounded-full transition-all",
                        isHealthy ? "bg-emerald-500" : "bg-amber-500",
                    )}
                    style={{ width: `${percentage}%` }}
                />
            </div>
            {!isHealthy && (
                <p className="mt-3 text-xs text-amber-700 dark:text-amber-300">
                    The shared pool is recovering. You can still select it; the
                    monitor will wait and resume automatically.
                </p>
            )}
            {freeProxy.usage?.limitReached ? (
                <p className="mt-3 text-xs text-amber-700 dark:text-amber-300">
                    Your running Free Proxy Pool monitor limit is reached. You
                    can still save this monitor, but it will remain paused until
                    a slot is available.
                </p>
            ) : null}
            {poolRegions.length > 0 && (
                <div className="border-border/60 mt-4 border-t pt-3">
                    <div className="mb-2.5 flex items-center justify-between gap-3">
                        <p className="text-xs font-medium">Pool regions</p>
                        <p className="text-muted-foreground text-[11px]">
                            {readyRegionCount} ready
                        </p>
                    </div>
                    <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
                        {poolRegions.map((region) => {
                            const ready = Boolean(
                                freeProxy.enabled && region.health?.healthy,
                            );
                            const selected = selectedRegion === region.code;
                            const blockedUntilReady =
                                region.code === "uk" && !ready;
                            return (
                                <button
                                    key={region.code}
                                    type="button"
                                    disabled={
                                        !freeProxy.enabled ||
                                        !onSelectRegion ||
                                        blockedUntilReady
                                    }
                                    onClick={() =>
                                        onSelectRegion?.(region.code)
                                    }
                                    className={cn(
                                        "flex min-w-0 items-center justify-between gap-2 rounded-md border px-2.5 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                                        selected
                                            ? "border-primary bg-primary/5"
                                            : ready
                                              ? "border-emerald-500/20 bg-emerald-500/5 hover:border-emerald-500/40"
                                              : "border-amber-500/20 bg-amber-500/5 hover:border-amber-500/40",
                                    )}
                                    title={
                                        blockedUntilReady
                                            ? `${region.label} unlocks after safe capacity is validated`
                                            : ready
                                              ? `Use ${region.label}`
                                              : `Use ${region.label} while its pool recovers`
                                    }
                                >
                                    <span className="flex min-w-0 items-center gap-1.5">
                                        <span>{region.flag}</span>
                                        <span className="truncate text-[11px] font-semibold uppercase">
                                            {region.code}
                                        </span>
                                    </span>
                                    <span
                                        className={cn(
                                            "text-[10px] tabular-nums",
                                            ready
                                                ? "text-emerald-700 dark:text-emerald-300"
                                                : "text-muted-foreground",
                                        )}
                                    >
                                        {region.health?.mature ?? 0}
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                </div>
            )}
        </div>
    );
}
