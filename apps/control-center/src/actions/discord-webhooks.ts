"use server";

import { auth } from "@/auth";
import { db } from "@/lib/db";

export async function getSavedDiscordWebhooks() {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");

    const webhooks = await db.discord_webhooks.findMany({
        where: { userId: session.user.id },
        select: { id: true, name: true, url: true },
        orderBy: [{ updated_at: "desc" }, { id: "desc" }],
    });

    return webhooks.map((webhook) => ({
        ...webhook,
        // Identify destinations without displaying their secret token in the list.
        webhookId: new URL(webhook.url).pathname.split("/")[3],
    }));
}
