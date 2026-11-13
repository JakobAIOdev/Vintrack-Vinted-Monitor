"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import Link from "next/link";
import { Loader2, ShoppingCart, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
    CheckoutRunError,
    runItemCheckout,
    type CheckoutRunResult,
} from "@/lib/open-checkout";
import {
    isCheckoutUrl,
    isPayPalPaymentUrl,
    type CheckoutTarget,
} from "@/lib/checkout";

type CheckoutFailure = {
    message: string;
    status?: number;
    interrupted?: boolean;
};

const TONE_CLASSES: Record<CheckoutRunResult["tone"], string> = {
    success: "text-emerald-700 dark:text-emerald-400",
    info: "",
    warning: "text-amber-700 dark:text-amber-300",
    error: "text-destructive",
};

// A buy link starts by itself only on its first, fresh open in this tab. A
// reload, a restored or discarded tab, or a page that stayed in the
// background for minutes needs an explicit click, because starting again
// could start a payment.
function autoStartAllowed(marker: string) {
    const navigation = performance.getEntriesByType("navigation")[0] as
        PerformanceNavigationTiming | undefined;
    if (navigation && navigation.type !== "navigate") return false;
    if ((document as Document & { wasDiscarded?: boolean }).wasDiscarded)
        return false;
    if (performance.now() > 120_000) return false;
    try {
        if (sessionStorage.getItem(marker)) return false;
    } catch {}
    return true;
}

