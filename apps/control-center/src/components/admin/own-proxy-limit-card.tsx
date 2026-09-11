"use client";

import { useState } from "react";
import { toast } from "sonner";
import { setGlobalOwnProxyMonitorLimit } from "@/actions/admin";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function OwnProxyLimitCard({ initialLimit }: { initialLimit: number }) {
    const [value, setValue] = useState(String(initialLimit));
    const [saving, setSaving] = useState(false);
    const [result, setResult] = useState<string | null>(null);
    async function save() {
        setSaving(true);
        setResult(null);
        try {
            const { limit, pausedCount } =
                await setGlobalOwnProxyMonitorLimit(value);
            setValue(String(limit));
            const message = `Own proxy limit saved: ${limit}. ${pausedCount} monitor(s) paused.`;
            setResult(message);
            toast.success(message);
        } catch (error) {
            toast.error(
                error instanceof Error
                    ? error.message
                    : "Could not save own proxy limit",
            );
        } finally {
            setSaving(false);
        }
    }
    return (
        <section className="border-border/60 bg-card space-y-3 rounded-lg border p-5">
            <h3 className="text-sm font-semibold">
                Running Own Proxy Monitor Limit
            </h3>
            <p className="text-muted-foreground text-xs">
                Maximum active monitors across all of a member’s own proxy
                groups. Premium members, admins and confirmed donors are exempt.
                Free Pool and overall limits apply separately.
            </p>
            <p className="text-muted-foreground text-xs">
                Saving also applies the limit to existing monitors, keeping the
                oldest active and pausing newer excess monitors. Save again to
                retry an incomplete application. A value of 0 blocks starts.
            </p>
            <Label htmlFor="own-proxy-active-limit">
                Active own proxy monitors per member
            </Label>
            <div className="flex max-w-sm gap-2">
                <Input
                    id="own-proxy-active-limit"
                    type="number"
                    min={0}
                    step={1}
                    required
                    value={value}
                    onChange={(event) => setValue(event.target.value)}
                />
                <Button onClick={save} disabled={saving}>
                    {saving ? "Applying…" : "Save and apply"}
                </Button>
            </div>
            {result && (
                <p role="status" className="text-sm">
                    {result}
                </p>
            )}
        </section>
    );
}
