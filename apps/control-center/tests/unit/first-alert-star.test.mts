import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as prompt from "../../src/lib/first-alert-star.ts";
import { DEFAULT_GITHUB_REWARDS_POLICY } from "../../src/lib/github-rewards.ts";
import type * as Server from "../../src/lib/first-alert-star.server";

function harness() {
    const status = {
        policy: { ...DEFAULT_GITHUB_REWARDS_POLICY, enforcementEnabled: true },
        starred: false,
        donated: false,
        githubConnected: true,
        githubIdentityKnown: true,
        starVerifiedAt: new Date().toISOString(),
        source: "policy_default",
        limitReached: false,
        effectiveLimit: 2 as number | null,
    };
    const state = {
        delivered: true,
        identity: "unstarred",
        nowStarred: false,
        verificationError: null as Error | null,
        webhookStar: false,
        verificationCalls: 0,
        claims: new Set<string>(),
        writes: [] as unknown[],
    };
    class GithubStarRecheckError extends Error {
        code: string;
        constructor(code: string) {
            super(code);
            this.code = code;
        }
    }
    const db = {
        member_reward_prompts: {
            findUnique: async ({
                where,
            }: {
                where: {
                    userId_policy_version_prompt_type: { userId: string };
                };
            }) =>
                state.claims.has(where.userId_policy_version_prompt_type.userId)
                    ? { id: 1 }
                    : null,
            createMany: async ({
                data,
            }: {
                data: {
                    userId: string;
                    policy_version: string;
                    prompt_type: string;
                };
            }) => {
                if (state.claims.has(data.userId)) return { count: 0 };
                assert.equal(
                    data.policy_version,
                    prompt.FIRST_ALERT_STAR_VERSION,
                );
                assert.equal(data.prompt_type, prompt.FIRST_ALERT_STAR_TYPE);
                state.claims.add(data.userId);
                return { count: 1 };
            },
            updateMany: async (write: unknown) => {
                state.writes.push(write);
                return { count: 1 };
            },
        },
        github_reward_accounts: {
            findUnique: async () => ({ star_status: state.identity }),
        },
        alert_notifications: {
            findFirst: async ({
                where,
            }: {
                where: {
                    kind: string;
                    deliveries: {
                        some: { status: string; completed_at: { not: null } };
                    };
                };
            }) => {
                assert.equal(where.kind, "item_match");
                assert.equal(where.deliveries.some.status, "sent");
                assert.equal(where.deliveries.some.completed_at.not, null);
                return state.delivered ? { id: 1 } : null;
            },
        },
        $transaction: async (fn: (tx: unknown) => unknown) => fn(db),
    };
    const modules: Record<string, unknown> = {
        "server-only": {},
        "@/lib/db": { db },
        "@/lib/first-alert-star": prompt,
        "@/lib/github-rewards.server": {
            getMemberGithubRewardStatus: async () => status,
            GithubStarRecheckError,
            recheckGithubStarForUser: async () => {
                state.verificationCalls++;
                if (state.verificationError) throw state.verificationError;
                if (state.webhookStar) state.identity = "starred";
                return { starred: state.nowStarred };
            },
        },
    };
    const source = ts.transpileModule(
        readFileSync(
            new URL(
                "../../src/lib/first-alert-star.server.ts",
                import.meta.url,
            ),
            "utf8",
        ),
        {
            compilerOptions: {
                module: ts.ModuleKind.CommonJS,
                target: ts.ScriptTarget.ES2022,
            },
        },
    ).outputText;
    const exports = {} as typeof Server;
    vm.runInNewContext(source, {
        exports,
        require: (name: string) => {
            assert.ok(name in modules, name);
            return modules[name];
        },
    });
    return { state, status, api: exports, GithubStarRecheckError };
}

