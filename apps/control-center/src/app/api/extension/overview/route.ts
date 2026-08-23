import {
    authenticateExtensionRequest,
    extensionJson,
    extensionOptions,
} from "@/lib/extension-auth.server";
import { getExtensionAccountStatus } from "@/lib/vinted-account.server";
import { getExtensionRecentFeed } from "@/lib/extension-feed.server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export function OPTIONS() {
    return extensionOptions();
}

export async function GET(request: Request) {
    const authentication = await authenticateExtensionRequest(request);
    if (!authentication.ok) return authentication.response;
    const { userId } = authentication.principal;

    try {
        const [account, monitors, priceWatchCount, recentFeed] =
            await Promise.all([
                getExtensionAccountStatus(userId),
                db.monitors.findMany({
                    where: { userId },
                    select: { id: true, name: true, status: true },
                    orderBy: { created_at: "desc" },
                }),
                db.price_watches.count({ where: { user_id: userId } }),
                getExtensionRecentFeed(userId, 6),
            ]);

        return extensionJson({
            account,
            monitors: {
                total: monitors.length,
                active: monitors.filter(
                    (monitor) => monitor.status === "active",
                ).length,
            },
            priceWatches: { total: priceWatchCount },
            recentFeed,
        });
    } catch {
        return extensionJson({ error: "Companion overview unavailable" }, 500);
    }
}
