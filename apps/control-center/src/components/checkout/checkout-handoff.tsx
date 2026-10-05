"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Loader2, ShoppingCart, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getCheckoutTarget, openItemCheckout } from "@/lib/open-checkout";
import type { CheckoutTarget } from "@/lib/checkout";

export function CheckoutHandoff({
    monitorId,
    itemId,
}: {
    monitorId: number;
    itemId: number;
}) {
    const [target, setTarget] = useState<CheckoutTarget | null>(null);
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(true);
    const [running, setRunning] = useState(false);
    const [opened, setOpened] = useState(false);
    const started = useRef(false);
    const inFlight = useRef(false);
    useEffect(() => {
        let cancelled = false;
        getCheckoutTarget(monitorId, itemId)
            .then((data) => {
                if (!cancelled) setTarget(data);
            })
            .catch((err: Error) => {
                if (!cancelled) setError(err.message);
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [monitorId, itemId]);

    const start = useCallback(async () => {
        if (inFlight.current) return;
        inFlight.current = true;
        setRunning(true);
        setError("");
        try {
            await openItemCheckout(monitorId, itemId, target ?? undefined);
            setOpened(true);
        } catch (err) {
            setError(
                err instanceof Error
                    ? err.message
                    : "Checkout could not be opened.",
            );
        } finally {
            inFlight.current = false;
            setRunning(false);
        }
    }, [monitorId, itemId, target]);

    useEffect(() => {
        if (!target) return;
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
    }, [target, start]);

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
                    <h1 className="text-2xl font-bold">
                        {error
                            ? "Checkout could not open"
                            : "Opening Vinted checkout"}
                    </h1>
                </div>
                {loading ? (
                    <p className="text-muted-foreground flex items-center gap-2">
                        <Loader2 className="size-4 animate-spin" />
                        Loading your item…
                    </p>
                ) : null}
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
                {!error && !opened && !loading ? (
                    <p
                        role="status"
                        className="text-muted-foreground flex items-center gap-2 text-sm"
                    >
                        <Loader2 className="size-4 animate-spin" />
                        {running
                            ? "Preparing your checkout…"
                            : "Waiting for this tab to open…"}
                    </p>
                ) : null}
                {error ? (
                    <p role="alert" className="text-destructive text-sm">
                        {error}
                    </p>
                ) : null}
                {opened ? (
                    <p role="status" className="text-sm">
                        Checkout is open in your Vinted tab. Confirm your
                        purchase there.
                    </p>
                ) : null}
                {target && (error || opened) ? (
                    <Button
                        onClick={start}
                        disabled={running}
                        className="w-full gap-2"
                    >
                        {running ? (
                            <Loader2 className="size-4 animate-spin" />
                        ) : (
                            <ShoppingCart className="size-4" />
                        )}
                        {running
                            ? "Preparing checkout…"
                            : opened
                              ? "Reopen checkout"
                              : "Try again"}
                    </Button>
                ) : null}
                {error || opened ? (
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
                        ) : (
                            <Link
                                href={`/login?returnTo=${encodeURIComponent(`/checkout/${monitorId}/${itemId}`)}`}
                                className="underline"
                            >
                                Sign in to Vintrack
                            </Link>
                        )}
                        <Link href="/account" className="underline">
                            Manage linked account
                        </Link>
                    </div>
                ) : null}
            </section>
        </main>
    );
}
