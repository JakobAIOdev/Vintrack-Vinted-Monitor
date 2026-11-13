import "server-only";

import { db } from "@/lib/db";
import {
    isInstanceAccessRestricted,
    isInstanceAccountAllowed,
} from "@/lib/auth-access";

export async function isInstanceUserAllowed(userId: string) {
    const user = await db.user.findUnique({
        where: { id: userId },
        select: { banned_at: true },
    });
    if (!user || user.banned_at) return false;
    if (!isInstanceAccessRestricted()) return true;

    const accounts = await db.account.findMany({
        where: { userId, provider: { in: ["discord", "oidc"] } },
        select: { provider: true, providerAccountId: true },
    });
    return accounts.some((account) => isInstanceAccountAllowed(account));
}
