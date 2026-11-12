import { db } from "@/lib/db";
import {
    buildExtensionInlineIndex,
    INLINE_INDEX_FIND_LIMIT,
    INLINE_INDEX_FIND_WINDOW_MS,
    INLINE_INDEX_WATCH_LIMIT,
} from "@/lib/extension-inline-index";
import { describePriceWatchState } from "@/lib/price-watch-state";
import { getBannedSellerIds, visibleSellerWhere } from "@/lib/seller-bans";

export async function getExtensionInlineIndex(
    userId: string,
    access: { finds: boolean; watches: boolean },
) {
    const now = new Date();
    const [monitors, bannedSellerIds] = access.finds
        ? await Promise.all([
              db.monitors.findMany({
                  where: { userId },
                  select: { id: true, name: true },
              }),
              getBannedSellerIds(userId),
          ])
        : [[], []];

    const [finds, watches] = await Promise.all([
        monitors.length > 0
            ? db.items.findMany({
                  where: {
                      monitor_id: { in: monitors.map((monitor) => monitor.id) },
                      found_at: {
                          gte: new Date(
                              now.getTime() - INLINE_INDEX_FIND_WINDOW_MS,
                          ),
                      },
                      ...visibleSellerWhere(bannedSellerIds),
                  },
                  orderBy: { found_at: "desc" },
                  // Duplicates across monitors collapse afterwards, so read a
                  // little beyond the published limit.
                  take: INLINE_INDEX_FIND_LIMIT * 2,
                  select: { id: true, monitor_id: true, found_at: true },
              })
            : [],
        access.watches
            ? db.price_watches.findMany({
                  where: { user_id: userId },
                  orderBy: { id: "desc" },
                  take: INLINE_INDEX_WATCH_LIMIT,
                  select: {
                      id: true,
                      status: true,
                      stopped_reason: true,
                      armed_at: true,
                      initial_price_minor: true,
                      target: {
                          select: {
                              item_id: true,
                              region: true,
                              current_price_minor: true,
                              currency_code: true,
                          },
                      },
                      schedule: {
                          select: {
                              current_price_minor: true,
                              currency_code: true,
                              availability: true,
                              last_error_code: true,
                          },
                      },
                  },
              })
            : [],
    ]);

    return buildExtensionInlineIndex({
        monitors,
        finds,
        watches: watches.map((watch) => ({
            ...watch,
            state: describePriceWatchState({
                status: watch.status,
                stoppedReason: watch.stopped_reason,
                availability: watch.schedule.availability,
                lastErrorCode: watch.schedule.last_error_code,
                armed: watch.armed_at !== null,
            }),
        })),
        now,
    });
}
