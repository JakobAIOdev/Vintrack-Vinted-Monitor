import { expect, test } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { createServer, type Server } from "node:http";

const enabled = process.env.CHECKOUT_MEMBER_UI_TEST === "true";
const memberId = "e2e-checkout-member";
let db: PrismaClient;
let stub: Server;
let contextState = "ready";
let proxyGroupId: number;

test.describe("experimental checkout member settings", () => {
    test.skip(
        !enabled,
        "requires the isolated checkout UI database and API stub",
    );
    test.describe.configure({ mode: "serial" });
    test.beforeAll(async () => {
        const database = new URL(
            process.env.DATABASE_URL || "postgres://invalid/invalid",
        );
        expect(database.pathname.startsWith("/vintrack_checkout_test")).toBe(
            true,
        );
        db = new PrismaClient();
        const group = await db.proxy_groups.create({
            data: {
                userId: memberId,
                name: "Dedicated checkout proxy",
                proxies: "http://proxy.example.com:8080",
            },
        });
        proxyGroupId = group.id;
        stub = createServer((request, response) => {
            response.setHeader("Content-Type", "application/json");
            if (request.url === "/api/checkout-agent/status") {
                response.end(
                    JSON.stringify({
                        available: true,
                        paired: true,
                        online: true,
                    }),
                );
            } else if (request.url === "/api/checkout-agent/pair-code") {
                response.end(
                    JSON.stringify({
                        code: "a".repeat(64),
                        expiresInSeconds: 300,
                    }),
                );
            } else if (request.url === "/api/checkout-agent/revoke") {
                response.end(JSON.stringify({ revoked: true }));
            } else if (request.url === "/api/account/status") {
                response.end(
                    JSON.stringify({
                        linked: true,
                        status: "active",
                        vinted_id: 42,
                        vinted_name: "synthetic_member",
                        domain: "www.vinted.de",
                        browser_linked: true,
                        server_checkout: {
                            state: contextState,
                            automatic_payment_available: true,
                        },
                    }),
                );
            } else if (request.method === "POST") {
                response.statusCode = 400;
                response.end(
                    JSON.stringify({
                        error: "No checkout or account mutation is allowed by this UI fixture",
                    }),
                );
            } else {
                response.end(
                    JSON.stringify({
                        linked: true,
                        notifications: [],
                        likes: [],
                        conversations: [],
                    }),
                );
            }
        });
        await new Promise<void>((resolve, reject) => {
            stub.once("error", reject);
            stub.listen(4110, "127.0.0.1", resolve);
        });
    });
    test.afterAll(async () => {
        if (proxyGroupId)
            await db.proxy_groups.deleteMany({
                where: { id: proxyGroupId, userId: memberId },
            });
        await db?.$disconnect();
        if (stub)
            await new Promise<void>((resolve) => stub.close(() => resolve()));
    });
    for (const [role, transport] of [
        ["free", "server"],
        ["premium", "server"],
        ["free", "agent"],
        ["premium", "agent"],
    ] as const) {
        test(`${role} members can opt into ${transport} checkout while disarming existing auto-payment`, async ({
            page,
        }) => {
            contextState = "ready";
            await db.user.update({
                where: { id: memberId },
                data: {
                    role,
                    checkout_enabled: true,
                    checkout_risk_version: 1,
                    checkout_risk_accepted_at: new Date(),
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
                },
            });
            await db.vinted_sessions.upsert({
                where: { userId: memberId },
                create: {
                    userId: memberId,
                    vinted_user_id: 42n,
                    vinted_name: "synthetic_member",
                    domain: "www.vinted.de",
                    access_token_ciphertext:
                        "synthetic-fixture-not-an-auth-token",
                },
                update: { vinted_user_id: 42n, domain: "www.vinted.de" },
            });
            await page.goto("/account?connection=vinted#checkout-settings");
            const method = page.getByLabel("Checkout method", { exact: true });
            await expect(method).toHaveValue("browser");
            await method.selectOption(transport);
            await expect(
                page.getByRole("checkbox", {
                    name: /(?:Auto-checkout|Full checkout) with my saved card after clicking a buy link/,
                }),
            ).not.toBeChecked();
            if (transport === "server") {
                await expect(
                    page.getByText("Session context is available.", {
                        exact: false,
                    }),
                ).toBeVisible();
                await expect(
                    page.getByRole("button", {
                        name: "Save checkout preferences",
                        exact: true,
                    }),
                ).toBeDisabled();
                await page
                    .getByLabel("Checkout proxy group", { exact: true })
                    .selectOption(String(proxyGroupId));
                await expect(
                    page.getByText(
                        "Discord and Telegram buy links use this method too.",
                        { exact: false },
                    ),
                ).toBeVisible();
            }
            await page
                .getByRole("button", {
                    name: "Save checkout preferences",
                    exact: true,
                })
                .click();
            await expect(
                page.getByText("Checkout preferences saved.", { exact: true }),
            ).toBeVisible();
            const saved = await db.user.findUniqueOrThrow({
                where: { id: memberId },
                select: { checkout_preferences: true },
            });
            const settings = saved.checkout_preferences as {
                transport?: string;
                proxyGroupId?: number;
                preferences?: { autoCheckout?: unknown };
            };
            expect(settings.transport).toBe(transport);
            if (transport === "server")
                expect(settings.proxyGroupId).toBe(proxyGroupId);
            expect(settings.preferences?.autoCheckout).toBeUndefined();
            await page.reload();
            await expect(method).toHaveValue(transport);
            await expect(
                page
                    .getByText("Request Full checkout", { exact: true })
                    .locator(".."),
            ).toContainText("Disabled");
            await expect(
                page.getByRole("note").filter({
                    hasText: "Requests are available only as Full checkout",
                }),
            ).toBeVisible();
            if (transport === "server")
                await expect(
                    page.getByLabel("Checkout proxy group", { exact: true }),
                ).toHaveValue(String(proxyGroupId));
            expect(
                await page.evaluate(
                    () => document.documentElement.scrollWidth <= innerWidth,
                ),
            ).toBe(true);
            if (transport === "server")
                await page
                    .getByLabel("Checkout method", { exact: true })
                    .locator("..")
                    .screenshot({
                        path: test.info().outputPath("checkout-method.png"),
                    });
            await page.locator("#checkout-settings").screenshot({
                path: test
                    .info()
                    .outputPath(`checkout-${transport}-${role}.png`),
            });
        });
    }
    test("a rejected server context gives a recovery instruction without checkout", async ({
        page,
    }) => {
        contextState = "blocked";
        await db.user.update({
            where: { id: memberId },
            data: {
                checkout_preferences: {
                    accountId: 42,
                    domain: "www.vinted.de",
                    transport: "server",
                    preferences: { shipping: "home", payment: "card" },
                },
            },
        });
        await page.goto("/account?connection=vinted#checkout-settings");
        await expect(
            page.getByText(
                "Vinted blocked request checkout for this session.",
                {
                    exact: false,
                },
            ),
        ).toBeVisible();
        await expect(
            page.getByRole("button", { name: "Sync server checkout context" }),
        ).toBeDisabled();
        await expect(
            page.getByText("Install or update it above", { exact: false }),
        ).toBeVisible();
    });

    test("checkout cookie sync requires the disclosed in-page consent and reports completion", async ({
        page,
    }) => {
        contextState = "ready";
        await page.addInitScript(() => {
            const syncRequests: unknown[] = [];
            (
                window as Window & { checkoutSyncRequests?: unknown[] }
            ).checkoutSyncRequests = syncRequests;
            window.addEventListener("message", (event) => {
                if (event.source !== window) return;
                if (event.data?.type === "VINTRACK_EXTENSION_PING") {
                    window.postMessage(
                        {
                            type: "VINTRACK_EXTENSION_READY",
                            payload: {
                                installed: true,
                                configured: true,
                                version: "0.4.3",
                                checkoutContextBackgroundSync: false,
                                requestId: event.data.requestId,
                            },
                        },
                        window.location.origin,
                    );
                }
                if (
                    event.data?.type ===
                    "VINTRACK_EXTENSION_REVOKE_CHECKOUT_CONTEXT"
                ) {
                    window.postMessage(
                        {
                            type: "VINTRACK_EXTENSION_REVOKE_CHECKOUT_CONTEXT_RESULT",
                            payload: {
                                ok: true,
                                checkoutContextBackgroundSync: false,
                            },
                        },
                        window.location.origin,
                    );
                }
                if (event.data?.type === "VINTRACK_EXTENSION_MANUAL_SYNC") {
                    syncRequests.push(event.data.payload);
                    window.postMessage(
                        {
                            type: "VINTRACK_EXTENSION_MANUAL_SYNC_RESULT",
                            payload: {
                                ok: true,
                                checkoutContextBackgroundSync: true,
                                results: [
                                    {
                                        ok: true,
                                        status: "completed",
                                        domain: "www.vinted.de",
                                        vintedName: "synthetic_member",
                                    },
                                ],
                            },
                        },
                        window.location.origin,
                    );
                }
            });
        });
        page.on("dialog", () => {
            throw new Error(
                "Checkout sync must not open a blocking browser dialog",
            );
        });
        await page.goto("/account?connection=vinted");
        const syncButton = page.getByRole("button", {
            name: "Sync server checkout context",
            exact: true,
        });
        await expect(syncButton).toBeEnabled();
        const keptInSync = page.getByText("Kept in sync from this browser", {
            exact: true,
        });
        const notKeptInSync = page.getByText("Not kept in sync", {
            exact: true,
        });
        const stopButton = page.getByRole("button", {
            name: "Stop keeping checkout context in sync",
            exact: true,
        });
        await expect(notKeptInSync).toBeVisible();
        await expect(stopButton).toHaveCount(0);
        await syncButton.click();
        const disclosure = page.getByRole("dialog", {
            name: "Sync checkout session?",
        });
        for (const text of [
            "datadome",
            "anon_id",
            "_vinted_fr_session",
            "v_udt",
            "CSRF",
            "browser User-Agent",
            "encrypted",
            "refresh token",
            "keeps sending them whenever it refreshes the Vinted session",
            "until you turn it off",
            "disconnect the extension",
            "switch account or region",
        ]) {
            await expect(disclosure).toContainText(text);
        }
        await expect(disclosure).toContainText(new URL(page.url()).origin);
        await disclosure
            .getByRole("button", { name: "Cancel", exact: true })
            .click();
        await expect(disclosure).not.toBeVisible();
        expect(
            await page.evaluate(
                () =>
                    (window as Window & { checkoutSyncRequests?: unknown[] })
                        .checkoutSyncRequests,
            ),
        ).toEqual([]);
        await syncButton.click();
        await disclosure
            .getByRole("button", { name: "Allow checkout sync", exact: true })
            .click();
        await expect(
            page.getByText("Synced Vinted account @synthetic_member", {
                exact: true,
            }),
        ).toBeVisible();
        await expect(syncButton).toBeEnabled();
        expect(
            await page.evaluate(
                () =>
                    (window as Window & { checkoutSyncRequests?: unknown[] })
                        .checkoutSyncRequests,
            ),
        ).toEqual([
            {
                preferredDomain: "www.vinted.de",
                includeCheckoutContext: true,
                checkoutContextConsent: 2,
            },
        ]);
        await expect(keptInSync).toBeVisible();
        await stopButton.click();
        await expect(notKeptInSync).toBeVisible();
        await expect(stopButton).toHaveCount(0);
    });

    test("agent pairing requires explicit disclosure and masks its one-time code", async ({
        page,
    }) => {
        await page.goto("/account?connection=vinted#local-checkout-agent");
        await page
            .getByLabel("Checkout method", { exact: true })
            .selectOption("agent");
        page.once("dialog", async (dialog) => {
            expect(dialog.message()).toContain("Vinted access token");
            expect(dialog.message()).toContain("Refresh tokens are excluded");
            await dialog.accept();
        });
        await page.getByRole("button", { name: "Create pairing code" }).click();
        const code = page.getByLabel("One-time pairing code", { exact: false });
        await expect(code).toHaveAttribute("type", "password");
        await expect(code).toHaveValue("a".repeat(64));
        await page
            .getByRole("button", { name: "Revoke agent", exact: true })
            .click();
        await expect(
            page.getByText("Checkout agent revoked.", { exact: true }),
        ).toBeVisible();
        await expect(code).toHaveCount(0);
    });
});
