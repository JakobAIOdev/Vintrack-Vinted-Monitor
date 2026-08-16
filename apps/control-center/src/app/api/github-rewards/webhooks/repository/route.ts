import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import {
    claimGithubAccountForUser,
    getGithubRewardsPolicy,
} from "@/lib/github-rewards.server";
import {
    beginGithubWebhookDelivery,
    finishGithubWebhookDelivery,
    verifyGithubWebhookSignature,
} from "@/lib/github-webhooks.server";
import { reconcileUserFreeProxyMonitorLimit } from "@/lib/free-proxy-limit-reconciliation.server";

type StarPayload = {
    action?: string;
    starred_at?: string | null;
    repository?: { name?: string; owner?: { login?: string } };
    sender?: {
        id?: number;
        login?: string;
        avatar_url?: string | null;
        type?: string;
    };
};

export async function POST(request: Request) {
    const rawBody = await request.text();
    if (
        !verifyGithubWebhookSignature(
            rawBody,
            request.headers.get("x-hub-signature-256"),
            process.env.GITHUB_REPOSITORY_WEBHOOK_SECRET,
        )
    ) {
        return NextResponse.json(
            { error: "Invalid signature" },
            { status: 401 },
        );
    }
    const deliveryId = request.headers.get("x-github-delivery");
    const event = request.headers.get("x-github-event");
    if (!deliveryId || event !== "star") {
        return NextResponse.json({ error: "Invalid event" }, { status: 400 });
    }

    let payload: StarPayload;
    try {
        payload = JSON.parse(rawBody) as StarPayload;
    } catch {
        return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
    if (
        !(await beginGithubWebhookDelivery({
            deliveryId,
            event,
            action: payload.action,
        }))
    ) {
        return NextResponse.json({ ok: true, duplicate: true });
    }

    try {
        const policy = await getGithubRewardsPolicy();
        if (!policy.integrationEnabled) {
            await finishGithubWebhookDelivery(deliveryId);
            return NextResponse.json({
                ok: true,
                ignored: "integration-disabled",
            });
        }
        if (
            payload.repository?.owner?.login?.toLowerCase() !==
                policy.repositoryOwner.toLowerCase() ||
            payload.repository?.name?.toLowerCase() !==
                policy.repositoryName.toLowerCase()
        ) {
            throw new Error("Webhook repository does not match reward policy");
        }
        if (!payload.sender?.id || !payload.sender.login) {
            throw new Error("Missing GitHub sender");
        }
        if (!["created", "deleted"].includes(payload.action ?? "")) {
            await finishGithubWebhookDelivery(deliveryId);
            return NextResponse.json({ ok: true, ignored: true });
        }

        const githubId = BigInt(payload.sender.id);
        const existing = await db.github_reward_accounts.findUnique({
            where: { github_id: githubId },
        });
        const authAccount = await db.account.findUnique({
            where: {
                provider_providerAccountId: {
                    provider: "github",
                    providerAccountId: String(payload.sender.id),
                },
            },
            select: { userId: true },
        });
        const claimedUserId =
            authAccount?.userId ?? existing?.claimed_user_id ?? null;
        if (authAccount?.userId) {
            await claimGithubAccountForUser({
                userId: authAccount.userId,
                githubId,
                login: payload.sender.login,
                avatarUrl: payload.sender.avatar_url,
            });
        }
        const eventAt = payload.starred_at
            ? new Date(payload.starred_at)
            : new Date();
        if (!existing?.star_event_at || existing.star_event_at <= eventAt) {
            await db.github_reward_accounts.upsert({
                where: { github_id: githubId },
                create: {
                    github_id: githubId,
                    login: payload.sender.login,
                    avatar_url: payload.sender.avatar_url ?? null,
                    account_type:
                        payload.sender.type === "Organization"
                            ? "organization"
                            : "user",
                    claimed_user_id: null,
                    star_status:
                        payload.action === "created" ? "starred" : "unstarred",
                    star_changed_at: eventAt,
                    star_verified_at: new Date(),
                    star_event_at: eventAt,
                },
                update: {
                    login: payload.sender.login,
                    avatar_url: payload.sender.avatar_url ?? null,
                    star_status:
                        payload.action === "created" ? "starred" : "unstarred",
                    star_changed_at: eventAt,
                    star_verified_at: new Date(),
                    star_event_at: eventAt,
                },
            });
        }
        if (claimedUserId) {
            await reconcileUserFreeProxyMonitorLimit(
                claimedUserId,
                `github-star:${payload.action}`,
                null,
            );
            // The member's limit just changed; drop the cached member pages so
            // the new allowance shows up on their next navigation.
            revalidatePath("/account");
            revalidatePath("/dashboard");
        }
        await finishGithubWebhookDelivery(deliveryId);
        return NextResponse.json({ ok: true });
    } catch (error) {
        await finishGithubWebhookDelivery(deliveryId, error);
        console.error("[github-rewards] repository webhook failed", error);
        return NextResponse.json(
            { error: "Webhook processing failed" },
            { status: 500 },
        );
    }
}
