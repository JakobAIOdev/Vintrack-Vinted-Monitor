import "server-only";
import { db } from "@/lib/db";
import { NextResponse } from "next/server";
import {
    checkoutRiskAccepted,
    CHECKOUT_CONSENT_REQUIRED,
} from "@/lib/checkout-consent";

export async function guardCheckoutConsent(userId: string) {
    const user = await db.user.findUnique({
        where: { id: userId },
        select: {
            checkout_risk_version: true,
            checkout_risk_accepted_at: true,
        },
    });
    if (
        checkoutRiskAccepted(
            user?.checkout_risk_version,
            user?.checkout_risk_accepted_at,
        )
    )
        return null;
    return NextResponse.json(
        {
            code: CHECKOUT_CONSENT_REQUIRED,
            error: "Accept the checkout risk warning before using checkout.",
        },
        { status: 403 },
    );
}
