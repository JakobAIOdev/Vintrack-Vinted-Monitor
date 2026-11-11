import { guardApiFeature } from "@/lib/features.server";
import { auth } from "@/auth";
import { NextRequest, NextResponse } from "next/server";

const API_URL = process.env.VINTED_SERVICE_URL || "http://localhost:4000";

export async function GET(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> },
) {
    const session = await auth();
    if (!session?.user?.id) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const featureDenied = await guardApiFeature(session.user.id, "chats");
    if (featureDenied) return featureDenied;

    const { id } = await params;
    // The id becomes a path segment of an internal request. Next decodes the
    // dynamic segment, so anything but digits could address another route.
    if (!/^\d{1,20}$/.test(id)) {
        return NextResponse.json(
            { error: "Invalid conversation id" },
            { status: 400 },
        );
    }
    const search = req.nextUrl.searchParams.toString();
    const url = `${API_URL}/api/messages/conversations/${id}${search ? `?${search}` : ""}`;

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
