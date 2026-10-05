import "server-only";

import { db } from "@/lib/db";
import { checkoutDomain, type CheckoutTarget } from "@/lib/checkout";
import { loadCheckoutPreferences } from "@/lib/checkout-preferences.server";

export class CheckoutTargetError extends Error {
    constructor(
        message: string,
        readonly status: number,
    ) {
        super(message);
    }
}

export async function loadCheckoutTarget(
    userId: string,
    monitorId: number,
    itemId: number,
): Promise<CheckoutTarget> {
    const item = await db.items.findFirst({
        where: {
            id: BigInt(itemId),
            monitor_id: monitorId,
            monitors: { userId },
        },
        select: { seller_id: true, title: true, price: true },
    });
    if (!item)
        throw new CheckoutTargetError("Item not found in your monitors.", 404);
    const account = await db.vinted_sessions.findUnique({
        where: { userId },
        select: { vinted_user_id: true, vinted_name: true, domain: true },
    });
    if (!account)
        throw new CheckoutTargetError(
            "Link your Vinted account in Account before opening checkout.",
            409,
        );
    const domain = checkoutDomain(account.domain);
    const accountId = Number(account.vinted_user_id);
    const sellerId = Number(item.seller_id);
    if (!domain || !Number.isSafeInteger(accountId) || accountId <= 0)
        throw new CheckoutTargetError(
            "Reconnect your Vinted account to confirm its identity.",
            409,
        );
    if (!Number.isSafeInteger(sellerId) || sellerId <= 0)
        throw new CheckoutTargetError(
            "Seller information is not available yet. Open the item on Vinted.",
            409,
        );
    if (sellerId === accountId)
        throw new CheckoutTargetError("You cannot buy your own item.", 400);
    return {
        itemId,
        monitorId,
        sellerId,
        accountId,
        accountName: account.vinted_name,
        domain,
        itemUrl: `https://${domain}/items/${itemId}`,
        title: item.title || "Vinted item",
        price: item.price,
        preferences: await loadCheckoutPreferences(userId, accountId, domain),
    };
}