export function CheckoutHandoff({
    monitorId,
    itemId,
    validateOnly = false,
    autoStart = true,
}: {
    monitorId: number;
    itemId: number;
    validateOnly?: boolean;
    autoStart?: boolean;
}) {
    const [target, setTarget] = useState<CheckoutTarget | null>(null);
    const [failure, setFailure] = useState<CheckoutFailure | null>(null);
    const [running, setRunning] = useState(false);
    const [needsClick, setNeedsClick] = useState(false);
    const [result, setResult] = useState<CheckoutRunResult | null>(null);
    const started = useRef(false);
    const inFlight = useRef(false);
    const marker = `vintrack-checkout:${monitorId}:${itemId}:${validateOnly}`;
    const start = useCallback(async () => {
        if (inFlight.current) return;
        inFlight.current = true;
        setRunning(true);
        setNeedsClick(false);
        setFailure(null);
        try {
            const outcome = await runItemCheckout(monitorId, itemId, {
                onTargetLoaded: setTarget,
                validateOnly,
                // Render the result and its links before the automatic
                // navigation, so they are there if it is blocked or the
                // member comes back.
                onResult: (current) => flushSync(() => setResult(current)),
            });
            setResult(outcome);
        } catch (err) {
            const status =
                err instanceof CheckoutRunError ? err.status : undefined;
            // A signed-out request started nothing, so the link may start
            // by itself again after signing in.
            if (status === 401)
                try {
                    sessionStorage.removeItem(marker);
                } catch {}
            setFailure({
                message:
                    err instanceof Error
                        ? err.message
                        : "Checkout could not be opened.",
                status,
                interrupted:
                    err instanceof CheckoutRunError && err.interrupted === true,
            });
        } finally {
            inFlight.current = false;
            setRunning(false);
        }
    }, [monitorId, itemId, validateOnly, marker]);

    useEffect(() => {
        function continueCheckout() {
            // Plain GET previews never prepare checkout. A hidden or
            // prerendered browser document waits until the user opens it.
            if (
                started.current ||
                document.visibilityState !== "visible" ||
                (document as Document & { prerendering?: boolean }).prerendering
            )
                return;
            started.current = true;
            if (!autoStart || !autoStartAllowed(marker)) {
                setNeedsClick(true);
                return;
            }
            try {
                sessionStorage.setItem(marker, "1");
            } catch {}
            void start();
        }
        document.addEventListener("visibilitychange", continueCheckout);
        document.addEventListener("prerenderingchange", continueCheckout);
        continueCheckout();
        return () => {
            document.removeEventListener("visibilitychange", continueCheckout);
            document.removeEventListener(
                "prerenderingchange",
                continueCheckout,
            );
        };
    }, [start, marker, autoStart]);

    const signedOut = failure?.status === 401;
    const returnPath = `/checkout/${monitorId}/${itemId}${validateOnly ? "?validate=1" : ""}`;
    // The links were verified before they reached this component; they are
    // checked once more here so nothing else can ever be rendered as a link.
    const paymentUrl =
        result?.status === "paypal_redirect_ready" &&
        isPayPalPaymentUrl(result.paymentUrl)
            ? result.paymentUrl
            : null;
    const checkoutUrl =
        target && result && isCheckoutUrl(result.checkoutUrl, target.domain)
            ? result.checkoutUrl
            : null;
    const canRefresh =
        result &&
        !["card_payment_confirmed", "card_payment_failed"].includes(
            result.status || "",
        );

    return (
        <main className="mx-auto flex min-h-screen max-w-lg items-center px-5 py-10">
            <section className="bg-card w-full space-y-5 rounded-2xl border p-6 shadow-sm">
                <Link
                    href="/dashboard"
                    className="text-muted-foreground text-sm font-semibold"
                >
                    Vintrack
                </Link>
                <div className="flex items-center gap-3">
                    <ShoppingCart className="text-primary size-6" />
                    <h1 className="text-2xl font-semibold">
                        {failure
                            ? failure.interrupted
                                ? "Checkout was interrupted"
                                : "Checkout could not open"
                            : result
                              ? "Checkout result"
                              : validateOnly
                                ? "Testing server checkout"
                                : running
                                  ? "Working on your checkout"
                                  : "Vinted checkout"}
                    </h1>
                </div>
                {validateOnly && (
                    <p className="text-muted-foreground text-sm">
                        This test prepares checkout and stops before the payment
                        request. It does not buy the item.
                    </p>
                )}
                {target ? (
                    <div className="bg-muted rounded-xl p-4">
                        <p className="font-semibold">{target.title}</p>
                        {target.price ? (
                            <p className="mt-1 text-sm">
                                {target.price} · shipping and fees shown on
                                Vinted
                            </p>
                        ) : null}
                        <p className="text-muted-foreground mt-2 text-sm">
                            Linked account:{" "}
                            {target.accountName
                                ? `@${target.accountName}`
                                : "Vinted account"}
                        </p>
                    </div>
                ) : null}
                {!failure && !result && !needsClick ? (
                    <p
                        role="status"
                        className="text-muted-foreground flex items-start gap-2 text-sm"
                    >
                        <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin" />
                        {!running
                            ? "Waiting for this tab to open…"
                            : validateOnly
                              ? "Preparing your checkout…"
                              : "Keep this page open. If automatic payment is enabled, a payment may be started now."}
                    </p>
                ) : null}
                {needsClick && !running && !failure && !result ? (
                    <>
                        <p className="text-muted-foreground text-sm">
                            Nothing was started automatically. Use the button to
                            start this checkout.
                        </p>
                        <Button onClick={start} className="w-full gap-2">
                            <ShoppingCart className="size-4" />
                            {validateOnly ? "Run test" : "Buy now"}
                        </Button>
                    </>
                ) : null}
                {failure ? (
                    <p role="alert" className="text-destructive text-sm">
                        {failure.message}
                    </p>
                ) : null}
                {signedOut ? (
                    <p className="text-muted-foreground text-sm">
                        This browser is not signed in to Vintrack. If the link
                        opened inside Discord or Telegram, sign in here once or
                        use the app&apos;s option to open the link in your
                        browser.
                    </p>
                ) : null}
                {result ? (
                    <p
                        role="status"
                        className={`text-sm ${TONE_CLASSES[result.tone]}`}
                    >
                        {result.message ||
                            "Checkout is open in your Vinted tab. Confirm your purchase there."}
                    </p>
                ) : null}
                {paymentUrl ? (
                    <div className="space-y-2">
                        <Button asChild size="lg" className="w-full">
                            <a href={paymentUrl} rel="noopener noreferrer">
                                Pay with PayPal
                            </a>
                        </Button>
                        <p className="text-muted-foreground text-sm">
                            Your order is reserved once PayPal confirms the
                            payment.
                        </p>
                    </div>
                ) : null}
                {checkoutUrl ? (
                    <Button
                        asChild
                        size="lg"
                        variant={result?.navigating ? "default" : "outline"}
                        className="w-full"
                    >
                        <a href={checkoutUrl} rel="noopener noreferrer">
                            {result?.navigating
                                ? "Continue in Vinted"
                                : "Finish this checkout in Vinted"}
                        </a>
                    </Button>
                ) : null}
                {(failure && !signedOut) || canRefresh ? (
                    <Button
                        onClick={start}
                        disabled={running}
                        variant={
                            paymentUrl || checkoutUrl ? "outline" : "default"
                        }
                        className="w-full gap-2"
                    >
                        {running ? (
                            <Loader2 className="size-4 animate-spin" />
                        ) : (
                            <ShoppingCart className="size-4" />
                        )}
                        {running
                            ? "Working…"
                            : failure
                              ? "Try again"
                              : validateOnly
                                ? "Run test again"
                                : "Refresh status"}
                    </Button>
                ) : null}
                {failure || result ? (
                    <div className="flex flex-wrap gap-4 text-sm">
                        {target ? (
                            <a
                                href={target.itemUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="flex items-center gap-1 underline"
                            >
                                <ExternalLink className="size-3" />
                                View on Vinted
                            </a>
                        ) : null}
                        {signedOut ? (
                            <Link
                                href={`/login?returnTo=${encodeURIComponent(returnPath)}`}
                                className="underline"
                            >
                                Sign in to Vintrack
                            </Link>
                        ) : null}
                        <Link href="/account" className="underline">
                            Manage linked account
                        </Link>
                    </div>
                ) : null}
            </section>
        </main>
    );
}
