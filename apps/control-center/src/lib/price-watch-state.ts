// One place that turns a watch's raw columns into what a member is told about
// it, shared by the dashboard and the browser extension endpoints.

export type PriceWatchStateKey =
    | "paused"
    | "sold"
    | "removed"
    | "unavailable"
    | "stopped"
    | "confirming"
    | "retrying"
    | "validating"
    | "reserved"
    | "hidden"
    | "watching";

export type PriceWatchStateTone = "ok" | "info" | "warn" | "danger" | "muted";

export type PriceWatchState = {
    key: PriceWatchStateKey;
    label: string;
    tone: PriceWatchStateTone;
    hint: string | null;
};

export type PriceWatchStateInput = {
    status: string;
    stoppedReason: string | null;
    availability: string;
    lastErrorCode: string | null;
    armed: boolean;
};

// Written by the worker when a check finds the listing sold or deleted.
const GONE_ERROR_CODES = new Set([
    "item_sold",
    "item_deleted",
    "item_unavailable",
]);

export function describePriceWatchState(
    input: PriceWatchStateInput,
): PriceWatchState {
    if (input.status === "paused") {
        return { key: "paused", label: "Paused", tone: "warn", hint: null };
    }

    if (input.status === "stopped") {
        switch (input.stoppedReason) {
            case "item_sold":
                return {
                    key: "sold",
                    label: "Sold",
                    tone: "muted",
                    hint: "This listing was sold or is no longer for sale, so Vintrack stopped watching it.",
                };
            case "item_deleted":
                return {
                    key: "removed",
                    label: "Removed",
                    tone: "muted",
                    hint: "This listing was removed from Vinted, so Vintrack stopped watching it.",
                };
            case "item_unavailable":
                return {
                    key: "unavailable",
                    label: "Unavailable",
                    tone: "muted",
                    hint: "This listing is no longer available, so Vintrack stopped watching it.",
                };
            default:
                return {
                    key: "stopped",
                    label: "Stopped",
                    tone: "danger",
                    hint: null,
                };
        }
    }

    if (input.lastErrorCode && GONE_ERROR_CODES.has(input.lastErrorCode)) {
        return {
            key: "confirming",
            label: "Confirming",
            tone: "warn",
            hint: "Vinted no longer offers this listing. Vintrack checks once more before it stops watching.",
        };
    }
    if (input.lastErrorCode) {
        return {
            key: "retrying",
            label: "Retrying",
            tone: "warn",
            hint: "The last check did not complete. Vintrack retries automatically.",
        };
    }
    if (!input.armed || input.availability === "pending") {
        return {
            key: "validating",
            label: "Validating",
            tone: "info",
            hint: null,
        };
    }
    if (input.availability === "reserved") {
        return {
            key: "reserved",
            label: "Reserved",
            tone: "warn",
            hint: "A buyer reserved this listing. Vintrack keeps watching in case it returns to sale.",
        };
    }
    if (input.availability === "hidden") {
        return {
            key: "hidden",
            label: "Hidden",
            tone: "warn",
            hint: "The seller hid this listing. Vintrack keeps watching in case it returns.",
        };
    }
    return { key: "watching", label: "Watching", tone: "ok", hint: null };
}
