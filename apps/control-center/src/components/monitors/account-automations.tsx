"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
    MessageSquare,
    BadgePercent,
    Loader2,
    Sparkles,
    History,
    ArrowRight,
    Clock3,
    ShieldCheck,
} from "lucide-react";
import { Tabs } from "radix-ui";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { saveAccountAutomation } from "@/actions/account-automations";
import {
    DEFAULT_AUTOMATION_SETTINGS,
    MESSAGE_PLACEHOLDERS,
    automationValidationError,
    parsePriceLimit,
    renderAutomationMessage,
    type AutomationKind,
    type AutomationSettings,
} from "@/lib/account-automations";

export type AutomationAttemptView = {
    id: string;
    itemId: string;
    kind: string;
    status: string;
    reason: string;
    createdAt: string;
};

const REASONS: Record<string, string> = {
    upstream_outcome_unverified:
        "Outcome unverified. Check Vinted; this action will not be repeated.",
    service_interrupted:
        "Service interrupted. Check Vinted; this action will not be repeated.",
    feature_unavailable: "Module access unavailable",
    region_mismatch: "Linked region changed",
    currency_mismatch: "Listing currency does not match the monitor region",
    settings_unavailable: "Module settings changed or access is unavailable",
    invalid_price_or_template: "Price limit exceeded or message invalid",
    linked_account_unavailable: "Linked account unavailable",
    invalid_target: "Item or seller unavailable",
    session_refresh_required: "Refresh your Vinted session",
    match_expired: "Match expired before sending",
};

