export type CheckoutTarget = {
    itemId: number;
    monitorId: number;
    sellerId: number;
    accountId: number;
    accountName: string;
    domain: string;
    itemUrl: string;
    title: string;
    price: string | null;
    preferences?: CheckoutPreferences;
};

export type CheckoutPreferences = {
    shipping: "home" | "vinted";
    payment: "wallet" | "paypal" | "vinted";
};

export const DEFAULT_CHECKOUT_PREFERENCES: CheckoutPreferences = {
    shipping: "home",
    payment: "wallet",
};

export function isCheckoutPreferences(
    value: unknown,
): value is CheckoutPreferences {
    if (!value || typeof value !== "object") return false;
    const preferences = value as Record<string, unknown>;
    return (
        Object.keys(preferences).every(
            (key) => key === "shipping" || key === "payment",
        ) &&
        typeof preferences.shipping === "string" &&
        typeof preferences.payment === "string" &&
        ["home", "vinted"].includes(preferences.shipping) &&
        ["wallet", "paypal", "vinted"].includes(preferences.payment)
    );
}

export function parseCheckoutIds(monitor: string, item: string) {
    if (!/^[1-9]\d*$/.test(monitor) || !/^[1-9]\d*$/.test(item)) return null;
    const monitorId = Number(monitor);
    const itemId = Number(item);
    if (
        !Number.isSafeInteger(monitorId) ||
        monitorId > 2147483647 ||
        !Number.isSafeInteger(itemId)
    )
        return null;
    return { monitorId, itemId };
}

export function checkoutDomain(raw: string) {
    const domain = raw.toLowerCase().replace(/^www\./, "");
    if (
        !/^vinted\.(at|be|co\.uk|com|cz|de|dk|es|fi|fr|hr|hu|ie|it|lt|lu|nl|pl|pt|ro|se|sk)$/.test(
            domain,
        )
    )
        return null;
    return `www.${domain}`;
}

export function isCheckoutUrl(raw: unknown, domain: string): raw is string {
    if (typeof raw !== "string" || !checkoutDomain(domain)) return false;
    try {
        const url = new URL(raw);
        return (
            url.protocol === "https:" &&
            url.host === domain &&
            !url.username &&
            !url.password &&
            url.pathname === "/checkout" &&
            !url.hash
        );
    } catch {
        return false;
    }
}

// Only checkout destinations are accepted by the login return path.
export function checkoutReturnPath(raw?: string) {
    const match = raw?.match(/^\/checkout\/([1-9]\d*)\/([1-9]\d*)$/);
    return match && parseCheckoutIds(match[1], match[2]) ? raw! : "/dashboard";
}

export function checkoutApiPath(monitorId: number, itemId: number) {
    return `/api/checkout/${monitorId}/${itemId}`;
}
