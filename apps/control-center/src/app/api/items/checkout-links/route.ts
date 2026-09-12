import { guardApiFeature } from "@/lib/features.server";
import { auth } from "@/auth";
import { NextRequest, NextResponse } from "next/server";
import { logAuditEvent } from "@/lib/audit";

const API_URL = process.env.VINTED_SERVICE_URL || "http://localhost:4000";

export async function GET() {
    const session = await auth();
    if (!session?.user?.id) {
        return NextResponse.json({ links: [] });
    }

    const featureDenied = await guardApiFeature(
        session.user.id,
        "checkout_links",
    );
    if (featureDenied) return featureDenied;

    try {
        const res = await fetch(`${API_URL}/api/items/checkout-links`, {
            headers: { "X-User-ID": session.user.id },
            cache: "no-store",
        });
        const data = await res.json();
        return NextResponse.json(data, { status: res.status });
    } catch {
        return NextResponse.json({ links: [] });
    }
}

export async function POST(req: NextRequest) {
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
        const body = await req.text();
        const parsed = JSON.parse(body || "{}") as {
            item_id?: unknown;
            seller_id?: unknown;
            status?: unknown;
        };
        const res = await fetch(`${API_URL}/api/items/checkout-links`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-User-ID": session.user.id,
            },
            body,
            cache: "no-store",
        });

        const data = await res.json().catch(() => ({}));
        await logAuditEvent({
            userId: session.user.id,
            action: "checkout_link.store",
            targetType: "item",
            targetId:
                typeof parsed.item_id === "number" ||
                typeof parsed.item_id === "string"
                    ? parsed.item_id
                    : null,
            status: res.ok ? "success" : "failed",
            metadata: {
                http_status: res.status,
                seller_id: parsed.seller_id ?? null,
                checkout_status: parsed.status ?? null,
            },
        });
        return NextResponse.json(data, { status: res.status });
    } catch {
        await logAuditEvent({
            userId: session.user.id,
            action: "checkout_link.store",
            targetType: "item",
            status: "failed",
            metadata: { error: "vinted_service_unreachable" },
        });
        return NextResponse.json(
            { error: "Vinted service unreachable" },
            { status: 502 },
        );
    }
}
