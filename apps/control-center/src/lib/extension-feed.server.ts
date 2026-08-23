import { db } from "@/lib/db";
import {
    buildSellerProfileUrl,
    getBannedSellerIds,
    visibleSellerWhere,
} from "@/lib/seller-bans";

export async function getExtensionRecentFeed(userId: string, limit = 6) {
    const [monitors, bannedSellerIds] = await Promise.all([
        db.monitors.findMany({
            where: { userId },
            select: { id: true },
        }),
        getBannedSellerIds(userId),
    ]);
    const monitorIds = monitors.map((monitor) => monitor.id);
    if (monitorIds.length === 0) return [];

    const items = await db.items.findMany({
        where: {
            monitor_id: { in: monitorIds },
            ...visibleSellerWhere(bannedSellerIds),
        },
        orderBy: { found_at: "desc" },
        take: Math.min(12, Math.max(1, limit)),
        select: {
            id: true,
            title: true,
            brand: true,
            price: true,
            total_price: true,
            size: true,
            condition: true,
            url: true,
            image_url: true,
            found_at: true,
            seller_id: true,
            seller_login: true,
            seller_profile_url: true,
            monitors: { select: { id: true, name: true } },
        },
    });

    return items.map(({ monitors: monitor, ...item }) => ({
        ...item,
        id: item.id.toString(),
        seller_id: item.seller_id?.toString() ?? null,
        seller_profile_url:
            item.seller_profile_url ||
            buildSellerProfileUrl(item.seller_id, item.seller_login, item.url),
        found_at: item.found_at?.toISOString() ?? null,
        monitor_id: monitor.id,
        monitor_name: monitor.name,
    }));
}
