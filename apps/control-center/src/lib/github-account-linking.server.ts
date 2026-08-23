import { db } from "@/lib/db";

export type GithubLinkPreparation =
    | { ok: true; recovered: boolean }
    | { ok: false; reason: "claim_conflict" | "account_conflict" };

export async function prepareGithubAccountLink(
    userId: string,
    githubId: bigint,
): Promise<GithubLinkPreparation> {
    const providerAccountId = githubId.toString();
    const [claim, linkedAccount] = await Promise.all([
        db.github_reward_accounts.findUnique({
            where: { github_id: githubId },
            select: { claimed_user_id: true },
        }),
        db.account.findUnique({
            where: {
                provider_providerAccountId: {
                    provider: "github",
                    providerAccountId,
                },
            },
            select: { userId: true },
        }),
    ]);

    if (claim?.claimed_user_id && claim.claimed_user_id !== userId) {
        return { ok: false, reason: "claim_conflict" };
    }
    if (!linkedAccount || linkedAccount.userId === userId) {
        return { ok: true, recovered: false };
    }

    // Older reward linking could claim the identity before Auth.js persisted
    // the provider. A failed callback then left a GitHub-only user behind. We
    // recover only when the reward claim proves this exact Vintrack member
    // already authorized the same GitHub identity and the other user has no
    // independent login provider.
    if (claim?.claimed_user_id !== userId) {
        return { ok: false, reason: "account_conflict" };
    }
    const accountCount = await db.account.count({
        where: { userId: linkedAccount.userId },
    });
    if (accountCount !== 1) {
        return { ok: false, reason: "account_conflict" };
    }

    await db.$transaction([
        db.session.deleteMany({ where: { userId: linkedAccount.userId } }),
        db.account.update({
            where: {
                provider_providerAccountId: {
                    provider: "github",
                    providerAccountId,
                },
            },
            data: { userId },
        }),
    ]);
    return { ok: true, recovered: true };
}

export async function unlinkGithubAccountForUser(userId: string) {
    return db.$transaction(async (tx) => {
        const github = await tx.account.findFirst({
            where: { userId, provider: "github" },
            select: { providerAccountId: true },
        });
        if (!github) {
            await tx.github_reward_accounts.updateMany({
                where: { claimed_user_id: userId },
                data: { claimed_user_id: null },
            });
            return null;
        }

        await tx.account.delete({
            where: {
                provider_providerAccountId: {
                    provider: "github",
                    providerAccountId: github.providerAccountId,
                },
            },
        });
        await tx.github_reward_accounts.updateMany({
            where: { claimed_user_id: userId },
            data: { claimed_user_id: null },
        });
        return github;
    });
}
