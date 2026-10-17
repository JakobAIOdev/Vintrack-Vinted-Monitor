import { expect, test } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const userId = process.env.E2E_TEST_USER_ID ?? "e2e-user";
let monitorId: number;

function screenshotPath(name: string) {
    return process.env.E2E_UPDATE_DOC_SCREENSHOTS === "true"
        ? `../../docs/screenshots/${name}`
        : test.info().outputPath(name);
}

test.describe("Account automations", () => {
    test.skip(
        process.env.E2E_TEST_MODE !== "true",
        "Requires the isolated authenticated E2E environment",
    );
    test.describe.configure({ mode: "serial" });
    test.beforeAll(async () => {
        await db.user.upsert({
            where: { id: userId },
            create: {
                id: userId,
                role: "admin",
                monitor_onboarding_status: "completed",
            },
            update: { role: "admin", monitor_onboarding_status: "completed" },
        });
        await db.vinted_sessions.upsert({
            where: { userId },
            create: {
                userId,
                vinted_user_id: BigInt(700001),
                domain: "www.vinted.de",
                status: "active",
                access_token_ciphertext: "synthetic-test-value",
            },
            update: {
                vinted_user_id: BigInt(700001),
                domain: "www.vinted.de",
                status: "active",
            },
        });
        const monitor = await db.monitors.create({
            data: {
                userId,
                name: "Vintage jackets",
                query: "jacket",
                region: "de",
                status: "active",
            },
        });
        monitorId = monitor.id;
    });
    test.afterAll(async () => {
        if (monitorId) {
            await db.account_automation_attempts.deleteMany({
                where: { monitor_id: monitorId },
            });
            await db.monitors.delete({ where: { id: monitorId } });
        }
        await db.vinted_sessions.deleteMany({
            where: { userId, vinted_user_id: BigInt(700001) },
        });
        await db.$disconnect();
    });
    test("settings stay in a compact modal, save separately and show persisted activity status", async ({
        page,
    }) => {
        await page.goto(`/monitors/${monitorId}`);
        const trigger = page.getByRole("button", { name: /^Automations/ });
        await expect(trigger).toHaveText(/Automations\s*Off/);
        await expect(
            page.getByRole("dialog", { name: "Automations", exact: true }),
        ).toHaveCount(0);
        await expect(page.getByLabel("Message template")).toHaveCount(0);
        await page.screenshot({
            path: screenshotPath(`account-automations-${test.info().project.name}.png`),
            fullPage: true,
        });
        await trigger.click();
        const dialog = page.getByRole("dialog", {
            name: "Automations",
            exact: true,
        });
        const expectedHeight = Math.min(560, page.viewportSize()!.height - 32);
        await expect
            .poll(async () => (await dialog.boundingBox())?.height)
            .toBeCloseTo(expectedHeight, 0);
        const initialBounds = await dialog.boundingBox();
        // The outer dialog stays in place, even when tab content differs.
        for (const tab of ["Auto-Message", "Activity", "Auto-Offer"]) {
            await dialog.getByRole("tab", { name: tab, exact: true }).click();
            // The opening animation can leave fractional initial bounds.
            // Keep the layout stable within one CSS pixel across tabs.
            await expect
                .poll(async () => {
                    const bounds = await dialog.boundingBox();
                    if (!bounds || !initialBounds) return Infinity;
                    return Math.max(...(["x", "y", "width", "height"] as const)
                        .map((key) => Math.abs(bounds[key] - initialBounds[key])));
                })
                .toBeLessThanOrEqual(1);
            if (tab !== "Auto-Message") {
                await dialog.screenshot({
                    path: screenshotPath(`account-automations-${tab === "Auto-Offer" ? "offer" : "activity"}-${test.info().project.name}.png`),
                });
            }
        }
        await expect(
            dialog.getByText("500 / module / UTC day", { exact: true }),
        ).toBeVisible();
        const offer = dialog.locator("section").filter({
            has: page.getByRole("heading", {
                name: "Auto-Offer",
                exact: true,
            }),
        });
        const message = dialog.locator("section").filter({
            has: page.getByRole("heading", {
                name: "Auto-Message",
                exact: true,
            }),
        });
        await expect(offer.getByRole("switch")).not.toBeChecked();
        await expect(
            dialog.getByRole("tab", { name: "Auto-Offer", exact: true }),
        ).toHaveAttribute("aria-selected", "true");
        await dialog
            .getByRole("tab", { name: "Auto-Message", exact: true })
            .click();
        await expect(message.getByRole("switch")).not.toBeChecked();
        await expect(message.getByLabel("Message template")).toHaveValue(
            "Hi! Is {title} still available?",
        );
        const template = message.getByLabel("Message template");
        await template.fill("Hi ,");
        await template.evaluate((field: HTMLTextAreaElement) =>
            field.setSelectionRange(3, 3),
        );
        await message
            .getByRole("button", { name: "Insert {seller}", exact: true })
            .click();
        await expect(template).toHaveValue("Hi {seller},");
        await expect(template).toBeFocused();
        await template.fill("Hi! Is {title} still available?");
        await dialog
            .getByRole("tab", { name: "Auto-Offer", exact: true })
            .click();
        await offer.getByRole("switch").click();
        await offer.getByLabel("Max. listing price (EUR)").fill("50,00");
        await offer.getByLabel("Discount (%)").fill("20");
        await expect(
            offer.getByText("20.00 EUR", { exact: true }),
        ).toBeVisible();
        // Unsaved toggles must not claim to be active.
        await expect(offer.getByText("Off", { exact: true })).toBeVisible();
        await offer.getByRole("button", { name: "Save & enable" }).click();
        await expect(offer.getByText("Active", { exact: true })).toBeVisible();
        const storedOffer = await db.monitor_account_automations.findUnique({
            where: {
                monitor_id_kind: { monitor_id: monitorId, kind: "offer" },
            },
        });
        expect(storedOffer?.max_price_minor).toBe(5000);
        expect(storedOffer?.discount_percent).toBe(20);
        await dialog.getByRole("tab", { name: /^Auto-Message/ }).click();
        await message.getByRole("switch").click();
        await message
            .getByLabel("Message template")
            .fill("Hi {seller}, is {title} available for {price} {currency}?");
        await expect(
            message.getByText(
                "Hi example_seller, is Vintage jacket available for 25.00 EUR?",
                { exact: true },
            ),
        ).toBeVisible();
        await message.getByLabel("Message template").fill("Hi {unknown}");
        await expect(
            message.getByRole("button", { name: "Save & enable" }),
        ).toBeDisabled();
        await message
            .getByLabel("Message template")
            .fill("Hi {seller}, is {title} still available?");
        // Switching tabs preserves the draft but never sends it.
        await dialog.getByRole("tab", { name: /^Auto-Offer/ }).click();
        await dialog.getByRole("tab", { name: /^Auto-Message/ }).click();
        await expect(message.getByLabel("Message template")).toHaveValue(
            "Hi {seller}, is {title} still available?",
        );
        await message.getByRole("button", { name: "Save & enable" }).click();
        await expect(
            message.getByText("Active", { exact: true }),
        ).toBeVisible();
        await dialog
            .getByRole("button", { name: "Close", exact: true })
            .click();
        await expect(trigger).toHaveText(/Automations\s*2 active/);
        await trigger.click();
        await offer.getByRole("switch").click();
        await expect(offer.getByText("Off", { exact: true })).toBeVisible();
        await expect
            .poll(
                async () =>
                    (
                        await db.monitor_account_automations.findUnique({
                            where: {
                                monitor_id_kind: {
                                    monitor_id: monitorId,
                                    kind: "offer",
                                },
                            },
                        })
                    )?.enabled,
            )
            .toBe(false);
        await dialog.getByRole("tab", { name: /^Auto-Message/ }).click();
        await expect(message.getByRole("switch")).toBeChecked();
        await expect(page.locator("[data-sonner-toast]")).toHaveCount(0, {
            timeout: 10000,
        });
        const bounds = await dialog.boundingBox();
        const viewport = page.viewportSize()!;
        expect(bounds!.width).toBeLessThanOrEqual(520);
        expect(bounds!.height).toBeLessThan(viewport.height);
        await dialog.screenshot({
            path: screenshotPath(`account-automations-modal-${test.info().project.name}.png`),
        });
        await dialog
            .getByRole("button", { name: "Close", exact: true })
            .click();
        await expect(trigger).toHaveText(/Automations\s*1 active/);
        await page.screenshot({
            path: screenshotPath(`account-automations-${test.info().project.name}.png`),
            fullPage: true,
        });
        expect(
            await page.evaluate(
                () => document.documentElement.scrollWidth <= window.innerWidth,
            ),
        ).toBe(true);
        // Escape closes the modal and restores focus to the visible entry point.
        await trigger.click();
        await page.setViewportSize({ ...page.viewportSize()!, height: 400 });
        await expect
            .poll(async () => (await dialog.boundingBox())?.height)
            .toBeCloseTo(368, 0);
        await page.keyboard.press("Escape");
        await expect(dialog).toHaveCount(0);
        await expect(trigger).toBeFocused();
    });
    test("paused monitors and an unverified account action show Paused instead of Active", async ({
        page,
    }) => {
        await db.monitors.update({
            where: { id: monitorId },
            data: { status: "paused" },
        });
        await page.goto(`/monitors/${monitorId}`);
        const trigger = page.getByRole("button", { name: /^Automations/ });
        await expect(trigger).toHaveText(/Automations\s*Paused/);
        await trigger.click();
        const dialog = page.getByRole("dialog", {
            name: "Automations",
            exact: true,
        });
        await dialog.getByRole("tab", { name: /^Auto-Message/ }).click();
        await expect(dialog.getByText("Paused", { exact: true })).toBeVisible();
        await expect(
            dialog.getByText(
                "Resume this monitor to start automatic actions.",
                { exact: true },
            ),
        ).toBeVisible();
        await db.monitors.update({
            where: { id: monitorId },
            data: { status: "active" },
        });
        await db.account_automation_attempts.create({
            data: {
                user_id: userId,
                account_id: BigInt(700001),
                domain: "www.vinted.de",
                item_id: BigInt(800001),
                monitor_id: monitorId,
                kind: "message",
                status: "uncertain",
                reason: "upstream_outcome_unverified",
            },
        });
        await page.reload();
        await expect(trigger).toHaveText(/Automations\s*Paused/);
        await trigger.click();
        await dialog.getByRole("tab", { name: /^Auto-Message/ }).click();
        await expect(
            dialog.getByText(
                "Paused after an unverified action. Check Vinted before sending manually.",
                { exact: true },
            ),
        ).toBeVisible();
    });
    test("unlinking disarms both modules and keeps history in the Activity tab", async ({
        page,
    }) => {
        await db.vinted_sessions.delete({ where: { userId } });
        await page.goto(`/monitors/${monitorId}`);
        const trigger = page.getByRole("button", { name: /^Automations/ });
        await expect(trigger).toHaveText(/Automations\s*Off/);
        await trigger.click();
        const dialog = page.getByRole("dialog", {
            name: "Automations",
            exact: true,
        });
        await expect(
            dialog.getByRole("switch", { name: "Enable Auto-Offer" }),
        ).toBeDisabled();
        await dialog.getByRole("tab", { name: /^Auto-Message/ }).click();
        await expect(
            dialog.getByRole("switch", { name: "Enable Auto-Message" }),
        ).not.toBeChecked();
        await dialog
            .getByRole("tab", { name: "Activity", exact: true })
            .click();
        await expect(
            dialog.getByText(
                "Outcome unverified. Check Vinted; this action will not be repeated.",
                { exact: true },
            ),
        ).toBeVisible();
    });
});
