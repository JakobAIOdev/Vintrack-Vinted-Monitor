import { isValidDiscordWebhook } from "@/lib/validation";

export const CHECKOUT_NOTIFICATION_SETTING_KEY =
    "checkout_discord_notifications";
export const CHECKOUT_NOTIFICATION_FIELDS = [
    { key: "method", label: "Checkout method", personal: false },
    { key: "payment", label: "Payment method", personal: false },
    { key: "region", label: "Region", personal: false },
    { key: "item", label: "Item title", personal: true },
    { key: "link", label: "Item link", personal: true },
    { key: "image", label: "Item image", personal: true },
    { key: "price", label: "Item price", personal: true },
    { key: "user", label: "Vintrack user (name / ID)", personal: true },
    { key: "account", label: "Vinted username", personal: true },
] as const;
export type CheckoutNotificationField =
    (typeof CHECKOUT_NOTIFICATION_FIELDS)[number]["key"];
export type CheckoutNotificationPolicy = {
    enabled: boolean;
    webhookUrl: string;
    events: "confirmed" | "all";
    fields: CheckoutNotificationField[];
};
export const ANONYMOUS_CHECKOUT_FIELDS: CheckoutNotificationField[] = [
    "method",
    "payment",
    "region",
];
export const DEFAULT_CHECKOUT_NOTIFICATION_POLICY: CheckoutNotificationPolicy =
    {
        enabled: false,
        webhookUrl: "",
        events: "all",
        fields: ANONYMOUS_CHECKOUT_FIELDS,
    };
export const CHECKOUT_OUTCOMES: Record<
    string,
    { label: string; confirmed: boolean }
> = {
    card_payment_confirmed: { label: "Purchase confirmed", confirmed: true },
    checkout_prepared: {
        label: "Checkout prepared · purchase not confirmed",
        confirmed: false,
    },
    checkout_review_required: {
        label: "Manual review required · purchase not confirmed",
        confirmed: false,
    },
    paypal_redirect_ready: {
        label: "PayPal opened · payment not confirmed",
        confirmed: false,
    },
    payment_url_created: {
        label: "Payment opened · payment not confirmed",
        confirmed: false,
    },
    card_authentication_required: {
        label: "Card authentication required · payment not confirmed",
        confirmed: false,
    },
    card_payment_pending: {
        label: "Card payment pending · purchase not confirmed",
        confirmed: false,
    },
    card_payment_failed: { label: "Card payment failed", confirmed: false },
    payment_outcome_unknown: {
        label: "Payment outcome unknown",
        confirmed: false,
    },
};
export type CheckoutNotificationEvent = {
    method: "oneclick" | "full_checkout";
    status: string;
    payment: string;
    region: string;
    item?: string | null;
    link?: string | null;
    image?: string | null;
    price?: string | null;
    user?: string | null;
    account?: string | null;
};

export function validateCheckoutNotificationPolicy(
    input: CheckoutNotificationPolicy,
) {
    if (
        !input ||
        typeof input.enabled !== "boolean" ||
        typeof input.webhookUrl !== "string" ||
        (input.events !== "all" && input.events !== "confirmed") ||
        !Array.isArray(input.fields) ||
        input.fields.some(
            (field) =>
                !CHECKOUT_NOTIFICATION_FIELDS.some(
                    (candidate) => candidate.key === field,
                ),
        )
    ) {
        throw new Error("Invalid checkout notification settings.");
    }
    const webhookUrl = input.webhookUrl.trim();
    if (
        (webhookUrl && !isValidDiscordWebhook(webhookUrl)) ||
        (input.enabled && !webhookUrl)
    ) {
        throw new Error(
            "Enter a valid Discord webhook URL before enabling notifications.",
        );
    }
    return {
        enabled: input.enabled,
        webhookUrl,
        events: input.events,
        fields: [...new Set(input.fields)],
    };
}

