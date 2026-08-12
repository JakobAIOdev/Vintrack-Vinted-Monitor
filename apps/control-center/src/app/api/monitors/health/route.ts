import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { redisClient } from "@/lib/redis";

export const dynamic = "force-dynamic";

export type MonitorHealth = {
    monitor_id: number;
    total_checks: number;
    total_errors: number;
    consecutive_errors: number;
    last_error?: string;
    last_error_code?: string;
    proxy_state?: string;
    retry_at?: string;
    proxy_label?: string;
    updated_at: string;
};

export async function GET() {
    const session = await auth();
    if (!session?.user?.id) {
        return new NextResponse("Unauthorized", { status: 401 });
    }

    const userMonitors = await db.monitors.findMany({
        where: { userId: session.user.id, status: "active" },
        select: { id: true },
    });

    if (userMonitors.length === 0) {
        return NextResponse.json({});
    }

    // This endpoint is polled every few seconds by every open dashboard, so it
    // uses the shared client rather than opening and quitting a connection per
    // request.
    const pipe = redisClient().pipeline();
    for (const m of userMonitors) {
        pipe.get(`monitor:health:${m.id}`);
    }
    const results = await pipe.exec();

    const health: Record<number, MonitorHealth> = {};
    if (results) {
        for (let i = 0; i < userMonitors.length; i++) {
            const [err, val] = results[i];
            if (!err && val && typeof val === "string") {
                try {
                    health[userMonitors[i].id] = JSON.parse(val);
                } catch {}
            }
        }
    }

    return NextResponse.json(health);
}
