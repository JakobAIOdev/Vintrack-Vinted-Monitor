"use client";

import { useEffect, useState, useCallback } from "react";
import { AlertTriangle, Clock3 } from "lucide-react";
import { getProxyErrorDetails } from "@/lib/proxy-errors";

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

function formatRetryTime(value?: string) {
    if (!value) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return new Intl.DateTimeFormat(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    }).format(date);
}

export function ProxyHealthCard({ monitorId }: { monitorId: number }) {
    const [health, setHealth] = useState<MonitorHealth | null>(null);

    const fetchHealth = useCallback(async () => {
        try {
            const res = await fetch("/api/monitors/health");
            if (res.ok) {
                const data = await res.json();
                setHealth(data[monitorId] || null);
            }
        } catch {}
    }, [monitorId]);

    useEffect(() => {
        const timeout = window.setTimeout(fetchHealth, 0);
        const interval = setInterval(fetchHealth, 10_000);
        return () => {
            window.clearTimeout(timeout);
            clearInterval(interval);
        };
    }, [fetchHealth]);

    if (!health) return null;

    const hasWarning =
        health.proxy_state === "waiting_for_proxy" ||
        health.proxy_state === "unavailable" ||
        health.consecutive_errors === -1 ||
        health.consecutive_errors >= 3;

    if (!hasWarning) return null;

    const issue = getProxyErrorDetails(
        health.last_error_code,
        health.last_error,
    );
    const retryTime = formatRetryTime(health.retry_at);
    const isWaiting = health.proxy_state === "waiting_for_proxy";

    return (
        <div
            className={`rounded-xl border px-5 py-4 ${
                isWaiting
                    ? "border-amber-200 bg-amber-50 dark:border-amber-500/20 dark:bg-amber-500/10"
                    : "border-red-200 bg-red-50 dark:border-red-500/20 dark:bg-red-500/10"
            }`}
        >
            <div className="mb-1 flex items-center gap-2">
                <AlertTriangle
                    className={`h-4 w-4 ${
                        isWaiting
                            ? "text-amber-700 dark:text-amber-400"
                            : "text-red-700 dark:text-red-400"
                    }`}
                />
                <p
                    className={`text-[13px] font-semibold ${
                        isWaiting
                            ? "text-amber-900 dark:text-amber-200"
                            : "text-red-800 dark:text-red-300"
                    }`}
                >
                    {issue.title}
                </p>
            </div>
            <p
                className={`text-[12px] ${
                    isWaiting
                        ? "text-amber-800 dark:text-amber-300"
                        : "text-red-700 dark:text-red-400"
                }`}
            >
                {issue.description}
            </p>
            {issue.action ? (
                <p className="mt-1 text-[12px] font-medium">{issue.action}</p>
            ) : null}
            {retryTime ? (
                <p className="mt-2 flex items-center gap-1.5 text-[11px] font-medium">
                    <Clock3 className="h-3.5 w-3.5" />
                    Automatic retry at {retryTime}
                </p>
            ) : null}
            {health.proxy_label ? (
                <p className="text-muted-foreground mt-1 font-mono text-[11px]">
                    Affected endpoint: {health.proxy_label}
                </p>
            ) : null}
            {health.last_error ? (
                <details className="mt-2 text-[11px]">
                    <summary className="cursor-pointer font-medium">
                        Technical details
                    </summary>
                    <p className="mt-1 break-words font-mono opacity-80">
                        {health.last_error}
                    </p>
                </details>
            ) : null}
        </div>
    );
}
