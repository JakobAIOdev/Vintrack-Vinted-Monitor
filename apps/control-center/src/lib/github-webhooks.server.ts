import { createHmac, timingSafeEqual } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

/** After this long, an unfinished delivery is treated as abandoned. */
const STUCK_DELIVERY_MS = 15 * 60 * 1000;

export function verifyGithubWebhookSignature(
    rawBody: string,
    signature: string | null,
    secret: string | undefined,
) {
    if (!secret || !signature?.startsWith("sha256=")) return false;
    const expected = `sha256=${createHmac("sha256", secret)
        .update(rawBody, "utf8")
        .digest("hex")}`;
    const actualBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    return (
        actualBuffer.length === expectedBuffer.length &&
        timingSafeEqual(actualBuffer, expectedBuffer)
    );
}

export async function beginGithubWebhookDelivery(input: {
    deliveryId: string;
    event: string;
    action?: string | null;
}) {
    try {
        await db.github_webhook_deliveries.create({
            data: {
                delivery_id: input.deliveryId,
                event: input.event,
                action: input.action ?? null,
            },
        });
        return true;
    } catch (error) {
        if (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === "P2002"
        ) {
            const retry = await db.github_webhook_deliveries.updateMany({
                where: {
                    delivery_id: input.deliveryId,
                    OR: [
                        { status: "failed" },
                        // A crash mid-processing would otherwise leave the row
                        // stuck in "processing" forever, and every GitHub
                        // redelivery would be silently dropped as a duplicate.
                        {
                            status: "processing",
                            received_at: {
                                lt: new Date(Date.now() - STUCK_DELIVERY_MS),
                            },
                        },
                    ],
                },
                data: {
                    event: input.event,
                    action: input.action ?? null,
                    status: "processing",
                    error: null,
                    processed_at: null,
                },
            });
            return retry.count === 1;
        }
        throw error;
    }
}

export async function finishGithubWebhookDelivery(
    deliveryId: string,
    error?: unknown,
) {
    await db.github_webhook_deliveries.update({
        where: { delivery_id: deliveryId },
        data: {
            status: error ? "failed" : "processed",
            error:
                error instanceof Error
                    ? error.message.slice(0, 2000)
                    : error
                      ? String(error).slice(0, 2000)
                      : null,
            processed_at: new Date(),
        },
    });
}
