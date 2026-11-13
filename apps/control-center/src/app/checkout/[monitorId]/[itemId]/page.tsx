import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { parseCheckoutIds } from "@/lib/checkout";
import { CheckoutHandoff } from "@/components/checkout/checkout-handoff";

export const metadata: Metadata = {
    title: "Open Vinted Checkout | Vintrack",
    robots: { index: false, follow: false },
};

export default async function CheckoutPage({
    params,
    searchParams,
}: {
    params: Promise<{ monitorId: string; itemId: string }>;
    searchParams: Promise<{ validate?: string | string[] }>;
}) {
    const path = await params;
    const ids = parseCheckoutIds(path.monitorId, path.itemId);
    if (!ids) notFound();
    // A malformed test flag must never fall through to a real purchase.
    const { validate } = await searchParams;
    if (validate !== undefined && validate !== "1") notFound();
    const validateOnly = validate === "1";
    // A buy link starts by itself only when the member opened it: typed,
    // bookmarked or opened from an app (no initiating site), from Vintrack
    // itself, or by a click. A navigation another site scripted without a
    // click gets the Buy now button instead. Browsers that send no fetch
    // metadata keep the page's own checks.
    const requestHeaders = await headers();
    const site = requestHeaders.get("sec-fetch-site");
    const autoStart =
        !site ||
        site === "none" ||
        site === "same-origin" ||
        requestHeaders.get("sec-fetch-user") === "?1";
    return (
        <CheckoutHandoff
            key={`${ids.monitorId}:${ids.itemId}:${validateOnly}`}
            {...ids}
            validateOnly={validateOnly}
            autoStart={autoStart}
        />
    );
}