function AutomationModule({
    monitorId,
    kind,
    initial,
    available,
    running,
    pauseReason,
    currency,
    monitorName,
}: {
    monitorId: number;
    kind: AutomationKind;
    initial: AutomationSettings;
    available: boolean;
    running: boolean;
    pauseReason: string;
    currency: string;
    monitorName: string;
}) {
    const router = useRouter();
    const templateRef = useRef<HTMLTextAreaElement>(null);
    const [settings, setSettings] = useState(initial);
    const [priceLimit, setPriceLimit] = useState(
        (initial.maxPriceMinor / 100).toFixed(2),
    );
    const [pending, startTransition] = useTransition();
    const effectiveSettings = {
        ...settings,
        maxPriceMinor: parsePriceLimit(priceLimit) ?? 0,
    };
    const error = automationValidationError(kind, effectiveSettings);
    const dirty = JSON.stringify(effectiveSettings) !== JSON.stringify(initial);
    const Icon = kind === "offer" ? BadgePercent : MessageSquare;
    const title = kind === "offer" ? "Auto-Offer" : "Auto-Message";
    const preview = renderAutomationMessage(settings.messageTemplate, {
        title: "Vintage jacket",
        price: "25.00",
        currency,
        seller: "example_seller",
        url: "https://www.vinted.de/items/example",
        monitor: monitorName,
    });
    function insertPlaceholder(name: string) {
        const field = templateRef.current;
        const start = field?.selectionStart ?? settings.messageTemplate.length;
        const end = field?.selectionEnd ?? start;
        const token = `{${name}}`;
        setSettings({
            ...settings,
            messageTemplate:
                settings.messageTemplate.slice(0, start) +
                token +
                settings.messageTemplate.slice(end),
        });
        window.requestAnimationFrame(() => {
            field?.focus();
            field?.setSelectionRange(
                start + token.length,
                start + token.length,
            );
        });
    }
    const offerPreview =
        error || effectiveSettings.maxPriceMinor < 2500
            ? "Skipped"
            : `${((25 * (100 - settings.discountPercent)) / 100).toFixed(2)} ${currency}`;
    function save(value: AutomationSettings) {
        startTransition(async () => {
            try {
                const result = await saveAccountAutomation(
                    monitorId,
                    kind,
                    value,
                );
                if (result.error) {
                    toast.error(result.error);
                    return;
                }
                toast.success(
                    value.enabled
                        ? `${title} enabled for new matches`
                        : `${title} disabled`,
                );
                router.refresh();
            } catch {
                toast.error("The module could not be saved. Please try again.");
            }
        });
    }
    return (
        <section className="flex h-full min-h-0 flex-col">
            <div className="mb-3 flex shrink-0 items-center gap-3 sm:mb-4">
                <Icon className="text-muted-foreground h-4 w-4" />
                <div className="min-w-0 flex-1">
                    <h3 className="text-sm font-semibold">{title}</h3>
                    <p className="text-muted-foreground mt-0.5 text-xs">
                        {kind === "offer"
                            ? "Offer on new matches."
                            : "Message new matches."}
                    </p>
                </div>
                <span
                    className={cn(
                        "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium",
                        initial.enabled
                            ? running
                                ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                                : "bg-amber-500/10 text-amber-700 dark:text-amber-400"
                            : "bg-muted text-muted-foreground",
                    )}
                >
                    {initial.enabled ? (running ? "Active" : "Paused") : "Off"}
                </span>
                <Switch
                    aria-label={`Enable ${title}`}
                    checked={settings.enabled}
                    disabled={pending || (!available && !initial.enabled)}
                    onCheckedChange={(enabled) => {
                        setSettings((previous) => ({ ...previous, enabled }));
                        // A saved module switches off immediately. Enabling requires saving the configured action.
                        if (!enabled && initial.enabled)
                            save({ ...effectiveSettings, enabled: false });
                    }}
                />
            </div>
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
                {kind === "offer" ? (
                    <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-2">
                            <Label htmlFor={`discount-${monitorId}`}>
                                Discount (%)
                            </Label>
                            <Input
                                id={`discount-${monitorId}`}
                                type="number"
                                min="1"
                                max="50"
                                value={settings.discountPercent}
                                disabled={pending || !available}
                                onChange={(event) =>
                                    setSettings({
                                        ...settings,
                                        discountPercent: Number(
                                            event.target.value,
                                        ),
                                    })
                                }
                            />
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor={`price-limit-${monitorId}`}>
                                Max. listing price ({currency})
                            </Label>
                            <Input
                                id={`price-limit-${monitorId}`}
                                inputMode="decimal"
                                value={priceLimit}
                                disabled={pending || !available}
                                onChange={(event) =>
                                    setPriceLimit(event.target.value)
                                }
                            />
                        </div>
                        <div className="bg-muted/40 col-span-2 rounded-lg border p-4">
                            <p className="text-muted-foreground mb-3 text-[11px] font-medium">
                                Offer preview
                            </p>
                            <div className="flex items-center justify-between gap-3">
                                <div>
                                    <p className="text-muted-foreground text-xs">
                                        Listing price
                                    </p>
                                    <p className="mt-1 text-lg font-semibold tabular-nums">
                                        25.00 {currency}
                                    </p>
                                </div>
                                <ArrowRight className="text-muted-foreground h-4 w-4 shrink-0" />
                                <div className="text-right">
                                    <p className="text-muted-foreground text-xs">
                                        Your offer
                                    </p>
                                    <p className="mt-1 text-lg font-semibold tabular-nums">
                                        {offerPreview}
                                    </p>
                                </div>
                            </div>
                            <p className="text-muted-foreground mt-3 border-t pt-3 text-xs leading-5">
                                {effectiveSettings.maxPriceMinor < 2500
                                    ? "This listing exceeds your price limit."
                                    : "Over-limit listings are skipped. Shipping and fees are excluded."}
                            </p>
                        </div>
                    </div>
                ) : (
                    <div className="space-y-2">
                        <Label htmlFor={`message-template-${monitorId}`}>
                            Message template
                        </Label>
                        <textarea
                            className="border-input bg-background focus-visible:ring-ring/50 flex h-[64px] min-h-[64px] w-full rounded-md border px-3 py-2 text-sm shadow-xs focus-visible:ring-[3px] focus-visible:outline-none disabled:opacity-50 sm:h-[78px]"
                            ref={templateRef}
                            id={`message-template-${monitorId}`}
                            value={settings.messageTemplate}
                            rows={3}
                            disabled={pending || !available}
                            onChange={(event) =>
                                setSettings({
                                    ...settings,
                                    messageTemplate: event.target.value,
                                })
                            }
                        />
                        <div
                            className="flex flex-wrap gap-1.5"
                            aria-label="Message placeholders"
                        >
                            {MESSAGE_PLACEHOLDERS.map((name) => (
                                <button
                                    key={name}
                                    type="button"
                                    aria-label={`Insert {${name}}`}
                                    disabled={pending || !available}
                                    onClick={() => insertPlaceholder(name)}
                                    className="bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring/50 rounded-md border px-2 py-1 font-mono text-[10px] outline-none focus-visible:ring-2 disabled:opacity-50"
                                >
                                    {`{${name}}`}
                                </button>
                            ))}
                        </div>
                        <div className="bg-muted/40 rounded-lg border p-2.5 sm:min-h-[88px] sm:p-3">
                            <p className="text-muted-foreground mb-1 text-xs font-medium">
                                Preview
                            </p>
                            <p className="max-h-20 overflow-y-auto text-sm break-words whitespace-pre-wrap">
                                {preview ||
                                    "Your message preview appears here."}
                            </p>
                        </div>
                    </div>
                )}
                {initial.enabled && !running && available && (
                    <p className="text-muted-foreground text-xs">
                        {pauseReason}
                    </p>
                )}
                {!available && (
                    <p className="text-muted-foreground text-xs">
                        Link an active Vinted account for this monitor’s region
                        and enable module access.{" "}
                        <Link className="underline" href="/account">
                            Account settings
                        </Link>
                    </p>
                )}
                {settings.enabled && dirty && (
                    <p className="text-muted-foreground text-xs">
                        Unsaved changes. Save to apply them to future matches.
                    </p>
                )}
                {settings.enabled && error && (
                    <p role="alert" className="text-destructive text-xs">
                        {error}
                    </p>
                )}
            </div>
            <div className="mt-3 shrink-0 border-t pt-3 sm:mt-4">
                <Button
                    size="sm"
                    className="w-full"
                    disabled={
                        pending ||
                        !dirty ||
                        (settings.enabled && (!available || Boolean(error)))
                    }
                    onClick={() => save(effectiveSettings)}
                >
                    {pending && (
                        <Loader2 className="mr-2 h-3 w-3 animate-spin" />
                    )}
                    {settings.enabled
                        ? initial.enabled
                            ? "Save changes"
                            : "Save & enable"
                        : "Save disabled"}
                </Button>
            </div>
        </section>
    );
}

