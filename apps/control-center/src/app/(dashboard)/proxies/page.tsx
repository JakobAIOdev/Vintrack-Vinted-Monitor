import { auth } from "@/auth";
import type { ProxyCheckResult } from "@/actions/proxy-groups";
import { db } from "@/lib/db";
import { getFreeProxyPoolHealth } from "@/lib/free-proxy-health";
import { REGIONS } from "@/lib/regions";
import { redirect } from "next/navigation";
import { ProxiesClient } from "./client";

export default async function ProxiesPage() {
    const session = await auth();
    if (!session?.user?.id) redirect("/login");

    const [proxyGroups, user, freeProxyHealth] = await Promise.all([
        db.proxy_groups.findMany({
            where: { userId: session.user.id },
            orderBy: { created_at: "desc" },
            include: {
                _count: { select: { monitors: true } },
            },
        }),
        db.user.findUnique({
            where: { id: session.user.id },
            select: { role: true },
        }),
        getFreeProxyPoolHealth(),
    ]);

    const regionOrder = new Map(
        REGIONS.map((region, index) => [region.code, index]),
    );
    const freeProxyRegions = Object.values(freeProxyHealth.regions)
        .sort(
            (a, b) =>
                (regionOrder.get(a.region) ?? Number.MAX_SAFE_INTEGER) -
                (regionOrder.get(b.region) ?? Number.MAX_SAFE_INTEGER),
        )
        .map((region) => ({
            region: region.region,
            usable: region.usable,
            medianLatencyMs: region.medianLatencyMs,
            healthy: region.healthy,
        }));

    return (
        <ProxiesClient
            initialGroups={proxyGroups.map((g) => ({
                id: g.id,
                name: g.name,
                proxies: g.proxies,
                monitorCount: g._count.monitors,
                bandwidthRxBytes: g.bandwidth_rx_bytes.toString(),
                bandwidthTxBytes: g.bandwidth_tx_bytes.toString(),
                bandwidthLimitBytes:
                    g.bandwidth_limit_bytes?.toString() ?? null,
                bandwidthResetAt: g.bandwidth_reset_at?.toISOString() ?? null,
                proxyCheck: {
                    status: g.proxy_check_status,
                    region: g.proxy_check_region,
                    total: g.proxy_check_total,
                    checked: g.proxy_check_checked,
                    working: g.proxy_check_working,
                    slow: g.proxy_check_slow,
                    failed: g.proxy_check_failed,
                    results: (Array.isArray(g.proxy_check_results)
                        ? g.proxy_check_results
                        : []) as ProxyCheckResult[],
                    error: g.proxy_check_error,
                    requestedAt:
                        g.proxy_check_requested_at?.toISOString() ?? null,
                    startedAt:
                        g.proxy_check_started_at?.toISOString() ?? null,
                    completedAt:
                        g.proxy_check_completed_at?.toISOString() ?? null,
                },
                created_at: g.created_at?.toISOString() ?? "",
            }))}
            userRole={user?.role ?? "free"}
            freeProxyPool={{
                enabled: freeProxyHealth.enabled,
                minActivePerRegion: freeProxyHealth.minActivePerRegion,
                regions: freeProxyRegions,
            }}
        />
    );
}
