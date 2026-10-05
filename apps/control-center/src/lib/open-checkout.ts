"use client";

import {
    checkoutApiPath,
    isCheckoutUrl,
    isPayPalPaymentUrl,
    checkoutPreferencesKey,
    type CheckoutTarget,
} from "@/lib/checkout";
import { runBrowserBuyViaExtension } from "@/lib/vintrack-extension";
import {
    CHECKOUT_RISK_WARNING_VERSION,
    CHECKOUT_CONSENT_REQUIRED,
} from "@/lib/checkout-consent";
import { requestCheckoutConsent } from "@/lib/checkout-consent.client";

const pending = new Map<string, Promise<string | undefined>>();

function hasCheckoutExtension() {
    return new Promise<number>((resolve) => {
        const timeout = window.setTimeout(() => finish(0), 750);
        function finish(version: number) {
            window.clearTimeout(timeout);
            window.removeEventListener("message", onMessage);
            resolve(version);
        }
        function onMessage(event: MessageEvent) {
            if (
                event.source === window &&
                event.origin === window.location.origin &&
                event.data?.type === "VINTRACK_EXTENSION_READY"
            )
                finish(
                    event.data.payload?.configured === true &&
                        Number.isSafeInteger(
                            event.data.payload?.checkoutPrepareVersion,
                        ) &&
                        event.data.payload.checkoutPrepareVersion >= 2
                        ? event.data.payload.checkoutPrepareVersion
                        : 0,
                );
        }
        window.addEventListener("message", onMessage);
        window.postMessage(
            { type: "VINTRACK_EXTENSION_PING" },
            window.location.origin,
        );
    });
}

export async function getCheckoutTarget(
    monitorId: number,
    itemId: number,
): Promise<CheckoutTarget> {
    const response = await fetch(checkoutApiPath(monitorId, itemId), {
        cache: "no-store",
    });
    const data = await response.json();
    // The server blocks old clients here too. Current clients may display the
    // read-only preview, but cannot prepare until the user accepts the warning.
    if (
        response.status === 403 &&
        data.code === CHECKOUT_CONSENT_REQUIRED &&
        data.target?.riskConsentVersion === null
    )
        return data.target;
    if (!response.ok)
        throw new Error(
            data.error ||
                (data.code === "FEATURE_UNAVAILABLE"
                    ? "Checkout is unavailable for your account."
                    : "Checkout could not be loaded."),
        );
    return data;
}

export function openItemCheckout(
    monitorId: number,
    itemId: number,
    loadedTarget?: CheckoutTarget,
) {
    const key = `${monitorId}:${itemId}`;
    const current = pending.get(key);
    if (current) return current;
    const promise = startCheckout(monitorId, itemId, loadedTarget).finally(() =>
        pending.delete(key),
    );
    pending.set(key, promise);
    return promise;
}

