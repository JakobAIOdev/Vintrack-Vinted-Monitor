import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { auth } from "@/auth";
import {
    buildSellerProfileUrl,
    getBannedSellerIds,
    visibleSellerWhere,
} from "@/lib/seller-bans";
import { normalizeLiveFeedItemCap } from "@/lib/live-feed";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
    const session = await auth();
    if (!session?.user?.id) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
        const itemCap = normalizeLiveFeedItemCap(
            new URL(request.url).searchParams.get("limit"),
        );
        const userMonitors = await db.monitors.findMany({
            where: { userId: session.user.id },
            select: { id: true },
        });

        const monitorIds = userMonitors.map((m) => m.id);

        if (monitorIds.length === 0) {
            return NextResponse.json([]);
        }

        const bannedSellerIds = await getBannedSellerIds(session.user.id);

        const items = await db.items.findMany({
            where: {
                monitor_id: { in: monitorIds },
                ...visibleSellerWhere(bannedSellerIds),
            },
            orderBy: { found_at: "desc" },
            take: itemCap,
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
                extra_images: true,
                found_at: true,
                location: true,
                rating: true,
                seller_id: true,
                seller_login: true,
                seller_profile_url: true,
                monitors: {
                    select: { name: true },
                },
            },
        });

        const safeItems = items.map(({ monitors, ...item }) => ({
            ...item,
            id: item.id.toString(),
            seller_id: item.seller_id?.toString() || null,
            seller_profile_url:
                item.seller_profile_url ||
                buildSellerProfileUrl(
                    item.seller_id,
                    item.seller_login,
                    item.url,
                ),
            monitor_name: monitors?.name || "Unknown",
        }));

        return NextResponse.json(safeItems);
    } catch (error) {
        console.error(error);
        return NextResponse.json(
            { error: "Internal Server Error" },
            { status: 500 },
        );
    }
}
