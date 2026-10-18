import "server-only";

import { db } from "@/lib/db";
import {
    isInstanceAccessRestricted,
    isInstanceAccountAllowed,
} from "@/lib/auth-access";

export async function isInstanceUserAllowed(userId: string) {
    if (!isInstanceAccessRestricted()) return true;

    const accounts = await db.account.findMany({
        where: { userId, provider: { in: ["discord", "oidc"] } },
        select: { provider: true, providerAccountId: true },
    });
    return accounts.some((account) => isInstanceAccountAllowed(account));
}
