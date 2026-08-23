import {
    authenticateExtensionRequest,
    extensionJson,
    extensionOptions,
} from "@/lib/extension-auth.server";
import { serializePriceMinor } from "@/lib/price-watch";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export function OPTIONS() {
    return extensionOptions();
}

function readLimit(value: string | null) {
    const parsed = Number(value ?? 10);
    return Number.isInteger(parsed) ? Math.min(25, Math.max(1, parsed)) : 10;
}

function readCursor(value: string | null) {
    if (!value) return null;
    try {
        const parsed = BigInt(value);
        return parsed > BigInt(0) ? parsed : null;
    } catch {
        return null;
    }
}

export async function GET(request: Request) {
    const authentication = await authenticateExtensionRequest(request);
    if (!authentication.ok) return authentication.response;
    const url = new URL(request.url);
    const limit = readLimit(url.searchParams.get("limit"));
    const rawCursor = url.searchParams.get("cursor");
    const cursor = readCursor(rawCursor);
    if (rawCursor && !cursor) {
        return extensionJson({ error: "Invalid cursor" }, 400);
    }

    try {
        const records = await db.price_watches.findMany({
            where: {
                user_id: authentication.principal.userId,
                ...(cursor ? { id: { lt: cursor } } : {}),
            },
            orderBy: { id: "desc" },
            take: limit + 1,
            include: { target: true, schedule: true },
        });
        const hasMore = records.length > limit;
        const page = hasMore ? records.slice(0, limit) : records;
        return extensionJson({
            items: page.map((watch) => ({
                id: watch.id.toString(),
                status: watch.status,
                createdAt: watch.created_at.toISOString(),
                target: {
                    itemId: watch.target.item_id.toString(),
                    region: watch.target.region,
                    canonicalUrl: watch.target.canonical_url,
                    title: watch.target.title,
                    imageUrl: watch.target.image_url,
                    currentPriceMinor: serializePriceMinor(
                        watch.schedule.current_price_minor ??
                            watch.target.current_price_minor,
                    ),
                    currencyCode:
                        watch.schedule.currency_code ??
                        watch.target.currency_code,
                    availability: watch.schedule.availability,
                    lastCheckedAt:
                        watch.schedule.last_checked_at?.toISOString() ?? null,
                },
            })),
            nextCursor: hasMore
                ? (page[page.length - 1]?.id.toString() ?? null)
                : null,
        });
    } catch {
        return extensionJson({ error: "Price Watches unavailable" }, 500);
    }
}
