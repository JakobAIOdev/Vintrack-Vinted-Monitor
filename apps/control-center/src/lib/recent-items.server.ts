import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { orderRowsByKeys, type RecentItemKey } from "@/lib/recent-items";

/**
 * Returns the keys of a member's newest visible items across all monitors.
 *
 * A plain `monitor_id IN (...) ORDER BY found_at DESC LIMIT n` makes
 * PostgreSQL fetch every stored item of every monitor and sort them, which is
 * tens of thousands of random reads on the large items table and took longer
 * than 15 seconds for members with busy monitors. The global top-n is always
 * contained in the union of each monitor's own top-n, so this walks the
 * (monitor_id, found_at) index backwards per monitor and merges at most
 * monitors * n rows. Banned sellers are filtered inside each monitor's scan so
 * the per-monitor limit still yields n visible rows.
 */
export async function getRecentVisibleItemKeys(
    userId: string,
    limit: number,
): Promise<RecentItemKey[]> {
    const take = Math.max(1, Math.floor(limit));
    return db.$queryRaw<RecentItemKey[]>(Prisma.sql`
        SELECT recent.id, recent.monitor_id
        FROM monitors m
        CROSS JOIN LATERAL (
            SELECT i.id, i.monitor_id, i.found_at
            FROM items i
            WHERE i.monitor_id = m.id
              AND (
                  i.seller_id IS NULL
                  OR NOT EXISTS (
                      SELECT 1
                      FROM seller_bans b
                      WHERE b."userId" = ${userId}
                        AND b.seller_id = i.seller_id
                  )
              )
            ORDER BY i.found_at DESC
            LIMIT ${take}
        ) recent
        WHERE m."userId" = ${userId}
        ORDER BY recent.found_at DESC
        LIMIT ${take}
    `);
}

/**
 * Loads full rows for keys from getRecentVisibleItemKeys and returns them in
 * the same newest-first order.
 */
export async function loadItemsInKeyOrder<
    Row extends { id: bigint; monitor_id: number },
>(
    keys: RecentItemKey[],
    load: (where: Prisma.itemsWhereInput) => Promise<Row[]>,
): Promise<Row[]> {
    if (keys.length === 0) return [];
    const rows = await load({
        OR: keys.map((key) => ({ id: key.id, monitor_id: key.monitor_id })),
    });
    return orderRowsByKeys(keys, rows);
}
