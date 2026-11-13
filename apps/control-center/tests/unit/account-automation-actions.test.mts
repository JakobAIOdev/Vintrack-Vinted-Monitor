import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as automations from "../../src/lib/account-automations.ts";
import { REGIONS } from "../../src/lib/regions.ts";

function harness({
    anonymous = false,
    foreign = false,
    denied = false,
    account = {
        vinted_user_id: BigInt(42),
        domain: "www.vinted.de",
        status: "active",
    },
} = {}) {
    const writes: Record<string, unknown>[] = [];
    const db = {
        monitors: {
            findFirst: async ({
                where,
            }: {
                where: { id: number; userId: string };
            }) => {
                assert.equal(where.userId, "synthetic-member");
                return foreign ? null : { id: where.id, region: "de" };
            },
        },
        monitor_account_automations: {
            updateMany: async (query: Record<string, unknown>) => {
                writes.push(query);
                return { count: 1 };
            },
        },
        $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
            fn({
                $queryRaw: async (_: TemplateStringsArray, userId: string) => {
                    assert.equal(userId, "synthetic-member");
                    return [account];
                },
                monitor_account_automations: {
                    upsert: async (query: Record<string, unknown>) =>
                        writes.push(query),
                },
            }),
    };
    const modules: Record<string, unknown> = {
        "@/auth": {
            auth: async () =>
                anonymous ? null : { user: { id: "synthetic-member" } },
        },
        "@/lib/db": { db },
        "@/lib/monitor-limits": {
            withMonitorActivationLock: async (
                _: string,
                fn: (tx: unknown) => Promise<unknown>,
            ) => db.$transaction(fn),
        },
        "@/lib/features.server": {
            getFeatureAccessForUser: async (_: string, userId: string) => {
                assert.equal(userId, "synthetic-member");
                return { allowed: !denied };
            },
        },
        "@/lib/regions": { REGIONS },
        "@/lib/account-automations": automations,
        "next/cache": { revalidatePath() {} },
    };
    const exports: {
        saveAccountAutomation?: (
            id: number,
            kind: string,
            value: automations.AutomationSettings,
        ) => Promise<{ error?: string; success?: boolean }>;
    } = {};
    const output = ts.transpileModule(
        readFileSync(
            new URL(
                "../../src/actions/account-automations.ts",
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
    vm.runInNewContext(output, {
        exports,
        require: (name: string) => {
            assert.ok(name in modules, `Unexpected import ${name}`);
            return modules[name];
        },
    });
    return { save: exports.saveAccountAutomation!, writes };
}

const enabled = { ...automations.DEFAULT_AUTOMATION_SETTINGS, enabled: true };

test("anonymous callers, foreign monitors, denied policies and region mismatches cannot arm modules", async () => {
    for (const scenario of [
        { anonymous: true },
        { foreign: true },
        { denied: true },
        {
            account: {
                vinted_user_id: BigInt(42),
                domain: "www.vinted.fr",
                status: "active",
            },
        },
        {
            account: {
                vinted_user_id: BigInt(42),
                domain: "www.vinted.de",
                status: "needs_browser_sync",
            },
        },
    ]) {
        const h = harness(scenario);
        assert.ok((await h.save(1, "message", enabled)).error);
        assert.equal(h.writes.length, 0);
    }
});

test("arming uses the identity locked inside the transaction and changes only the requested module", async () => {
    const h = harness();
    assert.equal((await h.save(1, "offer", enabled)).success, true);
    const write = h.writes[0] as {
        create: Record<string, unknown>;
        update: Record<string, unknown>;
    };
    assert.equal(write.create.account_id, BigInt(42));
    assert.equal(write.create.domain, "www.vinted.de");
    assert.equal(write.create.kind, "offer");
    assert.equal(write.create.monitor_id, 1);
    assert.equal(write.create.enabled, true);
    assert.ok(write.create.enabled_at);
    assert.ok(write.update.revision);
});

test("disabling stays available with withdrawn access or expired account and invalid edited fields", async () => {
    const h = harness({
        denied: true,
        account: {
            vinted_user_id: BigInt(42),
            domain: "www.vinted.fr",
            status: "needs_browser_sync",
        },
    });
    assert.equal(
        (
            await h.save(1, "offer", {
                ...enabled,
                enabled: false,
                maxPriceMinor: 0,
            })
        ).success,
        true,
    );
    const write = h.writes[0] as {
        where: { kind: string; monitor_id: number };
        data: { enabled: boolean };
    };
    assert.equal(write.where.kind, "offer");
    assert.equal(write.where.monitor_id, 1);
    assert.equal(write.data.enabled, false);
});
