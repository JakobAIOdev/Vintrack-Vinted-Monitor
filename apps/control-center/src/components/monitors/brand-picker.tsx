"use client";

import { useState, useRef, useEffect, useMemo } from "react";
import { BRANDS, type Brand } from "@/lib/brands";
import { X, Search } from "lucide-react";

interface BrandPickerProps {
  selected: string[];
  onChange: (ids: string[]) => void;
}

export function BrandPicker({ selected, onChange }: BrandPickerProps) {
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
    if (!query.trim()) return BRANDS.slice(0, 50);
    const q = query.toLowerCase();
    return BRANDS.filter((b) => b.label.toLowerCase().includes(q)).slice(0, 50);
  }, [query]);

  const selectedBrands = useMemo(
    () =>
      selected
        .map((id) => BRANDS.find((b) => b.id === id))
        .filter(Boolean) as Brand[],
    [selected]
  );

  const toggle = (brand: Brand) => {
    if (selected.includes(brand.id)) {
      onChange(selected.filter((id) => id !== brand.id));
    } else {
      onChange([...selected, brand.id]);
      setQuery("");
    }
  };

  const remove = (id: string) => {
    onChange(selected.filter((s) => s !== id));
  };

  return (
    <div ref={ref} className="relative">
      {selectedBrands.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {selectedBrands.map((brand) => (
            <span
              key={brand.id}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-blue-50 text-blue-700 text-[12px] font-medium border border-blue-200"
            >
              {brand.label}
              <button
                type="button"
                onClick={() => remove(brand.id)}
                className="hover:text-blue-900"
              >
                <X className="w-3 h-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
        <input
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          placeholder="Marke suchen…"
          className="w-full h-9 pl-8 pr-3 rounded-md border border-slate-200 bg-white text-[13px] outline-none focus:ring-2 focus:ring-slate-900/10 focus:border-slate-300 transition-colors"
        />
      </div>

      {open && (
        <div className="absolute z-50 mt-1 w-full max-h-52 overflow-y-auto rounded-md border border-slate-200 bg-white shadow-lg">
          {filtered.length === 0 ? (
            <div className="px-3 py-2 text-[13px] text-muted-foreground">
              Keine Marke gefunden
            </div>
          ) : (
            filtered.map((brand) => {
              const isSelected = selected.includes(brand.id);
              return (
                <button
                  key={brand.id}
                  type="button"
                  onClick={() => toggle(brand)}
                  className={`w-full text-left px-3 py-1.5 text-[13px] hover:bg-slate-50 transition-colors flex items-center justify-between ${
                    isSelected ? "bg-slate-50 font-medium" : ""
                  }`}
                >
                  <span>{brand.label}</span>
                  {isSelected && (
                    <span className="text-[11px] text-slate-400">✓</span>
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
