"use client";

import { useState, useSyncExternalStore } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { CHECKOUT_RISK_WARNING_VERSION } from "@/lib/checkout-consent";
import {
    finishCheckoutConsent,
    getCheckoutConsentPrompt,
    getServerCheckoutConsentPrompt,
    subscribeCheckoutConsent,
} from "@/lib/checkout-consent.client";

export function CheckoutRiskDialog() {
    const prompt = useSyncExternalStore(
        subscribeCheckoutConsent,
        getCheckoutConsentPrompt,
        getServerCheckoutConsentPrompt,
    );
    return prompt ? (
        <RiskPrompt
            key={String(prompt.autoCheckout)}
            autoCheckout={prompt.autoCheckout}
        />
    ) : null;
}

function RiskPrompt({ autoCheckout }: { autoCheckout: boolean }) {
    const [checked, setChecked] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    async function accept() {
        if (!checked || saving) return;
        setSaving(true);
        setError("");
        try {
            const response = await fetch("/api/checkout/consent", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    version: CHECKOUT_RISK_WARNING_VERSION,
                    accepted: true,
                }),
            });
            const data = await response.json();
            if (!response.ok || data.accepted !== true)
                throw new Error(
                    data.error ||
                        "Your acceptance could not be saved. Checkout has not started.",
                );
            finishCheckoutConsent(true);
        } catch (err) {
            setError(
                err instanceof Error
                    ? err.message
                    : "Your acceptance could not be saved. Checkout has not started.",
            );
            setSaving(false);
        }
    }
    return (
        <Dialog
            open
            onOpenChange={(open) => {
                if (!open && !saving) finishCheckoutConsent(false);
            }}
        >
            <DialogContent
                showCloseButton={false}
                className="flex max-h-[90dvh] flex-col overflow-hidden sm:max-w-xl"
                onEscapeKeyDown={(event) => {
                    if (saving) event.preventDefault();
                }}
                onInteractOutside={(event) => event.preventDefault()}
            >
                <DialogHeader className="shrink-0 text-left">
                    <div className="mb-2 flex size-10 items-center justify-center rounded-lg bg-amber-500/15 text-amber-600 dark:text-amber-400">
                        <AlertTriangle className="size-5" />
                    </div>
                    <DialogTitle className="text-xl">
                        Before you use checkout
                    </DialogTitle>
                    <DialogDescription>
                        Oneclick and auto-checkout are experimental. Please read
                        and accept these risks before continuing.
                    </DialogDescription>
                </DialogHeader>
                <div className="min-h-0 space-y-4 overflow-y-auto">
                    <div className="space-y-3 text-sm leading-6">
                        <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
                            <strong>
                                Your Vinted account may be restricted, suspended
                                or permanently banned.
                            </strong>{" "}
                            Vinted may treat automated checkout activity as a
                            violation of its rules. Vintrack cannot guarantee
                            that your account will remain accessible.
                        </p>
                        <p>
                            <strong>Errors can occur.</strong> Checkout can
                            fail, show outdated prices or delivery choices, or
                            produce an unclear result. Auto-checkout can start a
                            real payment; wallet funds or saved payment methods
                            may complete a purchase without another confirmation
                            window. Check your settings and total, and never
                            retry a payment with an unclear outcome.
                        </p>
                        <p>
                            <strong>Use at your own risk.</strong> To the extent
                            permitted by law, Vintrack and its developer accept
                            no liability for account restrictions, technical
                            errors, failed checkouts, unintended purchases or
                            resulting losses. This does not exclude liability
                            for intent, gross negligence, injury to life, body
                            or health, or other liability that cannot legally be
                            excluded.
                        </p>
                        {autoCheckout && (
                            <p className="font-medium">
                                Your saved auto-checkout mode is enabled. After
                                accepting, this buy link will continue and may
                                start a real payment.
                            </p>
                        )}
                    </div>
                    <label className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm leading-5">
                        <input
                            type="checkbox"
                            className="mt-1 size-4 shrink-0"
                            checked={checked}
                            disabled={saving}
                            onChange={(event) =>
                                setChecked(event.target.checked)
                            }
                        />
                        <span>
                            I have read and understand these risks and agree to
                            use checkout and auto-checkout at my own risk.
                        </span>
                    </label>
                    {error && (
                        <p role="alert" className="text-destructive text-sm">
                            {error}
                        </p>
                    )}
                </div>
                <DialogFooter className="shrink-0">
                    <Button
                        variant="outline"
                        disabled={saving}
                        onClick={() => finishCheckoutConsent(false)}
                    >
                        Cancel
                    </Button>
                    <Button
                        disabled={!checked || saving}
                        onClick={() => void accept()}
                    >
                        {saving && <Loader2 className="size-4 animate-spin" />}
                        {saving
                            ? "Saving acceptance…"
                            : "Accept risks and continue"}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
