import { auth } from "@/auth";
import { guardApiFeature } from "@/lib/features.server";
import { CheckoutTargetError, loadCheckoutTarget } from "@/lib/checkout.server";
import { queueCheckoutNotification } from "@/lib/checkout-notifications.server";
import {
    isCheckoutUrl,
    isPayPalPaymentUrl,
    checkoutPreferencesKey,
    parseCheckoutIds,
    isRequestCheckoutTransport,
} from "@/lib/checkout";
import { after, NextRequest, NextResponse } from "next/server";
import {
    CHECKOUT_RISK_WARNING_VERSION,
    CHECKOUT_CONSENT_REQUIRED,
} from "@/lib/checkout-consent";

const API_URL = process.env.VINTED_SERVICE_URL || "http://localhost:4000";
type Context = { params: Promise<{ monitorId: string; itemId: string }> };

// Checkout answers belong to one member at one moment: none may be cached.
const NO_STORE = "private, no-store";
function json(body: unknown, status = 200) {
    return NextResponse.json(body, {
        status,
        headers: { "Cache-Control": NO_STORE },
    });
}

async function handle(
    request: NextRequest,
    context: Context,
    prepare: boolean,
) {
    const session = await auth();
    if (!session?.user?.id)
        return json({ error: "Sign in to Vintrack to open checkout." }, 401);
    const userId = session.user.id;
    if (
        prepare &&
        (request.headers.get("sec-fetch-site") === "cross-site" ||
            (request.headers.get("origin") &&
                request.headers.get("origin") !==
                    new URL(process.env.AUTH_URL || request.nextUrl.origin)
                        .origin))
    ) {
        return json({ error: "Invalid checkout origin." }, 403);
    }
    const featureDenied = await guardApiFeature(userId, "checkout_links");
    if (featureDenied) {
        if (!featureDenied.headers.has("Cache-Control"))
            featureDenied.headers.set("Cache-Control", NO_STORE);
        return featureDenied;
    }
    const params = await context.params;
    const ids = parseCheckoutIds(params.monitorId, params.itemId);
    if (!ids) return json({ error: "Invalid item or monitor." }, 400);
    try {
        const target = await loadCheckoutTarget(
            userId,
            ids.monitorId,
            ids.itemId,
        );
        if (
            prepare &&
            target.riskConsentVersion !== CHECKOUT_RISK_WARNING_VERSION
        )
            return json(
                {
                    code: CHECKOUT_CONSENT_REQUIRED,
                    target,
                    error: "Accept the checkout risk warning before using checkout.",
                },
                403,
            );
        const checkoutMode = request.headers.get("x-vintrack-checkout-mode");
        if (
            prepare &&
            checkoutMode &&
            !["server", "browser", "validate"].includes(checkoutMode)
        )
            return json({ error: "Invalid checkout mode." }, 400);
        const browserPrepareOnly = prepare && checkoutMode === "browser";
        const stopBeforePayment = prepare && checkoutMode === "validate";
        if (browserPrepareOnly && !target.preferences?.autoCheckout)
            return json({ error: "Auto-checkout is not enabled." }, 400);
        if (
            browserPrepareOnly &&
            (request.headers.get("x-vintrack-checkout-account") !==
                `${target.accountId}@${target.domain}` ||
                request.headers.get("x-vintrack-checkout-preferences") !==
                    checkoutPreferencesKey(target.preferences!))
        )
            return json(
                {
                    error: "Checkout preferences or linked account changed. Reload the buy link.",
                },
                409,
            );
        // GET is read-only, including link previews and Next.js prefetches.
        if (!prepare)
            return target.riskConsentVersion === CHECKOUT_RISK_WARNING_VERSION
                ? json(target)
                : json(
                      {
                          code: CHECKOUT_CONSENT_REQUIRED,
                          error: "Accept the checkout risk warning before using checkout.",
                          target,
                      },
                      403,
                  );
        if (
            !browserPrepareOnly &&
            isRequestCheckoutTransport(target.checkoutTransport) &&
            !target.preferences?.autoCheckout
        )
            return json(
                {
                    target,
                    code: "FULL_CHECKOUT_REQUIRED",
                    error: "Request checkout is available only as Full checkout. Enable automatic payment with an explicit spending limit in Account, or select the browser session method for normal Oneclick.",
                },
                409,
            );
        if (!browserPrepareOnly && target.checkoutTransport === "agent") {
            if (checkoutMode === "server")
                return json(
                    { error: "This account uses its local agent." },
                    409,
                );
            const response = await fetch(
                `${API_URL}/api/items/checkout/agent`,
                {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "X-User-ID": userId,
                    },
                    body: JSON.stringify({
                        item_id: target.itemId,
                        monitor_id: target.monitorId,
                        seller_id: target.sellerId,
                        account_id: target.accountId,
                        domain: target.domain,
                        preferences: target.preferences,
                        stop_before_payment: stopBeforePayment,
                    }),
                    cache: "no-store",
                    signal: AbortSignal.timeout(15_000),
                },
            );
            const job = await response.json().catch(() => null);
            if (!response.ok)
                return json(
                    {
                        target,
                        error:
                            job?.error || "Local checkout agent unavailable.",
                        code: job?.code,
                    },
                    response.status,
                );
            if (!/^[a-f0-9]{64}$/.test(job?.job_id || ""))
                return json({ error: "Invalid agent job response." }, 502);
            return json(
                { target, status: "agent_queued", jobId: job.job_id },
                202,
            );
        }
        if (!browserPrepareOnly && target.checkoutTransport !== "server") {
            if (checkoutMode === "server" || stopBeforePayment)
                return json(
                    {
                        code: "SERVER_CHECKOUT_DISABLED",
                        error: "Enable experimental server checkout in Account first.",
                    },
                    403,
                );
            // This response only selects the saved browser transport. No
            // upstream request or payment authorization has happened yet.
            return json({ target, status: "browser_checkout_required" });
        }
        let response: Response;
        try {
            response = await fetch(`${API_URL}/api/items/checkout/prepare`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-User-ID": userId,
                },
                body: JSON.stringify({
                    item_id: target.itemId,
                    seller_id: target.sellerId,
                    account_id: target.accountId,
                    domain: target.domain,
                    preferences: target.preferences,
                    ...(browserPrepareOnly
                        ? { browser_prepare_only: true }
                        : {}),
                    ...(stopBeforePayment ? { stop_before_payment: true } : {}),
                }),
                cache: "no-store",
                signal: AbortSignal.timeout(90_000),
            });
        } catch {
            // The service may have been working on this checkout when the
            // call was lost. Never report that as a plain failure.
            return json(
                {
                    target,
                    code: "checkout_interrupted",
                    error: "The connection to the checkout service was interrupted while checkout was running. A purchase may already have been started; check Vinted before using this link again.",
                },
                502,
            );
        }
        const data = await response.json().catch(() => null);
        if (!response.ok)
            return json(
                {
                    target,
                    error: data?.error || "Vinted could not prepare checkout.",
                    code: data?.code,
                    failedStep: [
                        "transaction",
                        "build",
                        "update",
                        "payment",
                        "unknown",
                    ].includes(data?.failed_step)
                        ? data.failed_step
                        : undefined,
                    upstreamStatus:
                        Number.isInteger(data?.upstream_status) &&
                        data.upstream_status >= 400 &&
                        data.upstream_status <= 599
                            ? data.upstream_status
                            : undefined,
                    // Only the service may say that nothing was started and
                    // the buy link can be used again.
                    ...(data?.retryable === true ? { retryable: true } : {}),
                },
                // 401 from this route means "not signed in to Vintrack". A
                // Vinted session the service reports as rejected is a
                // different condition and keeps its own code.
                response.status === 401 ? 409 : response.status,
            );
        if (browserPrepareOnly)
            return json({
                browserPaymentAuthorized:
                    data?.browser_payment_authorized === true,
            });
        if (!isCheckoutUrl(data?.checkout_url, target.domain))
            return json(
                { error: "Vinted did not return a valid checkout link." },
                502,
            );
        if (!stopBeforePayment)
            after(() =>
                queueCheckoutNotification({
                    userId,
                    itemId: target.itemId,
                    monitorId: target.monitorId,
                    transactionId: data.transaction_id,
                    purchaseId: data.purchase_id,
                    status: data.status,
                    domain: target.domain,
                    method: target.preferences?.autoCheckout
                        ? "full_checkout"
                        : "oneclick",
                    payment: target.preferences?.payment,
                }),
            );
        return json({
            target,
            checkoutUrl: data.checkout_url,
            status: data.status,
            autoCheckoutReason: data.auto_checkout_reason,
            ...(stopBeforePayment ? { stoppedBeforePayment: true } : {}),
            ...(!stopBeforePayment &&
            target.preferences?.autoCheckout &&
            target.preferences.payment === "paypal" &&
            data.status === "paypal_redirect_ready" &&
            isPayPalPaymentUrl(data.payment_url)
                ? { paymentUrl: data.payment_url }
                : {}),
        });
    } catch (error) {
        return json(
            {
                error:
                    error instanceof CheckoutTargetError
                        ? error.message
                        : "Checkout could not be prepared. Open Vinted to continue; avoid repeatedly starting checkout.",
            },
            error instanceof CheckoutTargetError ? error.status : 502,
        );
    }
}

export function GET(request: NextRequest, context: Context) {
    return handle(request, context, false);
}
export function POST(request: NextRequest, context: Context) {
    return handle(request, context, true);
}
