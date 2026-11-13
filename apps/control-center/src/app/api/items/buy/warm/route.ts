import { guardApiFeature } from "@/lib/features.server";
import { auth } from "@/auth";
import { guardCheckoutConsent } from "@/lib/checkout-consent.server";
import { NextResponse } from "next/server";

export async function POST() {
    const session = await auth();
    if (!session?.user?.id) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const featureDenied = await guardApiFeature(
        session.user.id,
        "checkout_links",
    );
    if (featureDenied) return featureDenied;
    const consentDenied = await guardCheckoutConsent(session.user.id);
    if (consentDenied) return consentDenied;

    return NextResponse.json(
        {
            code: "FULL_CHECKOUT_REQUIRED",
            error: "Use a monitored-item buy link with Full checkout enabled in Account. Legacy request checkout is no longer available.",
        },
        { status: 410 },
    );
}
