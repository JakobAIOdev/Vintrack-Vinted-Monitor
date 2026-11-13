"use client";

import {
    checkoutApiPath,
    isCheckoutUrl,
    isPayPalPaymentUrl,
    checkoutPreferencesKey,
    type CheckoutTarget,
} from "@/lib/checkout";
import {
    detectCheckoutExtension,
    runBrowserBuyViaExtension,
} from "@/lib/vintrack-extension";

export async function openBrowserCheckout(target: CheckoutTarget) {
    const startedAt = performance.now();
    let authorizationMs = 0;
    let readinessMs = 0;
    const extension = await detectCheckoutExtension();
    if (extension.state !== "ready") {
        throw new Error(
            extension.state === "outdated"
                ? "Update the Vintrack extension before opening checkout."
                : "Open this buy link in a browser with the connected Vintrack extension. Connect or check the extension in Account, then try again. Checkout has not started.",
        );
    }
    const extensionAvailable = extension.protocol;
    if (
        target.preferences?.autoCheckout &&
        extension.automaticPayment === false
    ) {
        throw new Error(
            "Automatic payment is not supported by this extension. Update the extension or turn off auto-checkout in Account to review payment in Vinted.",
        );
    }
    if (extensionAvailable) {
        if (
            target.preferences?.autoCheckout &&
            !["EUR", "GBP"].includes(
                target.preferences.autoCheckout.currency,
            ) &&
            extensionAvailable < 8
        )
            throw new Error(
                "Update or reload the Vintrack extension to use all checkout currencies (version 0.4 or later).",
            );
        if (
            (target.preferences?.shipping === "pickup" ||
                target.preferences?.autoCheckout?.currency === "GBP") &&
            extensionAvailable < 7
        )
            throw new Error(
                "Update or reload the Vintrack extension to use saved pickup points or GBP auto-checkout (version 0.3.4 or later).",
            );
        if (
            target.preferences?.autoCheckout &&
            target.preferences.payment === "card" &&
            extensionAvailable < 6
        )
            throw new Error(
                "Update or reload the Vintrack extension to use card auto-checkout (version 0.3.1 or later).",
            );
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
                checkoutApiPath(target.monitorId, target.itemId),
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
                target.preferences.payment !== "paypal" ||
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
            "updateSkipped",
            "contactMs",
            "paymentMs",
            "extensionMs",
            "navigationMs",
            "clientNavigation",
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
                item_id: target.itemId,
                monitor_id: target.monitorId,
                seller_id: target.sellerId,
                transaction_id: result.transactionId || 0,
                purchase_id: result.purchaseId || "",
                checkout_url: result.checkoutUrl,
                status: result.status || "checkout_review_required",
            }),
        }).catch(() => {});
        return result.autoCheckoutReason;
    }
    throw new Error(
        "The connected extension could not start checkout. Check Account and try again.",
    );
}
