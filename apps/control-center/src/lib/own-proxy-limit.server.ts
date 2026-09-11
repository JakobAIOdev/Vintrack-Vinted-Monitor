import { db } from "@/lib/db";
import type { MonitorLimitClient } from "@/lib/monitor-limit-scopes";
import {
    OWN_PROXY_LIMIT_SETTING_KEY,
    parseOwnProxyLimit,
} from "@/lib/own-proxy-limit";

export async function getOwnProxyLimit(client: MonitorLimitClient = db) {
    const setting = await client.app_settings.findUnique({
        where: { key: OWN_PROXY_LIMIT_SETTING_KEY },
        select: { value: true },
    });
    return parseOwnProxyLimit(setting?.value);
}
