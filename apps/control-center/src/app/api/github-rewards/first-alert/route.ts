import { NextResponse } from "next/server";
import { auth } from "@/auth";
import {
    claimFirstAlertStarPrompt,
    recordFirstAlertStarAction,
} from "@/lib/first-alert-star.server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
    const session = await auth();
    if (!session?.user?.id) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const origin = request.headers.get("origin");
    if (origin && origin !== new URL(process.env.AUTH_URL || request.url).origin) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const body = await request.json().catch(() => null);
    if (body?.action === "dismissed" || body?.action === "cta") {
        await recordFirstAlertStarAction(session.user.id, body.action);
        return NextResponse.json({ ok: true });
    }
    if (body?.action !== "claim") {
        return NextResponse.json({ error: "Invalid action" }, { status: 400 });
    }
    return NextResponse.json(await claimFirstAlertStarPrompt(session.user.id), {
        headers: { "Cache-Control": "no-store" },
    });
}
