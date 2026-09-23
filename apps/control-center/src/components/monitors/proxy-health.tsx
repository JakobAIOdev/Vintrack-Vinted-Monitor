"use client";

import { useCallback, useEffect, useState, type ElementType } from "react";
import {
    AlertTriangle,
    CheckCircle2,
    Clock3,
    LoaderCircle,
    PauseCircle,
    Wrench,
} from "lucide-react";
import { cn } from "@/lib/utils";

export type MonitorHealth = {
    monitor_id: number;
    total_checks: number;
    total_errors: number;
    consecutive_errors: number;
    last_error?: string;
    last_error_code?: string;
    proxy_state?: string;
    runtime_state?: "starting" | "running" | "degraded" | "waiting_for_pool";
    state_since?: string;
    last_success_at?: string;
    effective_interval_ms?: number;
    retry_at?: string;
    proxy_label?: string;
    updated_at: string;
};

type RuntimeState = "starting" | "running" | "degraded" | "waiting";

type StatusPresentation = {
    label: string;
    compactLabel: string;
    description: string;
    icon: ElementType;
    statusClass: string;
    iconClass: string;
};

const runtimePresentations: Record<RuntimeState, StatusPresentation> = {
    running: {
        label: "Running",
        compactLabel: "Running",
        description: "Catalogue checks are healthy and new matches are live.",
        icon: CheckCircle2,
        statusClass: "text-emerald-700 dark:text-emerald-400",
        iconClass: "text-emerald-600 dark:text-emerald-400",
    },
    starting: {
        label: "Starting",
        compactLabel: "Starting",
        description: "Preparing the first safe catalogue check.",
        icon: LoaderCircle,
        statusClass: "text-sky-700 dark:text-sky-400",
        iconClass: "animate-spin text-sky-600 dark:text-sky-400",
    },
    waiting: {
        label: "Waiting for safe proxy capacity",
        compactLabel: "Waiting for capacity",
        description:
            "The monitor stays active and resumes automatically when the regional pool is ready.",
        icon: Clock3,
        statusClass: "text-amber-700 dark:text-amber-400",
        iconClass: "text-amber-600 dark:text-amber-400",
    },
    degraded: {
        label: "Temporarily degraded",
        compactLabel: "Degraded",
        description:
            "Some checks are delayed. Automatic retries are active; no action is needed.",
        icon: AlertTriangle,
        statusClass: "text-orange-700 dark:text-orange-400",
        iconClass: "text-orange-600 dark:text-orange-400",
    },
};

export function resolveMonitorRuntimeState(
    health?: MonitorHealth | null,
): RuntimeState {
    switch (health?.runtime_state) {
        case "waiting_for_pool":
            return "waiting";
        case "degraded":
            return "degraded";
        case "running":
            return "running";
        case "starting":
            return "starting";
    }

    // Older workers only reported proxy/error fields. Use those as a fallback,
    // but never let stale counters override an explicit runtime state.
    if (health?.proxy_state === "waiting_for_proxy") return "waiting";
    if (
        health?.proxy_state === "unavailable" ||
        health?.consecutive_errors === -1 ||
        (health?.consecutive_errors ?? 0) >= 3
    ) {
        return "degraded";
    }
    return "starting";
}

function runtimePresentation(health?: MonitorHealth | null) {
    return runtimePresentations[resolveMonitorRuntimeState(health)];
}

function formatTimestamp(value: string) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "recently";
    return new Intl.DateTimeFormat(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    }).format(date);
}

function formatInterval(value?: number) {
    if (!value || value <= 0) return null;
    if (value < 1_000) return `${Math.round(value)} ms interval`;
    const seconds = value / 1_000;
    return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)} s interval`;
}

function runtimeStatusTitle(
    health: MonitorHealth | null | undefined,
    presentation: StatusPresentation,
) {
    const details = [presentation.description];
    if (health?.last_success_at) {
        details.push(`Last success ${formatTimestamp(health.last_success_at)}`);
    }
    if (health?.retry_at && resolveMonitorRuntimeState(health) !== "running") {
        details.push(`Next retry ${formatTimestamp(health.retry_at)}`);
    }
    const interval = formatInterval(health?.effective_interval_ms);
    if (interval) details.push(interval);
    return details.join(" · ");
}

export function MonitorRuntimeStatus({
    health,
    compact = false,
    className,
}: {
    health?: MonitorHealth | null;
    compact?: boolean;
    className?: string;
}) {
    const presentation = runtimePresentation(health);
    const Icon = presentation.icon;

    return (
        <span
            role="status"
            data-runtime-state={resolveMonitorRuntimeState(health)}
            title={runtimeStatusTitle(health, presentation)}
            className={cn(
                "inline-flex min-w-0 max-w-full items-center gap-1.5 text-[11px] leading-none font-medium",
                presentation.statusClass,
                className,
            )}
        >
            <Icon className={cn("size-3 shrink-0", presentation.iconClass)} />
            <span className="truncate">
                {compact ? presentation.compactLabel : presentation.label}
            </span>
        </span>
    );
}

export function MonitorLifecycleStatus({
    status,
    health,
    compact = false,
    className,
}: {
    status: string;
    health?: MonitorHealth | null;
    compact?: boolean;
    className?: string;
}) {
    if (status === "active") {
        return (
            <MonitorRuntimeStatus
                health={health}
                compact={compact}
                className={className}
            />
        );
    }

    const states: Record<
        string,
        { label: string; icon: ElementType; className: string }
    > = {
        maintenance_paused: {
            label: "Maintenance",
            icon: Wrench,
            className: "text-violet-700 dark:text-violet-400",
        },
        inactivity_paused: {
            label: "Inactive",
            icon: Clock3,
            className: "text-amber-700 dark:text-amber-400",
        },
        error: {
            label: "Proxy error",
            icon: AlertTriangle,
            className: "text-red-700 dark:text-red-400",
        },
        paused: {
            label: "Paused",
            icon: PauseCircle,
            className: "text-muted-foreground",
        },
    };
    const presentation = states[status] ?? states.paused;
    const Icon = presentation.icon;

    return (
        <span
            role="status"
            className={cn(
                "inline-flex min-w-0 max-w-full items-center gap-1.5 text-[11px] leading-none font-medium",
                presentation.className,
                className,
            )}
        >
            <Icon className="size-3 shrink-0" />
            <span className="truncate">{presentation.label}</span>
        </span>
    );
}

export function ProxyHealthCard({
    monitorId,
    className,
}: {
    monitorId: number;
    className?: string;
}) {
    const [health, setHealth] = useState<MonitorHealth | null>(null);

    const fetchHealth = useCallback(async () => {
        try {
            const res = await fetch("/api/monitors/health", {
                cache: "no-store",
            });
            if (res.ok) {
                const data = await res.json();
                setHealth(data[monitorId] || null);
            }
        } catch {}
    }, [monitorId]);

    useEffect(() => {
        const timeout = window.setTimeout(fetchHealth, 0);
        const interval = window.setInterval(fetchHealth, 10_000);
        return () => {
            window.clearTimeout(timeout);
            window.clearInterval(interval);
        };
    }, [fetchHealth]);

    return (
        <MonitorRuntimeStatus
            health={health}
            compact
            className={className}
        />
    );
}
