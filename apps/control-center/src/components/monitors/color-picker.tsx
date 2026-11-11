"use client";

import { useState, useRef, useEffect, useMemo } from "react";
import { COLORS, type Color } from "@/lib/colors";
import { X, Search } from "lucide-react";

interface ColorPickerProps {
    selected: string[];
    onChange: (ids: string[]) => void;
}

export function ColorPicker({ selected, onChange }: ColorPickerProps) {
    const [query, setQuery] = useState("");
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        function handleClick(e: MouseEvent) {
            if (ref.current && !ref.current.contains(e.target as Node)) {
                setOpen(false);
            }
        }
        document.addEventListener("mousedown", handleClick);
        return () => document.removeEventListener("mousedown", handleClick);
    }, []);

    const filtered = useMemo(() => {
        if (!query.trim()) return COLORS;
        const q = query.toLowerCase();
        return COLORS.filter((c) => c.label.toLowerCase().includes(q));
    }, [query]);

    const selectedColors = useMemo(
        () =>
            selected
                .map((id) => COLORS.find((c) => c.id === id))
                .filter(Boolean) as Color[],
        [selected],
    );

    const toggle = (color: Color) => {
        if (selected.includes(color.id)) {
            onChange(selected.filter((id) => id !== color.id));
        } else {
            onChange([...selected, color.id]);
            setQuery("");
        }
    };

    const remove = (id: string) => {
        onChange(selected.filter((s) => s !== id));
    };

    function ColorDot({ hex, size = 14 }: { hex: string; size?: number }) {
        if (hex === "multi") {
            return (
                <span
                    className="border-input inline-block shrink-0 rounded-full border"
                    style={{
                        width: size,
                        height: size,
                        background:
                            "conic-gradient(red, yellow, lime, aqua, blue, magenta, red)",
                    }}
                />
            );
        }
        if (hex === "transparent") {
            return (
                <span
                    className="border-input inline-block shrink-0 rounded-full border"
                    style={{
                        width: size,
                        height: size,
                        background:
                            "linear-gradient(135deg, transparent 45%, #ef4444 45%, #ef4444 55%, transparent 55%), repeating-conic-gradient(#ffffff 0% 25%, #d4d4d8 0% 50%) 50% / 6px 6px",
                    }}
                />
            );
        }
        return (
            <span
                className="border-input inline-block shrink-0 rounded-full border"
                style={{ width: size, height: size, backgroundColor: hex }}
            />
        );
    }

    return (
        <div ref={ref} className="relative">
            {selectedColors.length > 0 && (
                <div className="mb-2 flex flex-wrap gap-1.5">
                    {selectedColors.map((color) => (
                        <span
                            key={color.id}
                            className="bg-primary text-primary-foreground border-primary inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[12px] font-medium"
                        >
                            <ColorDot hex={color.hex} size={12} />
                            {color.label}
                            <button
                                type="button"
                                onClick={() => remove(color.id)}
                                className="hover:text-foreground"
                            >
                                <X className="h-3 w-3" />
                            </button>
                        </span>
                    ))}
                </div>
            )}

            <div className="relative">
                <Search className="text-muted-foreground absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2" />
                <input
                    type="text"
                    value={query}
                    onChange={(e) => {
                        setQuery(e.target.value);
                        setOpen(true);
                    }}
                    onFocus={() => setOpen(true)}
                    placeholder="Search color"
                    className="border-input bg-background focus:border-border h-9 w-full rounded-md border pr-3 pl-8 text-[13px] transition-colors outline-none focus:ring-2 focus:ring-slate-900/10"
                />
            </div>

            {open && (
                <div className="border-input bg-background absolute z-50 mt-1 max-h-52 w-full overflow-y-auto rounded-md border shadow-lg">
                    {filtered.length === 0 ? (
                        <div className="text-muted-foreground px-3 py-2 text-[13px]">
                            No color found
                        </div>
                    ) : (
                        filtered.map((color) => {
                            const isSelected = selected.includes(color.id);
                            return (
                                <button
                                    key={color.id}
                                    type="button"
                                    onClick={() => toggle(color)}
                                    className={`hover:bg-muted flex w-full items-center justify-between px-3 py-1.5 text-left text-[13px] transition-colors ${
                                        isSelected
                                            ? "bg-accent text-accent-foreground font-medium"
                                            : ""
                                    }`}
                                >
                                    <span className="flex items-center gap-2">
                                        <ColorDot hex={color.hex} />
                                        {color.label}
                                    </span>
                                    {isSelected && (
                                        <span className="text-primary text-[11px]">
                                            ✓
                                        </span>
                                    )}
                                </button>
                            );
                        })
                    )}
                </div>
            )}
        </div>
    );
}
