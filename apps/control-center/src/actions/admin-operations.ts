"use server";

import { auth } from "@/auth";
import { db } from "@/lib/db";

async function requireAdmin() {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");
    if (session.user.role !== "admin") throw new Error("Forbidden");
}

type AdminOperationFilter = "all" | "delivery" | "proxy" | "monitor" | "audit";

type AdminOperationRow = {
    id: string;
    type: "audit" | "monitor" | "delivery" | "proxy";
    title: string;
    detail: string | null;
    status: string;
    subject: string | null;
    actor: string | null;
    createdAt: Date;
};

async function loadAdminOperationsSummary() {
    type StatRow = {
        channel: string;
        outcome: string;
        event_count: bigint;
    };
    type FailureRow = {
        channel: string;
        reason_code: string;
        event_count: bigint;
        last_seen_at: Date;
    };
    type LatencyRow = {
        p50_ms: number | null;
        p95_ms: number | null;
        p99_ms: number | null;
    };
    const [
        stats,
        queue,
        failures,
        incidents,
        briefIncidents,
        settings,
        latency,
    ] = await Promise.all([
        db.$queryRaw<StatRow[]>`
                    SELECT channel, outcome, SUM(event_count)::bigint AS event_count
                    FROM alert_event_hourly_stats
                    WHERE bucket_hour >= DATE_TRUNC('hour', NOW() - INTERVAL '24 hours')
                    GROUP BY channel, outcome
                `,
        db.$queryRaw<
            {
                status: string;
                event_count: bigint;
                oldest_at: Date | null;
            }[]
        >`
                    SELECT status, COUNT(*)::bigint AS event_count,
                        MIN(created_at) AS oldest_at
                    FROM alert_deliveries
                    WHERE status IN ('pending', 'processing', 'retrying')
                    GROUP BY status
                `,
        db.$queryRaw<FailureRow[]>`
                    SELECT channel, reason_code, SUM(event_count)::bigint AS event_count,
                        MAX(last_seen_at) AS last_seen_at
                    FROM alert_event_hourly_stats
                    WHERE bucket_hour >= DATE_TRUNC('hour', NOW() - INTERVAL '24 hours')
                      AND outcome = 'failed'
                    GROUP BY channel, reason_code
                    ORDER BY event_count DESC, last_seen_at DESC
                    LIMIT 8
                `,
        db.$queryRaw<
            {
                open_count: bigint;
                relevant_recovered_count: bigint;
                brief_recovered_count: bigint;
            }[]
        >`
                    SELECT
                        COUNT(*) FILTER (WHERE recovered_at IS NULL)::bigint AS open_count,
                        COUNT(*) FILTER (
                            WHERE recovered_at >= NOW() - INTERVAL '24 hours'
                              AND recovered_at - started_at >= INTERVAL '30 seconds'
                        )::bigint AS relevant_recovered_count,
                        COUNT(*) FILTER (
                            WHERE recovered_at >= NOW() - INTERVAL '24 hours'
                              AND recovered_at - started_at < INTERVAL '30 seconds'
                        )::bigint AS brief_recovered_count
                    FROM monitor_proxy_incidents
                    WHERE recovered_at IS NULL OR recovered_at >= NOW() - INTERVAL '24 hours'
                `,
        db.$queryRaw<
            {
                domain: string;
                proxy_source: string;
                incident_count: bigint;
                wait_count: bigint;
            }[]
        >`
                    SELECT domain, proxy_source,
                        COUNT(*)::bigint AS incident_count,
                        SUM(wait_count)::bigint AS wait_count
                    FROM monitor_proxy_incidents
                    WHERE recovered_at >= NOW() - INTERVAL '24 hours'
                      AND recovered_at - started_at < INTERVAL '30 seconds'
                    GROUP BY domain, proxy_source
                    ORDER BY incident_count DESC, wait_count DESC
                    LIMIT 8
                `,
        db.app_settings.findMany({
            where: {
                key: {
                    in: [
                        "alert_telemetry_tracked_since",
                        "alert_dispatcher_heartbeat",
                        "seller_enrichment_metrics",
                    ],
                },
            },
            select: { key: true, value: true },
        }),
        db.$queryRaw<LatencyRow[]>`
                    SELECT
                        PERCENTILE_CONT(0.50) WITHIN GROUP (
                            ORDER BY EXTRACT(EPOCH FROM (d.completed_at - d.created_at)) * 1000
                        )::double precision AS p50_ms,
                        PERCENTILE_CONT(0.95) WITHIN GROUP (
                            ORDER BY EXTRACT(EPOCH FROM (d.completed_at - d.created_at)) * 1000
                        )::double precision AS p95_ms,
                        PERCENTILE_CONT(0.99) WITHIN GROUP (
                            ORDER BY EXTRACT(EPOCH FROM (d.completed_at - d.created_at)) * 1000
                        )::double precision AS p99_ms
                    FROM alert_deliveries d
                    JOIN alert_notifications n ON n.id = d.notification_id
                    WHERE d.status = 'sent'
                      AND d.completed_at >= NOW() - INTERVAL '24 hours'
                      AND n.kind = 'item_match'
                `,
    ]);

    const outcomeTotals = new Map<string, number>();
    const byChannel: Record<
        string,
        { sent: number; failed: number; deduplicated: number }
    > = {};
    for (const row of stats) {
        const count = Number(row.event_count);
        outcomeTotals.set(
            row.outcome,
            (outcomeTotals.get(row.outcome) ?? 0) + count,
        );
        const channel = (byChannel[row.channel] ??= {
            sent: 0,
            failed: 0,
            deduplicated: 0,
        });
        if (row.outcome === "sent") channel.sent += count;
        if (row.outcome === "failed") channel.failed += count;
        if (row.outcome === "deduplicated") channel.deduplicated += count;
    }
    const sent = outcomeTotals.get("sent") ?? 0;
    const failed = outcomeTotals.get("failed") ?? 0;
    const queueTotals = Object.fromEntries(
        queue.map((row) => [row.status, Number(row.event_count)]),
    );
    const oldestPendingAt = queue
        .map((row) => row.oldest_at)
        .filter((value): value is Date => Boolean(value))
        .sort((a, b) => a.getTime() - b.getTime())[0];
    const settingMap = new Map(
        settings.map((setting) => [setting.key, setting.value]),
    );
    const enrichmentRaw = settingMap.get("seller_enrichment_metrics");
    let enrichment: {
        queueAgeMs: number;
        cacheHitRate: number;
        cacheHits: number;
        cacheMisses: number;
        remoteP95Ms: number;
        timeouts: number;
        updatedAt: string | null;
        freshHits: number;
        staleHits: number;
        redisHits: number;
        dbHits: number;
        refreshes: number;
        remoteP50Ms: number;
        remoteSuccessRate: number;
        strictRetryQueueAgeMs: number;
        backgroundQueueAgeMs: number;
    } | null = null;
    if (enrichmentRaw) {
        try {
            const value = JSON.parse(enrichmentRaw) as Record<string, unknown>;
            enrichment = {
                queueAgeMs: Number(value.queueAgeMs ?? 0),
                cacheHitRate: Number(value.cacheHitRate ?? 0),
                cacheHits: Number(value.cacheHits ?? 0),
                cacheMisses: Number(value.cacheMisses ?? 0),
                remoteP95Ms: Number(value.remoteP95Ms ?? 0),
                timeouts: Number(value.timeouts ?? 0),
                updatedAt:
                    typeof value.updatedAt === "string"
                        ? value.updatedAt
                        : null,
                freshHits: Number(value.freshHits ?? value.cacheHits ?? 0),
                staleHits: Number(value.staleHits ?? 0),
                redisHits: Number(value.redisHits ?? 0),
                dbHits: Number(value.dbHits ?? 0),
                refreshes: Number(value.refreshes ?? 0),
                remoteP50Ms: Number(value.remoteP50Ms ?? 0),
                remoteSuccessRate: Number(value.remoteSuccessRate ?? 0),
                strictRetryQueueAgeMs: Number(
                    value.strictRetryQueueAgeMs ?? 0,
                ),
                backgroundQueueAgeMs: Number(
                    value.backgroundQueueAgeMs ?? 0,
                ),
            };
        } catch {
            enrichment = null;
        }
    }

    return {
        windowHours: 24,
        sent,
        failed,
        deduplicated: outcomeTotals.get("deduplicated") ?? 0,
        queued: outcomeTotals.get("queued") ?? 0,
        retryScheduled: outcomeTotals.get("retry_scheduled") ?? 0,
        pending:
            (queueTotals.pending ?? 0) +
            (queueTotals.processing ?? 0) +
            (queueTotals.retrying ?? 0),
        retrying: queueTotals.retrying ?? 0,
        successRate: sent + failed > 0 ? (sent / (sent + failed)) * 100 : null,
        oldestPendingAt: oldestPendingAt ?? null,
        byChannel,
        topFailures: failures.map((row) => ({
            channel: row.channel,
            reasonCode: row.reason_code || "unknown",
            count: Number(row.event_count),
            lastSeenAt: row.last_seen_at,
        })),
        proxyIncidents: {
            open: Number(incidents[0]?.open_count ?? 0),
            recovered: Number(incidents[0]?.relevant_recovered_count ?? 0),
            brief: Number(incidents[0]?.brief_recovered_count ?? 0),
            briefGroups: briefIncidents.map((row) => ({
                domain: row.domain,
                proxySource: row.proxy_source,
                incidents: Number(row.incident_count),
                waits: Number(row.wait_count),
            })),
        },
        trackedSince: settingMap.get("alert_telemetry_tracked_since") ?? null,
        dispatcherHeartbeat:
            settingMap.get("alert_dispatcher_heartbeat") ?? null,
        enrichment,
        notificationLatency: {
            p50Ms: latency[0]?.p50_ms ?? null,
            p95Ms: latency[0]?.p95_ms ?? null,
            p99Ms: latency[0]?.p99_ms ?? null,
        },
    };
}

