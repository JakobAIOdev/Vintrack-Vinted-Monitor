"use client";

import {
    checkoutApiPath,
    isCheckoutUrl,
    isPayPalPaymentUrl,
    checkoutPreferencesKey,
    type CheckoutTarget,
} from "@/lib/checkout";
import { runBrowserBuyViaExtension } from "@/lib/vintrack-extension";

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
    const [target, extensionAvailable] = await Promise.all([
        loadedTarget ?? getCheckoutTarget(monitorId, itemId),
        hasCheckoutExtension(),
    ]);
    if (extensionAvailable) {
        if (target.preferences?.autoCheckout && extensionAvailable < 5)
            throw new Error(
                "Update or reload the Vintrack extension to use auto-checkout (version 0.2.6 or later).",
            );
        if (target.preferences?.autoCheckout) {
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
