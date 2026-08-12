import { NextResponse } from "next/server";
import { getInactiveMemberPolicyAdminState } from "@/actions/admin";

export const dynamic = "force-dynamic";

export async function GET() {
    try {
        const state = await getInactiveMemberPolicyAdminState();
        return NextResponse.json(state, {
            headers: { "Cache-Control": "no-store" },
        });
    } catch {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
}
