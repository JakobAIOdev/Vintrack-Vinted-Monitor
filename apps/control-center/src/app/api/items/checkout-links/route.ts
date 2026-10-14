import { guardApiFeature } from "@/lib/features.server";
import { auth } from "@/auth";
import { guardCheckoutConsent } from "@/lib/checkout-consent.server";
import { NextRequest, NextResponse } from "next/server";
import { logAuditEvent } from "@/lib/audit";
import { queueCheckoutNotification } from "@/lib/checkout-notifications.server";

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
    const consentDenied = await guardCheckoutConsent(session.user.id);
    if (consentDenied) return consentDenied;

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
    const origin = req.headers.get("origin");
    if (
        req.headers.get("sec-fetch-site") === "cross-site" ||
        (origin && origin !== new URL(process.env.AUTH_URL || req.url).origin)
    ) {
        return NextResponse.json(
            { error: "Invalid checkout origin." },
            { status: 403 },
        );
    }

    const featureDenied = await guardApiFeature(
        session.user.id,
        "checkout_links",
    );
    if (featureDenied) return featureDenied;
    const consentDenied = await guardCheckoutConsent(session.user.id);
    if (consentDenied) return consentDenied;

    try {
        const body = await req.text();
        const parsed = JSON.parse(body || "{}") as {
            item_id?: unknown;
            seller_id?: unknown;
            status?: unknown;
            transaction_id?: unknown;
            purchase_id?: unknown;
            monitor_id?: unknown;
            checkout_url?: unknown;
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
        if (res.ok)
            await queueCheckoutNotification({
                userId: session.user.id,
                itemId: parsed.item_id,
                transactionId: parsed.transaction_id,
                purchaseId: parsed.purchase_id,
                status: parsed.status,
                browserReported: true,
                checkoutUrl: parsed.checkout_url,
                monitorId:
                    Number.isSafeInteger(parsed.monitor_id) &&
                    Number(parsed.monitor_id) > 0
                        ? Number(parsed.monitor_id)
                        : undefined,
            });
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
