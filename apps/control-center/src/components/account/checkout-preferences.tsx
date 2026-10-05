"use client";

import { useEffect, useState, useTransition } from "react";
import {
    getCheckoutPreferenceSettings,
    saveCheckoutPreferences,
} from "@/actions/checkout-preferences";
import {
    DEFAULT_CHECKOUT_PREFERENCES,
    CHECKOUT_PAYMENT_LABELS,
    checkoutPaymentOptions,
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
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

export function CheckoutPreferencesCard({
    accountKey,
}: {
    accountKey: string;
}) {
    const [preferences, setPreferences] = useState<CheckoutPreferences>(
        DEFAULT_CHECKOUT_PREFERENCES,
    );
    const [loaded, setLoaded] = useState(false);
    const [domain, setDomain] = useState("");
    const [pending, startTransition] = useTransition();
    useEffect(() => {
        let cancelled = false;
        getCheckoutPreferenceSettings()
            .then((value) => {
                if (!cancelled) {
                    setPreferences(value.preferences);
                    setDomain(value.domain);
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
    return (
        <Card className="border-border/70 gap-0 overflow-hidden py-0 shadow-sm">
            <CardHeader className="border-b p-5">
                <CardTitle>Oneclick checkout</CardTitle>
                <CardDescription>
                    Choose what your notification checkout links should
                    preselect. Payment options follow your linked Vinted region
                    {domain
                        ? ` (${domain.replace("www.vinted.", "").toUpperCase()})`
                        : ""}
                    .
                </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 p-5">
                <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                        <Label htmlFor="checkout-shipping">Delivery</Label>
                        <select
                            id="checkout-shipping"
                            className="border-input bg-background h-10 w-full rounded-md border px-3 text-sm"
                            disabled={!loaded || pending}
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
                        <Label htmlFor="checkout-payment">Payment</Label>
                        <select
                            id="checkout-payment"
                            className="border-input bg-background h-10 w-full rounded-md border px-3 text-sm"
                            disabled={!loaded || pending}
                            value={preferences.payment}
                            onChange={(event) =>
                                setPreferences({
                                    ...preferences,
                                    payment: event.target
                                        .value as CheckoutPreferences["payment"],
                                })
                            }
                        >
                            {checkoutPaymentOptions(domain).map((payment) => (
                                <option key={payment} value={payment}>
                                    {CHECKOUT_PAYMENT_LABELS[payment]}
                                </option>
                            ))}
                        </select>
                    </div>
                </div>
                <p className="text-muted-foreground text-xs leading-5">
                    Vinted applies available wallet funds automatically. With
                    Wallet, review or choose the payment method for any
                    remaining amount in Vinted. Other choices apply to the
                    remainder. Vinted checks availability for each item and
                    device. Card preselection needs a saved card; if there is
                    more than one, choose it in Vinted first. Home delivery uses
                    the carrier Vinted preselects. Missing address, contact
                    details or unavailable options still need your attention.
                    You always confirm payment in Vinted.
                </p>
                <Button
                    disabled={!loaded || pending}
                    onClick={() =>
                        startTransition(async () => {
                            try {
                                const result =
                                    await saveCheckoutPreferences(preferences);
                                if (result.error) toast.error(result.error);
                                else
                                    toast.success(
                                        "Checkout preferences saved.",
                                    );
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
            </CardContent>
        </Card>
    );
}
