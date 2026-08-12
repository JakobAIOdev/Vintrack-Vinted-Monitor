import Redis from "ioredis";

const redisUrl = () => process.env.REDIS_URL || "redis://localhost:6379";

/**
 * Shared command client.
 *
 * Route handlers used to construct and quit a client per request. At a few
 * hundred dashboards polling every ten seconds that is a continuous stream of
 * Redis connection setups and teardowns for what are single-digit-millisecond
 * commands.
 */
const globalForRedis = globalThis as unknown as {
    vintrackRedis?: Redis;
    vintrackRedisSubscriber?: SharedSubscriber;
};

export function redisClient(): Redis {
    if (!globalForRedis.vintrackRedis) {
        globalForRedis.vintrackRedis = new Redis(redisUrl(), {
            maxRetriesPerRequest: 2,
            lazyConnect: false,
        });
        globalForRedis.vintrackRedis.on("error", (error) => {
            console.error("Redis client error:", error);
        });
    }
    return globalForRedis.vintrackRedis;
}

type ChannelHandler = (message: string) => void;

/**
 * Shared pub/sub connection.
 *
 * A Redis connection in subscriber mode cannot issue normal commands, so it has
 * to be separate from the command client. It is still one connection for the
 * whole process rather than one per open dashboard: subscriptions are
 * reference-counted, so the same channel opened by several tabs costs a single
 * SUBSCRIBE.
 */
class SharedSubscriber {
    private client: Redis | null = null;
    private handlers = new Map<string, Set<ChannelHandler>>();

    private connection(): Redis {
        if (!this.client) {
            const client = new Redis(redisUrl(), { maxRetriesPerRequest: null });
            client.on("error", (error) => {
                console.error("Redis subscriber error:", error);
            });
            client.on("message", (channel: string, message: string) => {
                const channelHandlers = this.handlers.get(channel);
                if (!channelHandlers) return;
                for (const handler of channelHandlers) {
                    try {
                        handler(message);
                    } catch (error) {
                        console.error("Redis message handler error:", error);
                    }
                }
            });
            this.client = client;
        }
        return this.client;
    }

    /** Returns an unsubscribe function. */
    subscribe(channel: string, handler: ChannelHandler): () => void {
        const client = this.connection();
        let channelHandlers = this.handlers.get(channel);
        if (!channelHandlers) {
            channelHandlers = new Set();
            this.handlers.set(channel, channelHandlers);
            client.subscribe(channel).catch((error) => {
                console.error(`Redis subscribe to ${channel} failed:`, error);
            });
        }
        channelHandlers.add(handler);

        let released = false;
        return () => {
            if (released) return;
            released = true;
            const current = this.handlers.get(channel);
            if (!current) return;
            current.delete(handler);
            if (current.size === 0) {
                this.handlers.delete(channel);
                client.unsubscribe(channel).catch((error) => {
                    console.error(
                        `Redis unsubscribe from ${channel} failed:`,
                        error,
                    );
                });
            }
        };
    }
}

export function redisSubscriber(): SharedSubscriber {
    if (!globalForRedis.vintrackRedisSubscriber) {
        globalForRedis.vintrackRedisSubscriber = new SharedSubscriber();
    }
    return globalForRedis.vintrackRedisSubscriber;
}

/** Channel carrying live item matches for one member. */
export function userItemChannel(userId: string): string {
    return `vinted:new_items:${userId}`;
}
