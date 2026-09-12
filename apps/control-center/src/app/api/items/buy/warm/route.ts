import { guardApiFeature } from "@/lib/features.server";
import { auth } from "@/auth";
import { NextResponse } from "next/server";

const API_URL = process.env.VINTED_SERVICE_URL || "http://localhost:4000";

export async function POST() {
    const session = await auth();
    if (!session?.user?.id) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const featureDenied = await guardApiFeature(
        session.user.id,
        "checkout_links",
    );
    if (featureDenied) return featureDenied;

    try {
        const res = await fetch(`${API_URL}/api/items/buy/warm`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-User-ID": session.user.id,
            },
            cache: "no-store",
        });

        const text = await res.text();
        let data;
        try {
            data = JSON.parse(text);
        } catch {
            data = { error: text || "An unknown error occurred" };
        }

        return NextResponse.json(data, { status: res.status });
    } catch {
        return NextResponse.json(
            { error: "Vinted service unreachable" },
            { status: 502 },
        );
    }
}
