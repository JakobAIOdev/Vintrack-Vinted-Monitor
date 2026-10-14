import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { createHash } from "node:crypto";
import type * as Policy from "../../src/lib/checkout-notifications";
import type * as Service from "../../src/lib/checkout-notifications.server";
import type * as Actions from "../../src/actions/admin-checkout-notifications";

function load<T>(
    path: string,
    modules: Record<string, unknown>,
    globals: Record<string, unknown> = {},
): T {
    const exports = {};
    const output = ts.transpileModule(
        readFileSync(new URL(path, import.meta.url), "utf8"),
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
        URL,
        AbortSignal,
        console,
        setTimeout: (callback: () => void) => callback(),
        ...globals,
    });
    return exports as T;
}
const validation = load("../../src/lib/validation.ts", {});
const policy = load<typeof Policy>("../../src/lib/checkout-notifications.ts", {
    "@/lib/validation": validation,
});
const webhook =
    "https://discord.com/api/webhooks/123456789012345678/synthetic-token";
const configured = {
    ...policy.DEFAULT_CHECKOUT_NOTIFICATION_POLICY,
    enabled: true,
    webhookUrl: webhook,
};

test("anonymous payload excludes identifiers, pictures and prices, even in title/footer", () => {
    const payload = policy.buildCheckoutNotification(
        configured,
        policy.CHECKOUT_NOTIFICATION_PREVIEW,
    );
    const text = JSON.stringify(payload);
    for (const value of [
        "example-id",
        "example_buyer",
        "Nike",
        "vinted.de",
        "vinted.net",
        "25.00",
    ])
        assert.ok(!text.includes(value), `Leaked ${value}`);
    assert.deepEqual(
        JSON.parse(JSON.stringify(payload.embeds[0].fields)).map(
            (field: { name: string }) => field.name,
        ),
        ["Status", "Checkout method", "Payment method", "Region"],
    );
    assert.deepEqual(JSON.parse(JSON.stringify(payload.allowed_mentions)), {
        parse: [],
    });
});

test("all detail fields are independently selectable and mention-safe", () => {
    const full = {
        ...configured,
        fields: policy.CHECKOUT_NOTIFICATION_FIELDS.map((field) => field.key),
    };
    const payload = policy.buildCheckoutNotification(full, {
        ...policy.CHECKOUT_NOTIFICATION_PREVIEW,
        item: "@everyone **test**",
        image: "https://images1.vinted.net/example.jpg?token=secret",
    });
    assert.ok(
        payload.embeds[0].fields.some((field) =>
            field.value.includes("\\*\\*test"),
        ),
    );
    assert.equal(
        payload.embeds[0].thumbnail?.url,
        "https://images1.vinted.net/example.jpg",
    );
    assert.ok(payload.embeds[0].url);
    const filtered = policy.filterStoredCheckoutNotification(payload, {
        fields: [],
    });
    assert.equal(filtered.embeds[0].fields.length, 1);
    assert.ok(!JSON.stringify(filtered).includes("example"));
    assert.ok(!filtered.embeds[0].url && !filtered.embeds[0].thumbnail);
});

test("only explicit confirmed outcomes can be called a purchase", () => {
    for (const [status, outcome] of Object.entries(policy.CHECKOUT_OUTCOMES)) {
        const payload = policy.buildCheckoutNotification(configured, {
            ...policy.CHECKOUT_NOTIFICATION_PREVIEW,
            status,
        });
        assert.equal(payload.embeds[0].color === 0x22c55e, outcome.confirmed);
        assert.equal(outcome.confirmed, status === "card_payment_confirmed");
    }
    assert.throws(() =>
        policy.buildCheckoutNotification(configured, {
            ...policy.CHECKOUT_NOTIFICATION_PREVIEW,
            status: "toString",
        }),
    );
});

test("webhook validation rejects arbitrary hosts, redirects and malformed field settings", () => {
    for (const webhookUrl of [
        "http://discord.com/api/webhooks/123456789012345678/token",
        "https://discord.com.evil.test/api/webhooks/123456789012345678/token",
        `${webhook}?redirect=secret`,
        "https://user:secret@discord.com/api/webhooks/123456789012345678/token",
        "",
    ]) {
        assert.throws(() =>
            policy.validateCheckoutNotificationPolicy({
                ...configured,
                webhookUrl,
            }),
        );
    }
    assert.throws(() =>
        policy.validateCheckoutNotificationPolicy({
            ...configured,
            fields: ["secret"] as never,
        }),
    );
    assert.equal(
        policy.validateCheckoutNotificationPolicy(configured).webhookUrl,
        webhook,
    );
});

