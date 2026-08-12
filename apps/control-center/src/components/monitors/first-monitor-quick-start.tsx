"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, CheckCircle2, Loader2, Rocket, Zap } from "lucide-react";
import { toast } from "sonner";
import {
    createPresetMonitor,
    dismissMonitorOnboarding,
} from "@/actions/monitor";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { MonitorPresetPicker } from "@/components/monitors/preset-picker";
import {
    getMonitorPreset,
    type MonitorPreset,
    type MonitorPresetKey,
} from "@/lib/monitor-presets";
import { REGIONS } from "@/lib/regions";

export type QuickStartPool = {
    enabled: boolean;
    minActivePerRegion: number;
    regions: Record<string, { healthy: boolean; usable: number }>;
};

function getDefaultReadyRegion(pool: QuickStartPool | null) {
    if (!pool?.enabled) return "";
    if (pool.regions.de) return "de";
    return REGIONS.find((region) => pool.regions[region.code])?.code ?? "";
}

export function FirstMonitorQuickStart({
    open,
    onOpenChange,
    initialPool,
    maintenanceEnabled = false,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    initialPool: QuickStartPool | null;
    maintenanceEnabled?: boolean;
}) {
    const router = useRouter();
    const [selectedPreset, setSelectedPreset] =
        useState<MonitorPresetKey | null>(null);
    const [pool, setPool] = useState<QuickStartPool | null>(initialPool);
    const [preferredRegion, setPreferredRegion] = useState(() =>
        getDefaultReadyRegion(initialPool),
    );
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [isLeaving, setIsLeaving] = useState(false);

    const configuredRegions = useMemo(
        () => REGIONS.filter((region) => pool?.regions[region.code]),
        [pool],
    );
    const selectedRegion =
        pool?.enabled && pool.regions[preferredRegion]
            ? preferredRegion
            : getDefaultReadyRegion(pool);
    const selectedRegionReady = Boolean(
        pool?.enabled && selectedRegion && pool.regions[selectedRegion],
    );
    const selectedPresetDefinition = useMemo(
        () => getMonitorPreset(selectedPreset)?.name ?? null,
        [selectedPreset],
    );

    const refreshPool = async () => {
        try {
            const response = await fetch("/api/proxy-groups", {
                cache: "no-store",
            });
            if (!response.ok) return;
            const data = await response.json();
            if (data.freeProxy) setPool(data.freeProxy as QuickStartPool);
        } catch {}
    };

    const persistDismissal = async () => {
        try {
            await dismissMonitorOnboarding();
        } catch {
            toast.error("Could not save your onboarding preference");
        }
    };

    const handleOpenChange = (nextOpen: boolean) => {
        onOpenChange(nextOpen);
        if (!nextOpen && !isSubmitting && !isLeaving) {
            void persistDismissal();
        }
    };

    const handlePresetSelect = (preset: MonitorPreset) => {
        setSelectedPreset(preset.key);
    };

    const handleCreate = async () => {
        if (!selectedPreset || !selectedRegionReady) return;

        setIsSubmitting(true);
        try {
            const result = await createPresetMonitor({
                presetKey: selectedPreset,
                region: selectedRegion,
            });

            if (!result.ok) {
                toast.error(result.message);
                if (result.code === "POOL_UNAVAILABLE") {
                    await refreshPool();
                }
                return;
            }

            toast.success(
                result.started
                    ? "Your demo monitor is running for 30 minutes"
                    : result.pauseReason === "maintenance"
                      ? "Monitor created paused while Vintrack is under maintenance"
                      : result.pauseReason === "free-proxy-limit"
                        ? "Monitor created and saved paused because your Free Proxy Pool monitor limit is reached"
                        : "Monitor created and saved paused because your active limit is reached",
            );
            router.push(result.redirectTo);
            router.refresh();
        } catch {
            toast.error("The monitor could not be created. Please try again.");
        } finally {
            setIsSubmitting(false);
        }
    };

    const handleManualSetup = async () => {
        setIsLeaving(true);
        onOpenChange(false);
        await persistDismissal();
        router.push("/monitors/new");
    };

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogContent
                data-testid="first-monitor-quick-start"
                className="max-h-[calc(100vh-2rem)] gap-0 overflow-y-auto p-0 sm:max-w-3xl"
            >
                <div className="border-border/60 bg-muted/20 border-b px-5 py-5 sm:px-7 sm:py-6">
                    <DialogHeader className="pr-7">
                        <div className="mb-1 flex items-center gap-2">
                            <span className="border-border/70 bg-background text-muted-foreground inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-semibold tracking-wider uppercase">
                                <Rocket className="size-3" /> Quick start · ~10
                                seconds
                            </span>
                        </div>
                        <DialogTitle className="text-xl sm:text-2xl">
                            Start your first monitor
                        </DialogTitle>
                        <DialogDescription className="max-w-2xl leading-6">
                            Choose a popular search. We configure it with
                            Vintrack&apos;s Free Proxy Pool — you can edit every
                            detail later. The demo runs for 30 minutes and can
                            be extended at any time.
                        </DialogDescription>
                    </DialogHeader>
                </div>

                <div className="space-y-5 px-5 py-5 sm:px-7 sm:py-6">
                    <MonitorPresetPicker
                        selected={selectedPreset}
                        onSelect={handlePresetSelect}
                    />

                    <div className="border-border/70 bg-muted/20 rounded-xl border p-4">
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                            <div>
                                <div className="flex items-center gap-2">
                                    <Zap className="size-4 text-emerald-600 dark:text-emerald-400" />
                                    <p className="text-sm font-semibold">
                                        Free Proxy Pool included
                                    </p>
                                </div>
                                <p className="text-muted-foreground mt-1 text-xs leading-5">
                                    Pick the Vinted region where you want to
                                    find listings.
                                </p>
                            </div>
                            <div className="flex min-w-0 items-center gap-2 sm:w-64">
                                {selectedRegionReady && (
                                    <CheckCircle2 className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                                )}
                                <select
                                    aria-label="Quick start region"
                                    value={selectedRegion}
                                    onChange={(event) =>
                                        setPreferredRegion(event.target.value)
                                    }
                                    className="border-input bg-background h-10 min-w-0 flex-1 rounded-md border px-3 text-sm outline-none focus:ring-2 focus:ring-slate-900 focus:ring-offset-1 dark:focus:ring-slate-300"
                                >
                                    {!selectedRegionReady && (
                                        <option value="">
                                            No ready regions
                                        </option>
                                    )}
                                    {configuredRegions.map((region) => {
                                        const health =
                                            pool?.regions[region.code];
                                        return (
                                            <option
                                                key={region.code}
                                                value={region.code}
                                            >
                                                {region.flag} {region.label} ·{" "}
                                                {health?.healthy
                                                    ? `Ready (${health.usable})`
                                                    : `Recovering (${health?.usable ?? 0})`}
                                            </option>
                                        );
                                    })}
                                </select>
                            </div>
                        </div>
                        {!selectedRegionReady && (
                            <p className="mt-3 text-xs leading-5 text-amber-700 dark:text-amber-300">
                                The Free Proxy Pool is disabled right now. You
                                can still set up a monitor manually with another
                                proxy source.
                            </p>
                        )}
                    </div>
                </div>

                <div className="border-border/60 bg-muted/15 flex flex-col-reverse gap-2 border-t px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-7">
                    <Button
                        type="button"
                        variant="ghost"
                        onClick={handleManualSetup}
                        disabled={isSubmitting || isLeaving}
                    >
                        Set up manually
                    </Button>
                    <Button
                        type="button"
                        data-testid="start-preset-monitor"
                        onClick={handleCreate}
                        disabled={
                            !selectedPreset ||
                            !selectedRegionReady ||
                            isSubmitting ||
                            isLeaving
                        }
                        className="gap-2 sm:min-w-52"
                    >
                        {isSubmitting ? (
                            <>
                                <Loader2 className="size-4 animate-spin" />
                                {maintenanceEnabled
                                    ? "Creating monitor…"
                                    : "Starting monitor…"}
                            </>
                        ) : selectedPresetDefinition ? (
                            <>
                                {maintenanceEnabled
                                    ? `Create ${selectedPresetDefinition} paused`
                                    : `Start ${selectedPresetDefinition}`}
                                <ArrowRight className="size-4" />
                            </>
                        ) : (
                            "Choose a preset"
                        )}
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}
