"use client";

import { useState } from "react";
import { Bell, RefreshCw, Send, Shield } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
    getCheckoutNotificationsAdminState,
    saveCheckoutNotifications,
    testCheckoutNotifications,
    retryCheckoutNotifications,
} from "@/actions/admin-checkout-notifications";
import {
    ANONYMOUS_CHECKOUT_FIELDS,
    CHECKOUT_NOTIFICATION_FIELDS,
    CHECKOUT_NOTIFICATION_PREVIEW,
    CHECKOUT_OUTCOMES,
    buildCheckoutNotification,
    type CheckoutNotificationField,
} from "@/lib/checkout-notifications";

type AdminState = Awaited<
    ReturnType<typeof getCheckoutNotificationsAdminState>
>;

export function CheckoutNotificationsAdminPanel({
    initialState,
}: {
    initialState: AdminState;
}) {
    const [state, setState] = useState(initialState);
    const [settings, setSettings] = useState(initialState.settings);
    const [webhookUrl, setWebhookUrl] = useState("");
    const [removeWebhook, setRemoveWebhook] = useState(false);
    const [busy, setBusy] = useState(false);
    const [previewStatus, setPreviewStatus] = useState(
        "card_payment_confirmed",
    );
    const preview = buildCheckoutNotification(
        settings,
        { ...CHECKOUT_NOTIFICATION_PREVIEW, status: previewStatus },
        true,
    ).embeds[0];
    const anonymous = settings.fields.every(
        (key) =>
            !CHECKOUT_NOTIFICATION_FIELDS.find((field) => field.key === key)
                ?.personal,
    );
    const dirty =
        webhookUrl !== "" ||
        removeWebhook ||
        JSON.stringify(settings) !== JSON.stringify(state.settings);
    function toggleField(key: CheckoutNotificationField, checked: boolean) {
        setSettings((current) => ({
            ...current,
            fields: checked
                ? [...current.fields, key]
                : current.fields.filter((field) => field !== key),
        }));
    }
    async function run(action: () => Promise<void>) {
        setBusy(true);
        try {
            await action();
        } catch (error) {
            toast.error(
                error instanceof Error
                    ? error.message
                    : "Notification settings unavailable.",
            );
        } finally {
            setBusy(false);
        }
    }
    return (
        <section
            className="bg-card border-border/60 space-y-6 rounded-lg border p-4 sm:p-6"
            aria-label="Checkout notifications"
        >
            <div className="flex items-start justify-between gap-4">
                <div>
                    <h2 className="flex items-center gap-2 text-lg font-semibold">
                        <Bell className="size-5" />
                        Checkout notifications
                    </h2>
                    <p className="text-muted-foreground mt-1 text-sm">
                        Track Oneclick buy and Full checkout usage in Discord.
                        Each message shows whether a purchase was confirmed or
                        still needs payment.
                    </p>
                </div>
                <Switch
                    aria-label="Enable checkout notifications"
                    checked={settings.enabled}
                    disabled={busy}
                    onCheckedChange={(enabled) =>
                        setSettings((current) => ({ ...current, enabled }))
                    }
                />
            </div>
            <div className="grid gap-6 lg:grid-cols-2">
                <fieldset disabled={busy} className="space-y-5">
                    <div className="space-y-2">
                        <Label htmlFor="checkout-webhook">
                            Discord webhook URL
                        </Label>
                        <Input
                            id="checkout-webhook"
                            type="password"
                            autoComplete="off"
                            value={webhookUrl}
                            placeholder={
                                state.hasWebhook
                                    ? "Webhook saved · enter a URL to replace it"
                                    : "https://discord.com/api/webhooks/…"
                            }
                            onChange={(event) => {
                                setWebhookUrl(event.target.value);
                                setRemoveWebhook(false);
                            }}
                        />
                        <p className="text-muted-foreground text-xs">
                            {state.hasWebhook
                                ? "The saved webhook token is hidden. Leave blank to keep it."
                                : "Create a webhook in your Discord channel’s integration settings."}
                        </p>
                        {state.hasWebhook ? (
                            <label className="flex items-center gap-2 text-sm">
                                <input
                                    type="checkbox"
                                    checked={removeWebhook}
                                    onChange={(event) => {
                                        setRemoveWebhook(event.target.checked);
                                        if (event.target.checked)
                                            setSettings((current) => ({
                                                ...current,
                                                enabled: false,
                                            }));
                                    }}
                                />
                                Remove saved webhook
                            </label>
                        ) : null}
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="checkout-events">
                            Events to notify
                        </Label>
                        <select
                            id="checkout-events"
                            className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
                            value={settings.events}
                            onChange={(event) =>
                                setSettings((current) => ({
                                    ...current,
                                    events: event.target.value as
                                        | "all"
                                        | "confirmed",
                                }))
                            }
                        >
                            <option value="all">
                                Usage and confirmed purchases
                            </option>
                            <option value="confirmed">
                                Confirmed purchases only
                            </option>
                        </select>
                        <p className="text-muted-foreground text-xs">
                            PayPal redirects, pending payments and 3-D Secure
                            are never marked as a completed purchase. Payments
                            completed later outside Vintrack are not tracked.
                        </p>
                    </div>
                    <div className="space-y-3">
                        <div className="flex flex-wrap items-center gap-2">
                            <span className="mr-auto text-sm font-medium">
                                Message fields
                            </span>
                            <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() =>
                                    setSettings((current) => ({
                                        ...current,
                                        fields: [...ANONYMOUS_CHECKOUT_FIELDS],
                                    }))
                                }
                            >
                                <Shield className="size-3.5" />
                                Anonymized
                            </Button>
                            <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() =>
                                    setSettings((current) => ({
                                        ...current,
                                        fields: CHECKOUT_NOTIFICATION_FIELDS.map(
                                            (field) => field.key,
                                        ),
                                    }))
                                }
                            >
                                All details
                            </Button>
                        </div>
                        <div className="grid gap-3 sm:grid-cols-2">
                            {CHECKOUT_NOTIFICATION_FIELDS.map((field) => (
                                <label
                                    key={field.key}
                                    className="flex items-center gap-2 text-sm"
                                >
                                    <input
                                        type="checkbox"
                                        checked={settings.fields.includes(
                                            field.key,
                                        )}
                                        onChange={(event) =>
                                            toggleField(
                                                field.key,
                                                event.target.checked,
                                            )
                                        }
                                    />
                                    {field.label}
                                </label>
                            ))}
                        </div>
                        <p className="text-muted-foreground text-xs">
                            {anonymous
                                ? "Anonymized: no user, account or item identifiers are included."
                                : "Selected user, account or item details will be shared with everyone who can access the Discord channel."}{" "}
                            Status is always included. Payment method means the
                            selected method, without card or bank details.
                        </p>
                    </div>
                </fieldset>
                <div className="space-y-3">
                    <div className="flex items-center justify-between gap-2">
                        <p className="text-sm font-medium">Discord preview</p>
                        <select
                            aria-label="Preview checkout status"
                            className="border-input bg-background max-w-[65%] rounded-md border p-1.5 text-xs"
                            value={previewStatus}
                            onChange={(event) =>
                                setPreviewStatus(event.target.value)
                            }
                        >
                            <option value="card_payment_confirmed">
                                Confirmed purchase
                            </option>
                            <option value="checkout_prepared">
                                Prepared checkout
                            </option>
                            <option value="paypal_redirect_ready">
                                PayPal payment open
                            </option>
                        </select>
                    </div>
                    <div className="rounded-lg bg-[#313338] p-4 text-sm text-[#dbdee1]">
                        <p className="mb-3 font-semibold text-white">
                            Vintrack Checkout{" "}
                            <span className="rounded bg-indigo-500 px-1 text-[10px]">
                                APP
                            </span>
                        </p>
                        <div
                            className="rounded border-l-4 bg-[#2b2d31] p-4"
                            style={{
                                borderLeftColor: `#${preview.color.toString(16).padStart(6, "0")}`,
                            }}
                        >
                            <p className="mb-3 font-semibold text-white">
                                {preview.title}
                            </p>
                            <div className="grid grid-cols-2 gap-3">
                                {preview.fields.map((field) => (
                                    <div
                                        key={field.name}
                                        className={
                                            field.inline ? "" : "col-span-2"
                                        }
                                    >
                                        <p className="text-xs font-semibold text-white">
                                            {field.name}
                                        </p>
                                        <p className="mt-1 text-xs break-words">
                                            {field.value}
                                        </p>
                                    </div>
                                ))}
                            </div>
                            {preview.url ? (
                                <p className="mt-3 text-xs text-[#00a8fc]">
                                    Item link included
                                </p>
                            ) : null}
                            {preview.thumbnail ? (
                                <div className="mt-3 flex h-16 w-16 items-center justify-center rounded bg-[#41434a] text-center text-xs">
                                    Item image
                                </div>
                            ) : null}
                            <p className="mt-4 text-[11px] text-[#949ba4]">
                                Synthetic preview · no real purchase
                            </p>
                        </div>
                    </div>
                </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
                <Button
                    disabled={busy || !dirty}
                    onClick={() =>
                        run(async () => {
                            const next = await saveCheckoutNotifications({
                                ...settings,
                                webhookUrl,
                                removeWebhook,
                            });
                            setState(next);
                            setSettings(next.settings);
                            setWebhookUrl("");
                            setRemoveWebhook(false);
                            toast.success("Checkout notifications saved.");
                        })
                    }
                >
                    {busy ? "Working…" : "Save notifications"}
                </Button>
                <Button
                    variant="outline"
                    disabled={busy || dirty || !state.hasWebhook}
                    onClick={() =>
                        run(async () => {
                            await testCheckoutNotifications();
                            toast.success("Test notification sent.");
                        })
                    }
                >
                    <Send className="size-4" />
                    Send test notification
                </Button>
                <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() =>
                        run(async () =>
                            setState(
                                await getCheckoutNotificationsAdminState(),
                            ),
                        )
                    }
                >
                    <RefreshCw className="size-4" />
                    Refresh deliveries
                </Button>
                {dirty ? (
                    <span className="text-muted-foreground text-xs">
                        Save changes before sending a test.
                    </span>
                ) : null}
            </div>
            <div className="border-border/60 space-y-3 border-t pt-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-medium">
                        Delivery history{" "}
                        <span className="text-muted-foreground font-normal">
                            · last 24h: {state.counts.delivered || 0} sent,{" "}
                            {state.counts.failed || 0} failed,{" "}
                            {(state.counts.pending || 0) +
                                (state.counts.sending || 0)}{" "}
                            pending
                        </span>
                    </p>
                    <Button
                        size="sm"
                        variant="outline"
                        disabled={busy || dirty || !state.settings.enabled}
                        onClick={() =>
                            run(async () => {
                                setState(await retryCheckoutNotifications());
                                toast.success("Pending deliveries processed.");
                            })
                        }
                    >
                        Retry pending / failed (up to 10)
                    </Button>
                </div>
                <p className="text-muted-foreground text-xs">
                    Rate limits and server errors are retried up to three times.
                    Connection failures can have an uncertain delivery outcome;
                    retrying may duplicate a message. Undelivered notifications
                    remain available here. Retries use the current field
                    selection and cannot add previously excluded details.
                </p>
                {state.recent.length ? (
                    <div className="overflow-x-auto">
                        <table className="w-full text-left text-xs">
                            <thead className="text-muted-foreground">
                                <tr>
                                    <th className="p-2">Time</th>
                                    <th className="p-2">Method / outcome</th>
                                    <th className="p-2">Delivery</th>
                                    <th className="p-2">Attempts</th>
                                </tr>
                            </thead>
                            <tbody>
                                {state.recent.map((row) => (
                                    <tr
                                        key={row.id}
                                        className="border-border/60 border-t"
                                    >
                                        <td className="p-2 whitespace-nowrap">
                                            {new Date(
                                                row.created_at,
                                            ).toLocaleString()}
                                        </td>
                                        <td className="p-2">
                                            {row.method === "full_checkout"
                                                ? "Full checkout"
                                                : "Oneclick buy"}
                                            <p className="text-muted-foreground mt-1">
                                                {CHECKOUT_OUTCOMES[row.outcome]
                                                    ?.label || row.outcome}
                                            </p>
                                        </td>
                                        <td className="p-2">
                                            {row.status}
                                            {row.last_error ? (
                                                <p className="mt-1 text-red-500">
                                                    {row.last_error}
                                                </p>
                                            ) : null}
                                        </td>
                                        <td className="p-2">{row.attempts}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                ) : (
                    <p className="text-muted-foreground text-sm">
                        No checkout notifications yet.
                    </p>
                )}
            </div>
        </section>
    );
}
