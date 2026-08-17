"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Loader2, TriangleAlert, X } from "lucide-react";
import {
    DEFAULT_SIZE_GROUP_ID,
    MAX_MONITOR_SIZES,
    type SizeSection,
} from "@/lib/sizes";
import { cn } from "@/lib/utils";

interface SizePickerProps {
    region: string;
    selected: string[];
    onChange: (ids: string[]) => void;
    defaultGroup?: string;
}

type SizeResponse = {
    sections?: SizeSection[];
    maxSelected?: number;
};

export function SizePicker({
    region,
    selected,
    onChange,
    defaultGroup,
}: SizePickerProps) {
    const [sections, setSections] = useState<SizeSection[]>([]);
    const [activeSection, setActiveSection] = useState<string>("men");
    const activeGroupRef = useRef(
        Number(defaultGroup) || DEFAULT_SIZE_GROUP_ID,
    );
    const [activeGroup, setActiveGroupState] = useState<number>(
        activeGroupRef.current,
    );
    const [dropdownOpen, setDropdownOpen] = useState(false);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState(false);
    const [maxSelected, setMaxSelected] = useState(MAX_MONITOR_SIZES);

    useEffect(() => {
        const controller = new AbortController();

        async function loadSizes() {
            setLoading(true);
            setLoadError(false);

            try {
                const response = await fetch(
                    `/api/sizes?region=${encodeURIComponent(region)}`,
                    { signal: controller.signal },
                );
                if (!response.ok) throw new Error("Unable to load sizes");

                const data = (await response.json()) as SizeResponse;
                const nextSections = data.sections ?? [];
                if (controller.signal.aborted) return;

                setSections(nextSections);
                setMaxSelected(data.maxSelected ?? MAX_MONITOR_SIZES);

                const currentGroup = activeGroupRef.current;
                const requestedGroup = Number(defaultGroup);
                const currentGroupExists = nextSections.some((section) =>
                    section.groups.some((group) => group.id === currentGroup),
                );
                const preferredGroup =
                    (Number.isInteger(requestedGroup) && requestedGroup) ||
                    (currentGroupExists && currentGroup) ||
                    DEFAULT_SIZE_GROUP_ID;
                const preferredSection = nextSections.find((section) =>
                    section.groups.some((group) => group.id === preferredGroup),
                );
                const fallbackSection = preferredSection ?? nextSections[0];
                const fallbackGroup =
                    fallbackSection?.groups.find(
                        (group) => group.id === preferredGroup,
                    ) ?? fallbackSection?.groups[0];

                if (fallbackSection && fallbackGroup) {
                    activeGroupRef.current = fallbackGroup.id;
                    setActiveSection(fallbackSection.key);
                    setActiveGroupState(fallbackGroup.id);
                }
            } catch {
                if (!controller.signal.aborted) setLoadError(true);
            } finally {
                if (!controller.signal.aborted) setLoading(false);
            }
        }

        loadSizes();
        return () => controller.abort();
    }, [region, defaultGroup]);

    const section =
        sections.find((candidate) => candidate.key === activeSection) ??
        sections[0];
    const group =
        section?.groups.find((candidate) => candidate.id === activeGroup) ??
        section?.groups[0];

    const selectedSizes = useMemo(() => {
        const labels = new Map<
            string,
            { groupLabel: string; sizeLabel: string }
        >();
        for (const candidateSection of sections) {
            for (const candidateGroup of candidateSection.groups) {
                for (const size of candidateGroup.sizes) {
                    labels.set(String(size.id), {
                        groupLabel: candidateGroup.label,
                        sizeLabel: size.label,
                    });
                }
            }
        }

        return selected.map((id) => ({
            id,
            groupLabel: labels.get(id)?.groupLabel,
            sizeLabel: labels.get(id)?.sizeLabel ?? id,
        }));
    }, [sections, selected]);

    const toggle = (id: number) => {
        const value = String(id);
        if (selected.includes(value)) {
            onChange(selected.filter((candidate) => candidate !== value));
            return;
        }
        if (selected.length >= maxSelected) return;
        onChange([...selected, value]);
    };

    const switchSection = (key: string) => {
        const nextSection = sections.find((candidate) => candidate.key === key);
        const nextGroup = nextSection?.groups[0];
        if (!nextSection || !nextGroup) return;

        setActiveSection(nextSection.key);
        activeGroupRef.current = nextGroup.id;
        setActiveGroupState(nextGroup.id);
        setDropdownOpen(false);
    };

    return (
        <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap gap-1.5">
                    {sections.map((candidate) => (
                        <button
                            key={candidate.key}
                            type="button"
                            data-testid={`size-section-${candidate.key}`}
                            onClick={() => switchSection(candidate.key)}
                            className={cn(
                                "rounded-full border px-2.5 py-1 text-[12px] font-medium transition-colors",
                                section?.key === candidate.key
                                    ? "border-primary bg-primary text-primary-foreground"
                                    : "border-input bg-background text-muted-foreground hover:bg-muted",
                            )}
                        >
                            {candidate.label}
                        </button>
                    ))}
                </div>
                <span
                    className={cn(
                        "text-[12px] font-medium tabular-nums",
                        selected.length >= maxSelected
                            ? "text-amber-600 dark:text-amber-400"
                            : "text-muted-foreground",
                    )}
                >
                    {selected.length}/{maxSelected} selected
                </span>
            </div>

            {selectedSizes.length > 0 && (
                <div
                    className="border-border/70 bg-muted/20 flex flex-wrap gap-1.5 rounded-xl border p-2.5"
                    data-testid="selected-size-chips"
                >
                    {selectedSizes.map((size) => (
                        <span
                            key={size.id}
                            className="border-primary/20 bg-primary/10 text-foreground inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[12px] font-medium"
                        >
                            <span className="max-w-[300px] truncate">
                                {size.groupLabel
                                    ? `${size.groupLabel} · ${size.sizeLabel}`
                                    : size.sizeLabel}
                            </span>
                            <button
                                type="button"
                                onClick={() =>
                                    onChange(
                                        selected.filter(
                                            (value) => value !== size.id,
                                        ),
                                    )
                                }
                                aria-label={`Remove ${size.sizeLabel}`}
                                className="text-muted-foreground hover:bg-background hover:text-foreground rounded-full p-0.5 transition-colors"
                            >
                                <X className="h-3 w-3" />
                            </button>
                        </span>
                    ))}
                </div>
            )}

            {loading && sections.length === 0 ? (
                <div className="text-muted-foreground flex min-h-24 items-center justify-center gap-2 text-[13px]">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Loading regional Vinted sizes…
                </div>
            ) : loadError && sections.length === 0 ? (
                <div className="border-destructive/30 bg-destructive/5 text-destructive flex items-center gap-2 rounded-lg border px-3 py-2 text-[12px]">
                    <TriangleAlert className="h-4 w-4 shrink-0" />
                    Regional sizes could not be loaded. Your existing selection
                    is unchanged.
                </div>
            ) : (
                <>
                    <div className="relative">
                        <button
                            type="button"
                            aria-label="Size group"
                            aria-expanded={dropdownOpen}
                            onClick={() => setDropdownOpen(!dropdownOpen)}
                            className="border-input bg-background hover:bg-muted flex h-9 w-full items-center justify-between rounded-md border px-3 text-left text-[13px] transition-colors"
                        >
                            <span className="truncate">
                                {group?.label ?? "Size group"}
                            </span>
                            <ChevronDown
                                className={cn(
                                    "text-muted-foreground h-3.5 w-3.5 shrink-0 transition-transform",
                                    dropdownOpen && "rotate-180",
                                )}
                            />
                        </button>
                        {dropdownOpen && section && (
                            <div className="border-input bg-background absolute z-50 mt-1 max-h-64 w-full overflow-y-auto rounded-md border shadow-lg">
                                {section.groups.map((candidate) => (
                                    <button
                                        key={candidate.id}
                                        type="button"
                                        onClick={() => {
                                            activeGroupRef.current =
                                                candidate.id;
                                            setActiveGroupState(candidate.id);
                                            setDropdownOpen(false);
                                        }}
                                        className={cn(
                                            "hover:bg-muted w-full px-3 py-1.5 text-left text-[13px] transition-colors",
                                            group?.id === candidate.id &&
                                                "bg-muted font-medium",
                                        )}
                                    >
                                        {candidate.label}
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>

                    {group && (
                        <div className="flex flex-wrap gap-1.5">
                            {group.sizes.map((size) => {
                                const id = String(size.id);
                                const isSelected = selected.includes(id);
                                const limitReached =
                                    !isSelected &&
                                    selected.length >= maxSelected;

                                return (
                                    <button
                                        key={size.id}
                                        type="button"
                                        aria-label={`${group.label}: ${size.label}`}
                                        onClick={() => toggle(size.id)}
                                        disabled={limitReached}
                                        className={cn(
                                            "flex h-8 items-center gap-1.5 rounded-lg border px-3 text-[13px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40",
                                            isSelected
                                                ? "bg-primary text-primary-foreground border-primary"
                                                : "bg-background hover:bg-muted border-input text-muted-foreground",
                                        )}
                                    >
                                        {size.label}
                                        {isSelected && (
                                            <Check className="h-3 w-3" />
                                        )}
                                    </button>
                                );
                            })}
                        </div>
                    )}
                </>
            )}

            <p className="text-muted-foreground text-[12px]">
                Options mirror Vinted for the selected region. Dimensions that
                Vinted does not expose as size IDs, such as separate trouser
                lengths, cannot be filtered here.
            </p>
        </div>
    );
}
