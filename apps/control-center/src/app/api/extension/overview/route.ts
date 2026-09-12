import {
    authenticateExtensionRequest,
    extensionJson,
    extensionOptions,
} from "@/lib/extension-auth.server";
import { getExtensionAccountStatus } from "@/lib/vinted-account.server";
import { getExtensionRecentFeed } from "@/lib/extension-feed.server";
import { db } from "@/lib/db";
import { getFeatureCapabilities } from "@/lib/features.server";

export const dynamic = "force-dynamic";

export function OPTIONS() {
    return extensionOptions();
}

export async function GET(request: Request) {
    const authentication = await authenticateExtensionRequest(request);
    if (!authentication.ok) return authentication.response;
    const { userId } = authentication.principal;

    try {
        const user = await db.user.findUnique({
            where: { id: userId },
            select: { role: true },
        });
        const capabilities = await getFeatureCapabilities(user?.role);
        const [account, monitors, priceWatchCount, recentFeed] =
            await Promise.all([
                capabilities.vinted_account.allowed
                    ? getExtensionAccountStatus(userId)
                    : null,
                db.monitors.findMany({
                    where: { userId },
                    select: { id: true, name: true, status: true },
                    orderBy: { created_at: "desc" },
                }),
                capabilities.price_watch.allowed
                    ? db.price_watches.count({ where: { user_id: userId } })
                    : 0,
                capabilities.live_feed.allowed
                    ? getExtensionRecentFeed(userId, 6)
                    : [],
            ]);

        return extensionJson({
            capabilities,
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
