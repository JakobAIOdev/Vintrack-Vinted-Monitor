import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { redisSubscriber, userItemChannel } from "@/lib/redis";
import { buildSellerProfileUrl, getBannedSellerIds } from "@/lib/seller-bans";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
    const session = await auth();
    if (!session?.user?.id) {
        return new NextResponse("Unauthorized", { status: 401 });
    }
    const userId = session.user.id;

    const userMonitors = await db.monitors.findMany({
        where: { userId },
        select: { id: true, name: true },
    });
    const monitorNames = new Map(
        userMonitors.map((monitor) => [monitor.id, monitor.name]),
    );
    const bannedSellerIds = new Set(
        (await getBannedSellerIds(userId)).map((id) => id.toString()),
    );

    const encoder = new TextEncoder();
    const stream = new TransformStream();
    const writer = stream.writable.getWriter();

    // The worker publishes to a per-member channel, so everything arriving here
    // already belongs to this member and no ownership filtering is needed. The
    // subscription itself is shared process-wide rather than opening a Redis
    // connection per browser tab.
    const unsubscribe = redisSubscriber().subscribe(
        userItemChannel(userId),
        (message) => {
            try {
                const parsed = JSON.parse(message);
                const monitorId = Number(parsed.monitor_id);
                const sellerId =
                    parsed.seller_id === null || parsed.seller_id === undefined
                        ? null
                        : String(parsed.seller_id);

                if (sellerId && bannedSellerIds.has(sellerId)) {
                    return;
                }

                const enrichedPayload = JSON.stringify({
                    ...parsed,
                    monitor_id: monitorId,
                    monitor_name:
                        monitorNames.get(monitorId) ||
                        parsed.monitor_name ||
                        null,
                    seller_profile_url:
                        parsed.seller_profile_url ||
                        buildSellerProfileUrl(
                            sellerId,
                            parsed.seller_login,
                            parsed.url,
                        ),
                });
                void writer.write(encoder.encode(`data: ${enrichedPayload}\n\n`));
            } catch {
                // Skip malformed messages
            }
        },
    );

    req.signal.addEventListener("abort", () => {
        unsubscribe();
        void writer.close().catch(() => {});
    });

    return new NextResponse(stream.readable, {
        headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
        },
    });
}
