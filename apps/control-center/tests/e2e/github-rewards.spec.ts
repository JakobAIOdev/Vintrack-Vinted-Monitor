import { expect, test } from "@playwright/test";
import { createHmac } from "node:crypto";
import GitHub from "next-auth/providers/github";
import {
    DEFAULT_GITHUB_REWARDS_POLICY,
    buildRewardPrompt,
    parseGithubRewardsPolicy,
    renderRewardMessage,
    resolveFreeProxyLimit,
    rewardNoticeForLimitTransition,
} from "../../src/lib/github-rewards";
import { isIgnorableSponsorsGraphqlError } from "../../src/lib/github-rewards-graphql";
import { verifyGithubWebhookSignature } from "../../src/lib/github-webhooks.server";

test("GitHub OAuth uses GitHub's RFC 9207 issuer", () => {
    const provider = GitHub({
        clientId: "github-client-id",
        clientSecret: "github-client-secret",
    });

    expect(provider.issuer).toBe("https://github.com/login/oauth");
});

test.describe("GitHub reward policy", () => {
    test("uses the safe 3/5/15 default and rejects inverted limits", () => {
        expect(parseGithubRewardsPolicy(null)).toMatchObject({
            enforcementEnabled: false,
            eligibleRoles: ["free"],
            defaultLimit: 3,
            starLimit: 5,
            donationLimit: 15,
        });
        expect(
            parseGithubRewardsPolicy(
                JSON.stringify({
                    ...DEFAULT_GITHUB_REWARDS_POLICY,
                    defaultLimit: 8,
                    starLimit: 5,
                }),
            ),
        ).toEqual(DEFAULT_GITHUB_REWARDS_POLICY);
    });

    test("renders member-controlled prompt templates", () => {
        expect(
            renderRewardMessage("Running {count}/{limit}; unlock {nextLimit}", {
                count: 3,
                limit: 3,
                nextLimit: 5,
            }),
        ).toBe("Running 3/3; unlock 5");
    });

    test("recognizes the first default limit transition and later blocked attempts", () => {
        expect(
            rewardNoticeForLimitTransition({
                currentCount: 2,
                activatedCount: 1,
                limit: 3,
                source: "policy_default",
                githubConnected: false,
                policy: {
                    ...DEFAULT_GITHUB_REWARDS_POLICY,
                    version: "test-v1",
                },
            }),
        ).toMatchObject({
            promptType: "star_upgrade",
            cta: "connect",
            policyVersion: "test-v1",
        });
        expect(
            rewardNoticeForLimitTransition({
                currentCount: 3,
                activatedCount: 1,
                limit: 3,
                source: "policy_default",
                githubConnected: false,
                policy: DEFAULT_GITHUB_REWARDS_POLICY,
            }),
        ).toBeNull();
    });
});

test.describe("Free Proxy Pool limit precedence", () => {
    const reward = { limit: 5, source: "github_star" as const };

    test("an admin override outranks every reward tier", () => {
        expect(
            resolveFreeProxyLimit({
                userOverride: 2,
                reward: { limit: 15, source: "donation" },
                roleLimit: 8,
                globalLimit: 9,
            }),
        ).toEqual({ limit: 2, source: "user_override" });
    });

    test("an override of 0 is honoured rather than treated as absent", () => {
        expect(
            resolveFreeProxyLimit({
                userOverride: 0,
                reward,
                roleLimit: null,
                globalLimit: null,
            }),
        ).toEqual({ limit: 0, source: "user_override" });
    });

    test("the reward tier outranks the role and global fallbacks", () => {
        expect(
            resolveFreeProxyLimit({
                userOverride: null,
                reward,
                roleLimit: 8,
                globalLimit: 9,
            }),
        ).toEqual({ limit: 5, source: "github_star" });
    });

    test("an exempt role resolves to unlimited instead of falling through", () => {
        expect(
            resolveFreeProxyLimit({
                userOverride: null,
                reward: { limit: null, source: "role_exempt" },
                roleLimit: 8,
                globalLimit: 9,
            }),
        ).toEqual({ limit: null, source: "role_exempt" });
    });

    test("role and global rows apply while enforcement is off", () => {
        expect(
            resolveFreeProxyLimit({
                userOverride: null,
                reward: null,
                roleLimit: 8,
                globalLimit: 9,
            }),
        ).toEqual({ limit: 8, source: "role" });
        expect(
            resolveFreeProxyLimit({
                userOverride: null,
                reward: null,
                roleLimit: null,
                globalLimit: 9,
            }),
        ).toEqual({ limit: 9, source: "global" });
        expect(
            resolveFreeProxyLimit({
                userOverride: null,
                reward: null,
                roleLimit: null,
                globalLimit: null,
            }),
        ).toEqual({ limit: null, source: null });
    });
});

