import "server-only";

import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { isValidDiscordWebhook } from "@/lib/validation";

// Keep saved destinations independent of the monitor or Price Watch that used them.
export async function rememberDiscordWebhook(
    tx: Pick<Prisma.TransactionClient, "discord_webhooks">,
    userId: string,
    rawUrl: string | null,
    name: string,
) {
    const url = rawUrl?.trim();
    if (!url || !isValidDiscordWebhook(url)) return;

    const urlHash = createHash("sha256").update(url).digest("hex");
    await tx.discord_webhooks.upsert({
        where: { userId_url_hash: { userId, url_hash: urlHash } },
        create: {
            userId,
            name: name.trim().slice(0, 255) || "Discord webhook",
            url,
            url_hash: urlHash,
        },
        // Preserve the original label when this destination is reused.
        update: { updated_at: new Date() },
    });
}
