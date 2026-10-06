"use server";

import { auth } from "@/auth";
import { db } from "@/lib/db";
import { ACCOUNT_UPDATES_VERSION } from "@/lib/account-updates";

export async function markAccountUpdatesSeen() {
    const session = await auth();
    if (!session?.user?.id) return { error: "Sign in to Vintrack." };

    try {
        await db.user.updateMany({
            where: {
                id: session.user.id,
                account_updates_seen_version: { lt: ACCOUNT_UPDATES_VERSION },
            },
            data: { account_updates_seen_version: ACCOUNT_UPDATES_VERSION },
        });
        return { success: true };
    } catch {
        return { error: "Account update status could not be saved." };
    }
}
