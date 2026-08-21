import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getEffectivePriceWatchLimit } from "@/lib/monitor-limits";
import { getTelegramConnection } from "@/lib/telegram-connection";
import { serializePriceMinor } from "@/lib/price-watch";
import { PriceWatchesClient, type PriceWatchView } from "./client";

export const dynamic = "force-dynamic";

export default async function PriceWatchesPage({
    searchParams,
}: {
    searchParams: Promise<{ watch?: string }>;
}) {
    const session = await auth();
    if (!session?.user?.id) redirect("/login");
    const userId = session.user.id;
    const focusedWatchId = (await searchParams).watch ?? null;

    const [records, telegramConnection, limits, activeCount, proxyGroups] =
        await Promise.all([
            db.price_watches.findMany({
                where: { user_id: userId },
                orderBy: { created_at: "desc" },
                include: {
                    target: true,
                    schedule: {
                        include: {
                            proxy_group: { select: { id: true, name: true } },
                            events: {
                                orderBy: { observed_at: "desc" },
                                take: 5,
                            },
                        },
                    },
                },
            }),
            getTelegramConnection(userId),
            getEffectivePriceWatchLimit(userId),
            db.price_watches.count({
                where: { user_id: userId, status: "active" },
            }),
            db.proxy_groups.findMany({
                where: { userId },
                orderBy: { name: "asc" },
                select: {
                    id: true,
                    name: true,
                    proxy_check_status: true,
                    proxy_check_region: true,
                    proxy_check_working: true,
                    bandwidth_limit_bytes: true,
                    bandwidth_rx_bytes: true,
                    bandwidth_tx_bytes: true,
                },
            }),
        ]);

    const watches: PriceWatchView[] = records.map((watch) => ({
        id: watch.id.toString(),
        status: watch.status,
        notificationsEnabled: watch.notifications_enabled,
        discordWebhook: watch.discord_webhook ?? "",
        webhookActive: watch.webhook_active,
        telegramActive: watch.telegram_active,
        initialPriceMinor: serializePriceMinor(watch.initial_price_minor),
        armedAt: watch.armed_at?.toISOString() ?? null,
        stoppedReason: watch.stopped_reason,
        createdAt: watch.created_at.toISOString(),
        pollIntervalSeconds: watch.poll_interval_seconds,
        transportKind: watch.schedule.transport_kind,
        proxyGroupId: watch.schedule.proxy_group_id,
        proxyGroupName: watch.schedule.proxy_group?.name ?? null,
        target: {
            region: watch.target.region,
            itemId: watch.target.item_id.toString(),
            canonicalUrl: watch.target.canonical_url,
            title: watch.target.title,
            imageUrl: watch.target.image_url,
            currentPriceMinor: serializePriceMinor(
                watch.schedule.current_price_minor ??
                    watch.target.current_price_minor,
            ),
            currencyCode:
                watch.schedule.currency_code ?? watch.target.currency_code,
            availability: watch.schedule.availability,
            lastCheckedAt:
                watch.schedule.last_checked_at?.toISOString() ?? null,
            nextCheckAt: watch.schedule.next_check_at.toISOString(),
            lastErrorCode: watch.schedule.last_error_code,
            events: watch.schedule.events.map((event) => ({
                id: event.id.toString(),
                previousPriceMinor: event.previous_price_minor.toString(),
                newPriceMinor: event.new_price_minor.toString(),
                currencyCode: event.currency_code,
                observedAt: event.observed_at.toISOString(),
            })),
        },
    }));

    return (
        <PriceWatchesClient
            initialWatches={watches}
            hasTelegramConnection={Boolean(telegramConnection)}
            activeCount={activeCount}
            activeLimit={limits.priceWatchLimit}
            activeLimitSource={limits.priceWatchLimitSource}
            focusedWatchId={focusedWatchId}
            proxyGroups={proxyGroups.map((group) => ({
                id: group.id,
                name: group.name,
                checkStatus: group.proxy_check_status,
                checkRegion: group.proxy_check_region,
                working: group.proxy_check_working,
                bandwidthReached:
                    group.bandwidth_limit_bytes !== null &&
                    group.bandwidth_rx_bytes + group.bandwidth_tx_bytes >=
                        group.bandwidth_limit_bytes,
            }))}
        />
    );
}
