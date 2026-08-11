"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
    BRANDS,
    compareBrandsForSearch,
    matchesBrandSearch,
    type Brand,
} from "@/lib/brands";
import { Check, Link2, Loader2, Search, Trash2, X } from "lucide-react";
import { toast } from "sonner";

interface BrandPickerProps {
    selected: string[];
    onChange: (ids: string[]) => void;
    region: string;
    catalogIds?: string[];
}

const BRAND_CACHE_KEY = "vintrack.brand-cache.v1";

function mergeBrands(...brandGroups: Brand[][]) {
    const brandsById = new Map<string, Brand>();

    for (const brands of brandGroups) {
        for (const brand of brands) {
            brandsById.set(brand.id, brand);
        }
    }

    return [...brandsById.values()].sort((a, b) =>
        a.label.localeCompare(b.label),
    );
}

function isBrand(value: unknown): value is Brand {
    const brand = value as Brand;
    return typeof brand?.id === "string" && typeof brand?.label === "string";
}

export function BrandPicker({
    selected,
    onChange,
    region,
    catalogIds = [],
}: BrandPickerProps) {
    const [query, setQuery] = useState("");
    const [open, setOpen] = useState(false);
    const [remoteBrands, setRemoteBrands] = useState<Brand[]>([]);
    const [cachedBrands, setCachedBrands] = useState<Brand[]>([]);
    const [personalBrands, setPersonalBrands] = useState<Brand[]>([]);
    const [loadingRemote, setLoadingRemote] = useState(false);
    const [remoteError, setRemoteError] = useState(false);
    const [showAddForm, setShowAddForm] = useState(false);
    const [brandUrl, setBrandUrl] = useState("");
    const [addingBrand, setAddingBrand] = useState(false);
    const [addError, setAddError] = useState("");
    const [removingBrandId, setRemovingBrandId] = useState<string | null>(null);
    const ref = useRef<HTMLDivElement>(null);
    const selectedKey = selected.join(",");

    useEffect(() => {
        function handleClick(e: MouseEvent) {
            if (ref.current && !ref.current.contains(e.target as Node)) {
                setOpen(false);
            }
        }
        document.addEventListener("mousedown", handleClick);
        return () => document.removeEventListener("mousedown", handleClick);
    }, []);

    useEffect(() => {
        try {
            const cached = JSON.parse(
                localStorage.getItem(BRAND_CACHE_KEY) || "[]",
            );
            if (Array.isArray(cached)) {
                setCachedBrands(cached.filter(isBrand));
            }
        } catch {
            setCachedBrands([]);
        }
    }, []);

    useEffect(() => {
        const controller = new AbortController();
        const params = new URLSearchParams();
        if (selectedKey) params.set("ids", selectedKey);

        void fetch(
            `/api/catalog/member-brands${params.size ? `?${params}` : ""}`,
            { cache: "no-store", signal: controller.signal },
        )
            .then(async (response) => {
                const data = await response.json();
                if (!response.ok) throw new Error(data?.error);
                if (!controller.signal.aborted) {
                    setPersonalBrands(
                        (Array.isArray(data.brands) ? data.brands : [])
                            .filter(isBrand)
                            .map((brand: Brand) => ({
                                ...brand,
                                source: "personal",
                            })),
                    );
                }
            })
            .catch(() => {
                if (!controller.signal.aborted) setPersonalBrands([]);
            });

        return () => controller.abort();
    }, [selectedKey]);

    useEffect(() => {
        const normalizedQuery = query.trim();
        if (normalizedQuery.length < 2) {
            setRemoteBrands([]);
            setLoadingRemote(false);
            setRemoteError(false);
            return;
        }

        const controller = new AbortController();
        const timeout = window.setTimeout(async () => {
            setLoadingRemote(true);
            setRemoteError(false);

            const params = new URLSearchParams({
                query: normalizedQuery,
                region,
            });
            if (catalogIds.length > 0) {
                params.set("catalog_ids", catalogIds.join(","));
            }

            try {
                const response = await fetch(
                    `/api/catalog/brands?${params.toString()}`,
                    { cache: "no-store", signal: controller.signal },
                );
                const data = await response.json();
                if (!response.ok) {
                    throw new Error(data?.error || "Brand search failed");
                }

                if (!controller.signal.aborted) {
                    setRemoteBrands(
                        (Array.isArray(data.brands) ? data.brands : [])
                            .filter(isBrand)
                            .map((brand: Brand) => ({
                                ...brand,
                                source: "vinted",
                            })),
                    );
                }
            } catch {
                if (!controller.signal.aborted) {
                    setRemoteBrands([]);
                    setRemoteError(true);
                }
            } finally {
                if (!controller.signal.aborted) setLoadingRemote(false);
            }
        }, 250);

        return () => {
            controller.abort();
            window.clearTimeout(timeout);
        };
    }, [catalogIds, query, region]);

    const allBrands = useMemo(
        () => mergeBrands(BRANDS, cachedBrands, remoteBrands, personalBrands),
        [cachedBrands, personalBrands, remoteBrands],
    );

    const filtered = useMemo(() => {
        const available = allBrands.filter(
            (brand) => brand.active !== false || selected.includes(brand.id),
        );
        if (!query.trim()) return available.slice(0, 50);
        return available
            .filter((brand) => matchesBrandSearch(brand, query))
            .sort((first, second) =>
                compareBrandsForSearch(first, second, query),
            )
            .slice(0, 50);
    }, [allBrands, query, selected]);

    const selectedBrands = useMemo(
        () =>
            selected.map(
                (id) =>
                    allBrands.find((brand) => brand.id === id) ?? {
                        id,
                        label: id,
                    },
            ),
        [allBrands, selected],
    );

    const rememberBrand = (brand: Brand) => {
        setCachedBrands((current) => {
            const next = mergeBrands(current, [brand]).slice(0, 500);
            try {
                localStorage.setItem(BRAND_CACHE_KEY, JSON.stringify(next));
            } catch {}
            return next;
        });
    };

    const forgetCachedBrand = (id: string) => {
        setCachedBrands((current) => {
            const next = current.filter((brand) => brand.id !== id);
            try {
                localStorage.setItem(BRAND_CACHE_KEY, JSON.stringify(next));
            } catch {}
            return next;
        });
    };

    const toggle = (brand: Brand) => {
        if (selected.includes(brand.id)) {
            onChange(selected.filter((id) => id !== brand.id));
        } else {
            rememberBrand(brand);
            onChange([...selected, brand.id]);
            setQuery("");
        }
    };

    const addPersonalBrand = async () => {
        if (!brandUrl.trim() || addingBrand) return;
        setAddingBrand(true);
        setAddError("");

        try {
            const response = await fetch("/api/catalog/member-brands", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ brand_url: brandUrl.trim(), region }),
            });
            const data = await response.json();
            if (!response.ok || !isBrand(data?.brand)) {
                throw new Error(data?.error || "Brand validation failed");
            }

            const brand: Brand = {
                ...data.brand,
                source: "personal",
                active: true,
            };
            setPersonalBrands((current) => mergeBrands(current, [brand]));
            rememberBrand(brand);
            if (!selected.includes(brand.id)) {
                onChange([...selected, brand.id]);
            }
            setBrandUrl("");
            setQuery("");
            setShowAddForm(false);
            toast.success(`${brand.label} added to your personal brands`);
        } catch (error) {
            setAddError(
                error instanceof Error
                    ? error.message
                    : "Brand validation failed",
            );
        } finally {
            setAddingBrand(false);
        }
    };

    const deletePersonalBrand = async (brand: Brand) => {
        if (removingBrandId) return;
        setRemovingBrandId(brand.id);
        try {
            const response = await fetch(
                `/api/catalog/member-brands/${brand.id}`,
                { method: "DELETE" },
            );
            if (!response.ok) throw new Error("Delete failed");

            setPersonalBrands((current) =>
                current.filter((candidate) => candidate.id !== brand.id),
            );
            forgetCachedBrand(brand.id);
            onChange(selected.filter((id) => id !== brand.id));
            toast.success(`${brand.label} removed from your personal brands`);
        } catch {
            toast.error("Could not remove personal brand");
        } finally {
            setRemovingBrandId(null);
        }
    };

    return (
        <div ref={ref} className="relative">
            {selectedBrands.length > 0 && (
                <div className="mb-2 flex flex-wrap gap-1.5">
                    {selectedBrands.map((brand) => (
                        <span
                            key={brand.id}
                            data-testid="selected-brand"
                            data-brand-id={brand.id}
                            className="bg-primary text-primary-foreground border-primary inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[12px] font-medium"
                        >
                            {brand.label}
                            {brand.source === "personal" && (
                                <span className="rounded bg-white/20 px-1 text-[9px] uppercase">
                                    Personal
                                </span>
                            )}
                            <button
                                type="button"
                                aria-label={`Deselect ${brand.label}`}
                                onClick={() =>
                                    onChange(
                                        selected.filter(
                                            (id) => id !== brand.id,
                                        ),
                                    )
                                }
                                className="hover:text-blue-900"
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
                    onChange={(event) => {
                        setQuery(event.target.value);
                        setOpen(true);
                        setShowAddForm(false);
                        setAddError("");
                    }}
                    onFocus={() => setOpen(true)}
                    placeholder="Search brand…"
                    aria-label="Search brand"
                    className="border-input bg-background focus:border-border h-9 w-full rounded-md border pr-3 pl-8 text-[13px] transition-colors outline-none focus:ring-2 focus:ring-slate-900/10"
                />
            </div>

            {open && (
                <div className="border-input bg-background absolute z-50 mt-1 max-h-72 w-full overflow-y-auto rounded-md border shadow-lg">
                    {filtered.map((brand) => {
                        const isSelected = selected.includes(brand.id);
                        const isPersonal = brand.source === "personal";
                        return (
                            <div
                                key={brand.id}
                                className={`hover:bg-muted flex items-center transition-colors ${
                                    isSelected
                                        ? "bg-accent text-accent-foreground font-medium"
                                        : ""
                                }`}
                            >
                                <button
                                    type="button"
                                    onClick={() => toggle(brand)}
                                    className="flex min-w-0 flex-1 items-center justify-between px-3 py-1.5 text-left text-[13px]"
                                >
                                    <span className="flex min-w-0 items-center gap-2">
                                        <span className="truncate">
                                            {brand.label}
                                        </span>
                                        {isPersonal && (
                                            <span className="border-primary/30 bg-primary/5 text-primary rounded border px-1 py-0.5 text-[9px] font-semibold uppercase">
                                                Personal
                                            </span>
                                        )}
                                    </span>
                                    {isSelected && (
                                        <Check className="text-primary h-3 w-3 shrink-0" />
                                    )}
                                </button>
                                {isPersonal && brand.active !== false && (
                                    <button
                                        type="button"
                                        aria-label={`Remove ${brand.label} from personal brands`}
                                        onClick={() =>
                                            void deletePersonalBrand(brand)
                                        }
                                        className="text-muted-foreground hover:text-destructive p-2"
                                    >
                                        {removingBrandId === brand.id ? (
                                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                        ) : (
                                            <Trash2 className="h-3.5 w-3.5" />
                                        )}
                                    </button>
                                )}
                            </div>
                        );
                    })}

                    {loadingRemote && (
                        <div className="border-border text-muted-foreground flex items-center gap-2 border-t px-3 py-2 text-[12px]">
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            Searching Vinted...
                        </div>
                    )}

                    {filtered.length === 0 && !loadingRemote && (
                        <div className="text-muted-foreground px-3 pt-2 text-[13px]">
                            {remoteError
                                ? "Vinted brand search unavailable"
                                : "No brand found"}
                        </div>
                    )}

                    {filtered.length === 0 && !loadingRemote && (
                        <div className="border-border mt-2 border-t p-3">
                            {!showAddForm ? (
                                <button
                                    type="button"
                                    data-testid="add-verified-brand"
                                    onClick={() => setShowAddForm(true)}
                                    className="text-primary flex items-center gap-1.5 text-[12px] font-medium hover:underline"
                                >
                                    <Link2 className="h-3.5 w-3.5" />
                                    Add verified Vinted brand
                                </button>
                            ) : (
                                <div className="space-y-2">
                                    <label className="text-foreground block text-[12px] font-medium">
                                        Vinted brand page link
                                    </label>
                                    <div className="flex gap-2">
                                        <input
                                            type="url"
                                            data-testid="personal-brand-url"
                                            value={brandUrl}
                                            onChange={(event) => {
                                                setBrandUrl(event.target.value);
                                                setAddError("");
                                            }}
                                            onKeyDown={(event) => {
                                                if (event.key === "Enter") {
                                                    event.preventDefault();
                                                    void addPersonalBrand();
                                                }
                                            }}
                                            placeholder="https://www.vinted.cz/brand/..."
                                            className="border-input bg-background h-8 min-w-0 flex-1 rounded border px-2 text-[12px] outline-none focus:ring-2 focus:ring-slate-900/10"
                                        />
                                        <button
                                            type="button"
                                            data-testid="verify-personal-brand"
                                            disabled={
                                                addingBrand || !brandUrl.trim()
                                            }
                                            onClick={() =>
                                                void addPersonalBrand()
                                            }
                                            className="bg-primary text-primary-foreground inline-flex h-8 items-center rounded px-3 text-[12px] font-medium disabled:opacity-50"
                                        >
                                            {addingBrand ? (
                                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                            ) : (
                                                "Verify"
                                            )}
                                        </button>
                                    </div>
                                    <p className="text-muted-foreground text-[10px] leading-relaxed">
                                        <span className="text-foreground font-medium">
                                            How to find it:
                                        </span>{" "}
                                        Open Vinted in your browser, open any
                                        item from the brand, click the brand
                                        name in the item details, then copy the
                                        URL from the address bar. A valid link
                                        contains <code>/brand/</code> and must
                                        be from the selected Vinted region.
                                    </p>
                                    {addError && (
                                        <p className="text-destructive text-[11px]">
                                            {addError}
                                        </p>
                                    )}
                                </div>
                            )}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
