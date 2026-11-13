"use client";

import { useEffect, useRef, useState } from "react";
import {
    ArrowRight,
    BellRing,
    Check,
    ExternalLink,
    Star,
    X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import type {
    FirstAlertStarPrompt,
    FirstAlertStarResult,
} from "@/lib/first-alert-star";

const endpoint = "/api/github-rewards/first-alert";

export function FirstAlertStarCard() {
    const [prompt, setPrompt] = useState<FirstAlertStarPrompt | null>(null);
    const inFlight = useRef<Promise<FirstAlertStarResult> | null>(null);

    useEffect(() => {
        let cancelled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const check = async () => {
            if (document.visibilityState === "hidden") {
                timer = setTimeout(check, 60_000);
                return;
            }
            // Share the request across Strict Mode effect replays. A one-shot
            // claim must not be consumed by an effect whose result is discarded.
            inFlight.current ??= fetch(endpoint, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "claim" }),
            }).then(async (response) => {
                if (!response.ok) throw new Error("Prompt unavailable");
                return response.json() as Promise<FirstAlertStarResult>;
            });
            try {
                const result = await inFlight.current;
                if (cancelled) return;
                setPrompt(result.prompt);
                if (result.retry) timer = setTimeout(check, 60_000);
            } catch {
                // Optional encouragement must never interrupt normal monitoring.
                if (!cancelled) timer = setTimeout(check, 60_000);
            } finally {
                if (!cancelled) inFlight.current = null;
            }
        };
        void check();
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, []);

    if (!prompt) return null;

    const finish = (action: "dismissed" | "cta") => {
        setPrompt(null);
        void fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action }),
            keepalive: true,
        }).catch(() => {});
    };

    return (
        <aside
            aria-labelledby="first-alert-star-title"
            data-testid="first-alert-star-card"
            className="bg-card text-card-foreground relative rounded-xl border border-amber-500/30 p-4 sm:p-5"
        >
            <button
                type="button"
                aria-label="Dismiss first alert celebration"
                onClick={() => finish("dismissed")}
                className="text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-ring absolute top-1 right-1 flex size-11 items-center justify-center rounded-lg focus-visible:ring-2 focus-visible:outline-none"
            >
                <X aria-hidden="true" className="size-4" />
            </button>
            <div className="flex items-start gap-3 sm:gap-4">
                <div className="relative mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-xl bg-amber-500/10 text-amber-700 dark:text-amber-300">
                    <BellRing aria-hidden="true" className="size-5" />
                    <span className="bg-card absolute -right-1 -bottom-1 rounded-full p-0.5">
                        <Check
                            aria-hidden="true"
                            className="size-3.5 text-emerald-700 dark:text-emerald-300"
                        />
                    </span>
                </div>
                <div className="min-w-0 flex-1">
                    <p className="text-muted-foreground pr-7 text-xs font-medium">
                        First alert delivered
                    </p>
                    <h2
                        id="first-alert-star-title"
                        className="mt-1 pr-7 text-base font-semibold tracking-tight"
                    >
                        Your first find is in.
                    </h2>
                    <p className="text-muted-foreground mt-1.5 max-w-2xl text-sm leading-6">
                        Enjoying Vintrack? A GitHub star supports the project
                        and raises your active Free Pool monitor limit from{" "}
                        {prompt.currentLimit} to {prompt.starLimit}.
                    </p>
                    <div className="mt-4 flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:gap-5">
                        <Button
                            asChild
                            className="min-h-11 w-full bg-amber-400 text-slate-950 hover:bg-amber-300 sm:w-auto"
                        >
                            <a
                                href={prompt.repositoryUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={() => finish("cta")}
                            >
                                <Star
                                    aria-hidden="true"
                                    className="size-4 text-slate-950"
                                />
                                <span className="text-slate-950">
                                    Star Vintrack
                                </span>
                                <ExternalLink
                                    aria-hidden="true"
                                    className="size-3.5 opacity-60"
                                />
                            </a>
                        </Button>
                        <p className="text-muted-foreground flex items-center gap-2 text-xs">
                            <span>{prompt.currentLimit} active monitors</span>
                            <ArrowRight
                                aria-hidden="true"
                                className="size-3.5"
                            />
                            <span className="text-foreground font-medium">
                                {prompt.starLimit} with a star
                            </span>
                        </p>
                    </div>
                </div>
            </div>
        </aside>
    );
}
