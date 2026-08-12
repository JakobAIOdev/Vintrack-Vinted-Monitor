import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getMonitorMaintenanceAdminState } from "@/actions/admin";

export const dynamic = "force-dynamic";

export async function GET() {
    const session = await auth();
    if (!session?.user?.id || session.user.role !== "admin") {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const state = await getMonitorMaintenanceAdminState();
    return NextResponse.json(state, {
        headers: { "Cache-Control": "private, no-store, max-age=0" },
    });
}