function harness(
    options: {
        status?: string;
        discordStatus?: number;
        throwing?: boolean;
        confirmedOnly?: boolean;
        disabled?: boolean;
        missingItem?: boolean;
        legacy?: boolean;
    } = {},
) {
    const rows = new Map<string, Record<string, unknown>>();
    const callbacks: (() => Promise<void>)[] = [];
    const calls: { url: URL; init: RequestInit }[] = [];
    let reads = 0;
    class KnownError extends Error {
        code = "P2002";
    }
    const saved = {
        ...configured,
        enabled: !options.disabled,
        events: options.confirmedOnly ? "confirmed" : "all",
    };
    const db = {
        app_settings: {
            findUnique: async () => ({ value: JSON.stringify(saved) }),
        },
        vinted_sessions: {
            findUnique: async () => ({
                domain: "www.vinted.de",
                vinted_name: "private-account",
                vinted_user_id: 42,
            }),
        },
        user: {
            findUnique: async () => ({
                name: "Private member",
                checkout_preferences: {
                    accountId: 42,
                    domain: "www.vinted.de",
                    preferences: {
                        shipping: "home",
                        payment: "card",
                        autoCheckout: {
                            warningVersion: 2,
                            currency: "EUR",
                            maxTotalMinor: 3000,
                        },
                    },
                },
            }),
        },
        items: {
            findFirst: async (query: {
                where: { monitors: { userId: string } };
            }) => {
                reads++;
                assert.equal(query.where.monitors.userId, "member");
                return options.missingItem
                    ? null
                    : {
                          title: "Private item",
                          image_url: "https://images1.vinted.net/private.jpg",
                          price: "25 EUR",
                      };
            },
        },
        checkout_notification_deliveries: {
            create: async ({
                data,
            }: {
                data: Record<string, unknown> & { id: string };
            }) => {
                if (rows.has(data.id)) throw new KnownError();
                rows.set(data.id, { ...data, status: "pending", attempts: 0 });
            },
            updateMany: async ({
                where,
                data,
            }: {
                where: { id: string; status?: string };
                data: Record<string, unknown>;
            }) => {
                const row = rows.get(where.id);
                if (
                    !row ||
                    row.status === "delivered" ||
                    (row.status === "sending" && !where.status)
                )
                    return { count: 0 };
                Object.assign(row, data);
                return { count: 1 };
            },
            findUniqueOrThrow: async ({ where }: { where: { id: string } }) =>
                rows.get(where.id),
            findUnique: async ({ where }: { where: { id: string } }) =>
                rows.get(where.id) || null,
            update: async ({
                where,
                data,
            }: {
                where: { id: string };
                data: Record<string, unknown>;
            }) => {
                const row = rows.get(where.id)!;
                if (data.attempts) row.attempts = Number(row.attempts) + 1;
                Object.assign(row, { ...data, attempts: row.attempts });
                return row;
            },
        },
    };
    const service = load<typeof Service>(
        "../../src/lib/checkout-notifications.server.ts",
        {
            "server-only": {},
            "node:crypto": { createHash },
            "next/server": {
                after: (callback: () => Promise<void>) =>
                    callbacks.push(callback),
            },
            "@prisma/client": {
                Prisma: { PrismaClientKnownRequestError: KnownError },
            },
            "@/lib/db": { db },
            "@/lib/checkout-notifications": policy,
            "@/lib/checkout": {
                checkoutDomain: (domain: string) =>
                    domain === "www.vinted.de" ? domain : null,
                isCheckoutUrl: (raw: unknown, domain: string) =>
                    typeof raw === "string" &&
                    raw.startsWith(`https://${domain}/checkout?`),
                isCheckoutPreferences: () => true,
                CHECKOUT_PAYMENT_LABELS: { card: "Card", vinted: "Vinted" },
            },
        },
        {
            fetch: async (url: URL, init: RequestInit) => {
                calls.push({ url, init });
                if (options.throwing)
                    throw new Error(`private webhook ${webhook}`);
                const status = options.discordStatus || 200;
                return new Response(
                    status === 429
                        ? JSON.stringify({ retry_after: 0.01 })
                        : "{}",
                    { status },
                );
            },
        },
    );
    const report = {
        userId: "member",
        itemId: 123,
        transactionId: 77,
        purchaseId: "synthetic",
        status: options.status || "card_payment_confirmed",
        browserReported: !options.legacy,
        checkoutUrl:
            "https://www.vinted.de/checkout?purchase_id=synthetic&order_id=77&order_type=transaction",
    };
    return { service, report, calls, rows, callbacks, reads: () => reads };
}

test("queue persists only selected fields, deduplicates checkout replay, and delivers after response", async () => {
    const h = harness();
    await h.service.queueCheckoutNotification(h.report);
    await h.service.queueCheckoutNotification({
        ...h.report,
        status: "checkout_review_required",
    });
    await h.service.queueCheckoutNotification(h.report);
    assert.equal(h.rows.size, 1); // A cached review cannot downgrade a confirmed purchase.
    assert.equal(h.calls.length, 0);
    for (const row of h.rows.values())
        assert.ok(!JSON.stringify(row.payload).includes("Private"));
    for (const callback of h.callbacks) await callback();
    assert.equal(h.calls.length, 1);
    for (const row of h.rows.values()) {
        assert.equal(row.status, "delivered");
        await h.service.deliverCheckoutNotification(String(row.id));
    }
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].url.searchParams.get("wait"), "true");
    assert.equal(h.calls[0].init.redirect, "error");
});

