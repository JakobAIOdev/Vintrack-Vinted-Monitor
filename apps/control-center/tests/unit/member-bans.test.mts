import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import type * as MemberBan from "../../src/lib/member-ban.server";

function harness(
    admin: { role: string; banned_at?: Date } | null,
    member: { role: string } | null,
) {
    let writes = 0;
    const tx = {
        $queryRaw: async () => [],
        $executeRaw: async () => 0,
        user: {
            findUnique: async ({ where }: { where: { id: string } }) =>
                where.id === "actor" ? admin : member,
            update: async () => {
                writes++;
                throw new Error("Unexpected mutation");
            },
        },
    };
    const modules: Record<string, unknown> = {
        "server-only": {},
        "@/lib/db": {
            db: {
                $transaction: async (operation: (tx: unknown) => unknown) =>
                    operation(tx),
            },
        },
        "@/lib/monitor-limits": {
            acquireGlobalMonitorActivationLock: async () => {},
        },
    };
    const exports = {};
    vm.runInNewContext(
        ts.transpileModule(
            readFileSync(
                new URL("../../src/lib/member-ban.server.ts", import.meta.url),
                "utf8",
            ),
            {
                compilerOptions: {
                    module: ts.ModuleKind.CommonJS,
                    target: ts.ScriptTarget.ES2022,
                },
            },
        ).outputText,
        {
            exports,
            require: (name: string) => {
                assert.ok(name in modules);
                return modules[name];
            },
        },
    );
    return {
        change: (exports as typeof MemberBan).changeMemberBan,
        writes: () => writes,
    };
}

test("ban and unban reject non-admin and banned actors before any mutation", async () => {
    for (const admin of [
        null,
        { role: "free" },
        { role: "premium" },
        { role: "admin", banned_at: new Date() },
    ]) {
        const h = harness(admin, { role: "free" });
        for (const banned of [true, false]) {
            await assert.rejects(
                () => h.change("actor", "target", banned),
                /Forbidden/,
            );
        }
        assert.equal(h.writes(), 0);
    }
});

test("self-bans, admin targets and missing members cannot be mutated", async () => {
    const h = harness({ role: "admin" }, { role: "admin" });
    await assert.rejects(() => h.change("actor", "actor", true), /own account/);
    await assert.rejects(() => h.change("actor", "target", true), /admin role/);
    assert.equal(h.writes(), 0);
    const missing = harness({ role: "admin" }, null);
    await assert.rejects(
        () => missing.change("actor", "target", true),
        /Member not found/,
    );
    assert.equal(missing.writes(), 0);
});
