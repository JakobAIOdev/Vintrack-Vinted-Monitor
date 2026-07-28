import { db } from "@/lib/db";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import { LiveFeed } from "@/components/monitors/live-feed";
import { Button } from "@/components/ui/button";
import { toggleMonitorStatus, deleteMonitor } from "@/actions/monitor";
import {
    ArrowLeft,
    PauseCircle,
    PlayCircle,
    Trash2,
    Tag,
    Globe,
    Zap,
    Pencil,
    Timer,
    Clock3,
} from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { getCategoryLabelsForRegion } from "@/lib/categories.server";
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
import { formatQuietHours } from "@/lib/monitor-schedule";
import { getMonitorActivationState } from "@/lib/monitor-limits";
import { ProxyHealthCard } from "@/components/monitors/proxy-health";
import { MonitorLiveProvider } from "@/components/monitors/monitor-live-context";
import { MonitorItemCount } from "@/components/monitors/monitor-item-count";
import { MonitorMetricsDialog } from "@/components/monitors/monitor-metrics-dialog";
import { getBannedSellerIds, visibleSellerWhere } from "@/lib/seller-bans";
import { DemoMonitorLease } from "@/components/monitors/demo-monitor-lease";
import { inferProxyErrorCode } from "@/lib/proxy-errors";

type MonitorRunRow = {
    status: string;
    status_code: number | null;
    duration_ms: number | null;
    item_count: number;
    error_message: string | null;
    checked_at: Date;
};

