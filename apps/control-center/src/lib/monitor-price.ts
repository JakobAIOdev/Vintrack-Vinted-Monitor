export function getMonitorPriceRangeValidationError(
    priceMin: number | null,
    priceMax: number | null,
) {
    if (priceMin !== null && (!Number.isFinite(priceMin) || priceMin < 0)) {
        return "Minimum price must be zero or greater.";
    }
    if (priceMax !== null && (!Number.isFinite(priceMax) || priceMax < 0)) {
        return "Maximum price must be zero or greater.";
    }
    if (priceMin !== null && priceMax !== null && priceMax < priceMin) {
        return "Maximum price must be greater than or equal to the minimum price.";
    }
    return null;
}