async function startCheckout(
    monitorId: number,
    itemId: number,
    loadedTarget?: CheckoutTarget,
) {
    let startedAt = performance.now();
    let authorizationMs = 0;
    let readinessMs = 0;
    const [initialTarget, extensionAvailable] = await Promise.all([
        loadedTarget ?? getCheckoutTarget(monitorId, itemId),
        hasCheckoutExtension(),
    ]);
    let target = initialTarget;
    if (target.riskConsentVersion !== CHECKOUT_RISK_WARNING_VERSION) {
        await requestCheckoutConsent(Boolean(target.preferences?.autoCheckout));
        // Fetch current saved choices after reading the warning. No Vinted
        // requests or payment claims may run while consent is pending.
        target = await getCheckoutTarget(monitorId, itemId);
        if (target.riskConsentVersion !== CHECKOUT_RISK_WARNING_VERSION)
            throw new Error(
                "Your checkout acceptance could not be verified. Checkout has not started.",
            );
        startedAt = performance.now();
    }
    if (extensionAvailable) {
        if (target.preferences?.autoCheckout && extensionAvailable < 5)
            throw new Error(
                "Update or reload the Vintrack extension to use auto-checkout (version 0.2.6 or later).",
            );
        if (target.preferences?.autoCheckout) {
            const readinessAt = performance.now();
            // Check the local receiver before consuming the shared payment
            // claim. This never runs a Vinted account or checkout request.
            const ready = await runBrowserBuyViaExtension(
                {
                    itemId: target.itemId,
                    sellerId: target.sellerId,
                    expectedAccountId: target.accountId,
                    domain: target.domain,
                    preferences: target.preferences,
                    readinessOnly: true,
                },
                25_000,
            );
            if (!ready?.ok || ready.ready !== true)
                throw new Error(
                    ready && !ready.ok
                        ? ready.error ||
                              "Reload Vinted before opening the buy link."
                        : "The Vinted tab did not become ready. Reload Vinted before opening the buy link.",
                );
            readinessMs = performance.now() - readinessAt;
            const authorizationAt = performance.now();
            const authorization = await fetch(
                checkoutApiPath(monitorId, itemId),
                {
                    method: "POST",
                    headers: {
                        "X-Vintrack-Checkout-Mode": "browser",
                        "X-Vintrack-Checkout-Account": `${target.accountId}@${target.domain}`,
                        "X-Vintrack-Checkout-Preferences":
                            checkoutPreferencesKey(target.preferences),
                    },
                },
            );
            const data = await authorization.json();
            if (!authorization.ok || data.browserPaymentAuthorized !== true)
                throw new Error(
                    data.error ||
                        "Auto-checkout could not be authorized. Check Vinted before trying again.",
                );
            authorizationMs = performance.now() - authorizationAt;
        }
        if (
            extensionAvailable < 3 &&
            target.preferences &&
            !["wallet", "paypal", "vinted"].includes(target.preferences.payment)
        )
            throw new Error(
                "Update or reload the Vintrack extension to use this payment method (version 0.2.4 or later).",
            );
        const result = await runBrowserBuyViaExtension(
            {
                itemId: target.itemId,
                sellerId: target.sellerId,
                expectedAccountId: target.accountId,
                domain: target.domain,
                itemUrl: target.itemUrl,
                preferences: target.preferences,
            },
            90_000,
        );
        // A timeout may mean Vinted accepted a mutation. Never fall back to a
        // second prepare flow after the extension was asked to start one.
        if (!result)
            throw new Error(
                "Checkout did not respond in time. Check the Vinted tab before trying again.",
            );
        if (!result.ok)
            throw new Error(
                result.code === "datadome_challenge"
                    ? "Complete Vinted's security check in the browser tab."
                    : result.error || "Browser checkout could not be prepared.",
            );
        if (!isCheckoutUrl(result.checkoutUrl, target.domain))
            throw new Error("Vinted did not return a valid checkout link.");
        if (
            result.paymentUrl &&
            (!target.preferences?.autoCheckout ||
                result.status !== "paypal_redirect_ready" ||
                !isPayPalPaymentUrl(result.paymentUrl))
        )
            throw new Error(
                "The payment destination could not be verified. Check Vinted before trying again.",
            );
        // Numeric timings only: no item/account IDs, URLs, tokens or responses.
        const timingKeys = [
            "tabReadyMs",
            "contextMs",
            "accountMs",
            "transactionMs",
            "buildMs",
            "updateMs",
            "contactMs",
            "paymentMs",
            "extensionMs",
        ];
        const timings = Object.fromEntries(
            timingKeys.flatMap((key) => {
                const value = result.timings?.[key];
                return typeof value === "number" &&
                    Number.isFinite(value) &&
                    value >= 0
                    ? [[key, Math.round(value)]]
                    : [];
            }),
        );
        console.info(
            "[vintrack:checkout-timing]",
            JSON.stringify({
                ...timings,
                readinessMs: Math.round(readinessMs),
                authorizationMs: Math.round(authorizationMs),
                handoffMs: Math.round(performance.now() - startedAt),
            }),
        );
        // History is best-effort; a slow history endpoint must not keep the
        // handoff displaying "Preparing" after the browser has opened checkout.
        void fetch("/api/items/checkout-links", {
            method: "POST",
            keepalive: true,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                item_id: itemId,
                seller_id: target.sellerId,
                transaction_id: result.transactionId || 0,
                purchase_id: result.purchaseId || "",
                checkout_url: result.checkoutUrl,
                status: result.status || "checkout_review_required",
            }),
        }).catch(() => {});
        return result.autoCheckoutReason;
    }
    const response = await fetch(checkoutApiPath(monitorId, itemId), {
        method: "POST",
    });
    const data = await response.json();
    if (!response.ok)
        throw new Error(data.error || "Checkout could not be prepared.");
    if (!isCheckoutUrl(data.checkoutUrl, target.domain))
        throw new Error("Vinted did not return a valid checkout link.");
    // Navigation in this tab also works in mobile browsers with popup blocking.
    if (
        data.paymentUrl &&
        target.preferences?.autoCheckout &&
        data.status === "paypal_redirect_ready" &&
        isPayPalPaymentUrl(data.paymentUrl)
    )
        window.location.assign(data.paymentUrl);
    else window.location.assign(data.checkoutUrl);
    return data.autoCheckoutReason as string | undefined;
}
