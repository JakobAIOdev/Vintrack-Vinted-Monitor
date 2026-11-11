"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import {
    AlertTriangle,
    ArrowUpRight,
    CheckCircle2,
    Copy,
    Loader2,
    ShoppingCart,
} from "lucide-react";
import { toast } from "sonner";
import { useVintedAccount } from "@/components/account-provider";
import { Button } from "@/components/ui/button";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

const TEST_ITEM = {
    id: 8636911207,
    sellerId: 3139621024,
    title: "kunstwerk",
    url: "https://www.vinted.de/items/8636911207-kunstwerk",
};

const DEFAULT_PAYPAL_PAYMENT_METHOD = `{"card_id":null,"pay_in_method_id":"10"}`;

type BrowserInfo = {
    language: string;
    color_depth: number;
    java_enabled: boolean;
    screen_height: number;
    screen_width: number;
    timezone_offset: number;
};

type TestResult = {
    ok: boolean;
    status: number;
    statusText: string;
    durationMs: number;
    request: unknown;
    response: unknown;
    errorMessage: string | null;
};

function isDataDomeResult(result: TestResult) {
    if (
        result.response &&
        typeof result.response === "object" &&
        "code" in result.response
    ) {
        return (
            (result.response as { code?: unknown }).code ===
            "datadome_challenge"
        );
    }
    return (
        result.errorMessage?.includes("datadome challenge") ||
        result.errorMessage?.includes("captcha-delivery.com")
    );
}

function getBrowserInfo(): BrowserInfo {
    if (typeof window === "undefined") {
        return {
            language: "en-DE",
            color_depth: 32,
            java_enabled: false,
            screen_height: 1080,
            screen_width: 1920,
            timezone_offset: -120,
        };
    }

    return {
        language: navigator.language || "en-DE",
        color_depth: window.screen.colorDepth || 32,
        java_enabled: false,
        screen_height: window.screen.height || 1080,
        screen_width: window.screen.width || 1920,
        timezone_offset: new Date().getTimezoneOffset(),
    };
}

function formatJSON(value: unknown) {
    return JSON.stringify(value, null, 2);
}

function extractErrorMessage(response: unknown, fallback: string) {
    if (response && typeof response === "object" && "error" in response) {
        const error = (response as { error?: unknown }).error;
        if (typeof error === "string" && error.trim()) {
            return error;
        }
    }
    if (response && typeof response === "object" && "message" in response) {
        const message = (response as { message?: unknown }).message;
        if (typeof message === "string" && message.trim()) {
            return message;
        }
    }
    return fallback;
}

function parsePositiveInt(value: string) {
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) {
        return 0;
    }
    return Number(trimmed);
}

function itemURLFromID(itemID: number, fallbackURL: string) {
    if (fallbackURL.trim()) {
        return fallbackURL.trim();
    }
    return `https://www.vinted.de/items/${itemID}`;
}

function isInvalidAuthResult(result: TestResult) {
    if (
        result.response &&
        typeof result.response === "object" &&
        "code" in result.response
    ) {
        return (
            (result.response as { code?: unknown }).code ===
            "invalid_authentication_token"
        );
    }
    return (
        result.errorMessage?.includes("invalid authentication token") ||
        result.errorMessage?.includes("invalid_authentication_token")
    );
}

function isPaymentURLMissingResult(result: TestResult) {
    if (
        result.response &&
        typeof result.response === "object" &&
        "code" in result.response
    ) {
        return (
            (result.response as { code?: unknown }).code ===
            "payment_url_missing"
        );
    }
    return result.errorMessage?.includes("did not return a PayPal/payment URL");
}

function isPaymentAlreadyProcessingResult(result: TestResult) {
    if (
        result.response &&
        typeof result.response === "object" &&
        "code" in result.response
    ) {
        return (
            (result.response as { code?: unknown }).code ===
            "payment_already_processing"
        );
    }
    return (
        result.errorMessage?.includes("Bezahlungsvorgang") &&
        (result.errorMessage.includes("abgeschlossen") ||
            result.errorMessage.includes("bearbeitet"))
    );
}

