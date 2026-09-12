import { guardApiFeature } from "@/lib/features.server";
import { auth } from "@/auth";
import { NextRequest, NextResponse } from "next/server";

const API_URL = process.env.VINTED_SERVICE_URL || "http://localhost:4000";

export async function GET(req: NextRequest) {
    const session = await auth();
    if (!session?.user?.id) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const featureDenied = await guardApiFeature(
        session.user.id,
        "vinted_account",
    );
    if (featureDenied) return featureDenied;

    const code = req.nextUrl.searchParams.get("code");
    if (!code) {
        return NextResponse.json(
            { error: "Code is required" },
            { status: 400 },
        );
    }

    try {
        const res = await fetch(
            `${API_URL}/api/account/browser-sync/status?code=${encodeURIComponent(code)}`,
            {
                headers: {
                    "Content-Type": "application/json",
                    "X-User-ID": session.user.id,
                },
                cache: "no-store",
            },
        );
        const data = await res.json();
        return NextResponse.json(data, { status: res.status });
    } catch {
        return NextResponse.json(
            { error: "Vinted service unreachable" },
            { status: 502 },
        );
    }
}
