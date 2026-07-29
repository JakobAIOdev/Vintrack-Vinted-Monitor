import { db } from "@/lib/db";

const DEFAULT_STARTER_REGIONS = "de,fr,it,es,nl,be,at";

export type FreeProxyRegionHealth = {
    region: string;
    active: number;
    reserve: number;
    warming: number;
    usable: number;
    pending: number;
    cooldown: number;
    dead: number;
    successRate: number | null;
    medianLatencyMs: number | null;
    lastCheckedAt: Date | null;
    healthy: boolean;
    state: "ready" | "building" | "recovering" | "disabled";
    neverChecked: number;
    topErrorCode: string | null;
};

export type FreeProxyPoolHealth = {
    enabled: boolean;
    state: "ready" | "building" | "recovering" | "disabled";
    minActivePerRegion: number;
    regions: Record<string, FreeProxyRegionHealth>;
    activeCount: number;
};

type FreeProxyHealthRow = {
    region: string;
    active_count: bigint;
    reserve_count: bigint;
    warming_count: bigint;
    pending_count: bigint;
    cooldown_count: bigint;
    dead_count: bigint;
    recent_success_count: bigint;
    recent_check_count: bigint;
    median_latency_ms: number | null;
    last_checked_at: Date | null;
    never_checked_count: bigint;
    top_error_code: string | null;
};

