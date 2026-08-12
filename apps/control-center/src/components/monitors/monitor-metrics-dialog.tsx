"use client";

import { useCallback, useEffect, useState } from "react";
import { Activity, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from "@/components/ui/dialog";
import { getProxyErrorDetails } from "@/lib/proxy-errors";

type MonitorMetricsDialogProps = {
    monitorId: number;
    initialMetrics: MonitorMetrics;
};

type MonitorMetrics = {
    recentChecks: number;
    successRate: number | null;
    avgDurationMs: number | null;
    newItems: number;
    failedChecks: number;
    lastError: string | null;
    lastErrorCode: string | null;
    earlyAlertRate?: number | null;
    medianEarlyLeadMs?: number | null;
    p95DetectToAlertMs?: number | null;
};

type MonitorMetricsResponse = {
    totalChecks: number;
    successRate: number | null;
    avgDurationMs: number | null;
    newItemCount: number;
    failedCount: number;
    lastError: string | null;
    lastErrorCode: string | null;
    lastStatusCode: number | null;
    earlyAlertRate: number | null;
    medianEarlyLeadMs: number | null;
    p95DetectToAlertMs: number | null;
};

function formatMs(value: number | null) {
    if (value === null) return "n/a";
    return `${value} ms`;
}

export function MonitorMetricsDialog({
    monitorId,
    initialMetrics,
}: MonitorMetricsDialogProps) {
    const [open, setOpen] = useState(false);
    const [metrics, setMetrics] = useState(initialMetrics);
    const [isRefreshing, setIsRefreshing] = useState(false);

    const refreshMetrics = useCallback(async () => {
        setIsRefreshing(true);
        try {
            const res = await fetch(`/api/monitors/${monitorId}/metrics`, {
                cache: "no-store",
            });
            if (!res.ok) return;
            const data = (await res.json()) as MonitorMetricsResponse;
            setMetrics({
                recentChecks: data.totalChecks,
                successRate: data.successRate,
                avgDurationMs: data.avgDurationMs,
                newItems: data.newItemCount,
                failedChecks: data.failedCount,
                lastError: data.lastError,
                lastErrorCode: data.lastErrorCode,
                earlyAlertRate: data.earlyAlertRate,
                medianEarlyLeadMs: data.medianEarlyLeadMs,
                p95DetectToAlertMs: data.p95DetectToAlertMs,
            });
        } finally {
            setIsRefreshing(false);
        }
    }, [monitorId]);

    useEffect(() => {
        if (!open) return;
        void refreshMetrics();
        const interval = window.setInterval(refreshMetrics, 10_000);
        return () => window.clearInterval(interval);
    }, [open, refreshMetrics]);

    const {
        recentChecks,
        successRate,
        avgDurationMs,
        newItems,
        failedChecks,
        lastError,
        lastErrorCode,
        earlyAlertRate = null,
        medianEarlyLeadMs = null,
        p95DetectToAlertMs = null,
    } = metrics;
    const hasIssues = failedChecks > 0 || Boolean(lastError);
    const issue = lastError
        ? getProxyErrorDetails(lastErrorCode, lastError)
        : null;

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
                <Button
                    variant="outline"
                    size="sm"
                    className="text-muted-foreground border-border hover:bg-muted h-8 gap-1.5 text-xs font-medium"
                    title="Open monitor metrics"
                >
                    <Activity className="h-3.5 w-3.5" />
                    Metrics
                    {hasIssues && (
                        <span
                            className="h-1.5 w-1.5 rounded-full bg-amber-500"
                            aria-label="Monitor has recent issues"
                        />
                    )}
                </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-xl">
                <DialogHeader>
                    <div className="flex items-start justify-between gap-4 pr-8">
                        <div className="space-y-1.5">
                            <DialogTitle>Monitor Health</DialogTitle>
                            <DialogDescription>
                                Performance from {recentChecks} worker checks in
                                the past hour. Refreshes every 10 seconds while
                                this dialog is open.
                            </DialogDescription>
                        </div>
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-8 text-xs"
                            onClick={refreshMetrics}
                            disabled={isRefreshing}
                        >
                            {isRefreshing ? "Refreshing..." : "Refresh"}
                        </Button>
                    </div>
                </DialogHeader>

                <div className="grid gap-3 sm:grid-cols-2">
                    <Metric
                        label="Reliability"
                        value={successRate === null ? "n/a" : `${successRate}%`}
                        description="Share of recent checks that reached Vinted successfully."
                    />
                    <Metric
                        label="Average check speed"
                        value={formatMs(avgDurationMs)}
                        description="Average time from starting a Vinted check until its result arrived."
                    />
                    <Metric
                        label="Items found"
                        value={String(newItems)}
                        description="New items found during the checks included in this view."
                    />
                    <Metric
                        label="Found before search"
                        value={
                            earlyAlertRate === null
                                ? "n/a"
                                : `${earlyAlertRate}%`
                        }
                        description="Share of recent items whose notification was delivered before the normal Vinted search found them."
                    />
                    <Metric
                        label="Typical head start"
                        value={formatMs(medianEarlyLeadMs)}
                        description="Typical amount of time saved when the faster discovery path beat the normal search."
                    />
                    <Metric
                        label="Notification speed"
                        value={formatMs(p95DetectToAlertMs)}
                        description="95% of first notifications were delivered within this time after an item was detected."
                    />
                </div>

                {hasIssues && (
                    <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 dark:border-amber-500/20 dark:bg-amber-500/10">
                        <p className="text-[13px] font-semibold text-amber-900 dark:text-amber-200">
                            {issue?.title ?? "Recent issue"}
                        </p>
                        <p className="mt-1 text-[12px] text-amber-700 dark:text-amber-300">
                            {failedChecks} failed check
                            {failedChecks === 1 ? "" : "s"} in the past hour.{" "}
                            {issue?.description}
                        </p>
                        {issue?.action ? (
                            <p className="mt-1 text-[12px] font-medium text-amber-800 dark:text-amber-200">
                                {issue.action}
                            </p>
                        ) : null}
                        {lastError ? (
                            <details className="mt-2 text-[11px] text-amber-800 dark:text-amber-300">
                                <summary className="cursor-pointer font-medium">
                                    Technical details
                                </summary>
                                <p className="mt-1 break-words font-mono">
                                    {lastError}
                                </p>
                            </details>
                        ) : null}
                    </div>
                )}
            </DialogContent>
        </Dialog>
    );
}

function Metric({
    label,
    value,
    description,
}: {
    label: string;
    value: string;
    description: string;
}) {
    return (
        <div className="border-border/75 bg-muted/25 rounded-lg border px-4 py-3">
            <div className="flex items-center gap-1.5">
                <p className="text-muted-foreground text-[11px] font-medium tracking-widest uppercase">
                    {label}
                </p>
                <span
                    className="group text-muted-foreground/70 hover:text-foreground focus-visible:text-foreground relative inline-flex h-4 w-4 items-center justify-center rounded-full transition-colors outline-none"
                    tabIndex={0}
                    aria-label={`${label}: ${description}`}
                >
                    <Info className="h-3.5 w-3.5" />
                    <span className="bg-popover text-popover-foreground pointer-events-none absolute bottom-full left-1/2 z-20 mb-2 hidden w-56 -translate-x-1/2 rounded-md border px-2.5 py-2 text-left text-[11px] leading-snug shadow-md group-hover:block group-focus-visible:block">
                        {description}
                    </span>
                </span>
            </div>
            <p className="mt-1 text-lg font-semibold">{value}</p>
        </div>
    );
}
