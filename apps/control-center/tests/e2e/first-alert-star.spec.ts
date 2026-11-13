import { expect, test } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { parseGithubRewardsPolicy } from "../../src/lib/github-rewards";

const db = new PrismaClient();
const userId = process.env.E2E_TEST_USER_ID ?? "e2e-user";
const endpoint = "**/api/github-rewards/first-alert";

test.beforeAll(async () => {
    const setting = await db.app_settings.findUnique({
        where: { key: "github_rewards_policy" },
    });
    const policy = parseGithubRewardsPolicy(setting?.value);
    await db.member_reward_prompts.upsert({
        where: {
            userId_policy_version_prompt_type: {
                userId,
                policy_version: policy.version,
                prompt_type: "announcement",
            },
        },
        create: {
            userId,
            policy_version: policy.version,
            prompt_type: "announcement",
            shown_at: new Date(),
        },
        update: { shown_at: new Date() },
    });
});

test.afterAll(async () => {
    await db.$disconnect();
});

test("celebrates one delivery without interrupting monitoring and stays dismissed", async ({
    page,
}, testInfo) => {
    let consumed = false;
    const actions: string[] = [];
    await page.route(endpoint, async (route) => {
        const action = route.request().postDataJSON().action as string;
        actions.push(action);
        if (action !== "claim") return route.fulfill({ json: { ok: true } });
        const show = !consumed;
        consumed = true;
        return route.fulfill({
            json: {
                prompt: show
                    ? {
                          repositoryUrl:
                              "https://github.com/JakobAIOdev/Vintrack-Vinted-Monitor",
                          currentLimit: 2,
                          starLimit: 5,
                      }
                    : null,
                retry: false,
            },
        });
    });
    await page.goto("/dashboard");
    const card = page.getByTestId("first-alert-star-card");
    await expect(card).toBeVisible();
    await expect(card).toContainText("from 2 to 5");
    await expect(
        card.getByRole("link", { name: "Star Vintrack" }),
    ).toHaveAttribute("target", "_blank");
    await expect(
        page.getByRole("heading", { name: "Your monitors", exact: true }),
    ).toBeVisible();
    await expect(
        page.getByRole("dialog", { name: /first alert/i }),
    ).toHaveCount(0);
    expect(
        await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
    ).toBe(true);
    await card.screenshot({
        path: testInfo.outputPath("first-alert-star-card.png"),
    });
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await page.addStyleTag({
        content: "*, *::before, *::after { transition: none !important; }",
    });
    await expect(
        card.getByRole("link", { name: "Star Vintrack" }).locator("span"),
    ).toBeVisible();
    await card.screenshot({
        path: testInfo.outputPath("first-alert-star-card-dark.png"),
    });
    await card
        .getByRole("button", { name: "Dismiss first alert celebration" })
        .click();
    await expect(card).toHaveCount(0);
    await expect.poll(() => actions.includes("dismissed")).toBe(true);
    await page.reload();
    await expect
        .poll(() => actions.filter((action) => action === "claim").length)
        .toBeGreaterThanOrEqual(2);
    await expect(card).toHaveCount(0);
});

test("a suppressed or unknown star status never flashes a card", async ({
    page,
}) => {
    await page.route(endpoint, (route) =>
        route.fulfill({ json: { prompt: null, retry: false } }),
    );
    await page.goto("/dashboard");
    await expect(
        page.getByRole("heading", { name: "Your monitors", exact: true }),
    ).toBeVisible();
    await expect(page.getByTestId("first-alert-star-card")).toHaveCount(0);
});

test("the star link opens GitHub and removes the one-time card", async ({
    page,
    context,
}) => {
    const actions: string[] = [];
    const repositoryUrl =
        "https://github.com/JakobAIOdev/Vintrack-Vinted-Monitor";
    await context.route(repositoryUrl, (route) =>
        route.fulfill({ body: "Synthetic GitHub destination" }),
    );
    await page.route(endpoint, (route) => {
        const action = route.request().postDataJSON().action as string;
        actions.push(action);
        return route.fulfill({
            json:
                action === "claim"
                    ? {
                          prompt: {
                              repositoryUrl,
                              currentLimit: 2,
                              starLimit: 5,
                          },
                          retry: false,
                      }
                    : { ok: true },
        });
    });
    await page.goto("/dashboard");
    const card = page.getByTestId("first-alert-star-card");
    const popupPromise = page.waitForEvent("popup");
    await card.getByRole("link", { name: "Star Vintrack" }).click();
    const popup = await popupPromise;
    await expect(popup).toHaveURL(repositoryUrl);
    await expect(card).toHaveCount(0);
    await expect.poll(() => actions.includes("cta")).toBe(true);
    await popup.close();
});

test("the encouragement remains readable when the dashboard starts in dark mode", async ({
    page,
}, testInfo) => {
    await page.addInitScript(() => localStorage.setItem("theme", "dark"));
    await page.route(endpoint, (route) =>
        route.fulfill({
            json: {
                prompt: {
                    repositoryUrl:
                        "https://github.com/JakobAIOdev/Vintrack-Vinted-Monitor",
                    currentLimit: 2,
                    starLimit: 5,
                },
                retry: false,
            },
        }),
    );
    await page.goto("/dashboard");
    await expect(page.locator("html")).toHaveClass(/dark/);
    const card = page.getByTestId("first-alert-star-card");
    await expect(
        card.getByRole("heading", { name: "Your first find is in." }),
    ).toBeVisible();
    await expect(
        card.getByRole("link", { name: "Star Vintrack" }),
    ).toBeVisible();
    await card.screenshot({
        path: testInfo.outputPath("first-alert-star-dark-load.png"),
    });
});
