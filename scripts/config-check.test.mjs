import test from "node:test";
import assert from "node:assert/strict";
import { checkConfigText, formatConfigResult } from "./config-check.mjs";

test("detects duplicate keys without exposing values", () => {
    const secret = "do-not-print-this";
    const result = checkConfigText(`AUTH_URL=http://localhost:3000\nAUTH_URL=${secret}\n`);
    assert.match(result.errors.join("\n"), /duplicate key AUTH_URL/);
    assert.doesNotMatch(formatConfigResult(result), new RegExp(secret));
});

test("warns for legacy origins and rejects conflicts", () => {
    const result = checkConfigText("AUTH_URL=https://vintrack.example\nAPP_PUBLIC_URL=https://old.example\n");
    assert.ok(result.warnings.some((item) => item.includes("deprecated")));
    assert.ok(result.errors.some((item) => item.includes("conflicts")));
});

test("validates credential groups and numbers", () => {
    const result = checkConfigText("AUTH_GITHUB_ID=id\nPRICE_WATCH_WORKERS=zero\n");
    assert.ok(result.errors.some((item) => item.includes("AUTH_GITHUB_SECRET")));
    assert.ok(result.errors.some((item) => item.includes("positive integer")));
});

test("requires safe production origins and mandatory secrets", () => {
    const result = checkConfigText("NODE_ENV=production\nAUTH_URL=http://localhost:3000\n");
    assert.ok(result.errors.some((item) => item.includes("AUTH_SECRET")));
    assert.ok(result.errors.some((item) => item.includes("stable HTTPS")));
});