export default async function MonitorPage({
    params,
}: {
    params: Promise<{ id: string }>;
}) {
    const resolvedParams = await params;
    const session = await auth();
    if (!session?.user?.id) redirect("/login");

    const monitorId = parseInt(resolvedParams.id);

    if (isNaN(monitorId)) return notFound();

    const monitor = await db.monitors.findFirst({
        where: { id: monitorId, userId: session.user.id },
        include: {
            _count: { select: { items: true } },
            proxy_group: { select: { name: true } },
        },
    });

    if (!monitor) return notFound();

    const bannedSellerIds = await getBannedSellerIds(session.user.id);
    const visibleItemWhere = {
        monitor_id: monitor.id,
        ...visibleSellerWhere(bannedSellerIds),
    };
    const visibleItemCount = await db.items.count({
        where: visibleItemWhere,
    });

    const toggleAction = toggleMonitorStatus.bind(
        null,
        monitor.id,
        monitor.status || "active",
    );
    const resumeState =
        monitor.status === "active"
            ? null
            : await getMonitorActivationState(monitor.userId);
    const resumeBlocked = resumeState ? !resumeState.canActivate : false;
    const deleteAction = deleteMonitor.bind(null, monitor.id);
    const categoryLabels = await getCategoryLabelsForRegion(
        monitor.catalog_ids,
        monitor.region,
    );
    const recentRuns = await db.$queryRaw<MonitorRunRow[]>`
        SELECT status, status_code, duration_ms, item_count, error_message, checked_at
        FROM monitor_runs
        WHERE monitor_id = ${monitor.id}
          AND fetch_source = 'canonical'
        ORDER BY checked_at DESC
        LIMIT 100
    `;
    const successCount = recentRuns.filter(
        (run) => run.status === "success",
    ).length;
    const failedCount = recentRuns.filter(
        (run) => run.status === "failed",
    ).length;
    const durations = recentRuns
        .map((run) => run.duration_ms)
        .filter((value): value is number => typeof value === "number");
    const avgDuration =
        durations.length > 0
            ? Math.round(
                  durations.reduce((sum, value) => sum + value, 0) /
                      durations.length,
              )
            : null;
    const successRate =
        recentRuns.length > 0
            ? Math.round((successCount / recentRuns.length) * 100)
            : null;
    const oldestRecentRunAt = recentRuns.at(-1)?.checked_at ?? null;
    const savedItemsInWindow = oldestRecentRunAt
        ? await db.items.count({
              where: {
                  ...visibleItemWhere,
                  found_at: { gte: oldestRecentRunAt },
              },
          })
        : 0;
    const lastErrorRun =
        recentRuns.find((run) => run.error_message) ?? null;
    const lastError = lastErrorRun?.error_message ?? null;
    const lastErrorCode = lastError
        ? inferProxyErrorCode(lastError, lastErrorRun?.status_code)
        : null;

    return (
        <MonitorLiveProvider initialItemCount={visibleItemCount}>
            <div className="space-y-6">
                <div className="flex flex-col items-start justify-between gap-4 md:flex-row md:items-center">
                    <div className="flex items-center gap-3">
                        <Link href="/dashboard">
                            <Button
                                variant="outline"
                                size="icon"
                                className="h-8 w-8"
                            >
                                <ArrowLeft className="h-4 w-4" />
                            </Button>
                        </Link>

                        <div>
                            <div className="flex items-center gap-2.5">
                                <h1 className="text-2xl font-bold tracking-tight">
                                    {monitor.name}
                                </h1>
                                <Badge
                                    variant={
                                        monitor.status === "active"
                                            ? "default"
                                            : "secondary"
                                    }
                                    className={`text-[10px] font-medium ${
                                        monitor.status === "active"
                                            ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-400"
                                            : "bg-muted text-muted-foreground"
                                    }`}
                                >
                                    {monitor.status === "active" ? (
                                        <span className="flex items-center gap-1">
                                            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                                            Running
                                        </span>
                                    ) : (
                                        (monitor.status
                                            ?.charAt(0)
                                            .toUpperCase() ?? "") +
                                        (monitor.status?.slice(1) ?? "Paused")
                                    )}
                                </Badge>
                            </div>

                            <div className="text-muted-foreground mt-1 flex flex-wrap items-center gap-3 text-sm">
                                {monitor.query && (
                                    <>
                                        <span>Keywords: {monitor.query}</span>
                                        <span className="text-muted-foreground/50">
                                            ·
                                        </span>
                                    </>
                                )}
                                <span>ID: {monitor.id}</span>
                                {monitor.price_max && (
                                    <>
                                        <span className="text-muted-foreground/50">
                                            ·
                                        </span>
                                        <span className="flex items-center gap-1">
                                            <Tag className="h-3 w-3" /> Max{" "}
                                            {monitor.price_max}€
                                        </span>
                                    </>
                                )}
                                <span className="text-muted-foreground/50">
                                    ·
                                </span>
                                <MonitorItemCount />
                                <span className="text-muted-foreground/50">
                                    ·
                                </span>
                                <span>{getRegionLabel(monitor.region)}</span>
                                <span className="text-muted-foreground/50">
                                    ·
                                </span>
                                <span className="flex items-center gap-1">
                                    <Timer className="h-3 w-3" />{" "}
                                    {formatQueryDelay(monitor.query_delay_ms)}
                                </span>
                                {monitor.quiet_hours_enabled && (
                                    <>
                                        <span className="text-muted-foreground/50">
                                            ·
                                        </span>
                                        <span
                                            className="flex items-center gap-1"
                                            title={monitor.quiet_hours_timezone}
                                        >
                                            <Clock3 className="h-3 w-3" />
                                            {formatQuietHours({
                                                enabled: true,
                                                startMinute:
                                                    monitor.quiet_hours_start_minute,
                                                endMinute:
                                                    monitor.quiet_hours_end_minute,
                                                mode:
                                                    monitor.quiet_hours_mode ===
                                                    "slow"
                                                        ? "slow"
                                                        : "pause",
                                                delayMs:
                                                    monitor.quiet_hours_delay_ms,
                                                timezone:
                                                    monitor.quiet_hours_timezone,
                                            })}
                                        </span>
                                    </>
                                )}
                                <span className="text-muted-foreground/50">
                                    ·
                                </span>
                                {monitor.proxy_source === "free" ? (
                                    <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                                        <Globe className="h-3 w-3" /> Free Proxy
                                        Pool
                                    </span>
                                ) : monitor.proxy_group ? (
                                    <span className="flex items-center gap-1">
                                        <Globe className="h-3 w-3" />{" "}
                                        {monitor.proxy_group.name}
                                    </span>
                                ) : (
                                    <span className="flex items-center gap-1 text-amber-600 dark:text-amber-500">
                                        <Zap className="h-3 w-3" /> Server
                                        Proxies
                                    </span>
                                )}
                            </div>

                            {(monitor.catalog_ids ||
                                monitor.brand_ids ||
                                monitor.color_ids ||
                                monitor.status_ids ||
                                monitor.size_id ||
                                monitor.allowed_countries) && (
                                <div className="mt-2 flex flex-wrap gap-1">
                                    {monitor.allowed_countries && (
                                        <span
                                            className="inline-flex items-center rounded-md border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-400"
                                            title={`Only items from: ${monitor.allowed_countries}`}
                                        >
                                            {getRegionFlags(
                                                monitor.allowed_countries,
                                            ).join(" ")}
                                        </span>
                                    )}
                                    {categoryLabels.map((label) => (
                                        <span
                                            key={`cat-${label}`}
                                            className="inline-flex items-center rounded-md border border-violet-200 bg-violet-50 px-1.5 py-0.5 text-[10px] font-medium text-violet-700 dark:border-violet-500/20 dark:bg-violet-500/10 dark:text-violet-400"
                                        >
                                            {label}
                                        </span>
                                    ))}
                                    {monitor.brand_ids &&
                                        getBrandLabels(monitor.brand_ids).map(
                                            (label) => (
                                                <span
                                                    key={`brand-${label}`}
                                                    className="inline-flex items-center rounded-md border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-700 dark:border-blue-500/20 dark:bg-blue-500/10 dark:text-blue-400"
                                                >
                                                    {label}
                                                </span>
                                            ),
                                        )}
                                    {monitor.color_ids &&
                                        getColorLabels(monitor.color_ids).map(
                                            (label) => (
                                                <span
                                                    key={`color-${label}`}
                                                    className="inline-flex items-center rounded-md border border-pink-200 bg-pink-50 px-1.5 py-0.5 text-[10px] font-medium text-pink-700 dark:border-pink-500/20 dark:bg-pink-500/10 dark:text-pink-400"
                                                >
                                                    {label}
                                                </span>
                                            ),
                                        )}
                                    {monitor.status_ids &&
                                        getStatusLabels(
                                            monitor.status_ids,
                                            getStatusLocaleForRegionCodes(
                                                monitor.allowed_countries,
                                                monitor.region,
                                            ),
                                        ).map((label) => (
                                            <span
                                                key={`status-${label}`}
                                                className="inline-flex items-center rounded-md border border-cyan-200 bg-cyan-50 px-1.5 py-0.5 text-[10px] font-medium text-cyan-700 dark:border-cyan-500/20 dark:bg-cyan-500/10 dark:text-cyan-400"
                                                title={label}
                                            >
                                                {label}
                                            </span>
                                        ))}
                                    {monitor.size_id &&
                                        getSizeLabels(monitor.size_id).map(
                                            (label) => (
                                                <span
                                                    key={`size-${label}`}
                                                    className="inline-flex items-center rounded-md border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-400"
                                                >
                                                    {label}
                                                </span>
                                            ),
                                        )}
                                </div>
                            )}
                        </div>
                    </div>

                    <div className="flex items-center gap-2">
                        <Link href={`/monitors/${monitor.id}/edit`}>
                            <Button
                                variant="outline"
                                size="sm"
                                className="text-muted-foreground border-border hover:bg-muted h-8 text-xs font-medium"
                            >
                                <Pencil className="mr-1.5 h-3.5 w-3.5" /> Edit
                            </Button>
                        </Link>

                        <form action={toggleAction}>
                            <Button
                                variant="outline"
                                size="sm"
                                disabled={resumeBlocked}
                                title={
                                    resumeBlocked && resumeState
                                        ? `Active monitor limit reached (${resumeState.activeCount}/${resumeState.activeLimit})`
                                        : undefined
                                }
                                className={`h-8 text-xs font-medium ${
                                    monitor.status === "active"
                                        ? "border-amber-200 text-amber-600 hover:bg-amber-50 dark:border-amber-500/20 dark:text-amber-500 dark:hover:bg-amber-500/10"
                                        : "border-emerald-200 text-emerald-600 hover:bg-emerald-50 dark:border-emerald-500/20 dark:text-emerald-400 dark:hover:bg-emerald-500/10"
                                }`}
                            >
                                {monitor.status === "active" ? (
                                    <>
                                        <PauseCircle className="mr-1.5 h-3.5 w-3.5" />{" "}
                                        Pause
                                    </>
                                ) : (
                                    <>
                                        <PlayCircle className="mr-1.5 h-3.5 w-3.5" />{" "}
                                        Resume
                                    </>
                                )}
                            </Button>
                        </form>

                        <form action={deleteAction}>
                            <Button
                                variant="outline"
                                size="sm"
                                className="h-8 border-red-200 text-xs font-medium text-red-500 hover:bg-red-50 hover:text-red-600 dark:border-red-500/20 dark:text-red-400 dark:hover:bg-red-500/10 dark:hover:text-red-300"
                            >
                                <Trash2 className="mr-1.5 h-3.5 w-3.5" /> Delete
                            </Button>
                        </form>
                    </div>
                </div>

                {monitor.demo_expires_at && (
                    <DemoMonitorLease
                        monitorId={monitor.id}
                        initialExpiresAt={monitor.demo_expires_at.toISOString()}
                        initialStatus={monitor.status ?? "paused"}
                        initialNow={new Date().toISOString()}
                    />
                )}

                {monitor.status === "active" && (
                    <ProxyHealthCard monitorId={monitor.id} />
                )}

                <div>
                    <div className="mb-4 flex items-center justify-between gap-3">
                        <h2 className="text-lg font-semibold">
                            Latest Results
                        </h2>
                        <MonitorMetricsDialog
                            monitorId={monitor.id}
                            initialMetrics={{
                                recentChecks: recentRuns.length,
                                successRate,
                                avgDurationMs: avgDuration,
                                newItems: savedItemsInWindow,
                                failedChecks: failedCount,
                                lastError,
                                lastErrorCode,
                            }}
                        />
                    </div>
                    <LiveFeed monitorId={monitor.id} />
                </div>
            </div>
        </MonitorLiveProvider>
    );
}