export async function getFreeProxyPoolHealth(): Promise<FreeProxyPoolHealth> {
    if (
        process.env.E2E_TEST_MODE === "true" &&
        process.env.E2E_ONBOARDING === "true"
    ) {
        const now = new Date();
        return {
            enabled: true,
            state: "ready",
            minActivePerRegion: 1,
            activeCount: 1,
            regions: {
                de: {
                    region: "de",
                    active: 1,
                    reserve: 0,
                    warming: 0,
                    usable: 1,
                    pending: 0,
                    cooldown: 0,
                    dead: 0,
                    successRate: 100,
                    medianLatencyMs: 120,
                    lastCheckedAt: now,
                    healthy: true,
                    state: "ready",
                    neverChecked: 0,
                    topErrorCode: null,
                },
            },
        };
    }

    const [setting, minActiveSetting, starterRegionsSetting, rows] =
        await Promise.all([
            db.app_settings.findUnique({
                where: { key: "free_proxy_enabled" },
                select: { value: true },
            }),
            db.app_settings.findUnique({
                where: { key: "free_proxy_min_active_per_region" },
                select: { value: true },
            }),
            db.app_settings.findUnique({
                where: { key: "free_proxy_starter_regions" },
                select: { value: true },
            }),
            db.$queryRaw<FreeProxyHealthRow[]>`
            SELECT
                region,
                COUNT(*) FILTER (
                    WHERE status = 'active'
                      AND last_success_at >= NOW() - INTERVAL '20 minutes'
                )::bigint AS active_count,
                COUNT(*) FILTER (
                    WHERE status = 'active'
                      AND failure_streak <= 2
                      AND last_success_at >= NOW() - INTERVAL '90 minutes'
                      AND last_success_at < NOW() - INTERVAL '20 minutes'
                )::bigint AS reserve_count,
                COUNT(*) FILTER (
                    WHERE status = 'pending'
                      AND success_streak > 0
                      AND last_success_at >= NOW() - INTERVAL '20 minutes'
                )::bigint AS warming_count,
                COUNT(*) FILTER (
                    WHERE status = 'pending'
                      AND (
                        success_streak = 0
                        OR last_success_at IS NULL
                        OR last_success_at < NOW() - INTERVAL '20 minutes'
                      )
                )::bigint AS pending_count,
                COUNT(*) FILTER (
                    WHERE status = 'cooldown'
                       OR (
                        status = 'active'
                        AND (
                            last_success_at IS NULL
                            OR last_success_at < NOW() - INTERVAL '90 minutes'
                            OR (
                                failure_streak > 2
                                AND last_success_at < NOW() - INTERVAL '20 minutes'
                            )
                        )
                      )
                )::bigint AS cooldown_count,
                COUNT(*) FILTER (WHERE status = 'dead')::bigint AS dead_count,
                COUNT(*) FILTER (
                    WHERE last_checked_at >= NOW() - INTERVAL '24 hours'
                      AND last_status_code = 200
                      AND last_error IS NULL
                )::bigint AS recent_success_count,
                COUNT(*) FILTER (
                    WHERE last_checked_at >= NOW() - INTERVAL '24 hours'
                )::bigint AS recent_check_count,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms)
                    FILTER (
                        WHERE latency_ms IS NOT NULL
                          AND last_status_code = 200
                          AND last_error IS NULL
                    ) AS median_latency_ms,
                MAX(last_checked_at) AS last_checked_at
                ,
                COUNT(*) FILTER (
                    WHERE last_checked_at IS NULL
                )::bigint AS never_checked_count,
                mode() WITHIN GROUP (ORDER BY last_error_code)
                    FILTER (WHERE last_error_code IS NOT NULL) AS top_error_code
            FROM free_proxy_health
            GROUP BY region
        `,
        ]);

    const minActivePerRegion = Number(minActiveSetting?.value ?? 25);
    const configuredRegions = (
        starterRegionsSetting?.value ?? DEFAULT_STARTER_REGIONS
    )
        .split(",")
        .map((region) => region.trim().toLowerCase())
        .filter(Boolean);
    const rowsByRegion = new Map(rows.map((row) => [row.region, row]));
    const regions = Object.fromEntries(
        configuredRegions.map((region) => {
            const row = rowsByRegion.get(region);
            if (!row) {
                const emptyHealth: FreeProxyRegionHealth = {
                    region,
                    active: 0,
                    reserve: 0,
                    warming: 0,
                    usable: 0,
                    pending: 0,
                    cooldown: 0,
                    dead: 0,
                    successRate: null,
                    medianLatencyMs: null,
                    lastCheckedAt: null,
                    healthy: false,
                    state: setting?.value === "true" ? "building" : "disabled",
                    neverChecked: 0,
                    topErrorCode: null,
                };
                return [region, emptyHealth];
            }

            const active = Number(row.active_count);
            const reserve = Number(row.reserve_count);
            const warming = Number(row.warming_count);
            const usable = active + reserve + warming;
            const recentSuccessCount = Number(row.recent_success_count);
            const recentCheckCount = Number(row.recent_check_count);
            const health: FreeProxyRegionHealth = {
                region: row.region,
                active,
                reserve,
                warming,
                usable,
                pending: Number(row.pending_count),
                cooldown: Number(row.cooldown_count),
                dead: Number(row.dead_count),
                successRate:
                    recentCheckCount > 0
                        ? Math.round(
                              (recentSuccessCount / recentCheckCount) * 100,
                          )
                        : null,
                medianLatencyMs:
                    row.median_latency_ms === null
                        ? null
                        : Math.round(row.median_latency_ms),
                lastCheckedAt: row.last_checked_at,
                healthy: usable >= minActivePerRegion,
                state:
                    setting?.value !== "true"
                        ? "disabled"
                        : usable >= minActivePerRegion
                          ? "ready"
                          : row.last_checked_at === null
                            ? "building"
                            : "recovering",
                neverChecked: Number(row.never_checked_count),
                topErrorCode: row.top_error_code,
            };
            return [region, health];
        }),
    );

    const enabled = setting?.value === "true";
    const regionValues = Object.values(regions);
    const state: FreeProxyPoolHealth["state"] = !enabled
        ? "disabled"
        : regionValues.some((region) => region.state === "ready")
          ? "ready"
          : regionValues.every((region) => region.state === "building")
            ? "building"
            : "recovering";

    return {
        enabled,
        state,
        minActivePerRegion,
        regions,
        activeCount: regions.de?.usable ?? 0,
    };
}
