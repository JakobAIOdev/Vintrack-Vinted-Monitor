import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { parseCheckoutIds } from "@/lib/checkout";
import { CheckoutHandoff } from "@/components/checkout/checkout-handoff";

export const metadata: Metadata = {
    title: "Open Vinted Checkout | Vintrack",
    robots: { index: false, follow: false },
};

export default async function CheckoutPage({
    params,
}: {
    params: Promise<{ monitorId: string; itemId: string }>;
}) {
    const path = await params;
    const ids = parseCheckoutIds(path.monitorId, path.itemId);
    if (!ids) notFound();
    return <CheckoutHandoff {...ids} />;
}
