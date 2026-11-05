import { db } from "@/lib/db";
import { buildSellerProfileUrl } from "@/lib/seller-bans";
import {
    getRecentVisibleItemKeys,
    loadItemsInKeyOrder,
} from "@/lib/recent-items.server";

export async function getExtensionRecentFeed(userId: string, limit = 6) {
    const keys = await getRecentVisibleItemKeys(
        userId,
        Math.min(12, Math.max(1, limit)),
    );
    const items = await loadItemsInKeyOrder(keys, (where) =>
        db.items.findMany({
            where,
            select: {
                id: true,
                monitor_id: true,
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
        }),
    );

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
