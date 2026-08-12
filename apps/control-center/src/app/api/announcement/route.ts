import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getMemberAnnouncement } from "@/lib/member-announcement.server";
import { getMonitorMaintenance } from "@/lib/monitor-maintenance.server";

export const dynamic = "force-dynamic";

export async function GET() {
    const session = await auth();
    if (!session?.user?.id) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const [announcement, maintenance] = await Promise.all([
        getMemberAnnouncement(),
        getMonitorMaintenance(),
    ]);
    return NextResponse.json(
        { announcement, maintenance },
        { headers: { "Cache-Control": "private, no-store, max-age=0" } },
    );
}
