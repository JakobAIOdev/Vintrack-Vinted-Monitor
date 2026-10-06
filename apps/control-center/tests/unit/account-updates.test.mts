import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { ACCOUNT_UPDATES_VERSION } from "../../src/lib/account-updates.ts";

function harness(anonymous = false, storageFailure = false) {
    const writes: unknown[] = [];
    const modules: Record<string, unknown> = {
        "@/auth": {
            auth: async () =>
                anonymous ? null : { user: { id: "synthetic-member" } },
        },
        "@/lib/account-updates": { ACCOUNT_UPDATES_VERSION },
        "@/lib/db": {
            db: {
                user: {
                    updateMany: async (write: unknown) => {
                        if (storageFailure)
                            throw new Error("private storage details");
                        writes.push(write);
                        return { count: 1 };
                    },
                },
            },
        },
    };
    const exports: {
        markAccountUpdatesSeen?: () => Promise<{
            success?: boolean;
            error?: string;
        }>;
    } = {};
    const source = ts.transpileModule(
        readFileSync(
            new URL("../../src/actions/account-updates.ts", import.meta.url),
            "utf8",
        ),
        {
            compilerOptions: {
                module: ts.ModuleKind.CommonJS,
                target: ts.ScriptTarget.ES2022,
            },
        },
    ).outputText;
    vm.runInNewContext(source, {
        exports,
        require: (name: string) => {
            assert.ok(name in modules);
            return modules[name];
        },
    });
    return { writes, markSeen: exports.markAccountUpdatesSeen! };
}

test("anonymous visits cannot acknowledge another member's Account updates", async () => {
    const h = harness(true);
    assert.equal((await h.markSeen()).error, "Sign in to Vintrack.");
    assert.equal(h.writes.length, 0);
});

test("Account announcement acknowledgment is scoped to the signed-in member and never changes checkout consent", async () => {
    const h = harness();
    assert.equal((await h.markSeen()).success, true);
    assert.deepEqual(JSON.parse(JSON.stringify(h.writes)), [
        {
            where: {
                id: "synthetic-member",
                account_updates_seen_version: { lt: ACCOUNT_UPDATES_VERSION },
            },
            data: { account_updates_seen_version: ACCOUNT_UPDATES_VERSION },
        },
    ]);
});

test("failed acknowledgment stays unseen and does not expose storage errors", async () => {
    const h = harness(false, true);
    assert.equal(
        (await h.markSeen()).error,
        "Account update status could not be saved.",
    );
    assert.equal(h.writes.length, 0);
});
