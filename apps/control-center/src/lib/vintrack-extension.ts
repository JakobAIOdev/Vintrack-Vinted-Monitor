export type CheckoutExtensionState = {
    state: "ready" | "unconfigured" | "outdated" | "unavailable";
    protocol: number;
    automaticPayment?: boolean;
};

// Probe only capabilities. A slow/missing receiver must never choose another
// checkout executor. A cold extension can need time to start.
export function detectCheckoutExtension(): Promise<CheckoutExtensionState> {
    if (typeof window === "undefined")
        return Promise.resolve({ state: "unavailable", protocol: 0 });
    return new Promise((resolve) => {
        const timers: number[] = [];
        const requestId = `checkout-probe-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        function finish(result: CheckoutExtensionState) {
            for (const timer of timers) window.clearTimeout(timer);
            window.removeEventListener("message", onMessage);
            resolve(result);
        }
        function onMessage(event: MessageEvent) {
            if (
                event.source !== window ||
                event.origin !== window.location.origin ||
                event.data?.type !== "VINTRACK_EXTENSION_READY"
            )
                return;
            const payload = event.data.payload;
            if (
                payload?.requestId !== undefined &&
                payload.requestId !== requestId
            )
                return;
            const protocol = Number.isSafeInteger(
                payload?.checkoutPrepareVersion,
            )
                ? payload.checkoutPrepareVersion
                : 0;
            finish({
                state:
                    payload?.configured !== true
                        ? "unconfigured"
                        : protocol < 2 ||
                            payload?.checkoutCapabilities?.prepare === false
                          ? "outdated"
                          : "ready",
                protocol,
                automaticPayment:
                    typeof payload?.checkoutCapabilities?.automaticPayment ===
                    "boolean"
                        ? payload.checkoutCapabilities.automaticPayment
                        : undefined,
            });
        }
        function ping() {
            window.postMessage(
                { type: "VINTRACK_EXTENSION_PING", requestId },
                window.location.origin,
            );
        }
        window.addEventListener("message", onMessage);
        timers.push(
            window.setTimeout(
                () => finish({ state: "unavailable", protocol: 0 }),
                3000,
            ),
        );
        for (const delay of [250, 1000])
            timers.push(window.setTimeout(ping, delay));
        ping();
    });
}

export type BrowserBuyPayload = {
    itemId: number;
    sellerId: number;
    expectedAccountId: number;
    itemUrl?: string;
    domain?: string;
    preferences?: import("@/lib/checkout").CheckoutPreferences;
    readinessOnly?: boolean;
};

export type BrowserBuyResult =
    | {
          ok: true;
          checkoutUrl?: string;
          purchaseId?: string;
          transactionId?: number;
          status?: string;
          paymentUrl?: string;
          autoCheckoutReason?: string;
          ready?: boolean;
          timings?: Record<string, number>;
      }
    | {
          ok: false;
          code?: string;
          error?: string;
          captchaUrl?: string;
      };

export async function runBrowserBuyViaExtension(
    payload: BrowserBuyPayload,
    timeoutMs = 30000,
): Promise<BrowserBuyResult | null> {
    if (typeof window === "undefined") {
        return null;
    }

    const requestId =
        typeof crypto !== "undefined" && "randomUUID" in crypto
            ? crypto.randomUUID()
            : `vintrack-buy-${Date.now()}-${Math.random().toString(16).slice(2)}`;

    return new Promise((resolve) => {
        const timeout = window.setTimeout(() => {
            window.removeEventListener("message", handleResponse);
            resolve(null);
        }, timeoutMs);

        function handleResponse(event: MessageEvent) {
            if (
                event.source !== window ||
                event.origin !== window.location.origin ||
                event.data?.type !== "VINTRACK_EXTENSION_BUY_RESULT" ||
                event.data.payload?.requestId !== requestId
            ) {
                return;
            }

            window.clearTimeout(timeout);
            window.removeEventListener("message", handleResponse);
            resolve(event.data.payload as BrowserBuyResult);
        }

        window.addEventListener("message", handleResponse);
        window.postMessage(
            {
                type: "VINTRACK_EXTENSION_BUY",
                payload: {
                    ...payload,
                    requestId,
                },
            },
            window.location.origin,
        );
    });
}
