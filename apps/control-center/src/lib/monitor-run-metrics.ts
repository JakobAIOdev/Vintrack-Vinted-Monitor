import { db } from "@/lib/db";

/**
 * Per-monitor check statistics.
 *
 * These used to be computed from the last 100 rows of `monitor_runs`. At a
 * default 1500 ms interval that window was about two and a half minutes, and it
 * only worked because every single check wrote a row. The worker now folds
 * routine checks into `monitor_run_hourly_stats` and writes detail rows only for
 * failures and for successes that produced new items, so the counts come from
 * the aggregate instead.
 *
 * The window is the current hour bucket plus the previous one: long enough to be
 * stable, short enough that a monitor which started failing minutes ago does not
 * still read as healthy.
 */
export type MonitorRunMetrics = {
    totalChecks: number;
    successCount: number;
    failedCount: number;
    avgDurationMs: number | null;
    lastError: string | null;
    lastStatusCode: number | null;
};

type MonitorRunMetricsRow = {
    total_checks: bigint;
    success_count: bigint;
    failed_count: bigint;
    avg_duration_ms: number | null;
    last_error: string | null;
    last_status_code: number | null;
};

/** Start of the metrics window, also used to bound the matching item count. */
export function monitorRunMetricsWindowStart(now = new Date()): Date {
    const start = new Date(now);
    start.setMinutes(0, 0, 0);
    start.setHours(start.getHours() - 1);
    return start;
}

export async function loadMonitorRunMetrics(
    monitorId: number,
    windowStart = monitorRunMetricsWindowStart(),
): Promise<MonitorRunMetrics> {
    const rows = await db.$queryRaw<MonitorRunMetricsRow[]>`
        SELECT
            COALESCE(SUM(check_count), 0)::bigint            AS total_checks,
            COALESCE(SUM(successful_check_count), 0)::bigint AS success_count,
            COALESCE(SUM(failed_check_count), 0)::bigint     AS failed_count,
            CASE WHEN SUM(duration_sample_count) > 0
                 THEN SUM(duration_total_ms)::double precision
                      / SUM(duration_sample_count)::double precision
                 ELSE NULL END                               AS avg_duration_ms,
            (ARRAY_AGG(latest_error ORDER BY latest_error_at DESC)
                FILTER (WHERE latest_error IS NOT NULL))[1]  AS last_error,
            (ARRAY_AGG(latest_status_code ORDER BY latest_error_at DESC)
                FILTER (WHERE latest_error IS NOT NULL))[1]  AS last_status_code
        FROM monitor_run_hourly_stats
        WHERE monitor_id = ${monitorId}
          AND fetch_source = 'canonical'
          AND bucket_hour >= ${windowStart}
    `;

    const row = rows[0];
    return {
        totalChecks: Number(row?.total_checks ?? 0),
        successCount: Number(row?.success_count ?? 0),
        failedCount: Number(row?.failed_count ?? 0),
        avgDurationMs: row?.avg_duration_ms ?? null,
        lastError: row?.last_error ?? null,
        lastStatusCode: row?.last_status_code ?? null,
    };
}
