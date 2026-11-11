"use client";

import { ITEM_STATUSES } from "@/lib/statuses";
import { cn } from "@/lib/utils";
import { Check } from "lucide-react";

interface StatusPickerProps {
    selected: string[];
    onChange: (ids: string[]) => void;
    locale?: string;
}

export function StatusPicker({
    selected,
    onChange,
    locale = "en",
}: StatusPickerProps) {
    const toggle = (id: string) => {
        if (selected.includes(id)) {
            onChange(selected.filter((value) => value !== id));
            return;
        }
        onChange([...selected, id]);
    };

    return (
        <div className="space-y-3">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {ITEM_STATUSES.map((status) => {
                    const isSelected = selected.includes(status.id);
                    return (
                        <button
                            key={status.id}
                            type="button"
                            onClick={() => toggle(status.id)}
                            className={`group rounded-xl border px-3 py-3 text-left transition-colors ${
                                isSelected
                                    ? "border-primary bg-accent text-accent-foreground shadow-sm"
                                    : "border-input bg-background hover:border-border hover:bg-muted/50"
                            }`}
                        >
                            <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                    <div className="flex items-center gap-2">
                                        <span className="text-[13px] font-medium">
                                            {status.labels[locale] ??
                                                status.label}
                                        </span>
                                    </div>
                                    <p className="text-muted-foreground mt-1 text-[12px] leading-5">
                                        {status.description}
                                    </p>
                                </div>
                                <span
                                    className={cn(
                                        "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition-colors",
                                        isSelected
                                            ? "border-primary bg-primary text-primary-foreground"
                                            : "border-input bg-background group-hover:border-primary/50 text-transparent",
                                    )}
                                >
                                    <Check className="h-3 w-3" />
                                </span>
                            </div>
                        </button>
                    );
                })}
            </div>
        </div>
    );
}
