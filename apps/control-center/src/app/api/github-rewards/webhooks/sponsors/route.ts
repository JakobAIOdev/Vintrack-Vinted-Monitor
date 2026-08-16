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

type SponsorEntity = {
    id?: number;
    login?: string;
    avatar_url?: string | null;
    type?: string;
};

type SponsorshipPayload = {
    action?: string;
    sender?: SponsorEntity;
    sponsorship?: {
        node_id?: string;
        id?: string | number;
        created_at?: string;
        is_one_time_payment?: boolean;
        privacy_level?: string;
        sponsor?: SponsorEntity;
        sponsor_entity?: SponsorEntity;
        sponsorable?: { login?: string };
        tier?: {
            name?: string;
            monthly_price_in_cents?: number;
            is_one_time?: boolean;
        };
    };
};

export async function POST(request: Request) {
    const rawBody = await request.text();
    if (
        !verifyGithubWebhookSignature(
            rawBody,
            request.headers.get("x-hub-signature-256"),
            process.env.GITHUB_SPONSORS_WEBHOOK_SECRET,
        )
    ) {
        return NextResponse.json(
            { error: "Invalid signature" },
            { status: 401 },
        );
    }
    const deliveryId = request.headers.get("x-github-delivery");
    const event = request.headers.get("x-github-event");
    if (!deliveryId || event !== "sponsorship") {
        return NextResponse.json({ error: "Invalid event" }, { status: 400 });
    }

    let payload: SponsorshipPayload;
    try {
        payload = JSON.parse(rawBody) as SponsorshipPayload;
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
        const sponsorship = payload.sponsorship;
        const sponsor =
            sponsorship?.sponsor_entity ??
            sponsorship?.sponsor ??
            payload.sender;
        if (!sponsorship || !sponsor?.id || !sponsor.login) {
            throw new Error("Missing sponsorship or sponsor identity");
        }
        if (
            sponsorship.sponsorable?.login?.toLowerCase() !==
            policy.sponsorsLogin.toLowerCase()
        ) {
            throw new Error("Webhook sponsorable does not match reward policy");
        }
        const githubId = BigInt(sponsor.id);
        const [authAccount, existingRewardAccount] = await Promise.all([
            db.account.findUnique({
                where: {
                    provider_providerAccountId: {
                        provider: "github",
                        providerAccountId: String(sponsor.id),
                    },
                },
                select: { userId: true },
            }),
            db.github_reward_accounts.findUnique({
                where: { github_id: githubId },
                select: { claimed_user_id: true },
            }),
        ]);
        const claimedUserId =
            authAccount?.userId ??
            existingRewardAccount?.claimed_user_id ??
            null;
        if (authAccount?.userId && sponsor.type !== "Organization") {
            await claimGithubAccountForUser({
                userId: authAccount.userId,
                githubId,
                login: sponsor.login,
                avatarUrl: sponsor.avatar_url,
            });
        }
        await db.$transaction(async (tx) => {
            await tx.github_reward_accounts.upsert({
                where: { github_id: githubId },
                create: {
                    github_id: githubId,
                    login: sponsor.login!,
                    avatar_url: sponsor.avatar_url ?? null,
                    account_type:
                        sponsor.type === "Organization"
                            ? "organization"
                            : "user",
                    claimed_user_id: null,
                },
                update: {
                    login: sponsor.login!,
                    avatar_url: sponsor.avatar_url ?? null,
                },
            });
            const now = new Date();
            const sponsoredAt = sponsorship.created_at
                ? new Date(sponsorship.created_at)
                : now;
            // Never fall back to the delivery id: two deliveries for the same
            // sponsorship would then create two independent donation rows.
            const sponsorshipId = String(
                sponsorship.node_id ?? sponsorship.id ?? "",
            );
            if (!sponsorshipId) {
                throw new Error("Sponsorship payload has no stable identifier");
            }
            await tx.github_sponsorships.upsert({
                where: { id: sponsorshipId },
                create: {
                    id: sponsorshipId,
                    sponsor_github_id: githubId,
                    sponsorable_login: policy.sponsorsLogin,
                    is_one_time:
                        sponsorship.is_one_time_payment ??
                        sponsorship.tier?.is_one_time ??
                        false,
                    is_active: payload.action !== "cancelled",
                    tier_name: sponsorship.tier?.name ?? null,
                    amount_cents:
                        sponsorship.tier?.monthly_price_in_cents ?? null,
                    payment_source: "GITHUB",
                    privacy_level: sponsorship.privacy_level ?? null,
                    source: "webhook",
                    sponsored_at: sponsoredAt,
                    last_seen_at: now,
                    last_verified_at: now,
                },
                update: {
                    is_active: payload.action !== "cancelled",
                    tier_name: sponsorship.tier?.name ?? null,
                    amount_cents:
                        sponsorship.tier?.monthly_price_in_cents ?? null,
                    last_seen_at: now,
                    last_verified_at: now,
                    verification_status: "verified",
                },
            });
        });
        if (claimedUserId && sponsor.type !== "Organization") {
            await reconcileUserFreeProxyMonitorLimit(
                claimedUserId,
                `github-sponsorship:${payload.action ?? "updated"}`,
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
        console.error("[github-rewards] sponsors webhook failed", error);
        return NextResponse.json(
            { error: "Webhook processing failed" },
            { status: 500 },
        );
    }
}
