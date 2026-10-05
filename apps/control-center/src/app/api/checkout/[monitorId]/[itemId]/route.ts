import { auth } from "@/auth";
import { guardApiFeature } from "@/lib/features.server";
import { CheckoutTargetError, loadCheckoutTarget } from "@/lib/checkout.server";
import { isCheckoutUrl, parseCheckoutIds } from "@/lib/checkout";
import { NextRequest, NextResponse } from "next/server";

const API_URL = process.env.VINTED_SERVICE_URL || "http://localhost:4000";
type Context = { params: Promise<{ monitorId: string; itemId: string }> };

async function handle(
    request: NextRequest,
    context: Context,
    prepare: boolean,
) {
    const session = await auth();
    if (!session?.user?.id)
        return NextResponse.json(
            { error: "Sign in to Vintrack to open checkout." },
            { status: 401 },
        );
    if (
        prepare &&
        (request.headers.get("sec-fetch-site") === "cross-site" ||
            (request.headers.get("origin") &&
                request.headers.get("origin") !==
                    new URL(process.env.AUTH_URL || request.nextUrl.origin)
                        .origin))
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
    const params = await context.params;
    const ids = parseCheckoutIds(params.monitorId, params.itemId);
    if (!ids)
        return NextResponse.json(
            { error: "Invalid item or monitor." },
            { status: 400 },
        );
    try {
        const target = await loadCheckoutTarget(
            session.user.id,
            ids.monitorId,
            ids.itemId,
        );
        // GET is read-only, including link previews and Next.js prefetches.
        if (!prepare)
            return NextResponse.json(target, {
                headers: { "Cache-Control": "private, no-store" },
            });
        const response = await fetch(`${API_URL}/api/items/checkout/prepare`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-User-ID": session.user.id,
            },
            body: JSON.stringify({
                item_id: target.itemId,
                seller_id: target.sellerId,
                account_id: target.accountId,
                domain: target.domain,
            }),
            cache: "no-store",
            signal: AbortSignal.timeout(90_000),
        });
        const data = await response.json().catch(() => null);
        if (!response.ok)
            return NextResponse.json(
                {
                    error: data?.error || "Vinted could not prepare checkout.",
                    code: data?.code,
                },
                { status: response.status },
            );
        if (!isCheckoutUrl(data?.checkout_url, target.domain))
            return NextResponse.json(
                { error: "Vinted did not return a valid checkout link." },
                { status: 502 },
            );
        return NextResponse.json(
            { checkoutUrl: data.checkout_url, status: data.status },
            { headers: { "Cache-Control": "private, no-store" } },
        );
    } catch (error) {
        return NextResponse.json(
            {
                error:
                    error instanceof CheckoutTargetError
                        ? error.message
                        : "Checkout could not be prepared. Open Vinted to continue; avoid repeatedly starting checkout.",
            },
            {
                status:
                    error instanceof CheckoutTargetError ? error.status : 502,
            },
        );
    }
}

export function GET(request: NextRequest, context: Context) {
    return handle(request, context, false);
}
export function POST(request: NextRequest, context: Context) {
    return handle(request, context, true);
}
