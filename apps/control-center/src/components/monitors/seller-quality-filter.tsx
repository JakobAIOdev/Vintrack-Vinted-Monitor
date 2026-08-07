"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { ShieldCheck, Star } from "lucide-react";

const RATING_PRESETS = [4, 4.5, 4.8, 4.9];
const COUNT_PRESETS = [1, 5, 10, 50];

type SellerQualityFilterProps = {
    idPrefix: string;
    enabled: boolean;
    rating: number;
    ratingCount: number;
    onEnabledChange: (enabled: boolean) => void;
    onRatingChange: (rating: number) => void;
    onRatingCountChange: (count: number) => void;
};

function PresetButton({
    active,
    children,
    onClick,
}: {
    active: boolean;
    children: React.ReactNode;
    onClick: () => void;
}) {
    return (
        <button
            type="button"
            aria-pressed={active}
            onClick={onClick}
            className={cn(
                "h-8 rounded-md border px-2.5 text-xs font-semibold transition-all",
                active
                    ? "border-amber-400/70 bg-amber-400/15 text-amber-800 shadow-sm dark:border-amber-400/40 dark:text-amber-300"
                    : "border-border/70 bg-background/80 text-muted-foreground hover:text-foreground hover:border-amber-300",
            )}
        >
            {children}
        </button>
    );
}

export function SellerQualityFilter({
    idPrefix,
    enabled,
    rating,
    ratingCount,
    onEnabledChange,
    onRatingChange,
    onRatingCountChange,
}: SellerQualityFilterProps) {
    const ratingId = `${idPrefix}-min-seller-rating`;
    const countId = `${idPrefix}-min-seller-rating-count`;

    return (
        <div
            className={cn(
                "overflow-hidden rounded-xl border transition-colors",
                enabled
                    ? "via-background dark:via-background border-amber-300/70 bg-gradient-to-br from-amber-50/80 to-orange-50/40 dark:border-amber-500/25 dark:from-amber-500/10 dark:to-orange-500/5"
                    : "border-border/70 bg-muted/20",
            )}
            data-testid="seller-quality-filter"
        >
            <input
                type="hidden"
                name="min_seller_rating"
                value={enabled ? rating.toFixed(1) : ""}
            />
            <input
                type="hidden"
                name="min_seller_rating_count"
                value={enabled ? String(ratingCount) : ""}
            />

            <div className="flex items-center justify-between gap-4 p-4">
                <div className="flex min-w-0 items-start gap-3">
                    <span
                        className={cn(
                            "flex size-9 shrink-0 items-center justify-center rounded-lg border",
                            enabled
                                ? "border-amber-300/70 bg-amber-400/15 text-amber-700 dark:border-amber-400/30 dark:text-amber-300"
                                : "border-border/70 bg-background text-muted-foreground",
                        )}
                    >
                        <ShieldCheck className="size-4.5" />
                    </span>
                    <div className="min-w-0 space-y-0.5">
                        <Label
                            htmlFor={`${idPrefix}-seller-quality-enabled`}
                            className="text-[13px] font-semibold"
                        >
                            Seller quality
                        </Label>
                        <p className="text-muted-foreground text-[12px] leading-relaxed">
                            Require a proven rating before a listing is saved or
                            sent.
                        </p>
                    </div>
                </div>
                <Switch
                    id={`${idPrefix}-seller-quality-enabled`}
                    checked={enabled}
                    onCheckedChange={onEnabledChange}
                    aria-label="Enable seller quality filter"
                />
            </div>

            {enabled && (
                <div className="border-t border-amber-300/50 px-4 pt-4 pb-4 dark:border-amber-500/20">
                    <div className="grid gap-5 sm:grid-cols-2">
                        <div className="space-y-2.5">
                            <div className="flex items-center justify-between gap-2">
                                <Label htmlFor={ratingId} className="text-xs">
                                    Minimum stars
                                </Label>
                                <span className="inline-flex items-center gap-1 text-xs font-bold text-amber-700 dark:text-amber-300">
                                    <Star className="size-3 fill-current" />
                                    {rating.toFixed(1)}+
                                </span>
                            </div>
                            <div className="flex flex-wrap gap-1.5">
                                {RATING_PRESETS.map((preset) => (
                                    <PresetButton
                                        key={preset}
                                        active={rating === preset}
                                        onClick={() => onRatingChange(preset)}
                                    >
                                        {preset.toFixed(1)}
                                    </PresetButton>
                                ))}
                            </div>
                            <Input
                                id={ratingId}
                                aria-label="Minimum seller stars"
                                type="number"
                                min={1}
                                max={5}
                                step={0.1}
                                value={rating}
                                onChange={(event) => {
                                    const value =
                                        event.currentTarget.valueAsNumber;
                                    if (Number.isFinite(value))
                                        onRatingChange(value);
                                }}
                                onBlur={() =>
                                    onRatingChange(
                                        Math.min(
                                            5,
                                            Math.max(
                                                1,
                                                Math.round(rating * 10) / 10,
                                            ),
                                        ),
                                    )
                                }
                                className="bg-background/90 h-9"
                            />
                        </div>

                        <div className="space-y-2.5">
                            <div className="flex items-center justify-between gap-2">
                                <Label htmlFor={countId} className="text-xs">
                                    Minimum ratings
                                </Label>
                                <span className="text-xs font-bold text-amber-700 dark:text-amber-300">
                                    {ratingCount.toLocaleString()}+
                                </span>
                            </div>
                            <div className="flex flex-wrap gap-1.5">
                                {COUNT_PRESETS.map((preset) => (
                                    <PresetButton
                                        key={preset}
                                        active={ratingCount === preset}
                                        onClick={() =>
                                            onRatingCountChange(preset)
                                        }
                                    >
                                        {preset}+
                                    </PresetButton>
                                ))}
                            </div>
                            <Input
                                id={countId}
                                aria-label="Minimum seller rating count"
                                type="number"
                                min={1}
                                step={1}
                                value={ratingCount}
                                onChange={(event) => {
                                    const value =
                                        event.currentTarget.valueAsNumber;
                                    if (Number.isFinite(value)) {
                                        onRatingCountChange(value);
                                    }
                                }}
                                onBlur={() =>
                                    onRatingCountChange(
                                        Math.max(1, Math.round(ratingCount)),
                                    )
                                }
                                className="bg-background/90 h-9"
                            />
                        </div>
                    </div>

                    <div className="mt-4 flex items-start gap-2 rounded-lg border border-amber-300/60 bg-amber-100/55 px-3 py-2.5 text-[12px] leading-relaxed text-amber-950 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-100">
                        <Star className="mt-0.5 size-3.5 shrink-0 fill-amber-500 text-amber-500" />
                        <span>
                            Only sellers with{" "}
                            <strong>≥ {rating.toFixed(1)}★</strong> and{" "}
                            <strong>
                                ≥ {ratingCount.toLocaleString()} ratings
                            </strong>{" "}
                            will pass. Unrated or unavailable sellers are
                            excluded.
                        </span>
                    </div>
                </div>
            )}
        </div>
    );
}
