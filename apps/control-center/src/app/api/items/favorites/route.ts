import { guardApiFeature } from "@/lib/features.server";
import { auth } from "@/auth";
import { NextResponse } from "next/server";

const API_URL = process.env.VINTED_SERVICE_URL || "http://localhost:4000";

export async function GET(request: Request) {
    const session = await auth();
    if (!session?.user?.id) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const featureDenied = await guardApiFeature(session.user.id, "liked_items");
    if (featureDenied) return featureDenied;

    const { searchParams } = new URL(request.url);
    const page = searchParams.get("page") || "";

    try {
        const res = await fetch(`${API_URL}/api/items/favorites?page=${page}`, {
            headers: { "X-User-ID": session.user.id },
            cache: "no-store",
        });

        if (!res.ok) {
            const errData = await res.json().catch(() => ({}));
            return NextResponse.json(
                errData || { error: "Failed to fetch favorites" },
                { status: res.status },
            );
        }

        const data = await res.json();
        return NextResponse.json(data);
    } catch (error) {
        console.error("[api/items/favorites] Error proxying request:", error);
        return NextResponse.json(
            { error: "Internal Server Error" },
            { status: 500 },
        );
    }
}