export async function getAdminOperationsSummary() {
    await requireAdmin();
    return loadAdminOperationsSummary();
}

export async function getAdminOperationsPage(input?: {
    filter?: AdminOperationFilter;
    cursor?: string | null;
    pageSize?: number;
}) {
    await requireAdmin();
    const filter = input?.filter ?? "all";
    const pageSize = Math.min(Math.max(input?.pageSize ?? 50, 1), 50);
    const parsedCursor = input?.cursor ? new Date(input.cursor) : null;
    const cursor =
        parsedCursor && !Number.isNaN(parsedCursor.getTime())
            ? parsedCursor
            : null;
    const rows: AdminOperationRow[] = [];
    const queryLimit = pageSize + 1;

    if (filter === "all" || filter === "delivery") {
        const deliveryRows = await db.alert_events.findMany({
            where: {
                status:
                    filter === "all"
                        ? "failed"
                        : {
                              in: ["failed", "retry_scheduled", "cancelled"],
                          },
                ...(cursor ? { created_at: { lt: cursor } } : {}),
            },
            orderBy: [{ created_at: "desc" }, { id: "desc" }],
            take: queryLimit,
            select: {
                id: true,
                channel: true,
                status: true,
                notification_kind: true,
                reason_code: true,
                failure_reason: true,
                attempt_number: true,
                created_at: true,
                monitor: {
                    select: {
                        name: true,
                        user: { select: { name: true, email: true } },
                    },
                },
            },
        });
        rows.push(
            ...deliveryRows.map((row) => ({
                id: `delivery-${row.id.toString()}`,
                type: "delivery" as const,
                title: `${row.channel} ${row.notification_kind}`,
                detail: [
                    row.reason_code ?? row.status,
                    row.attempt_number ? `attempt ${row.attempt_number}` : null,
                    row.failure_reason,
                ]
                    .filter(Boolean)
                    .join(" · "),
                status: row.status,
                subject: row.monitor?.name ?? null,
                actor:
                    row.monitor?.user.name ?? row.monitor?.user.email ?? null,
                createdAt: row.created_at,
            })),
        );
    }

    if (filter === "all" || filter === "proxy") {
        const proxyRows = await db.monitor_proxy_incidents.findMany({
            where: {
                OR: [
                    { recovered_at: null },
                    {
                        recovered_at: {
                            not: null,
                            ...(cursor ? { lt: cursor } : {}),
                        },
                        AND: {
                            recovered_at: {
                                gte: new Date(Date.now() - 30 * 86400_000),
                            },
                        },
                    },
                ],
                ...(cursor ? { started_at: { lt: cursor } } : {}),
            },
            orderBy: [{ started_at: "desc" }, { id: "desc" }],
            take: queryLimit,
            include: {
                monitor: {
                    select: {
                        name: true,
                        user: { select: { name: true, email: true } },
                    },
                },
            },
        });
        rows.push(
            ...proxyRows
                .filter(
                    (row) =>
                        !row.recovered_at ||
                        row.recovered_at.getTime() - row.started_at.getTime() >=
                            30_000,
                )
                .map((row) => ({
                    id: `proxy-${row.id.toString()}`,
                    type: "proxy" as const,
                    title: row.recovered_at
                        ? "Proxy pool recovered"
                        : "Proxy pool waiting",
                    detail: `${row.domain} · ${row.proxy_source} · ${row.wait_count} wait${row.wait_count === 1 ? "" : "s"}${row.recovered_at ? ` · ${Math.max(1, Math.round((row.recovered_at.getTime() - row.started_at.getTime()) / 1000))}s` : ""}`,
                    status: row.recovered_at ? "recovered" : "warning",
                    subject: row.monitor.name,
                    actor:
                        row.monitor.user.name ?? row.monitor.user.email ?? null,
                    createdAt: row.started_at,
                })),
        );
    }

    if (filter === "all" || filter === "monitor") {
        const monitorRows = await db.monitor_events.findMany({
            where: {
                severity:
                    filter === "all" ? "error" : { in: ["warning", "error"] },
                event_type: {
                    notIn: ["proxy_pool_waiting", "proxy_pool_recovered"],
                },
                ...(cursor ? { created_at: { lt: cursor } } : {}),
            },
            orderBy: [{ created_at: "desc" }, { id: "desc" }],
            take: queryLimit,
            include: {
                monitor: {
                    select: {
                        name: true,
                        user: { select: { name: true, email: true } },
                    },
                },
            },
        });
        rows.push(
            ...monitorRows.map((row) => ({
                id: `monitor-${row.id.toString()}`,
                type: "monitor" as const,
                title: row.event_type,
                detail: row.message,
                status: row.severity,
                subject: row.monitor.name,
                actor: row.monitor.user.name ?? row.monitor.user.email ?? null,
                createdAt: row.created_at,
            })),
        );
    }

    if (filter === "all" || filter === "audit") {
        const auditRows = await db.audit_events.findMany({
            where: {
                ...(filter === "all" ? { status: { not: "success" } } : {}),
                ...(cursor ? { created_at: { lt: cursor } } : {}),
            },
            orderBy: [{ created_at: "desc" }, { id: "desc" }],
            take: queryLimit,
            include: { user: { select: { name: true, email: true } } },
        });
        rows.push(
            ...auditRows.map((row) => ({
                id: `audit-${row.id.toString()}`,
                type: "audit" as const,
                title: row.action,
                detail: row.target_type,
                status: row.status,
                subject: row.target_id,
                actor: row.user?.name ?? row.user?.email ?? null,
                createdAt: row.created_at,
            })),
        );
    }

    const page = rows
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, pageSize);
    return {
        rows: page,
        nextCursor:
            rows.length > pageSize
                ? (page.at(-1)?.createdAt.toISOString() ?? null)
                : null,
    };
}

export async function getAdminOperationsState(input?: {
    filter?: AdminOperationFilter;
    cursor?: string | null;
    pageSize?: number;
}) {
    await requireAdmin();
    const [summary, page] = await Promise.all([
        loadAdminOperationsSummary(),
        getAdminOperationsPage(input),
    ]);
    return { summary, page };
}
