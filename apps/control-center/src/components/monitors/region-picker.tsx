"use client";

import { REGIONS } from "@/lib/regions";
import { cn } from "@/lib/utils";

interface RegionPickerProps {
  selected: string;
  onChange: (code: string) => void;
}

export function RegionPicker({ selected, onChange }: RegionPickerProps) {
  return (
    <div className="grid grid-cols-4 gap-1.5">
      {REGIONS.map((region) => {
        const isSelected = selected === region.code;
        return (
          <button
            key={region.code}
            type="button"
            onClick={() => onChange(region.code)}
            className={cn(
              "flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[12px] font-medium transition-colors",
              isSelected
                ? "border-slate-900 bg-slate-900 text-white"
                : "border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50"
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
