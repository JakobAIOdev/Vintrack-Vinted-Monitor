"use server";

import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getFeatureAccessForUser } from "@/lib/features.server";
import { REGIONS } from "@/lib/regions";
import {
    automationValidationError,
    type AutomationKind,
    type AutomationSettings,
} from "@/lib/account-automations";
import { revalidatePath } from "next/cache";
import { withMonitorActivationLock } from "@/lib/monitor-limits";

export async function saveAccountAutomation(
    monitorId: number,
    kind: AutomationKind,
    settings: AutomationSettings,
) {
    const session = await auth();
    if (!session?.user?.id) return { error: "Sign in to Vintrack." };
    if (
        !Number.isSafeInteger(monitorId) ||
        monitorId <= 0 ||
        (kind !== "offer" && kind !== "message")
    )
        return { error: "Invalid automation." };
    if (!settings || typeof settings.enabled !== "boolean")
        return { error: "Invalid module setting." };
    const userId = session.user.id;
    const monitor = await db.monitors.findFirst({
        where: { id: monitorId, userId },
    });
    if (!monitor) return { error: "Monitor not found." };
    // Disabling remains available after unlinking or withdrawing feature access.
    if (!settings.enabled) {
        await db.monitor_account_automations.updateMany({
            where: { monitor_id: monitorId, kind },
            data: { enabled: false, revision: { increment: 1 } },
        });
        revalidatePath(`/monitors/${monitorId}`);
        return { success: true };
    }
    const validationError = automationValidationError(kind, settings);
    if (validationError) return { error: validationError };
    const access = await getFeatureAccessForUser(
        kind === "offer" ? "auto_offers" : "auto_messages",
        userId,
        db,
        false,
    );
    if (!access.allowed)
        return { error: "This module is unavailable for your account." };
    const result = await withMonitorActivationLock(userId, async (tx) => {
        // Serialize settings with account changes; never arm against an identity read before the transaction.
        const accounts = await tx.$queryRaw<
            { vinted_user_id: bigint; domain: string; status: string }[]
        >`
            SELECT vinted_user_id, domain, status FROM vinted_sessions WHERE user_id = ${userId} FOR UPDATE
        `;
        const account = accounts[0];
        const region = REGIONS.find((entry) => entry.code === monitor.region);
        if (
            !account ||
            account.vinted_user_id <= BigInt(0) ||
            account.status !== "active"
        )
            return { error: "Link an active Vinted account first." };
        if (!region || account.domain.replace(/^www\./, "") !== region.domain)
            return {
                error: "The monitor region must match your linked Vinted account.",
            };
        const data = {
            enabled: true,
            account_id: account.vinted_user_id,
            domain: account.domain,
            discount_percent: kind === "offer" ? settings.discountPercent : 10,
            max_price_minor: kind === "offer" ? settings.maxPriceMinor : 10000,
            message_template:
                kind === "message" ? settings.messageTemplate.trim() : "",
            enabled_at: new Date(),
        };
        await tx.monitor_account_automations.upsert({
            where: { monitor_id_kind: { monitor_id: monitorId, kind } },
            create: { monitor_id: monitorId, kind, ...data },
            update: { ...data, revision: { increment: 1 } },
        });
        return { success: true };
    });
    revalidatePath(`/monitors/${monitorId}`);
    return result;
}
