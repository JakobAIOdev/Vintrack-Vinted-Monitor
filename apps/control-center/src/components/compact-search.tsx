"use client";

import { useRef } from "react";
import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export function CompactSearch({
    value,
    onChange,
    label,
    clearLabel,
    placeholder,
    className,
}: {
    value: string;
    onChange: (value: string) => void;
    label: string;
    clearLabel: string;
    placeholder: string;
    className?: string;
}) {
    const inputRef = useRef<HTMLInputElement>(null);

    return (
        <div className={cn("relative w-full min-w-0", className)}>
            <Search
                aria-hidden="true"
                className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2"
            />
            <Input
                ref={inputRef}
                type="search"
                aria-label={label}
                placeholder={placeholder}
                value={value}
                onChange={(event) => onChange(event.target.value)}
                className="bg-card h-8 pr-8 pl-8 text-sm shadow-none [&::-webkit-search-cancel-button]:appearance-none"
            />
            {value && (
                <button
                    type="button"
                    aria-label={clearLabel}
                    onClick={() => {
                        onChange("");
                        inputRef.current?.focus();
                    }}
                    className="text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-ring absolute top-0 right-0 flex size-8 items-center justify-center rounded-r-md focus-visible:ring-2 focus-visible:outline-none"
                >
                    <X aria-hidden="true" className="size-4" />
                </button>
            )}
        </div>
    );
}
