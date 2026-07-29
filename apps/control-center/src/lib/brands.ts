import brandsData from "./brands.generated.json";

export type Brand = { label: string; id: string };

export const BRANDS: Brand[] = [...brandsData].sort((a, b) =>
    a.label.localeCompare(b.label),
);

export function normalizeBrandSearch(value: string): string {
    return value
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "");
}

export function matchesBrandSearch(brand: Brand, query: string): boolean {
    const normalizedQuery = normalizeBrandSearch(query);
    if (!normalizedQuery) return false;
    return normalizeBrandSearch(brand.label).includes(normalizedQuery);
}

export function compareBrandsForSearch(
    first: Brand,
    second: Brand,
    query: string,
): number {
    const normalizedQuery = normalizeBrandSearch(query);
    const firstLabel = normalizeBrandSearch(first.label);
    const secondLabel = normalizeBrandSearch(second.label);
    const rank = (label: string) => {
        if (label === normalizedQuery) return 0;
        if (label.startsWith(normalizedQuery)) return 1;
        return 2;
    };

    return (
        rank(firstLabel) - rank(secondLabel) ||
        first.label.localeCompare(second.label)
    );
}

const BRANDS_BY_ID: Record<string, Brand> = Object.create(null);
for (const brand of BRANDS) {
    BRANDS_BY_ID[brand.id] = brand;
}

export function getBrandLabel(id: string): string {
    return BRANDS_BY_ID[id]?.label ?? id;
}

export function getBrandLabels(brandIds: string | null | undefined): string[] {
    if (!brandIds) return [];
    return brandIds
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map(getBrandLabel);
}
