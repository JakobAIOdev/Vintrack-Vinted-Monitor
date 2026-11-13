"use client";

import {
    checkoutApiPath,
    isCheckoutUrl,
    isPayPalPaymentUrl,
    isRequestCheckoutTransport,
    type CheckoutTarget,
} from "@/lib/checkout";
import {
    CHECKOUT_RISK_WARNING_VERSION,
    CHECKOUT_CONSENT_REQUIRED,
} from "@/lib/checkout-consent";
import { openBrowserCheckout } from "@/lib/open-browser-checkout";
import { requestCheckoutConsent } from "@/lib/checkout-consent.client";

export type CheckoutRunTone = "success" | "info" | "warning" | "error";

// Links are only ever set after isCheckoutUrl / isPayPalPaymentUrl passed.
export type CheckoutRunResult = {
    message?: string;
    status?: string;
    tone: CheckoutRunTone;
    checkoutUrl?: string;
    paymentUrl?: string;
    navigating?: boolean;
};

export type CheckoutRunOptions = {
    onTargetLoaded?: (target: CheckoutTarget) => void;
    validateOnly?: boolean;
    // Called once with the final result, before any automatic navigation.
    onResult?: (result: CheckoutRunResult) => void;
};

export class CheckoutRunError extends Error {
    readonly status?: number;
    readonly code?: string;
    readonly interrupted?: boolean;

    constructor(
        message: string,
        details: { status?: number; code?: string; interrupted?: boolean } = {},
    ) {
        super(message);
        this.name = "CheckoutRunError";
        this.status = details.status;
        this.code = details.code;
        this.interrupted = details.interrupted;
    }
}

const INTERRUPTED_MESSAGE =
    "The connection was interrupted while checkout was running. A purchase may already have been started; check Vinted before using this link again.";
const AGENT_RESULT_UNAVAILABLE =
    "Agent result unavailable. Check Vinted before continuing.";
const MAX_FAILED_JOB_POLLS = 5;

type PendingRun = {
    result: Promise<CheckoutRunResult>;
    message?: Promise<string | undefined>;
};
const pending = new Map<string, PendingRun>();

function pendingRun(
    monitorId: number,
    itemId: number,
    options: CheckoutRunOptions,
) {
    const key = `${monitorId}:${itemId}:${options.validateOnly ? "validate" : "checkout"}`;
    const current = pending.get(key);
    if (current) return current;
    const run: PendingRun = {
        result: startCheckout(monitorId, itemId, options).finally(() =>
            pending.delete(key),
        ),
    };
    pending.set(key, run);
    return run;
}

// Concurrent calls for the same item and mode share one request. Only the
// first caller's callbacks run; every caller receives the same result.
export function runItemCheckout(
    monitorId: number,
    itemId: number,
    options: CheckoutRunOptions = {},
) {
    return pendingRun(monitorId, itemId, options).result;
}

export function openItemCheckout(
    monitorId: number,
    itemId: number,
    onTargetLoaded?: (target: CheckoutTarget) => void,
    validateOnly = false,
) {
    const run = pendingRun(monitorId, itemId, { onTargetLoaded, validateOnly });
    return (run.message ??= run.result.then((result) => result.message));
}

// A lost connection or an unreadable body leaves the purchase state unknown.
// The request is never repeated here.
async function requestJson(url: string, init: RequestInit) {
    let response: Response;
    try {
        response = await fetch(url, init);
    } catch {
        throw new CheckoutRunError(INTERRUPTED_MESSAGE, { interrupted: true });
    }
    try {
        const data = await response.json();
        if (data && typeof data === "object" && !Array.isArray(data))
            return { response, data };
    } catch {}
    throw new CheckoutRunError(INTERRUPTED_MESSAGE, {
        status: response.status,
        interrupted: true,
    });
}

function resultTone(status: unknown): CheckoutRunTone {
    if (status === "card_payment_confirmed") return "success";
    if (
        status === "card_payment_failed" ||
        status === "payment_outcome_unknown"
    )
        return "error";
    if (status === "checkout_review_required" || status === "checkout_prepared")
        return "warning";
    return "info";
}

