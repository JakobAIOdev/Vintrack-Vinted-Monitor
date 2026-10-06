import { auth } from "@/auth";
import { guardApiFeature } from "@/lib/features.server";
import { CheckoutTargetError, loadCheckoutTarget } from "@/lib/checkout.server";
import {
    isCheckoutUrl,
    isPayPalPaymentUrl,
    checkoutPreferencesKey,
    parseCheckoutIds,
} from "@/lib/checkout";
import { NextRequest, NextResponse } from "next/server";
import {
    CHECKOUT_RISK_WARNING_VERSION,
    CHECKOUT_CONSENT_REQUIRED,
} from "@/lib/checkout-consent";

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
        if (
            prepare &&
            target.riskConsentVersion !== CHECKOUT_RISK_WARNING_VERSION
        )
            return NextResponse.json(
                {
                    code: CHECKOUT_CONSENT_REQUIRED,
                    error: "Accept the checkout risk warning before using checkout.",
                },
                { status: 403 },
            );
        const browserPrepareOnly =
            prepare &&
            request.headers.get("x-vintrack-checkout-mode") === "browser";
        if (browserPrepareOnly && !target.preferences?.autoCheckout)
            return NextResponse.json(
                { error: "Auto-checkout is not enabled." },
                { status: 400 },
            );
        if (
            browserPrepareOnly &&
            (request.headers.get("x-vintrack-checkout-account") !==
                `${target.accountId}@${target.domain}` ||
                request.headers.get("x-vintrack-checkout-preferences") !==
                    checkoutPreferencesKey(target.preferences!))
        )
            return NextResponse.json(
                {
                    error: "Checkout preferences or linked account changed. Reload the buy link.",
                },
                { status: 409 },
            );
        // GET is read-only, including link previews and Next.js prefetches.
        if (!prepare)
            return NextResponse.json(
                target.riskConsentVersion === CHECKOUT_RISK_WARNING_VERSION
                    ? target
                    : {
                          code: CHECKOUT_CONSENT_REQUIRED,
                          error: "Accept the checkout risk warning before using checkout.",
                          target,
                      },
                {
                    status:
                        target.riskConsentVersion ===
                        CHECKOUT_RISK_WARNING_VERSION
                            ? 200
                            : 403,
                    headers: { "Cache-Control": "private, no-store" },
                },
            );
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
                preferences: target.preferences,
                ...(browserPrepareOnly ? { browser_prepare_only: true } : {}),
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
        if (browserPrepareOnly)
            return NextResponse.json(
                {
                    browserPaymentAuthorized:
                        data?.browser_payment_authorized === true,
                },
                { headers: { "Cache-Control": "private, no-store" } },
            );
        if (!isCheckoutUrl(data?.checkout_url, target.domain))
            return NextResponse.json(
                { error: "Vinted did not return a valid checkout link." },
                { status: 502 },
            );
        return NextResponse.json(
            {
                checkoutUrl: data.checkout_url,
                status: data.status,
                autoCheckoutReason: data.auto_checkout_reason,
                ...(target.preferences?.autoCheckout &&
                target.preferences.payment === "paypal" &&
                data.status === "paypal_redirect_ready" &&
                isPayPalPaymentUrl(data.payment_url)
                    ? { paymentUrl: data.payment_url }
                    : {}),
            },
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