test("only a delivered item-match alert unlocks the encouragement", async () => {
    const h = harness();
    h.state.delivered = false;
    const waiting = await h.api.claimFirstAlertStarPrompt("member");
    assert.equal(waiting.prompt, null);
    assert.equal(waiting.retry, true);
    assert.equal(h.state.verificationCalls, 0);
    h.state.delivered = true;
    const result = await h.api.claimFirstAlertStarPrompt("member");
    assert.equal(result.prompt?.currentLimit, 2);
    assert.equal(result.prompt?.starLimit, 5);
    assert.equal(
        result.prompt?.repositoryUrl,
        "https://github.com/JakobAIOdev/Vintrack-Vinted-Monitor",
    );
    assert.equal(h.state.verificationCalls, 1);
});

test("existing stars, unknown identities and members who cannot benefit never see it", async () => {
    for (const flag of ["integrationEnabled", "enforcementEnabled"] as const) {
        const h = harness();
        h.status.policy[flag] = false;
        assert.equal(
            (await h.api.claimFirstAlertStarPrompt("member")).prompt,
            null,
        );
        assert.equal(h.state.verificationCalls, 0);
    }
    for (const patch of [
        { starred: true },
        { donated: true },
        { githubConnected: false },
        { githubIdentityKnown: false },
        { starVerifiedAt: "" },
        { source: "role_exempt" },
        { source: "user_override" },
        { limitReached: true },
        { effectiveLimit: null },
        { effectiveLimit: 5 },
    ]) {
        const h = harness();
        Object.assign(h.status, patch);
        assert.equal(
            (await h.api.claimFirstAlertStarPrompt("member")).prompt,
            null,
        );
        assert.equal(h.state.verificationCalls, 0);
    }
    const h = harness();
    h.state.identity = "unknown";
    assert.equal(
        (await h.api.claimFirstAlertStarPrompt("member")).prompt,
        null,
    );
    assert.equal(h.state.verificationCalls, 0);
});

test("fresh verification suppresses stale negatives and concurrent star webhooks", async () => {
    for (const flag of ["nowStarred", "webhookStar"] as const) {
        const h = harness();
        h.state[flag] = true;
        assert.equal(
            (await h.api.claimFirstAlertStarPrompt("member")).prompt,
            null,
        );
        assert.equal(h.state.claims.size, 0);
    }
});

test("unavailable verification fails closed; cooldown waits without consuming the prompt", async () => {
    for (const cooldown of [false, true]) {
        const h = harness();
        h.state.verificationError = cooldown
            ? new h.GithubStarRecheckError("cooldown")
            : new Error("unavailable");
        const result = await h.api.claimFirstAlertStarPrompt("member");
        assert.equal(result.prompt, null);
        assert.equal(result.retry, cooldown);
        assert.equal(h.state.claims.size, 0);
    }
});

test("simultaneous tabs get at most one card and policy changes cannot repeat it", async () => {
    const h = harness();
    const results = await Promise.all([
        h.api.claimFirstAlertStarPrompt("member"),
        h.api.claimFirstAlertStarPrompt("member"),
    ]);
    assert.equal(results.filter((result) => result.prompt).length, 1);
    h.status.policy.version = "new-policy";
    assert.equal(
        (await h.api.claimFirstAlertStarPrompt("member")).prompt,
        null,
    );
    assert.ok((await h.api.claimFirstAlertStarPrompt("another-member")).prompt);
});

test("dismissal and clicks update only the signed-in member's fixed milestone", async () => {
    const h = harness();
    await h.api.recordFirstAlertStarAction("member", "dismissed");
    assert.equal(h.state.claims.size, 0);
    const write = h.state.writes[0] as {
        where: { userId: string; policy_version: string; prompt_type: string };
    };
    assert.equal(write.where.userId, "member");
    assert.equal(write.where.policy_version, prompt.FIRST_ALERT_STAR_VERSION);
    assert.equal(write.where.prompt_type, prompt.FIRST_ALERT_STAR_TYPE);
});