async function startCheckout(
    monitorId: number,
    itemId: number,
    options: CheckoutRunOptions,
): Promise<CheckoutRunResult> {
    const { onTargetLoaded, validateOnly = false } = options;
    const finish = (result: CheckoutRunResult) => {
        // A failing listener must not hide a finished checkout or stop the
        // handoff that follows it.
        try {
            options.onResult?.(result);
        } catch {}
        return result;
    };
    let startedAt = performance.now();
    const prepare = () =>
        requestJson(checkoutApiPath(monitorId, itemId), {
            method: "POST",
            cache: "no-store",
            ...(validateOnly
                ? { headers: { "X-Vintrack-Checkout-Mode": "validate" } }
                : {}),
            signal: AbortSignal.timeout(95_000),
        });
    let { response, data } = await prepare();
    if (data.target) onTargetLoaded?.(data.target);
    if (response.status === 403 && data.code === CHECKOUT_CONSENT_REQUIRED) {
        await requestCheckoutConsent(
            Boolean(data.target?.preferences?.autoCheckout),
        );
        // Consent is the only pre-mutation retry. The server reloads current
        // access, linked identity and saved preferences before preparing.
        startedAt = performance.now();
        ({ response, data } = await prepare());
        if (data.target) onTargetLoaded?.(data.target);
    }
    if (!response.ok) {
        const serverMessage =
            typeof data.error === "string" && data.error ? data.error : "";
        // A retryable failure keeps the server text: it already says that
        // nothing was started and the link can be used again.
        throw new CheckoutRunError(
            serverMessage ||
                (data.code === "FEATURE_UNAVAILABLE"
                    ? "Checkout is not available for your account on this instance."
                    : "Checkout could not be prepared. Check Vinted before trying again."),
            {
                status: response.status,
                code: typeof data.code === "string" ? data.code : undefined,
                interrupted: data.code === "checkout_interrupted",
            },
        );
    }
    const target: CheckoutTarget | undefined = data.target;
    if (data.status === "browser_checkout_required") {
        if (validateOnly)
            throw new Error(
                "Enable experimental server checkout in Account before testing it.",
            );
        if (
            !target ||
            target.itemId !== itemId ||
            target.monitorId !== monitorId ||
            target.riskConsentVersion !== CHECKOUT_RISK_WARNING_VERSION ||
            target.checkoutTransport !== "browser"
        )
            throw new Error(
                "Checkout settings could not be verified. Reload the buy link.",
            );
        return finish({
            message: await openBrowserCheckout(target),
            tone: "info",
        });
    }
    if (
        !isRequestCheckoutTransport(target?.checkoutTransport) ||
        !target?.preferences?.autoCheckout
    )
        throw new Error(
            "Request checkout requires Full checkout with automatic payment and a spending limit. Enable it in Account or choose the browser session method.",
        );
    if (data.status === "agent_queued") {
        if (
            !target ||
            target.checkoutTransport !== "agent" ||
            target.itemId !== itemId ||
            target.monitorId !== monitorId ||
            target.riskConsentVersion !== CHECKOUT_RISK_WARNING_VERSION ||
            !/^[a-f0-9]{64}$/.test(data.jobId || "")
        )
            throw new Error("Local agent checkout could not be verified.");
        const jobId = data.jobId;
        let completed = false;
        let failedPolls = 0;
        // A queued job may wait up to two minutes for the agent and then
        // needs time to run; give up reading only after both have passed.
        const deadline = performance.now() + 225_000;
        while (performance.now() < deadline) {
            // Polling only reads the job. A dropped poll is repeated; the
            // checkout itself is never submitted again.
            const poll = await requestJson(
                `/api/checkout-agent/jobs/${jobId}`,
                { cache: "no-store", signal: AbortSignal.timeout(15_000) },
            ).catch(() => null);
            if (
                !poll ||
                poll.response.status === 429 ||
                poll.response.status >= 500
            ) {
                if (++failedPolls >= MAX_FAILED_JOB_POLLS)
                    throw new CheckoutRunError(
                        (poll && typeof poll.data.error === "string"
                            ? poll.data.error
                            : "") || AGENT_RESULT_UNAVAILABLE,
                        { status: poll?.response.status, interrupted: !poll },
                    );
                await new Promise((resolve) => setTimeout(resolve, 750));
                continue;
            }
            failedPolls = 0;
            const job = poll.data;
            if (!poll.response.ok)
                throw new CheckoutRunError(
                    (typeof job.error === "string" ? job.error : "") ||
                        AGENT_RESULT_UNAVAILABLE,
                    { status: poll.response.status },
                );
            if (["expired", "interrupted"].includes(job.state))
                throw new Error(
                    "Agent checkout was interrupted. Check Vinted; this job will not be replayed.",
                );
            if (job.state === "complete") {
                if (!job.result?.checkout_url)
                    throw new Error(
                        job.result?.auto_checkout_reason ||
                            "Local checkout stopped. Check Account and Vinted before continuing.",
                    );
                data = {
                    target,
                    checkoutUrl: job.result.checkout_url,
                    paymentUrl: job.result.payment_url,
                    status: job.result.status,
                    autoCheckoutReason: job.result.auto_checkout_reason,
                    stoppedBeforePayment: job.stopped_before_payment === true,
                };
                completed = true;
                break;
            }
            await new Promise((resolve) => setTimeout(resolve, 750));
        }
        if (!completed)
            throw new Error(
                "The local agent has not returned a result yet. The job may still be running: check Vinted before doing anything else. Opening this link again shows its result and will not start another checkout.",
            );
    }
    if (
        !target ||
        target.itemId !== itemId ||
        target.monitorId !== monitorId ||
        target.riskConsentVersion !== CHECKOUT_RISK_WARNING_VERSION ||
        !isCheckoutUrl(data.checkoutUrl, target.domain)
    )
        throw new Error("Vinted did not return a valid checkout link.");
    if (
        data.paymentUrl &&
        (!target.preferences?.autoCheckout ||
            target.preferences.payment !== "paypal" ||
            data.status !== "paypal_redirect_ready" ||
            !isPayPalPaymentUrl(data.paymentUrl))
    )
        throw new Error(
            "The payment destination could not be verified. Check Vinted before trying again.",
        );
    const status: string | undefined =
        typeof data.status === "string" ? data.status : undefined;
    const reason: string | undefined =
        typeof data.autoCheckoutReason === "string" && data.autoCheckoutReason
            ? data.autoCheckoutReason
            : undefined;
    const checkoutUrl: string = data.checkoutUrl;
    const paymentUrl: string | undefined = data.paymentUrl || undefined;
    const requestOutcomes: Record<string, string> = {
        card_payment_confirmed:
            "Vinted confirmed your card payment. Check your order; do not pay again.",
        card_payment_pending:
            "Your card payment is processing. Check Vinted; do not pay again.",
        card_payment_failed:
            "Vinted reported a failed card payment. No automatic retry will run.",
        payment_outcome_unknown:
            "The payment outcome is unknown. Check Vinted before trying again.",
    };
    const outcome =
        status && Object.hasOwn(requestOutcomes, status)
            ? reason || requestOutcomes[status]
            : undefined;
    if (validateOnly) {
        if (data.stoppedBeforePayment !== true)
            throw new Error(
                "The server did not confirm a stop before payment. Check Vinted before continuing.",
            );
        // A test never hands out a payment or checkout link.
        if (outcome)
            return finish({
                message: `No new payment request was sent. ${outcome}`,
                status,
                tone: resultTone(status),
            });
        return finish({
            message: `Test finished before payment. ${
                status === "payment_ready"
                    ? "Your saved payment and order total were verified."
                    : "Review the checkout in Vinted; payment readiness was not confirmed."
            }`,
            status,
            tone: status === "payment_ready" ? "info" : "warning",
        });
    }
    // The service owns preparation, payment claims, checkpoints and history.
    // Never dispatch extension checkout or retry an uncertain HTTP mutation.
    console.info(
        "[vintrack:checkout-timing]",
        JSON.stringify({
            transport:
                target.checkoutTransport === "agent"
                    ? "local_agent"
                    : "service",
            handoffMs: Math.round(performance.now() - startedAt),
        }),
    );
    if (outcome)
        return finish({ message: outcome, status, tone: resultTone(status) });
    if (
        status !== "paypal_redirect_ready" &&
        status !== "card_authentication_required"
    )
        return finish({
            message:
                reason ||
                "Full checkout stopped before payment because the saved payment, delivery or total could not be verified. Check your settings and Vinted before continuing.",
            status,
            tone: "warning",
            ...(status === "checkout_review_required" ||
            status === "checkout_prepared"
                ? { checkoutUrl }
                : {}),
        });
    const result = finish({
        message:
            reason ||
            (paymentUrl
                ? "Continue in PayPal to complete the payment."
                : "Continue in Vinted to complete this checkout."),
        status,
        tone: resultTone(status),
        ...(paymentUrl ? { paymentUrl } : { checkoutUrl }),
        navigating: true,
    });
    // Same-tab navigation also works for notification handoffs without a
    // second gesture or a popup exception. No Vinted tab is needed beforehand.
    window.location.assign(paymentUrl || checkoutUrl);
    return result;
}
