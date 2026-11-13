"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

export function LocalCheckoutAgentCard() {
    const [status, setStatus] = useState<{
        available?: boolean;
        paired?: boolean;
        online?: boolean;
    }>({});
    const [code, setCode] = useState("");
    const [pending, setPending] = useState(false);
    const [origin, setOrigin] = useState("");
    useEffect(() => {
        setOrigin(window.location.origin);
        let active = true;
        const refresh = async () => {
            try {
                const response = await fetch("/api/checkout-agent/status", {
                    cache: "no-store",
                    signal: AbortSignal.timeout(8_000),
                });
                if (response.ok && active) setStatus(await response.json());
            } catch {
                if (active) setStatus({ available: false });
            }
        };
        void refresh();
        const timer = setInterval(() => void refresh(), 10_000);
        return () => {
            active = false;
            clearInterval(timer);
        };
    }, []);
    useEffect(() => {
        if (!code) return;
        const timer = setTimeout(() => setCode(""), 300_000);
        return () => clearTimeout(timer);
    }, [code]);
    return (
        <div
            className="space-y-3 rounded-md border p-4"
            id="local-checkout-agent"
        >
            <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-medium">
                    Local checkout agent · Experimental
                </p>
                <span className="text-muted-foreground text-xs" role="status">
                    {status.online
                        ? "Online"
                        : status.paired
                          ? "Paired · Offline"
                          : "Not paired"}
                </span>
            </div>
            <p className="text-muted-foreground text-xs leading-5">
                Runs checkout requests on your own computer and network. Keep
                the agent running; a browser is not required after setup.
                Clicked buy links can finish even after you close Vintrack. A
                valid Vinted session is still required.
            </p>
            <ol className="text-muted-foreground list-inside list-decimal space-y-2 text-xs leading-5">
                <li>
                    Get the checkout agent for your operating system from your
                    Vintrack administrator.
                </li>
                <li>
                    Run{" "}
                    <code className="break-all">
                        checkout-agent pair --server{" "}
                        {origin || "https://your-vintrack"}
                    </code>{" "}
                    and paste the one-time code below.
                </li>
                <li>
                    Run <code>checkout-agent run</code>, sync checkout session
                    context above, then choose “Local request agent” below.
                    Re-enable automatic payment separately if wanted.
                </li>
            </ol>
            <div className="flex flex-wrap gap-2">
                <Button
                    type="button"
                    variant="outline"
                    disabled={pending || status.available !== true}
                    onClick={async () => {
                        if (
                            !window.confirm(
                                "Pair your own computer as a checkout agent? For 30 days, until revoked, it may receive explicitly started checkout jobs plus the saved Vinted access token, the four synced checkout-context cookies (datadome, anon_id, _vinted_fr_session and v_udt), CSRF token and browser User-Agent from this Vintrack instance over HTTPS. Vinted sessions stay in agent memory. Refresh tokens and all other cookies are excluded. The device credential is saved in your local user profile. Pairing a replacement revokes the previous agent, and a new code replaces any earlier code. Share the code only with your own agent.",
                            )
                        )
                            return;
                        setPending(true);
                        try {
                            const response = await fetch(
                                "/api/checkout-agent/pair-code",
                                { method: "POST", cache: "no-store" },
                            );
                            const data = await response.json();
                            if (!response.ok)
                                throw new Error(
                                    data.error || "Pairing unavailable",
                                );
                            if (!/^[a-f0-9]{64}$/.test(data.code || ""))
                                throw new Error("Invalid pairing response");
                            setCode(data.code);
                        } catch (error) {
                            toast.error(
                                error instanceof Error
                                    ? error.message
                                    : "Pairing unavailable",
                            );
                        } finally {
                            setPending(false);
                        }
                    }}
                >
                    Create pairing code
                </Button>
                {status.paired && (
                    <Button
                        type="button"
                        variant="outline"
                        disabled={pending}
                        onClick={async () => {
                            setPending(true);
                            try {
                                const response = await fetch(
                                    "/api/checkout-agent/revoke",
                                    { method: "POST" },
                                );
                                if (!response.ok)
                                    throw new Error(
                                        "Agent could not be revoked",
                                    );
                                setCode("");
                                setStatus({
                                    available: true,
                                    paired: false,
                                    online: false,
                                });
                                toast.success("Checkout agent revoked.");
                            } catch {
                                toast.error("Agent could not be revoked.");
                            } finally {
                                setPending(false);
                            }
                        }}
                    >
                        Revoke agent
                    </Button>
                )}
            </div>
            {code && (
                <div className="flex flex-wrap items-end gap-2">
                    <label className="min-w-0 flex-1 space-y-1 text-xs">
                        One-time pairing code (expires in five minutes)
                        <input
                            type="password"
                            readOnly
                            value={code}
                            className="bg-background mt-1 h-9 w-full rounded-md border px-2"
                        />
                    </label>
                    <Button
                        type="button"
                        variant="outline"
                        onClick={() =>
                            void navigator.clipboard.writeText(code).then(
                                () => toast.success("Pairing code copied."),
                                () =>
                                    toast.error(
                                        "Select and copy the code manually.",
                                    ),
                            )
                        }
                    >
                        Copy code
                    </Button>
                </div>
            )}
            {status.available === false && (
                <p className="text-muted-foreground text-xs">
                    Agent pairing is unavailable. Ask your administrator to
                    apply the agent database migration and update the service.
                </p>
            )}
        </div>
    );
}
