import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

type AlertEventRow = {
    id: bigint;
    monitor_id: number | null;
    monitor_name: string | null;
    item_id: bigint | null;
    channel: string;
    status: string;
    failure_reason: string | null;
    created_at: Date;
    notification_kind: string;
    attempt_count: number;
    reason_code: string | null;
    completed_at: Date | null;
};

export async function GET() {
    const session = await auth();
    if (!session?.user?.id) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const rows = await db.$queryRaw<AlertEventRow[]>`
        SELECT
            delivery.id,
            notification.monitor_id,
            m.name AS monitor_name,
            notification.item_id,
            delivery.channel,
            delivery.status,
            delivery.last_error_detail AS failure_reason,
            delivery.created_at,
            notification.kind AS notification_kind,
            delivery.attempt_count,
            delivery.last_reason_code AS reason_code,
            delivery.completed_at
        FROM alert_deliveries delivery
        JOIN alert_notifications notification
          ON notification.id = delivery.notification_id
        LEFT JOIN monitors m ON m.id = notification.monitor_id
        WHERE notification.user_id = ${session.user.id}
        ORDER BY delivery.created_at DESC, delivery.id DESC
        LIMIT 100
    `;

    return NextResponse.json({
        alerts: rows.map((row) => ({
            id: row.id.toString(),
            monitorId: row.monitor_id,
            monitorName: row.monitor_name,
            itemId: row.item_id?.toString() ?? null,
            channel: row.channel,
            status: row.status,
            failureReason: row.failure_reason,
            createdAt: row.created_at.toISOString(),
            kind: row.notification_kind,
            attempts: row.attempt_count,
            reasonCode: row.reason_code,
            completedAt: row.completed_at?.toISOString() ?? null,
        })),
    });
}
