"use client";

import { useEffect, useId, useState } from "react";
import { getSavedDiscordWebhooks } from "@/actions/discord-webhooks";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

export function SavedDiscordWebhookSelect({
    value,
    onChange,
    disabled = false,
}: {
    value: string;
    onChange: (url: string) => void;
    disabled?: boolean;
}) {
    const id = useId();
    const [webhooks, setWebhooks] = useState<
        Awaited<ReturnType<typeof getSavedDiscordWebhooks>>
    >([]);
    const [status, setStatus] = useState<"loading" | "ready" | "error">(
        "loading",
    );
    const [attempt, setAttempt] = useState(0);

    useEffect(() => {
        let cancelled = false;
        getSavedDiscordWebhooks().then(
            (saved) => {
                if (cancelled) return;
                setWebhooks(saved);
                setStatus("ready");
            },
            () => {
                if (!cancelled) setStatus("error");
            },
        );
        return () => {
            cancelled = true;
        };
    }, [attempt]);

    if (status === "error") {
        return (
            <div
                className="text-muted-foreground flex items-center gap-2 text-xs"
                role="status"
            >
                <span>Saved webhooks could not be loaded.</span>
                <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                        setStatus("loading");
                        setAttempt((current) => current + 1);
                    }}
                >
                    Retry
                </Button>
            </div>
        );
    }

    const selected = webhooks.find((webhook) => webhook.url === value.trim());

    return (
        <div className="space-y-1.5">
            {(status === "loading" || webhooks.length > 0) && (
                <>
                    <Label htmlFor={id} className="text-xs">
                        Saved Discord webhooks
                    </Label>
                    <select
                        id={id}
                        value={selected?.id ?? ""}
                        disabled={disabled || status === "loading"}
                        onChange={(event) => {
                            const webhook = webhooks.find(
                                (entry) =>
                                    String(entry.id) === event.target.value,
                            );
                            onChange(webhook?.url ?? "");
                        }}
                        className="border-input bg-background focus-visible:ring-ring w-full min-w-0 rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:outline-none disabled:opacity-50"
                    >
                        <option value="">
                            {status === "loading"
                                ? "Loading saved webhooks…"
                                : "Enter a new webhook"}
                        </option>
                        {webhooks.map((webhook) => (
                            <option key={webhook.id} value={webhook.id}>
                                {webhook.name} · {webhook.webhookId}
                            </option>
                        ))}
                    </select>
                </>
            )}
            <p className="text-muted-foreground text-xs">
                Webhooks are remembered for your account when you save.
            </p>
        </div>
    );
}