test.describe("Reward prompts", () => {
    const policy = DEFAULT_GITHUB_REWARDS_POLICY;

    test("each tier upsells the next step, and the top tier upsells nothing", () => {
        expect(
            buildRewardPrompt({
                source: "policy_default",
                policy,
                count: 3,
                limit: 3,
                githubConnected: true,
            }),
        ).toMatchObject({
            type: "star_upgrade",
            primaryAction: "star",
            nextLimit: policy.starLimit,
        });
        expect(
            buildRewardPrompt({
                source: "github_star",
                policy,
                count: 5,
                limit: 5,
                githubConnected: true,
            }),
        ).toMatchObject({
            type: "donation_upgrade",
            primaryAction: "donate",
            nextLimit: policy.donationLimit,
        });
        expect(
            buildRewardPrompt({
                source: "donation",
                policy,
                count: 15,
                limit: 15,
                githubConnected: true,
            }),
        ).toMatchObject({ type: "hard_limit", primaryAction: null });
    });

    test("a member without GitHub is asked to connect before starring", () => {
        expect(
            buildRewardPrompt({
                source: "policy_default",
                policy,
                count: 3,
                limit: 3,
                githubConnected: false,
            }).primaryAction,
        ).toBe("connect");
    });

    test("an admin-set limit is explained instead of upsold", () => {
        const prompt = buildRewardPrompt({
            source: "user_override",
            policy,
            count: 2,
            limit: 2,
            githubConnected: true,
        });
        expect(prompt).toMatchObject({
            type: "hard_limit",
            primaryAction: null,
        });
        expect(prompt.message).toContain("set by an administrator");
    });
});

test("GitHub webhook signatures require the exact raw body", () => {
    const secret = "github-webhook-test-secret";
    const body = JSON.stringify({ action: "created", repository: "vintrack" });
    const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

    expect(verifyGithubWebhookSignature(body, signature, secret)).toBe(true);
    expect(verifyGithubWebhookSignature(`${body}\n`, signature, secret)).toBe(
        false,
    );
    expect(verifyGithubWebhookSignature(body, "sha256=bad", secret)).toBe(
        false,
    );
});

test.describe("GitHub Sponsors partial GraphQL access", () => {
    test("keeps syncing when a fine-grained token hides one sponsorship node", () => {
        expect(
            isIgnorableSponsorsGraphqlError({
                message: "Resource not accessible by personal access token",
                path: ["user", "sponsorshipsAsMaintainer", "nodes", 6],
            }),
        ).toBe(true);
    });

    test("keeps syncing when only a sponsorship detail field is hidden", () => {
        expect(
            isIgnorableSponsorsGraphqlError({
                message: "Resource not accessible by personal access token",
                path: [
                    "user",
                    "sponsorshipsAsMaintainer",
                    "nodes",
                    0,
                    "tier",
                ],
            }),
        ).toBe(true);
    });

    test("still fails when the whole sponsorship connection is inaccessible", () => {
        expect(
            isIgnorableSponsorsGraphqlError({
                message: "Resource not accessible by personal access token",
                path: ["user", "sponsorshipsAsMaintainer"],
            }),
        ).toBe(false);
    });
});