function isPaymentMethodInvalidResult(result: TestResult) {
    if (
        result.response &&
        typeof result.response === "object" &&
        "code" in result.response
    ) {
        return (
            (result.response as { code?: unknown }).code ===
            "payment_method_invalid"
        );
    }
    return (
        result.errorMessage?.includes("Purchase card is not valid") ||
        result.errorMessage?.includes("andere Zahlungsmethode")
    );
}

function isPhoneRequiredResult(result: TestResult) {
    if (
        result.response &&
        typeof result.response === "object" &&
        "code" in result.response
    ) {
        return (
            (result.response as { code?: unknown }).code === "phone_required"
        );
    }
    return (
        result.errorMessage?.includes("Telefonnummer") &&
        result.errorMessage?.includes("erforderlich")
    );
}

export function OneClickBuyTestClient() {
    const { linked, loading } = useVintedAccount();
    const [itemId, setItemId] = useState(String(TEST_ITEM.id));
    const [sellerId, setSellerId] = useState(String(TEST_ITEM.sellerId));
    const [productTitle, setProductTitle] = useState(TEST_ITEM.title);
    const [productUrl, setProductUrl] = useState(TEST_ITEM.url);
    const [incogniaToken, setIncogniaToken] = useState("");
    const [phoneNumber, setPhoneNumber] = useState("");
    const [paymentMethodJson, setPaymentMethodJson] = useState(
        DEFAULT_PAYPAL_PAYMENT_METHOD,
    );
    const [confirmed, setConfirmed] = useState(false);
    const [running, setRunning] = useState(false);
    const [result, setResult] = useState<TestResult | null>(null);

    const browserInfo = useMemo(() => getBrowserInfo(), []);
    const parsedItemId = parsePositiveInt(itemId);
    const parsedSellerId = parsePositiveInt(sellerId);
    const currentProductUrl = itemURLFromID(
        parsedItemId || TEST_ITEM.id,
        productUrl,
    );
    const hasValidProduct = parsedItemId > 0 && parsedSellerId > 0;
    const parsedPaymentMethod = useMemo(() => {
        if (!paymentMethodJson.trim()) {
            return null;
        }
        try {
            const value = JSON.parse(paymentMethodJson);
            return value && typeof value === "object" && !Array.isArray(value)
                ? value
                : null;
        } catch {
            return null;
        }
    }, [paymentMethodJson]);
    const hasValidPaymentMethod =
        !paymentMethodJson.trim() || parsedPaymentMethod !== null;

    const requestPayload = useMemo(
        () => ({
            item_id: parsedItemId,
            seller_id: parsedSellerId,
            pickup_type: 1,
            ...(parsedPaymentMethod
                ? { payment_method: parsedPaymentMethod }
                : {}),
            ...(incogniaToken.trim()
                ? { incognia_request_token: incogniaToken.trim() }
                : {}),
            ...(phoneNumber.trim() ? { phone_number: phoneNumber.trim() } : {}),
            browser_info: browserInfo,
        }),
        [
            browserInfo,
            incogniaToken,
            parsedItemId,
            parsedPaymentMethod,
            parsedSellerId,
            phoneNumber,
        ],
    );

    const runTest = async () => {
        if (!hasValidProduct) {
            toast.error("Item ID and Seller ID must be positive numbers");
            return;
        }
        if (!hasValidPaymentMethod) {
            toast.error("Payment method JSON must be an object");
            return;
        }
        setRunning(true);
        setResult(null);
        const startedAt = performance.now();

        try {
            const res = await fetch("/api/items/buy", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(requestPayload),
            });
            const text = await res.text();
            let response: unknown;
            try {
                response = JSON.parse(text);
            } catch {
                response = text || null;
            }

            const durationMs = Math.round(performance.now() - startedAt);
            const errorMessage = res.ok
                ? null
                : extractErrorMessage(
                      response,
                      `Request failed with status ${res.status}`,
                  );

            setResult({
                ok: res.ok,
                status: res.status,
                statusText: res.statusText,
                durationMs,
                request: requestPayload,
                response,
                errorMessage,
            });

            if (!res.ok) {
                toast.error(errorMessage || "One-click buy failed");
                return;
            }

            const data = response as {
                payment_url?: string;
                checkout_url?: string;
            };
            const nextUrl = data.payment_url || data.checkout_url;
            if (nextUrl) {
                window.open(nextUrl, "_blank", "noopener,noreferrer");
                toast.success(
                    data.payment_url
                        ? "Reserved. Opened PayPal."
                        : "Reserved. Opened checkout.",
                );
            } else {
                toast.success(
                    "Request succeeded, but no payment or checkout URL was returned",
                );
            }
        } catch (error) {
            const durationMs = Math.round(performance.now() - startedAt);
            const errorMessage =
                error instanceof Error
                    ? error.message
                    : "Network error while calling /api/items/buy";
            setResult({
                ok: false,
                status: 0,
                statusText: "Network Error",
                durationMs,
                request: requestPayload,
                response: null,
                errorMessage,
            });
            toast.error(errorMessage);
        } finally {
            setRunning(false);
        }
    };

    const copyResult = async () => {
        if (!result) return;
        await navigator.clipboard.writeText(formatJSON(result));
        toast.success("Copied test result");
    };

    const resetProduct = () => {
        setItemId(String(TEST_ITEM.id));
        setSellerId(String(TEST_ITEM.sellerId));
        setProductTitle(TEST_ITEM.title);
        setProductUrl(TEST_ITEM.url);
        setResult(null);
    };

    return (
        <div className="mx-auto max-w-5xl space-y-6">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div>
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                        <Badge variant="secondary">Experimental</Badge>
                        <Badge variant="outline">Test product</Badge>
                        <Badge variant={linked ? "default" : "outline"}>
                            {loading
                                ? "Checking account"
                                : linked
                                  ? "Vinted linked"
                                  : "Vinted not linked"}
                        </Badge>
                    </div>
                    <h1 className="text-2xl font-semibold tracking-tight">
                        Experimental Buy Lab
                    </h1>
                    <p className="text-muted-foreground mt-1 max-w-2xl text-sm">
                        Runs the experimental Vinted PayPal checkout flow
                        against a test product and prints the exact request,
                        response, status code, and error message.
                    </p>
                </div>
                <Button asChild variant="outline">
                    <a
                        href={currentProductUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                    >
                        Open product
                        <ArrowUpRight className="ml-2 h-4 w-4" />
                    </a>
                </Button>
            </div>

            <Card>
                <CardHeader>
                    <CardTitle>Product</CardTitle>
                    <CardDescription>
                        Use the default product or enter a fresh item for
                        another test run.
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="grid gap-3 sm:grid-cols-2">
                        <label className="block space-y-2">
                            <span className="text-sm font-medium">Item ID</span>
                            <input
                                value={itemId}
                                onChange={(event) =>
                                    setItemId(event.target.value)
                                }
                                inputMode="numeric"
                                className="border-border bg-background focus:ring-ring w-full rounded-md border px-3 py-2 font-mono text-sm outline-none focus:ring-2"
                            />
                        </label>
                        <label className="block space-y-2">
                            <span className="text-sm font-medium">
                                Seller ID
                            </span>
                            <input
                                value={sellerId}
                                onChange={(event) =>
                                    setSellerId(event.target.value)
                                }
                                inputMode="numeric"
                                className="border-border bg-background focus:ring-ring w-full rounded-md border px-3 py-2 font-mono text-sm outline-none focus:ring-2"
                            />
                        </label>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                        <label className="block space-y-2">
                            <span className="text-sm font-medium">Title</span>
                            <input
                                value={productTitle}
                                onChange={(event) =>
                                    setProductTitle(event.target.value)
                                }
                                className="border-border bg-background focus:ring-ring w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
                            />
                        </label>
                        <label className="block space-y-2">
                            <span className="text-sm font-medium">
                                Product URL
                            </span>
                            <input
                                value={productUrl}
                                onChange={(event) =>
                                    setProductUrl(event.target.value)
                                }
                                className="border-border bg-background focus:ring-ring w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
                            />
                        </label>
                    </div>
                    {!hasValidProduct && (
                        <div className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border p-3 text-sm">
                            Item ID and Seller ID must be positive numbers.
                        </div>
                    )}
                    <div className="flex flex-wrap items-center gap-2">
                        <Button asChild variant="outline" size="sm">
                            <a
                                href={currentProductUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                            >
                                Open current product
                                <ArrowUpRight className="ml-2 h-4 w-4" />
                            </a>
                        </Button>
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={resetProduct}
                        >
                            Reset default product
                        </Button>
                    </div>
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>Run Checkout</CardTitle>
                    <CardDescription>
                        This can reserve the item on Vinted. PayPal payment is
                        still completed in the opened payment page and uses the
                        shipping address already stored on the linked Vinted
                        account.
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                        <div>
                            <p className="font-medium text-amber-700 dark:text-amber-300">
                                Experimental module
                            </p>
                            <p className="text-muted-foreground">
                                This area is intentionally separated from the
                                normal Vintrack workflow. Use it only for
                                controlled buy tests and expect auth or checkout
                                edge cases.
                            </p>
                        </div>
                    </div>

                    {!linked && !loading && (
                        <div className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
                            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                            <div>
                                <p className="font-medium">
                                    Vinted account is not linked.
                                </p>
                                <p className="text-muted-foreground">
                                    Link an account first, then return to this
                                    page.
                                </p>
                                <Button asChild size="sm" className="mt-3">
                                    <Link href="/account">Go to Account</Link>
                                </Button>
                            </div>
                        </div>
                    )}

                    <label className="block space-y-2">
                        <span className="text-sm font-medium">
                            x-incognia-request-token (optional)
                        </span>
                        <textarea
                            value={incogniaToken}
                            onChange={(event) =>
                                setIncogniaToken(event.target.value)
                            }
                            placeholder="Paste a fresh token from the browser request if Vinted rejects checkout/build or checkout/payment."
                            rows={4}
                            className="border-border bg-background focus:ring-ring w-full resize-y rounded-md border px-3 py-2 font-mono text-xs outline-none focus:ring-2"
                        />
                    </label>

                    <label className="block space-y-2">
                        <span className="text-sm font-medium">
                            Shipping phone number (optional)
                        </span>
                        <input
                            value={phoneNumber}
                            onChange={(event) =>
                                setPhoneNumber(event.target.value)
                            }
                            placeholder="+491234567890"
                            className="border-border bg-background focus:ring-ring w-full rounded-md border px-3 py-2 font-mono text-sm outline-none focus:ring-2"
                        />
                        <span className="text-muted-foreground text-xs">
                            Overrides the linked account phone for this test and
                            is sent to Vinted shipping_contact when the checkout
                            exposes a shipping_order_id.
                        </span>
                    </label>

                    <label className="block space-y-2">
                        <span className="text-sm font-medium">
                            payment_method JSON (optional)
                        </span>
                        <textarea
                            value={paymentMethodJson}
                            onChange={(event) =>
                                setPaymentMethodJson(event.target.value)
                            }
                            placeholder={DEFAULT_PAYPAL_PAYMENT_METHOD}
                            rows={4}
                            className="border-border bg-background focus:ring-ring w-full resize-y rounded-md border px-3 py-2 font-mono text-xs outline-none focus:ring-2"
                        />
                        {!hasValidPaymentMethod && (
                            <span className="text-destructive text-xs">
                                Payment method JSON must be a JSON object, not
                                an array or scalar.
                            </span>
                        )}
                        <span className="text-muted-foreground text-xs">
                            Default is the PayPal payload captured from Vinted:
                            card_id null and pay_in_method_id 10.
                        </span>
                    </label>

                    <label className="border-border/80 flex items-start gap-2 rounded-lg border p-3 text-sm">
                        <input
                            type="checkbox"
                            checked={confirmed}
                            onChange={(event) =>
                                setConfirmed(event.target.checked)
                            }
                            className="mt-1"
                        />
                        <span>
                            I understand this test may reserve the item on
                            Vinted and may open PayPal or checkout using the
                            address already configured in my linked Vinted
                            account.
                        </span>
                    </label>

                    <div className="flex flex-wrap gap-2">
                        <Button
                            onClick={runTest}
                            disabled={
                                loading ||
                                !linked ||
                                !confirmed ||
                                running ||
                                !hasValidProduct ||
                                !hasValidPaymentMethod
                            }
                            className="gap-2"
                        >
                            {running ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                                <ShoppingCart className="h-4 w-4" />
                            )}
                            {running ? "Running..." : "Run one-click buy"}
                        </Button>
                        {result && (
                            <Button
                                variant="outline"
                                onClick={copyResult}
                                className="gap-2"
                            >
                                <Copy className="h-4 w-4" />
                                Copy result
                            </Button>
                        )}
                    </div>
                </CardContent>
            </Card>

            <div className="grid gap-6 lg:grid-cols-2">
                <Card>
                    <CardHeader>
                        <CardTitle>Request Payload</CardTitle>
                        <CardDescription>
                            Sent to `/api/items/buy`.
                        </CardDescription>
                    </CardHeader>
                    <CardContent>
                        <pre className="bg-muted max-h-105 overflow-auto rounded-lg p-3 text-xs">
                            {formatJSON(requestPayload)}
                        </pre>
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader>
                        <CardTitle>Latest Result</CardTitle>
                        <CardDescription>
                            Status, duration, parsed response, and exact error
                            message.
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-3">
                        {result ? (
                            <>
                                <div className="flex flex-wrap gap-2">
                                    <Badge
                                        variant={
                                            result.ok
                                                ? "default"
                                                : "destructive"
                                        }
                                    >
                                        {result.ok ? "OK" : "FAILED"}
                                    </Badge>
                                    <Badge variant="outline">
                                        HTTP {result.status || "network"}
                                    </Badge>
                                    <Badge variant="outline">
                                        {result.durationMs}ms
                                    </Badge>
                                </div>
                                {result.errorMessage ? (
                                    <div className="border-destructive/40 bg-destructive/10 text-destructive rounded-lg border p-3 text-sm">
                                        {result.errorMessage}
                                    </div>
                                ) : (
                                    <div className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-600 dark:text-emerald-400">
                                        <CheckCircle2 className="h-4 w-4" />
                                        Request completed successfully.
                                    </div>
                                )}
                                {isDataDomeResult(result) && (
                                    <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
                                        Vinted returned a DataDome checkout
                                        challenge. Relink the account with fresh
                                        tokens from the same logged-in browser
                                        session, then run this test again. The
                                        x-incognia-request-token is not a
                                        cookie.
                                    </div>
                                )}
                                {isInvalidAuthResult(result) && (
                                    <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
                                        Vinted rejected the stored access token
                                        before checkout. Sync the browser
                                        extension again with the currently
                                        logged-in browser session, not with
                                        values from the request sample files.
                                    </div>
                                )}
                                {isPaymentURLMissingResult(result) && (
                                    <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
                                        Vinted accepted the checkout/payment
                                        request but did not return a PayPal
                                        redirect URL. The checkout_url is only
                                        Vinted checkout page; use payment_raw
                                        below to inspect which payment state
                                        Vinted returned.
                                    </div>
                                )}
                                {isPaymentAlreadyProcessingResult(result) && (
                                    <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
                                        Vinted says this transaction payment is
                                        already finished or being processed.
                                        This usually happens after rerunning the
                                        same test checkout. Use a fresh item or
                                        reset the Vinted checkout state before
                                        testing again.
                                    </div>
                                )}
                                {isPaymentMethodInvalidResult(result) && (
                                    <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
                                        Vinted rejected the payment method with
                                        checkout_error. The API flow reached
                                        checkout payment, but Vinted did not
                                        accept the stored/default payment method
                                        for this purchase.
                                    </div>
                                )}
                                {isPhoneRequiredResult(result) && (
                                    <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
                                        Vinted requires a phone number for the
                                        delivery address before payment can
                                        start. Add one in the Shipping phone
                                        number field or store it on the Account
                                        page, then retry with a fresh checkout.
                                    </div>
                                )}
                                <pre className="bg-muted max-h-105 overflow-auto rounded-lg p-3 text-xs">
                                    {formatJSON(result.response)}
                                </pre>
                            </>
                        ) : (
                            <div className="border-border text-muted-foreground rounded-lg border border-dashed p-6 text-sm">
                                No test run yet.
                            </div>
                        )}
                    </CardContent>
                </Card>
            </div>
        </div>
    );
}