export function AccountAutomations({
    monitorId,
    monitorName,
    currency,
    offer,
    message,
    offerAvailable,
    messageAvailable,
    monitorActive = true,
    pausedUntil,
    attempts,
}: {
    monitorId: number;
    monitorName: string;
    currency: string;
    offer?: AutomationSettings;
    message?: AutomationSettings;
    offerAvailable: boolean;
    messageAvailable: boolean;
    monitorActive?: boolean;
    pausedUntil?: string;
    attempts: AutomationAttemptView[];
}) {
    const [expiredPause, setExpiredPause] = useState<string>();
    useEffect(() => {
        if (!pausedUntil) return;
        const timer = window.setTimeout(
            () => setExpiredPause(pausedUntil),
            Math.max(0, Date.parse(pausedUntil) - Date.now()),
        );
        return () => window.clearTimeout(timer);
    }, [pausedUntil]);
    const temporarilyPaused = Boolean(
        pausedUntil && expiredPause !== pausedUntil,
    );
    const offerRunning = offerAvailable && monitorActive && !temporarilyPaused;
    const messageRunning =
        messageAvailable && monitorActive && !temporarilyPaused;
    const pauseReason = !monitorActive
        ? "Resume this monitor to start automatic actions."
        : "Paused after an unverified action. Check Vinted before sending manually.";
    const enabledCount =
        Number(Boolean(offer?.enabled)) + Number(Boolean(message?.enabled));
    const activeCount =
        Number(Boolean(offer?.enabled && offerRunning)) +
        Number(Boolean(message?.enabled && messageRunning));
    const status =
        activeCount > 0
            ? `${activeCount} active`
            : enabledCount > 0
              ? "Paused"
              : "Off";
    const tabClassName =
        "text-muted-foreground data-[state=active]:text-foreground data-[state=active]:bg-background data-[state=active]:shadow-sm focus-visible:ring-ring/50 inline-flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-2 text-xs whitespace-nowrap font-medium outline-none focus-visible:ring-2";

    return (
        <Dialog>
            <DialogTrigger asChild>
                <Button
                    variant="outline"
                    size="sm"
                    className="h-8 gap-1.5 text-xs font-medium"
                    title={`Automations: ${status}. Configure automatic offers and messages.`}
                >
                    <Sparkles className="h-3.5 w-3.5" />
                    Automations
                    <span
                        className={cn(
                            "rounded px-1.5 py-0.5 text-[10px] leading-none",
                            activeCount > 0
                                ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                                : enabledCount > 0
                                  ? "bg-amber-500/10 text-amber-700 dark:text-amber-400"
                                  : "bg-muted text-muted-foreground",
                        )}
                    >
                        {status}
                    </span>
                </Button>
            </DialogTrigger>
            <DialogContent className="h-[560px] max-h-[calc(100dvh-2rem)] grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0 sm:max-w-[520px]">
                <DialogHeader className="border-b px-5 py-4 text-left">
                    <DialogTitle className="flex items-center gap-2 pr-6">
                        <Sparkles className="text-muted-foreground h-4 w-4" />
                        Automations
                    </DialogTitle>
                    <DialogDescription className="truncate text-xs">
                        {monitorName} · Automatic actions for new matches
                    </DialogDescription>
                </DialogHeader>
                <Tabs.Root
                    defaultValue="offer"
                    className="flex min-h-0 flex-col"
                >
                    <Tabs.List
                        aria-label="Automation settings"
                        className="bg-muted/60 mx-5 mt-4 flex shrink-0 gap-1 rounded-lg p-1"
                    >
                        <Tabs.Trigger
                            value="offer"
                            aria-label="Auto-Offer"
                            className={tabClassName}
                        >
                            <BadgePercent className="h-3.5 w-3.5" />
                            <span className="hidden sm:inline">Auto-Offer</span>
                            <span className="sm:hidden">Offer</span>
                            {offer?.enabled && (
                                <span
                                    className={cn(
                                        "h-1.5 w-1.5 shrink-0 rounded-full",
                                        offerRunning
                                            ? "bg-emerald-500"
                                            : "bg-amber-500",
                                    )}
                                    aria-label={
                                        offerRunning ? "Active" : "Paused"
                                    }
                                />
                            )}
                        </Tabs.Trigger>
                        <Tabs.Trigger
                            value="message"
                            aria-label="Auto-Message"
                            className={tabClassName}
                        >
                            <MessageSquare className="h-3.5 w-3.5" />
                            <span className="hidden sm:inline">
                                Auto-Message
                            </span>
                            <span className="sm:hidden">Message</span>
                            {message?.enabled && (
                                <span
                                    className={cn(
                                        "h-1.5 w-1.5 shrink-0 rounded-full",
                                        messageRunning
                                            ? "bg-emerald-500"
                                            : "bg-amber-500",
                                    )}
                                    aria-label={
                                        messageRunning ? "Active" : "Paused"
                                    }
                                />
                            )}
                        </Tabs.Trigger>
                        <Tabs.Trigger value="activity" className={tabClassName}>
                            <History className="h-3.5 w-3.5" /> Activity
                        </Tabs.Trigger>
                    </Tabs.List>
                    <div className="min-h-0 flex-1 px-5 py-4">
                        <Tabs.Content
                            value="offer"
                            forceMount
                            className="h-full min-h-0 outline-none data-[state=inactive]:hidden"
                        >
                            <AutomationModule
                                key={`offer-${JSON.stringify(offer)}`}
                                monitorId={monitorId}
                                monitorName={monitorName}
                                kind="offer"
                                currency={currency}
                                initial={offer ?? DEFAULT_AUTOMATION_SETTINGS}
                                available={offerAvailable}
                                running={offerRunning}
                                pauseReason={pauseReason}
                            />
                        </Tabs.Content>
                        <Tabs.Content
                            value="message"
                            forceMount
                            className="h-full min-h-0 outline-none data-[state=inactive]:hidden"
                        >
                            <AutomationModule
                                key={`message-${JSON.stringify(message)}`}
                                monitorId={monitorId}
                                monitorName={monitorName}
                                kind="message"
                                currency={currency}
                                initial={message ?? DEFAULT_AUTOMATION_SETTINGS}
                                available={messageAvailable}
                                running={messageRunning}
                                pauseReason={pauseReason}
                            />
                        </Tabs.Content>
                        <Tabs.Content
                            value="activity"
                            className="flex h-full min-h-0 flex-col outline-none"
                        >
                            <div className="mb-3 flex items-center justify-between">
                                <h3 className="text-sm font-semibold">
                                    Recent activity
                                </h3>
                                <span className="text-muted-foreground text-[11px]">
                                    {attempts.length
                                        ? `Last ${attempts.length} attempts`
                                        : "No attempts yet"}
                                </span>
                            </div>
                            <div className="mb-3 grid shrink-0 grid-cols-3 gap-2">
                                {[
                                    { label: "Sent", status: "sent" },
                                    {
                                        label: "Check Vinted",
                                        status: "uncertain",
                                    },
                                    { label: "Skipped", status: "skipped" },
                                ].map(({ label, status }) => (
                                    <div
                                        key={status}
                                        className="bg-muted/40 rounded-lg border px-3 py-2"
                                    >
                                        <p className="text-lg font-semibold tabular-nums">
                                            {
                                                attempts.filter(
                                                    (attempt) =>
                                                        attempt.status ===
                                                        status,
                                                ).length
                                            }
                                        </p>
                                        <p className="text-muted-foreground text-[11px]">
                                            {label}
                                        </p>
                                    </div>
                                ))}
                            </div>
                            <div className="min-h-0 flex-1 overflow-y-auto">
                                {attempts.length === 0 ? (
                                    <div className="flex h-full min-h-36 flex-col items-center justify-center rounded-lg border border-dashed px-5 py-4 text-center">
                                        <History className="text-muted-foreground mx-auto mb-3 h-5 w-5" />
                                        <p className="text-sm font-medium">
                                            No automatic actions yet
                                        </p>
                                        <p className="text-muted-foreground mt-1 text-xs">
                                            Actions for new matches will appear
                                            here.
                                        </p>
                                    </div>
                                ) : (
                                    <div className="divide-y">
                                        {attempts.map((attempt) => (
                                            <div
                                                key={attempt.id}
                                                className="space-y-1.5 py-3 first:pt-0"
                                            >
                                                <div className="flex items-center justify-between gap-3 text-xs">
                                                    <span className="font-medium">
                                                        {attempt.kind ===
                                                        "offer"
                                                            ? "Auto-Offer"
                                                            : "Auto-Message"}{" "}
                                                        · {attempt.itemId}
                                                    </span>
                                                    <span
                                                        className={cn(
                                                            "shrink-0 rounded-full px-2 py-0.5 capitalize",
                                                            attempt.status ===
                                                                "sent"
                                                                ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                                                                : "bg-muted text-muted-foreground",
                                                        )}
                                                    >
                                                        {attempt.status ===
                                                        "uncertain"
                                                            ? "Check Vinted"
                                                            : attempt.status}
                                                    </span>
                                                </div>
                                                <p className="text-muted-foreground text-xs leading-5">
                                                    {REASONS[attempt.reason] ??
                                                        (attempt.status ===
                                                        "sent"
                                                            ? "Sent successfully"
                                                            : "Check Vinted before sending manually")}
                                                </p>
                                                <time
                                                    dateTime={attempt.createdAt}
                                                    className="text-muted-foreground block text-[10px]"
                                                >
                                                    {attempt.createdAt
                                                        .slice(0, 16)
                                                        .replace("T", " ")}{" "}
                                                    UTC
                                                </time>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                            <p className="text-muted-foreground mt-3 shrink-0 text-[11px] leading-5">
                                Matches expire after two minutes. Unverified
                                actions pause sending for 15 minutes and are
                                never retried. Reload to update activity.
                            </p>
                        </Tabs.Content>
                    </div>
                    <div className="bg-muted/30 text-muted-foreground flex shrink-0 items-center justify-between gap-3 border-t px-5 py-3 text-[11px]">
                        <span
                            className="flex items-center gap-1.5"
                            title="Safety cap per linked account, shared across all monitors."
                        >
                            <ShieldCheck className="h-3.5 w-3.5 shrink-0" />
                            500 / module / UTC day
                        </span>
                        <span className="flex items-center gap-1.5">
                            <Clock3 className="h-3.5 w-3.5 shrink-0" />
                            5s between actions
                        </span>
                    </div>
                </Tabs.Root>
            </DialogContent>
        </Dialog>
    );
}
