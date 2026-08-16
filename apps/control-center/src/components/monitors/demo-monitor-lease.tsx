"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Clock3, InfinityIcon, Loader2, TimerReset } from "lucide-react";
import { toast } from "sonner";
import { extendDemoMonitor, keepDemoMonitorRunning } from "@/actions/monitor";
import { Button } from "@/components/ui/button";
import { DEMO_MONITOR_DURATION_MINUTES } from "@/lib/demo-monitor";

function formatRemaining(milliseconds: number) {
    const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function DemoMonitorLease({
    monitorId,
    initialExpiresAt,
    initialStatus,
    initialNow,
    maintenanceEnabled = false,
}: {
    monitorId: number;
    initialExpiresAt: string;
    initialStatus: string;
    initialNow: string;
    maintenanceEnabled?: boolean;
}) {
    const router = useRouter();
    const [expiresAt, setExpiresAt] = useState(initialExpiresAt);
    const [status, setStatus] = useState(initialStatus);
    const [now, setNow] = useState(() => new Date(initialNow).getTime());
    const [pendingAction, setPendingAction] = useState<
        "extend" | "keep" | null
    >(null);
    const [converted, setConverted] = useState(false);

    const remainingMs = new Date(expiresAt).getTime() - now;
    const expired = remainingMs <= 0;
    const running = status === "active" && !expired;

    useEffect(() => {
        const interval = window.setInterval(() => setNow(Date.now()), 1000);
        return () => window.clearInterval(interval);
    }, []);

    useEffect(() => {
        if (!expired || status !== "active") return;
        const timeout = window.setTimeout(() => router.refresh(), 6000);
        return () => window.clearTimeout(timeout);
    }, [expired, router, status]);

    const handleExtend = async () => {
        setPendingAction("extend");
        try {
            const result = await extendDemoMonitor(monitorId);
            setExpiresAt(result.expiresAt);
            setStatus(result.status);
            setNow(Date.now());
            toast.success(
                result.rewardNotice
                    ? `${result.rewardNotice.title}: ${result.rewardNotice.message}`
                    : `Demo monitor is running for another ${DEMO_MONITOR_DURATION_MINUTES} minutes`,
            );
            router.refresh();
        } catch (error) {
            toast.error(
                error instanceof Error
                    ? error.message
                    : "Could not extend the demo monitor",
            );
        } finally {
            setPendingAction(null);
        }
    };

    const handleKeepRunning = async () => {
        setPendingAction("keep");
        try {
            const result = await keepDemoMonitorRunning(monitorId);
            setConverted(true);
            toast.success(
                result.rewardNotice
                    ? `${result.rewardNotice.title}: ${result.rewardNotice.message}`
                    : "Demo limit removed — this monitor keeps running",
            );
            router.refresh();
        } catch (error) {
            toast.error(
                error instanceof Error
                    ? error.message
                    : "Could not remove the demo limit",
            );
        } finally {
            setPendingAction(null);
        }
    };

    if (converted) return null;

    return (
        <div
            data-testid="demo-monitor-lease"
            className="flex flex-col gap-4 rounded-xl border border-amber-500/25 bg-amber-500/8 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5"
        >
            <div className="flex min-w-0 items-start gap-3">
                <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-amber-500/15 text-amber-700 dark:text-amber-300">
                    <Clock3 className="size-4" />
                </span>
                <div>
                    <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-semibold">
                            {running
                                ? "Demo monitor"
                                : expired
                                  ? "Demo time ended"
                                  : "Demo monitor paused"}
                        </p>
                        {running && (
                            <span className="rounded-full bg-amber-500/15 px-2 py-0.5 font-mono text-[11px] font-semibold text-amber-800 dark:text-amber-200">
                                {formatRemaining(remainingMs)}
                            </span>
                        )}
                    </div>
                    <p className="text-muted-foreground mt-1 text-xs leading-5">
                        {running
                            ? "It pauses automatically when the timer ends. Extend it or remove the demo limit whenever you want."
                            : maintenanceEnabled
                              ? "This demo is safely paused and cannot be resumed until maintenance is complete."
                              : "Start another 30-minute session or keep this monitor running without a time limit."}
                    </p>
                </div>
            </div>
            <div className="flex shrink-0 flex-col gap-2 sm:flex-row">
                <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleExtend}
                    disabled={pendingAction !== null || maintenanceEnabled}
                    title={
                        maintenanceEnabled
                            ? "Paused for maintenance"
                            : undefined
                    }
                    className="gap-1.5"
                >
                    {pendingAction === "extend" ? (
                        <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                        <TimerReset className="size-3.5" />
                    )}
                    {running ? "+30 min" : "Run for 30 min"}
                </Button>
                <Button
                    type="button"
                    size="sm"
                    onClick={handleKeepRunning}
                    disabled={pendingAction !== null || maintenanceEnabled}
                    title={
                        maintenanceEnabled
                            ? "Paused for maintenance"
                            : undefined
                    }
                    className="gap-1.5"
                >
                    {pendingAction === "keep" ? (
                        <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                        <InfinityIcon className="size-3.5" />
                    )}
                    Keep running
                </Button>
            </div>
        </div>
    );
}