test("disabled/confirmed-only/invalid events and unowned browser reports cannot notify", async () => {
    for (const options of [
        { disabled: true },
        { confirmedOnly: true, status: "paypal_redirect_ready" },
        { status: "toString" },
        { missingItem: true },
    ]) {
        const h = harness(options);
        await h.service.queueCheckoutNotification(h.report);
        assert.equal(h.rows.size, 0);
        assert.equal(h.callbacks.length, 0);
    }
    const h = harness();
    await h.service.queueCheckoutNotification({
        ...h.report,
        checkoutUrl:
            "https://www.vinted.de/checkout?purchase_id=another&order_id=77",
    });
    assert.equal(h.rows.size, 0);
});

test("Discord rate limits retry boundedly while permanent/ambiguous failures retain sanitized history", async () => {
    for (const [options, expected] of [
        [{ discordStatus: 429 }, 3],
        [{ discordStatus: 401 }, 1],
        [{ throwing: true }, 1],
    ] as const) {
        const h = harness(options);
        await h.service.queueCheckoutNotification(h.report);
        await h.callbacks[0]();
        assert.equal(h.calls.length, expected);
        const row = [...h.rows.values()][0];
        assert.equal(row.status, "failed");
        assert.ok(!String(row.last_error).includes("synthetic-token"));
    }
});

test("anonymous server checkout does not query item details", async () => {
    const h = harness({ legacy: true });
    await h.service.queueCheckoutNotification(h.report);
    assert.equal(h.reads(), 0);
});

function adminHarness(role = "admin") {
    let saved = { ...configured };
    let writes = 0;
    let sends = 0;
    const audits: unknown[] = [];
    const actions = load<typeof Actions>(
        "../../src/actions/admin-checkout-notifications.ts",
        {
            "@/auth": {
                auth: async () => ({ user: { id: "admin-member", role } }),
            },
            "next/cache": { revalidatePath: () => {} },
            "@/lib/audit": {
                logAuditEvent: async (event: unknown) => audits.push(event),
            },
            "@/lib/checkout-notifications": policy,
            "@/lib/checkout-notifications.server": {
                loadCheckoutNotificationPolicy: async () => saved,
                sendCheckoutDiscord: async () => {
                    sends++;
                    return { ok: true };
                },
                deliverCheckoutNotification: async () => {
                    sends++;
                },
            },
            "@/lib/db": {
                db: {
                    app_settings: {
                        upsert: async (query: {
                            update: { value: string };
                        }) => {
                            writes++;
                            saved = JSON.parse(query.update.value);
                        },
                    },
                    checkout_notification_deliveries: {
                        findMany: async () => [],
                        groupBy: async () => [],
                    },
                },
            },
        },
    );
    return {
        actions,
        saved: () => saved,
        writes: () => writes,
        sends: () => sends,
        audits,
    };
}

test("all notification admin actions reject members before reading/writing/sending", async () => {
    const h = adminHarness("premium");
    for (const action of [
        () => h.actions.getCheckoutNotificationsAdminState(),
        () => h.actions.saveCheckoutNotifications(configured),
        () => h.actions.testCheckoutNotifications(),
        () => h.actions.retryCheckoutNotifications(),
    ])
        await assert.rejects(action, /Unauthorized/);
    assert.equal(h.writes(), 0);
    assert.equal(h.sends(), 0);
});

test("admin snapshots and audit metadata hide saved webhook tokens; blank preserves and remove clears", async () => {
    const h = adminHarness();
    const state = await h.actions.getCheckoutNotificationsAdminState();
    assert.equal(state.hasWebhook, true);
    assert.ok(!JSON.stringify(state).includes("synthetic-token"));
    await h.actions.saveCheckoutNotifications({
        ...configured,
        webhookUrl: "",
    });
    assert.equal(h.saved().webhookUrl, webhook);
    await h.actions.saveCheckoutNotifications({
        ...configured,
        enabled: false,
        webhookUrl: "",
        removeWebhook: true,
    });
    assert.equal(h.saved().webhookUrl, "");
    assert.ok(!JSON.stringify(h.audits).includes("synthetic-token"));
    await assert.rejects(
        () => h.actions.testCheckoutNotifications(),
        /Save a Discord webhook/,
    );
});

test("prepared activity can later produce a single confirmed purchase", async () => {
    const h = harness({ status: "checkout_prepared" });
    await h.service.queueCheckoutNotification(h.report);
    await h.service.queueCheckoutNotification({
        ...h.report,
        status: "card_payment_confirmed",
    });
    await h.service.queueCheckoutNotification({
        ...h.report,
        status: "card_payment_confirmed",
    });
    assert.equal(h.rows.size, 2);
});
