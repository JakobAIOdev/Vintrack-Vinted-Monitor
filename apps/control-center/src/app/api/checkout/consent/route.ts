import { auth } from "@/auth";
import { db } from "@/lib/db";
import { guardApiFeature } from "@/lib/features.server";
import { CHECKOUT_RISK_WARNING_VERSION } from "@/lib/checkout-consent";
import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
    const session = await auth();
    if (!session?.user?.id)
        return NextResponse.json(
            { error: "Sign in to Vintrack." },
            { status: 401 },
        );
    if (
        request.headers.get("sec-fetch-site") === "cross-site" ||
        (request.headers.get("origin") &&
            request.headers.get("origin") !==
                new URL(process.env.AUTH_URL || request.nextUrl.origin).origin)
    )
        return NextResponse.json(
            { error: "Invalid checkout origin." },
            { status: 403 },
        );
    const denied = await guardApiFeature(session.user.id, "checkout_links");
    if (denied) return denied;
    const input = await request.json().catch(() => null);
    if (
        !input ||
        input.accepted !== true ||
        input.version !== CHECKOUT_RISK_WARNING_VERSION ||
        Object.keys(input).some(
            (key) => key !== "accepted" && key !== "version",
        )
    )
        return NextResponse.json(
            {
                error: "Explicit acceptance of the current checkout warning is required.",
            },
            { status: 400 },
        );
    try {
        await db.user.update({
            where: { id: session.user.id },
            data: {
                checkout_risk_version: CHECKOUT_RISK_WARNING_VERSION,
                checkout_risk_accepted_at: new Date(),
            },
        });
        return NextResponse.json(
            { accepted: true, version: CHECKOUT_RISK_WARNING_VERSION },
            { headers: { "Cache-Control": "private, no-store" } },
        );
    } catch {
        return NextResponse.json(
            {
                error: "Your acceptance could not be saved. Checkout has not started.",
            },
            { status: 503 },
        );
    }
}
