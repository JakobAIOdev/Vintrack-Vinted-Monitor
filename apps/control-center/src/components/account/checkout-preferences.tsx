"use client";

import { useEffect, useState, useTransition } from "react";
import {
    getCheckoutPreferenceSettings,
    saveCheckoutPreferences,
    setCheckoutModuleEnabled,
} from "@/actions/checkout-preferences";
import {
    DEFAULT_CHECKOUT_PREFERENCES,
    CHECKOUT_PAYMENT_LABELS,
    checkoutPaymentOptions,
    autoCheckoutAllowed,
    autoCheckoutWarningVersion,
    type CheckoutPreferences,
} from "@/lib/checkout";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useRouter } from "next/navigation";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { PowerOff } from "lucide-react";
import { toast } from "sonner";
import { CHECKOUT_RISK_WARNING_VERSION } from "@/lib/checkout-consent";
import { requestCheckoutConsent } from "@/lib/checkout-consent.client";

export function CheckoutPreferencesCard({
    accountKey,
}: {
    accountKey: string;
}) {
    const [preferences, setPreferences] = useState<CheckoutPreferences>(
        DEFAULT_CHECKOUT_PREFERENCES,
    );
    const router = useRouter();
    const [checkoutEnabled, setCheckoutEnabled] = useState(false);
    const [loaded, setLoaded] = useState(false);
    const [domain, setDomain] = useState("");
    const [autoEnabled, setAutoEnabled] = useState(false);
    const [savedPreferences, setSavedPreferences] =
        useState<CheckoutPreferences>(DEFAULT_CHECKOUT_PREFERENCES);
    const savedAutoEnabled = Boolean(savedPreferences.autoCheckout);
    const [warningAccepted, setWarningAccepted] = useState(false);
    const [maxTotal, setMaxTotal] = useState("");
    const [pending, startTransition] = useTransition();
    const [riskConsentVersion, setRiskConsentVersion] = useState<number | null>(
        null,
    );
    useEffect(() => {
        let cancelled = false;
        getCheckoutPreferenceSettings()
            .then((value) => {
                if (!cancelled) {
                    setCheckoutEnabled(value.checkoutEnabled);
                    setPreferences(value.preferences);
                    setRiskConsentVersion(value.riskConsentVersion);
                    setDomain(value.domain);
                    setAutoEnabled(Boolean(value.preferences.autoCheckout));
                    setSavedPreferences(value.preferences);
                    setWarningAccepted(Boolean(value.preferences.autoCheckout));
                    setMaxTotal(
                        value.preferences.autoCheckout
                            ? (
                                  value.preferences.autoCheckout.maxTotalMinor /
                                  100
                              ).toFixed(2)
                            : "",
                    );
                    setLoaded(true);
                }
            })
            .catch(() => {
                if (!cancelled)
                    toast.error("Checkout preferences could not be loaded.");
            });
        return () => {
            cancelled = true;
        };
    }, [accountKey]);
    const canAutoCheckout = autoCheckoutAllowed(domain, preferences.payment);
    const maxTotalMinor = /^\d+(?:[.,]\d{1,2})?$/.test(maxTotal)
        ? Math.round(Number(maxTotal.replace(",", ".")) * 100)
        : 0;
    const validAutoCheckout =
        !autoEnabled ||
        (canAutoCheckout &&
            warningAccepted &&
            Number.isSafeInteger(maxTotalMinor) &&
            maxTotalMinor > 0 &&
            maxTotalMinor <= 1_000_000);
    return (
        <Card className="border-border/70 gap-0 overflow-hidden py-0 shadow-sm">
            <CardHeader className="border-b p-5">
                <CardTitle className="flex items-center justify-between gap-3">
                    Oneclick checkout
                    <Badge variant={checkoutEnabled ? "default" : "secondary"}>
                        {!loaded
                            ? "Loading…"
                            : checkoutEnabled
                              ? "Enabled"
                              : "Disabled"}
                    </Badge>
                </CardTitle>
                <CardDescription>
                    {loaded && !checkoutEnabled
                        ? "Buy links and automatic payment are turned off. Your saved choices remain stored."
                        : `Choose delivery and payment for your buy links${domain ? ` (${domain.replace("www.vinted.", "").toUpperCase()})` : ""}. Oneclick opens the final review; auto-checkout can start payment.`}
                </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 p-5">
                <div className="flex items-center justify-between gap-4 rounded-md border p-4">
                    <div className="space-y-1">
                        <Label htmlFor="checkout-module">
                            Enable checkout module
                        </Label>
                        <p className="text-muted-foreground text-xs leading-5">
                            Enable Oneclick in the dashboard and notification
                            links. Turning this off also disables saved
                            auto-checkout. Payment and delivery choices are
                            kept.
                        </p>
                    </div>
                    <Switch
                        id="checkout-module"
                        checked={checkoutEnabled}
                        disabled={!loaded || pending}
                        onCheckedChange={(enabled) => {
                            startTransition(async () => {
                                try {
                                    if (enabled) {
                                        await requestCheckoutConsent();
                                        setRiskConsentVersion(
                                            CHECKOUT_RISK_WARNING_VERSION,
                                        );
                                    }
                                    const result =
                                        await setCheckoutModuleEnabled(enabled);
                                    if (result.error) {
                                        toast.error(result.error);
                                        return;
                                    }
                                    setCheckoutEnabled(enabled);
                                    setAutoEnabled(false);
                                    setWarningAccepted(false);
                                    const savedChoices = {
                                        shipping: savedPreferences.shipping,
                                        payment: savedPreferences.payment,
                                    };
                                    setPreferences(savedChoices);
                                    setSavedPreferences(savedChoices);
                                    router.refresh();
                                    toast.success(
                                        enabled
                                            ? "Checkout module enabled."
                                            : "Checkout module disabled.",
                                    );
                                } catch (error) {
                                    if (
                                        !(
                                            error instanceof Error &&
                                            error.message.startsWith(
                                                "Checkout cancelled.",
                                            )
                                        )
                                    )
                                        toast.error(
                                            "Checkout module setting could not be saved.",
                                        );
                                }
                            });
                        }}
                    />
                </div>
                <div
                    className="grid gap-3 sm:grid-cols-2"
                    aria-label="Saved checkout status"
                >
                    <div className="flex items-center justify-between gap-3 rounded-md border px-4 py-3 text-sm">
                        <span>Oneclick buy</span>
                        <Badge
                            variant={checkoutEnabled ? "default" : "secondary"}
                        >
                            {!loaded
                                ? "Loading…"
                                : checkoutEnabled
                                  ? "Enabled"
                                  : "Disabled"}
                        </Badge>
                    </div>
                    <div className="flex items-center justify-between gap-3 rounded-md border px-4 py-3 text-sm">
                        <span>Auto-checkout / auto-buy</span>
                        <Badge
                            variant={
                                checkoutEnabled && savedAutoEnabled
                                    ? "default"
                                    : "secondary"
                            }
                        >
                            {!loaded
                                ? "Loading…"
                                : checkoutEnabled && savedAutoEnabled
                                  ? "Enabled"
                                  : "Disabled"}
                        </Badge>
                    </div>
                </div>
                {!loaded ? (
                    <p role="status" className="text-muted-foreground text-sm">
                        Loading checkout settings…
                    </p>
                ) : !checkoutEnabled ? (
                    <div className="bg-muted/40 space-y-4 rounded-lg border p-4">
                        <div className="flex gap-3">
                            <PowerOff
                                className="text-muted-foreground mt-0.5 size-5 shrink-0"
                                aria-hidden="true"
                            />
                            <div className="space-y-1">
                                <p className="text-sm font-medium">
                                    Oneclick and auto-checkout are disabled
                                </p>
                                <p className="text-muted-foreground text-sm leading-6">
                                    Enable the checkout module above to use buy
                                    links or edit payment and delivery.
                                    Auto-checkout stays off until you enable it
                                    separately and save your limit.
                                </p>
                            </div>
                        </div>
                        <div className="text-muted-foreground grid gap-3 border-t pt-4 text-sm sm:grid-cols-2">
                            <div>
                                <p className="text-xs">
                                    Saved delivery · inactive
                                </p>
                                <p className="mt-1">
                                    {preferences.shipping === "home"
                                        ? "Home delivery to my Vinted address"
                                        : "Vinted’s saved delivery choice"}
                                </p>
                            </div>
                            <div>
                                <p className="text-xs">
                                    Saved payment · inactive
                                </p>
                                <p className="mt-1">
                                    {
                                        CHECKOUT_PAYMENT_LABELS[
                                            preferences.payment
                                        ]
                                    }
                                </p>
                            </div>
                        </div>
                    </div>
                ) : (
                    <div className="space-y-4">
                        <div className="grid gap-4 sm:grid-cols-2">
                            <div className="space-y-2">
                                <Label htmlFor="checkout-shipping">
                                    Delivery
                                </Label>
                                <select
                                    id="checkout-shipping"
                                    className="border-input bg-background h-10 w-full rounded-md border px-3 text-sm"
                                    disabled={
                                        !loaded || pending || !checkoutEnabled
                                    }
                                    value={preferences.shipping}
                                    onChange={(event) =>
                                        setPreferences({
                                            ...preferences,
                                            shipping: event.target
                                                .value as CheckoutPreferences["shipping"],
                                        })
                                    }
                                >
                                    <option value="home">
                                        Home delivery to my Vinted address
                                    </option>
                                    <option value="vinted">
                                        Keep Vinted&apos;s saved delivery choice
                                    </option>
                                </select>
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="checkout-payment">
                                    Payment
                                </Label>
                                <select
                                    id="checkout-payment"
                                    className="border-input bg-background h-10 w-full rounded-md border px-3 text-sm"
                                    disabled={
                                        !loaded || pending || !checkoutEnabled
                                    }
                                    value={preferences.payment}
                                    onChange={(event) => {
                                        setAutoEnabled(false);
                                        setWarningAccepted(false);
                                        setPreferences({
                                            shipping: preferences.shipping,
                                            payment: event.target
                                                .value as CheckoutPreferences["payment"],
                                        });
                                    }}
                                >
                                    {checkoutPaymentOptions(domain).map(
                                        (payment) => (
                                            <option
                                                key={payment}
                                                value={payment}
                                            >
                                                {
                                                    CHECKOUT_PAYMENT_LABELS[
                                                        payment
                                                    ]
                                                }
                                            </option>
                                        ),
                                    )}
                                </select>
                            </div>
                        </div>
                        <p className="text-muted-foreground text-xs leading-5">
                            Vinted applies available wallet funds automatically.
                            With Wallet, review or choose the payment method for
                            any remaining amount in Vinted. Other choices apply
                            to the remainder. Vinted checks availability for
                            each item and device. Card preselection needs a
                            saved card; if there is more than one, choose it in
                            Vinted first. Home delivery uses the carrier Vinted
                            preselects. Missing address, contact details or
                            unavailable options still need your attention.
                            Normal Oneclick stops before payment in Vinted.
                        </p>
                        <div className="border-border space-y-3 rounded-md border p-4">
                            <div className="flex items-center justify-between gap-3 text-sm">
                                <p className="font-medium">Automatic payment</p>
                                <Badge
                                    variant={
                                        autoEnabled ? "outline" : "secondary"
                                    }
                                >
                                    {autoEnabled !== savedAutoEnabled
                                        ? "Unsaved changes"
                                        : savedAutoEnabled
                                          ? "Enabled"
                                          : "Disabled"}
                                </Badge>
                            </div>
                            {autoEnabled !== savedAutoEnabled && (
                                <p
                                    role="status"
                                    className="rounded-md bg-amber-500/10 p-3 text-xs leading-5 text-amber-700 dark:text-amber-300"
                                >
                                    {savedAutoEnabled
                                        ? "Your saved auto-checkout is still active. Save these changes to turn it off."
                                        : "Auto-checkout is not active yet. Accept the payment warning, set a limit and save to enable it."}
                                </p>
                            )}
                            <Label className="flex items-center gap-2">
                                <input
                                    type="checkbox"
                                    checked={autoEnabled}
                                    disabled={
                                        !loaded ||
                                        pending ||
                                        !checkoutEnabled ||
                                        !canAutoCheckout
                                    }
                                    onChange={(event) => {
                                        const enable = event.target.checked;
                                        setWarningAccepted(false);
                                        if (!enable) {
                                            setAutoEnabled(false);
                                            return;
                                        }
                                        startTransition(async () => {
                                            try {
                                                // Review risks at the moment the mode
                                                // is enabled, before it can be saved.
                                                await requestCheckoutConsent();
                                                setRiskConsentVersion(
                                                    CHECKOUT_RISK_WARNING_VERSION,
                                                );
                                                setAutoEnabled(true);
                                            } catch {
                                                setAutoEnabled(false);
                                            }
                                        });
                                    }}
                                />
                                Auto-checkout with{" "}
                                {preferences.payment === "card"
                                    ? "my saved card"
                                    : "PayPal"}{" "}
                                after clicking a buy link
                            </Label>
                            <p className="text-muted-foreground text-xs leading-5">
                                {canAutoCheckout
                                    ? preferences.payment === "card"
                                        ? "Optional: submit payment with the card saved in Vinted. Your card may be charged immediately. Only verified EUR checkouts within your limit qualify; bank authentication or CVV confirmation may still be required in Vinted. Dashboard and notification buy links use this mode after a click. Monitor matches do not buy automatically."
                                        : "Optional: skip Vinted’s final payment button and open PayPal. Only verified EUR checkouts within your limit qualify. This applies to dashboard and notification buy links, and does not buy new monitor matches automatically."
                                    : "Choose a saved card or PayPal (where offered in your linked region) to enable auto-checkout. Other payment methods use normal Oneclick."}
                            </p>
                            {autoEnabled && (
                                <div className="space-y-3">
                                    <div
                                        role="note"
                                        className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm leading-6"
                                    >
                                        <strong>
                                            Warning: this starts a real payment.
                                        </strong>{" "}
                                        A buy-link click submits Vinted’s
                                        payment request using your saved
                                        delivery choice.{" "}
                                        {preferences.payment === "card" && (
                                            <>
                                                <strong>
                                                    Your saved card may be
                                                    charged immediately, without
                                                    another confirmation.
                                                </strong>{" "}
                                                Bank authentication (3-D Secure)
                                                or a CVV request must be
                                                completed in Vinted. Vintrack
                                                never saves your card number or
                                                CVV.{" "}
                                            </>
                                        )}
                                        Wallet funds can complete a purchase
                                        without another confirmation. Vintrack
                                        stops when wallet funds are applied,
                                        amounts cannot be verified or the total
                                        exceeds your limit, but an external
                                        confirmation window is not guaranteed.
                                        Check your limit and delivery settings
                                        before enabling this. An item
                                        reservation is not guaranteed. Never
                                        repeat a payment with an unclear
                                        outcome.
                                    </div>
                                    <div className="space-y-2">
                                        <Label htmlFor="checkout-max-total">
                                            Maximum order total (EUR, including
                                            shipping and fees)
                                        </Label>
                                        <input
                                            id="checkout-max-total"
                                            type="text"
                                            inputMode="decimal"
                                            className="border-input bg-background h-10 w-full rounded-md border px-3 text-sm"
                                            disabled={pending}
                                            value={maxTotal}
                                            placeholder="e.g. 30.00"
                                            onChange={(event) => {
                                                setMaxTotal(event.target.value);
                                                setWarningAccepted(false);
                                            }}
                                        />
                                    </div>
                                    <Label className="flex items-start gap-2 leading-5">
                                        <input
                                            type="checkbox"
                                            checked={warningAccepted}
                                            disabled={pending}
                                            onChange={(event) =>
                                                setWarningAccepted(
                                                    event.target.checked,
                                                )
                                            }
                                        />
                                        I understand{" "}
                                        {preferences.payment === "card"
                                            ? "that my card may be charged immediately"
                                            : "the payment risk"}{" "}
                                        and enable auto-checkout within this
                                        limit.
                                    </Label>
                                </div>
                            )}
                        </div>
                        <Button
                            disabled={
                                !loaded ||
                                pending ||
                                !checkoutEnabled ||
                                !validAutoCheckout
                            }
                            onClick={() =>
                                startTransition(async () => {
                                    try {
                                        if (
                                            autoEnabled &&
                                            riskConsentVersion !==
                                                CHECKOUT_RISK_WARNING_VERSION
                                        ) {
                                            await requestCheckoutConsent();
                                            setRiskConsentVersion(
                                                CHECKOUT_RISK_WARNING_VERSION,
                                            );
                                        }
                                        const nextPreferences: CheckoutPreferences =
                                            {
                                                shipping: preferences.shipping,
                                                payment: preferences.payment,
                                                ...(autoEnabled
                                                    ? {
                                                          autoCheckout: {
                                                              warningVersion:
                                                                  autoCheckoutWarningVersion(
                                                                      preferences.payment,
                                                                  ),
                                                              maxTotalMinor,
                                                              currency:
                                                                  "EUR" as const,
                                                          },
                                                      }
                                                    : {}),
                                            };
                                        const result =
                                            await saveCheckoutPreferences(
                                                nextPreferences,
                                            );
                                        if (result.error)
                                            toast.error(result.error);
                                        else {
                                            setSavedPreferences(
                                                nextPreferences,
                                            );
                                            toast.success(
                                                "Checkout preferences saved.",
                                            );
                                        }
                                    } catch {
                                        toast.error(
                                            "Checkout preferences could not be saved.",
                                        );
                                    }
                                })
                            }
                        >
                            {pending ? "Saving…" : "Save checkout preferences"}
                        </Button>
                    </div>
                )}
            </CardContent>
        </Card>
    );
}
