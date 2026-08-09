import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

type AlertOutboxClient = Prisma.TransactionClient | typeof db;

export type AlertNotificationKind =
    | "monitor_created"
    | "monitor_started"
    | "monitor_paused"
    | "monitor_auto_stopped"
    | "proxy_warning"
    | "free_proxy_limit_pause";

export type AlertOutboxMonitor = {
    id: number;
    userId: string;
    name: string;
    discord_webhook: string | null;
    webhook_active: boolean;
    telegram_active: boolean;
    notifications_enabled: boolean;
};

function destinationFingerprint(channel: string, destination: string) {
    return createHash("sha256")
        .update(`${channel.toLowerCase()}\0${destination.trim()}`)
        .digest("hex");
}

export async function enqueueMonitorStatusNotification(
    client: AlertOutboxClient,
    monitor: AlertOutboxMonitor,
    input: {
        kind: AlertNotificationKind;
        title: string;
        message: string;
        idempotencyKey: string;
        expiresAt?: Date;
    },
) {
    if (!monitor.notifications_enabled) return false;

    const deliveries: Prisma.alert_deliveriesCreateWithoutNotificationInput[] =
        [];
    if (monitor.webhook_active && monitor.discord_webhook) {
        deliveries.push({
            channel: "discord",
            destination_fingerprint: destinationFingerprint(
                "discord",
                monitor.discord_webhook,
            ),
        });
    }
    if (monitor.telegram_active) {
        const connection = await client.telegram_connections.findUnique({
            where: { userId: monitor.userId },
            select: { chat_id: true },
        });
        if (connection) {
            deliveries.push({
                channel: "telegram",
                destination_fingerprint: destinationFingerprint(
                    "telegram",
                    connection.chat_id,
                ),
            });
        }
    }
    if (deliveries.length === 0) return false;

    try {
        await client.alert_notifications.create({
            data: {
                user_id: monitor.userId,
                monitor_id: monitor.id,
                kind: input.kind,
                payload_version: 1,
                payload: {
                    version: 1,
                    kind: input.kind,
                    monitorName: monitor.name,
                    title: input.title,
                    message: input.message,
                },
                idempotency_key: input.idempotencyKey,
                expires_at:
                    input.expiresAt ?? new Date(Date.now() + 60 * 60 * 1000),
                deliveries: { create: deliveries },
                events: {
                    create: deliveries.map((delivery) => ({
                        userId: monitor.userId,
                        monitor_id: monitor.id,
                        channel: delivery.channel,
                        status: "queued",
                        notification_kind: input.kind,
                    })),
                },
            },
        });
        return true;
    } catch (error) {
        if (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === "P2002"
        ) {
            return false;
        }
        throw error;
    }
}

export async function cancelPendingMonitorNotifications(
    client: AlertOutboxClient,
    monitorId: number,
    channel?: "discord" | "telegram",
) {
    const channelFilter = channel
        ? Prisma.sql`AND delivery.channel = ${channel}`
        : Prisma.empty;
    await client.$executeRaw(Prisma.sql`
        WITH cancelled AS (
            UPDATE alert_deliveries delivery
            SET status = 'cancelled',
                last_reason_code = 'notifications_disabled',
                last_error_detail = 'notification target was disabled',
                completed_at = NOW(), lease_until = NULL, claim_token = NULL,
                updated_at = NOW()
            FROM alert_notifications notification
            WHERE notification.id = delivery.notification_id
              AND notification.monitor_id = ${monitorId}
              AND delivery.status IN ('pending', 'retrying')
              ${channelFilter}
            RETURNING delivery.id, delivery.notification_id, delivery.channel,
                delivery.attempt_count
        )
        INSERT INTO alert_events (
            "userId", monitor_id, item_id, notification_id, delivery_id,
            channel, status, notification_kind, reason_code, attempt_number,
            failure_reason
        )
        SELECT notification.user_id, notification.monitor_id,
            notification.item_id, notification.id, cancelled.id,
            cancelled.channel, 'cancelled', notification.kind,
            'notifications_disabled', NULLIF(cancelled.attempt_count, 0),
            'notification target was disabled'
        FROM cancelled
        JOIN alert_notifications notification
          ON notification.id = cancelled.notification_id
    `);
}