function safeText(value: string) {
    return value
        .replace(/[\u0000-\u001f]/g, " ")
        .replace(/([\\`*_~|<>\[\]])/g, "\\$1")
        .slice(0, 1000);
}

function publicHttpsUrl(value?: string | null) {
    try {
        const url = new URL(value || "");
        if (url.protocol !== "https:" || url.username || url.password)
            return undefined;
        // Never forward checkout/payment URLs or signed query parameters.
        url.search = "";
        url.hash = "";
        return url.href;
    } catch {
        return undefined;
    }
}

export function buildCheckoutNotification(
    policy: Pick<CheckoutNotificationPolicy, "fields">,
    event: CheckoutNotificationEvent,
    test = false,
) {
    const outcome = Object.hasOwn(CHECKOUT_OUTCOMES, event.status)
        ? CHECKOUT_OUTCOMES[event.status]
        : undefined;
    if (!outcome) throw new Error("Unsupported checkout outcome.");
    const fields: { name: string; value: string; inline: boolean }[] = [
        { name: "Status", value: outcome.label, inline: false },
    ];
    for (const field of CHECKOUT_NOTIFICATION_FIELDS) {
        if (
            !policy.fields.includes(field.key) ||
            field.key === "image" ||
            field.key === "link"
        )
            continue;
        const value =
            field.key === "method"
                ? event.method === "full_checkout"
                    ? "Full checkout"
                    : "Oneclick buy"
                : event[field.key];
        if (value)
            fields.push({
                name: field.label,
                value: safeText(value),
                inline: !["item", "user", "account"].includes(field.key),
            });
    }
    const url = policy.fields.includes("link")
        ? publicHttpsUrl(event.link)
        : undefined;
    const image = policy.fields.includes("image")
        ? publicHttpsUrl(event.image)
        : undefined;
    return {
        username: "Vintrack Checkout",
        allowed_mentions: { parse: [] as string[] },
        embeds: [
            {
                title: test
                    ? "Test · Checkout notification"
                    : "Vintrack checkout",
                color: outcome.confirmed ? 0x22c55e : 0xf59e0b,
                fields,
                ...(url ? { url } : {}),
                ...(image ? { thumbnail: { url: image } } : {}),
                ...(test
                    ? {
                          footer: {
                              text: "Synthetic preview · no real purchase",
                          },
                      }
                    : {}),
            },
        ],
    };
}

export const CHECKOUT_NOTIFICATION_PREVIEW: CheckoutNotificationEvent = {
    method: "full_checkout",
    status: "card_payment_confirmed",
    payment: "Card",
    region: "DE",
    item: "Vintage Nike jacket",
    price: "25.00 EUR",
    user: "Example member (example-id)",
    account: "example_buyer",
    link: "https://www.vinted.de/items/123",
    image: "https://images1.vinted.net/example.jpg",
};

export type CheckoutNotificationPayload = ReturnType<
    typeof buildCheckoutNotification
>;

// A retry may disclose fewer fields after an admin changes the privacy preset.
// Never add fields which were absent from the original filtered payload.
export function filterStoredCheckoutNotification(
    payload: CheckoutNotificationPayload,
    policy: Pick<CheckoutNotificationPolicy, "fields">,
): CheckoutNotificationPayload {
    const allowed = new Set(
        CHECKOUT_NOTIFICATION_FIELDS.filter((field) =>
            policy.fields.includes(field.key),
        ).map((field) => field.label as string),
    );
    return {
        username: "Vintrack Checkout",
        allowed_mentions: { parse: [] },
        embeds: payload.embeds.map((embed) => ({
            title: embed.title,
            color: embed.color,
            fields: embed.fields.filter(
                (field) => field.name === "Status" || allowed.has(field.name),
            ),
            ...(policy.fields.includes("link") && embed.url
                ? { url: embed.url }
                : {}),
            ...(policy.fields.includes("image") && embed.thumbnail
                ? { thumbnail: embed.thumbnail }
                : {}),
        })),
    };
}
