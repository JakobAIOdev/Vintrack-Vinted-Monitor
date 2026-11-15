"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";

export function ExpandableSearch({
    value,
    onChange,
    label,
    clearLabel,
    closeLabel,
    placeholder,
}: {
    value: string;
    onChange: (value: string) => void;
    label: string;
    clearLabel: string;
    closeLabel: string;
    placeholder: string;
}) {
    const [expanded, setExpanded] = useState(Boolean(value));
    const inputId = useId();
    const inputRef = useRef<HTMLInputElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const wasExpanded = useRef(false);

    useEffect(() => {
        if (expanded) inputRef.current?.focus();
        else if (wasExpanded.current) triggerRef.current?.focus();
        wasExpanded.current = expanded;
    }, [expanded]);

    const close = () => {
        onChange("");
        setExpanded(false);
    };

    return (
        <div
            data-expanded={expanded}
            className="expandable-search bg-card ring-input focus-within:ring-ring relative h-8 max-w-full min-w-0 rounded-md shadow-xs ring-1 ring-inset"
            onKeyDown={(event) => {
                if (event.key === "Escape" && expanded) {
                    event.preventDefault();
                    event.stopPropagation();
                    close();
                }
            }}
        >
            <Search
                aria-hidden="true"
                className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2"
            />
            <button
                ref={triggerRef}
                type="button"
                hidden={expanded}
                aria-label={label}
                title={label}
                aria-expanded={expanded}
                aria-controls={inputId}
                onClick={() => setExpanded(true)}
                className="ui-action hover:bg-accent hover:text-accent-foreground h-full w-full rounded-md transition-colors"
            >
                <span className="sr-only">{label}</span>
            </button>
            <Input
                ref={inputRef}
                id={inputId}
                hidden={!expanded}
                type="search"
                aria-label={label}
                placeholder={placeholder}
                value={value}
                onChange={(event) => onChange(event.target.value)}
                className="h-full border-0 bg-transparent pr-8 pl-8 text-sm shadow-none focus-visible:ring-0 dark:bg-transparent [&::-webkit-search-cancel-button]:appearance-none"
            />
            {expanded && (
                <button
                    type="button"
                    aria-label={value ? clearLabel : closeLabel}
                    title={value ? clearLabel : closeLabel}
                    onClick={() => {
                        if (value) {
                            onChange("");
                            inputRef.current?.focus();
                        } else close();
                    }}
                    className="ui-action text-muted-foreground hover:bg-accent hover:text-foreground absolute top-0 right-0 flex h-full w-8 items-center justify-center rounded-r-md transition-colors"
                >
                    <X aria-hidden="true" className="size-3.5" />
                </button>
            )}
        </div>
    );
}
