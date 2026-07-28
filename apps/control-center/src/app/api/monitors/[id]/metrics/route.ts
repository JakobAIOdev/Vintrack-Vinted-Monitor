import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { inferProxyErrorCode } from "@/lib/proxy-errors";

export const dynamic = "force-dynamic";

type MetricsRow = {
    total_checks: bigint;
    success_count: bigint;
    failed_count: bigint;
    avg_duration_ms: number | null;
    saved_item_count: bigint;
    last_error: string | null;
    last_status_code: number | null;
};

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

    const [rows, detectionRows] = await Promise.all([
        db.$queryRaw<MetricsRow[]>`
        WITH recent AS (
            SELECT status, status_code, duration_ms, error_message, checked_at
            FROM monitor_runs
            WHERE monitor_id = ${monitorId}
              AND fetch_source = 'canonical'
            ORDER BY checked_at DESC
            LIMIT 100
        ),
        bounds AS (
            SELECT MIN(checked_at) AS oldest_check_at
            FROM recent
        )
        SELECT
            COUNT(*)::bigint AS total_checks,
            COUNT(*) FILTER (WHERE status = 'success')::bigint AS success_count,
            COUNT(*) FILTER (WHERE status = 'failed')::bigint AS failed_count,
            AVG(duration_ms)::float AS avg_duration_ms,
            (
                SELECT COUNT(*)::bigint
                FROM items i, bounds b
                WHERE i.monitor_id = ${monitorId}
                  AND b.oldest_check_at IS NOT NULL
                  AND i.found_at >= b.oldest_check_at
            ) AS saved_item_count,
            (
                SELECT error_message
                FROM recent
                WHERE error_message IS NOT NULL
                ORDER BY checked_at DESC
                LIMIT 1
            ) AS last_error,
            (
                SELECT status_code
                FROM recent
                WHERE error_message IS NOT NULL
                ORDER BY checked_at DESC
                LIMIT 1
            ) AS last_status_code
        FROM recent
        `,
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
    const row = rows[0];
    const detectionRow = detectionRows[0];
    const totalChecks = Number(row?.total_checks ?? 0);
    const successCount = Number(row?.success_count ?? 0);
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
        failedCount: Number(row?.failed_count ?? 0),
        successRate,
        avgDurationMs:
            row?.avg_duration_ms === null || row?.avg_duration_ms === undefined
                ? null
                : Math.round(row.avg_duration_ms),
        newItemCount: Number(row?.saved_item_count ?? 0),
        lastError: row?.last_error ?? null,
        lastErrorCode: row?.last_error
            ? inferProxyErrorCode(row.last_error, row.last_status_code)
            : null,
        lastStatusCode: row?.last_status_code ?? null,
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
