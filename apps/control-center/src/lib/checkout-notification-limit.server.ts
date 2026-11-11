import "server-only";

import { redisClient } from "@/lib/redis";

const WINDOW_SECONDS = 3600;
const MAX_BROWSER_REPORTS_PER_WINDOW = 12;

/**
 * Bounds how many checkout notifications one member's browser can trigger.
 *
 * A browser-reported checkout outcome is the member's own claim: the server
 * cannot check it against Vinted. Each distinct purchase id produces a new
 * message in the operator's webhook, so without a cap a single member could
 * fill that channel. Real use stays far below this limit.
 */
export async function allowBrowserCheckoutNotification(
    userId: string,
): Promise<boolean> {
    try {
        const key = `checkout:browser-notifications:${userId}`;
        const count = await redisClient().incr(key);
        if (count === 1) await redisClient().expire(key, WINDOW_SECONDS);
        return count <= MAX_BROWSER_REPORTS_PER_WINDOW;
    } catch (error) {
        // Losing a genuine purchase notification during a Redis outage is
        // worse than the cap being unavailable for its duration.
        console.error(
            "[checkout-notifications] Rate limit unavailable:",
            error instanceof Error ? error.message : "unknown error",
        );
        return true;
    }
}
