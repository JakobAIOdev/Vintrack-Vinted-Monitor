"use client";

import { REGIONS } from "@/lib/regions";
import { cn } from "@/lib/utils";

interface RegionPickerProps {
    selected: string;
    onChange: (code: string) => void;
}

export function RegionPicker({ selected, onChange }: RegionPickerProps) {
    return (
        <div
            className="grid grid-cols-2 gap-1.5 sm:grid-cols-4"
            role="group"
            aria-label="Vinted region"
            data-testid="region-picker"
        >
            {REGIONS.map((region) => {
                const isSelected = selected === region.code;
                return (
                    <button
                        key={region.code}
                        type="button"
                        aria-pressed={isSelected}
                        onClick={() => onChange(region.code)}
                        className={cn(
                            "focus-visible:ring-ring flex min-h-7 min-w-0 cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none",
                            isSelected
                                ? "border-primary bg-primary text-primary-foreground"
                                : "border-input bg-background text-muted-foreground hover:border-border hover:bg-muted",
                        )}
                    >
                        <span className="text-sm">{region.flag}</span>
                        <span className="truncate">{region.label}</span>
                    </button>
                );
            })}
        </div>
    );
}
