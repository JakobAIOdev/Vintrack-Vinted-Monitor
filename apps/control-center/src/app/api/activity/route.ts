import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { acquireGlobalMonitorActivationLock } from "@/lib/monitor-limits";
import { touchDashboardActivity } from "@/lib/dashboard-activity";

export const dynamic = "force-dynamic";

export async function POST() {
    const session = await auth();
    if (!session?.user?.id) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const userId = session.user.id;
    await db.$transaction(async (tx) => {
        await acquireGlobalMonitorActivationLock(tx);
        await touchDashboardActivity(tx, userId);
    });
    return NextResponse.json(
        { ok: true },
        { headers: { "Cache-Control": "no-store" } },
    );
}
