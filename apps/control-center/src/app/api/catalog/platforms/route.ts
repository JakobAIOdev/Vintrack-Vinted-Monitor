import { auth } from "@/auth";
import { NextRequest, NextResponse } from "next/server";

const API_URL = process.env.VINTED_SERVICE_URL || "http://localhost:4000";

export async function GET(req: NextRequest) {
    const session = await auth();
    if (!session?.user?.id) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const search = req.nextUrl.searchParams.toString();
    const url = `${API_URL}/api/catalog/platforms${search ? `?${search}` : ""}`;

    try {
        const res = await fetch(url, {
            headers: {
                "Content-Type": "application/json",
                "X-User-ID": session.user.id,
            },
            cache: "no-store",
        });
        const data = await res.json();
        return NextResponse.json(data, { status: res.status });
    } catch {
        return NextResponse.json(
            { error: "Vinted service unreachable" },
            { status: 502 },
        );
    }
}
