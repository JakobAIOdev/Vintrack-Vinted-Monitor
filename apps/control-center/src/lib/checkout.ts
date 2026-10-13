import currencyMinorUnits from "./checkout-currencies.generated.json" with { type: "json" };

export type CheckoutCurrency = keyof typeof currencyMinorUnits;
export const CHECKOUT_CURRENCIES = Object.keys(
    currencyMinorUnits,
) as CheckoutCurrency[];

export function isCheckoutCurrency(value: unknown): value is CheckoutCurrency {
    return (
        typeof value === "string" &&
        Object.prototype.hasOwnProperty.call(currencyMinorUnits, value)
    );
}

export function checkoutCurrencyDigits(currency: CheckoutCurrency) {
    return currencyMinorUnits[currency];
}

export function checkoutMaximumMinor(currency: CheckoutCurrency) {
    return 10_000 * 10 ** checkoutCurrencyDigits(currency);
}

// Decimal strings only: never round extra non-zero decimal places or convert
// a spending limit into another currency. Some native quotes pad whole units.
export function parseCheckoutAmount(
    amount: string,
    currency: CheckoutCurrency,
): number | null {
    if (
        !isCheckoutCurrency(currency) ||
        typeof amount !== "string" ||
        !/^\d{1,7}(?:[.,]\d{1,4})?$/.test(amount)
    )
        return null;
    const digits = checkoutCurrencyDigits(currency);
    const [whole, fraction = ""] = amount.replace(",", ".").split(".");
    if (/[1-9]/.test(fraction.slice(digits))) return null;
    return (
        Number(whole) * 10 ** digits +
        Number((fraction + "0".repeat(digits)).slice(0, digits))
    );
}

export function checkoutDefaultCurrency(domain: string): CheckoutCurrency {
    const normalized = checkoutDomain(domain);
    const currencies: Record<string, CheckoutCurrency> = {
        "www.vinted.co.uk": "GBP",
        "www.vinted.pl": "PLN",
        "www.vinted.cz": "CZK",
        "www.vinted.se": "SEK",
        "www.vinted.dk": "DKK",
        "www.vinted.ro": "RON",
        "www.vinted.hu": "HUF",
        "www.vinted.com": "USD",
    };
    return currencies[normalized || ""] || "EUR";
}

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
    riskConsentVersion?: number | null;
};

export type CheckoutPreferences = {
    shipping: "home" | "pickup" | "vinted";
    payment:
        | "wallet"
        | "paypal"
        | "vinted"
        | "card"
        | "google_pay"
        | "klarna"
        | "tink"
        | "bancontact"
        | "ideal"
        | "blik"
        | "przelewy24";
    autoCheckout?: {
        warningVersion: 1 | 2;
        maxTotalMinor: number;
        currency: CheckoutCurrency;
    };
};

export const AUTO_CHECKOUT_WARNING_VERSION = 1;
export const CARD_AUTO_CHECKOUT_WARNING_VERSION = 2;

export function autoCheckoutWarningVersion(payment: string) {
    return payment === "card"
        ? CARD_AUTO_CHECKOUT_WARNING_VERSION
        : AUTO_CHECKOUT_WARNING_VERSION;
}

export function checkoutPreferencesKey(preferences: CheckoutPreferences) {
    const setting = preferences.autoCheckout;
    return `${preferences.shipping}:${preferences.payment}${
        setting
            ? `:auto:${setting.warningVersion}:${setting.currency}:${setting.maxTotalMinor}`
            : ""
    }`;
}

export function autoCheckoutAllowed(domain: string, payment: string) {
    const normalized = checkoutDomain(domain);
    return (
        Boolean(normalized) &&
        (payment === "card" ||
            (payment === "paypal" &&
                ["www.vinted.de", "www.vinted.at", "www.vinted.be"].includes(
                    normalized || "",
                )))
    );
}

export function isAutoCheckoutPreference(
    value: unknown,
    payment = "paypal",
): boolean {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
    const setting = value as Record<string, unknown>;
    return (
        Object.keys(setting).length === 3 &&
        setting.warningVersion === autoCheckoutWarningVersion(payment) &&
        isCheckoutCurrency(setting.currency) &&
        Number.isSafeInteger(setting.maxTotalMinor) &&
        (setting.maxTotalMinor as number) > 0 &&
        (setting.maxTotalMinor as number) <=
            checkoutMaximumMinor(setting.currency)
    );
}

export const CHECKOUT_PAYMENT_LABELS: Record<
    CheckoutPreferences["payment"],
    string
> = {
    wallet: "Vinted Wallet",
    vinted: "Keep Vinted's saved payment choice",
    card: "Card saved in Vinted",
    google_pay: "Google Pay",
    paypal: "PayPal",
    klarna: "Klarna",
    tink: "Bank account (Tink)",
    bancontact: "Bancontact Pay",
    ideal: "iDEAL | Wero",
    blik: "BLIK",
    przelewy24: "Przelewy24",
};

// Regional presets are filtered again against the actual checkout response.
// Apple Pay is omitted: Vinted documents it as iOS-app-only, not web checkout.
const REGIONAL_CHECKOUT_PAYMENTS: Record<
    string,
    CheckoutPreferences["payment"][]
> = {
    "www.vinted.de": ["paypal", "tink", "klarna"],
    "www.vinted.at": ["paypal"],
    "www.vinted.be": ["paypal", "bancontact"],
    "www.vinted.nl": ["ideal"],
    "www.vinted.pl": ["blik", "przelewy24"],
};

export function checkoutPaymentOptions(
    domain: string,
): CheckoutPreferences["payment"][] {
    const normalized = checkoutDomain(domain);
    if (!normalized) return [];
    return [
        "wallet",
        "vinted",
        "card",
        "google_pay",
        ...(REGIONAL_CHECKOUT_PAYMENTS[normalized] || []),
    ];
}

export function checkoutPaymentAllowed(
    domain: string,
    payment: CheckoutPreferences["payment"],
) {
    return checkoutPaymentOptions(domain).includes(payment);
}

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
            (key) =>
                key === "shipping" ||
                key === "payment" ||
                key === "autoCheckout",
        ) &&
        typeof preferences.shipping === "string" &&
        typeof preferences.payment === "string" &&
        ["home", "pickup", "vinted"].includes(preferences.shipping) &&
        Object.prototype.hasOwnProperty.call(
            CHECKOUT_PAYMENT_LABELS,
            preferences.payment,
        ) &&
        (preferences.autoCheckout === undefined ||
            (["paypal", "card"].includes(preferences.payment) &&
                isAutoCheckoutPreference(
                    preferences.autoCheckout,
                    preferences.payment,
                )))
    );
}

export function isPayPalPaymentUrl(raw: unknown): raw is string {
    if (typeof raw !== "string") return false;
    try {
        const url = new URL(raw);
        return (
            url.protocol === "https:" &&
            ["www.paypal.com", "paypal.com"].includes(url.host) &&
            !url.username &&
            !url.password &&
            !url.hash &&
            ["/checkoutnow", "/webscr", "/cgi-bin/webscr"].includes(
                url.pathname,
            )
        );
    } catch {
        return false;
    }
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
