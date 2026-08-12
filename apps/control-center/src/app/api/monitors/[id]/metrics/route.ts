import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { inferProxyErrorCode } from "@/lib/proxy-errors";
import {
    loadMonitorRunMetrics,
    monitorRunMetricsWindowStart,
} from "@/lib/monitor-run-metrics";

export const dynamic = "force-dynamic";

type DetectionMetricsRow = {
    detection_count: bigint;
    early_alert_count: bigint;
    median_early_lead_ms: number | null;
    p95_detect_to_alert_ms: number | null;
};

export async function GET(
    _req: Request,
    { params }: { params: Promise<{ id: string }> },
) {
    const session = await auth();
    if (!session?.user?.id) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;
    const monitorId = Number(id);
    if (!Number.isInteger(monitorId)) {
        return NextResponse.json({ error: "Invalid ID" }, { status: 400 });
    }

    const monitor = await db.monitors.findFirst({
        where: { id: monitorId, userId: session.user.id },
        select: { id: true },
    });
    if (!monitor) {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const windowStart = monitorRunMetricsWindowStart();
    const [runMetrics, savedItemCount, detectionRows] = await Promise.all([
        loadMonitorRunMetrics(monitorId, windowStart),
        db.items.count({
            where: { monitor_id: monitorId, found_at: { gte: windowStart } },
        }),
        db.$queryRaw<DetectionMetricsRow[]>`
        WITH recent_raw AS (
            SELECT early_seen_at, canonical_seen_at, alert_sent_at
            FROM monitor_item_detections
            WHERE monitor_id = ${monitorId}
            ORDER BY created_at DESC
            LIMIT 500
        ),
        recent_detections AS (
            SELECT
                early_seen_at,
                canonical_seen_at,
                alert_sent_at,
                CASE
                    WHEN early_seen_at IS NULL THEN canonical_seen_at
                    WHEN canonical_seen_at IS NULL THEN early_seen_at
                    ELSE LEAST(early_seen_at, canonical_seen_at)
                END AS first_seen_at
            FROM recent_raw
        )
        SELECT
            COUNT(*)::bigint AS detection_count,
            COUNT(*) FILTER (
                WHERE early_seen_at IS NOT NULL
                  AND alert_sent_at IS NOT NULL
                  AND (
                    canonical_seen_at IS NULL
                    OR alert_sent_at < canonical_seen_at
                  )
            )::bigint AS early_alert_count,
            percentile_cont(0.5) WITHIN GROUP (
                ORDER BY EXTRACT(EPOCH FROM (
                    canonical_seen_at - early_seen_at
                )) * 1000
            ) FILTER (
                WHERE early_seen_at IS NOT NULL
                  AND canonical_seen_at IS NOT NULL
                  AND early_seen_at < canonical_seen_at
            )::float AS median_early_lead_ms,
            percentile_cont(0.95) WITHIN GROUP (
                ORDER BY EXTRACT(EPOCH FROM (
                    alert_sent_at - first_seen_at
                )) * 1000
            ) FILTER (
                WHERE alert_sent_at IS NOT NULL
                  AND first_seen_at IS NOT NULL
                  AND alert_sent_at >= first_seen_at
            )::float AS p95_detect_to_alert_ms
        FROM recent_detections
        `,
    ]);
    const detectionRow = detectionRows[0];
    const { totalChecks, successCount } = runMetrics;
    const successRate =
        totalChecks > 0 ? Math.round((successCount / totalChecks) * 100) : null;
    const detectionCount = Number(detectionRow?.detection_count ?? 0);
    const earlyAlertCount = Number(detectionRow?.early_alert_count ?? 0);
    const earlyAlertRate =
        detectionCount > 0
            ? Math.round((earlyAlertCount / detectionCount) * 100)
            : null;

    return NextResponse.json({
        totalChecks,
        failedCount: runMetrics.failedCount,
        successRate,
        avgDurationMs:
            runMetrics.avgDurationMs === null
                ? null
                : Math.round(runMetrics.avgDurationMs),
        newItemCount: savedItemCount,
        lastError: runMetrics.lastError,
        lastErrorCode: runMetrics.lastError
            ? inferProxyErrorCode(runMetrics.lastError, runMetrics.lastStatusCode)
            : null,
        lastStatusCode: runMetrics.lastStatusCode,
        earlyAlertRate,
        medianEarlyLeadMs:
            detectionRow?.median_early_lead_ms === null ||
            detectionRow?.median_early_lead_ms === undefined
                ? null
                : Math.round(detectionRow.median_early_lead_ms),
        p95DetectToAlertMs:
            detectionRow?.p95_detect_to_alert_ms === null ||
            detectionRow?.p95_detect_to_alert_ms === undefined
                ? null
                : Math.round(detectionRow.p95_detect_to_alert_ms),
    });
}
