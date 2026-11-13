import { expect, test, type Page } from "@playwright/test";
import { GUIDE_TOPICS, guideHref } from "../../src/lib/guides";

async function selectTopic(
    page: Page,
    href: string,
    label: string,
    isMobile: boolean,
) {
    if (isMobile)
        await page
            .getByLabel("Guide topic", { exact: true })
            .selectOption(href);
    else
        await page
            .getByRole("navigation", { name: "Guide topics", exact: true })
            .getByRole("link", { name: label, exact: true })
            .click();
}

test("public guide topics expose readable content, canonical metadata, and working section links", async ({
    page,
    request,
}) => {
    for (const topic of GUIDE_TOPICS) {
        const path = guideHref("public", topic.slug);
        await page.goto(path);
        await expect(page.locator("h1")).toHaveText(topic.title);
        await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
            "href",
            new URL(path, page.url()).toString(),
        );
        await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
            "content",
            /index, follow/,
        );
        for (const article of topic.articles) {
            await expect(page.locator(`article#${article.id}`)).toContainText(
                article.result,
            );
        }
        const json = await page
            .locator('script[type="application/ld+json"]')
            .first()
            .textContent();
        expect(JSON.parse(json!)["@type"]).toBe("BreadcrumbList");
    }
    expect((await request.get("/guides/not-a-topic")).status()).toBe(404);
    const sitemap = await (await request.get("/sitemap.xml")).text();
    for (const topic of GUIDE_TOPICS)
        expect(sitemap).toContain(`${guideHref("public", topic.slug)}</loc>`);
    await page.goto("/guides/notifications#discord");
    await expect(
        page.getByRole("heading", {
            name: "Set up Discord notifications",
            exact: true,
        }),
    ).toBeInViewport();
    for (const image of await page.locator("article img:visible").all()) {
        await expect
            .poll(() =>
                image.evaluate(
                    (node) => (node as HTMLImageElement).naturalWidth,
                ),
            )
            .toBeGreaterThan(0);
    }
});

test("topic navigation supports mobile selection, browser back, and direct URLs", async ({
    page,
    isMobile,
}) => {
    await page.goto("/guides/quick-start");
    await selectTopic(page, "/guides/notifications", "Notifications", isMobile);
    await expect(page).toHaveURL(/\/guides\/notifications$/);
    await expect(
        page.getByRole("heading", {
            name: "Set up Discord notifications",
            exact: true,
        }),
    ).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(/\/guides\/quick-start$/);
    if (!isMobile)
        await expect(
            page
                .getByRole("navigation", { name: "Guide topics" })
                .getByRole("link", { name: "Quick start", exact: true }),
        ).toHaveAttribute("aria-current", "page");
    await page.setViewportSize({ width: 320, height: 844 });
    await page.addStyleTag({
        content:
            "html { font-size: 20px; } *, *::before, *::after { transition: none !important; }",
    });
    expect(
        await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
    ).toBe(true);
});

test("the signed-in guide reuses the public instructions and keeps internal pages noindex", async ({
    page,
    isMobile,
}) => {
    test.skip(
        process.env.E2E_TEST_MODE !== "true",
        "Requires the isolated signed-in fixtures.",
    );
    await page.goto("/guide");
    await expect(
        page.getByRole("heading", { name: "Guides", exact: true }),
    ).toBeVisible();
    await selectTopic(page, "/guide/notifications", "Notifications", isMobile);
    await expect(page).toHaveURL(/\/guide\/notifications$/);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
        "content",
        /noindex, nofollow/,
    );
    await expect(page.locator("#discord")).toContainText(
        GUIDE_TOPICS[2].articles[0].result,
    );
    await page.goto("/guide/monitors#price-watches");
    await expect(
        page.getByRole("heading", {
            name: "Track a price drop on one item",
            exact: true,
        }),
    ).toBeInViewport();
    await expect(
        page
            .locator('a[href="/price-watches"]')
            .filter({ hasText: "Open Price Watch" }),
    ).toBeVisible();
    await page.goto("/monitors/new");
    await page.locator("#monitor-notifications > summary").click();
    await page
        .getByRole("link", {
            name: "Discord and Telegram setup guide",
            exact: true,
        })
        .click();
    await expect(page).toHaveURL(/\/guide\/notifications#discord$/);
    await expect(
        page.getByRole("heading", {
            name: "Set up Discord notifications",
            exact: true,
        }),
    ).toBeInViewport();
});

test("guide screenshots follow the selected theme, persist it, and respect system changes", async ({
    page,
}, testInfo) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.addInitScript(() => {
        if (!localStorage.getItem("theme"))
            localStorage.setItem("theme", "light");
    });
    const topic = GUIDE_TOPICS.find((item) => item.slug === "notifications")!;
    const image = topic.articles[0].image!;
    const paths = ["/guides/notifications#discord"];
    if (process.env.E2E_TEST_MODE === "true")
        paths.push("/guide/notifications#discord");
    for (const path of paths) {
        await page.goto(path);
        const figure = page.locator("#discord figure");
        const light = figure.locator('[data-screenshot-theme="light"]');
        const dark = figure.locator('[data-screenshot-theme="dark"]');
        await expect(light).toBeVisible();
        await expect(dark).toBeHidden();
        await expect(light).toHaveAttribute("href", image.src);
        const openNavigation = page.getByRole("button", {
            name: "Open navigation",
            exact: true,
        });
        const usesNavigationDrawer = await openNavigation.isVisible();
        if (usesNavigationDrawer) await openNavigation.click();
        await page
            .getByRole("button", { name: "Toggle color theme", exact: true })
            .first()
            .click();
        if (usesNavigationDrawer)
            await page
                .getByRole("button", { name: "Close navigation", exact: true })
                .click();
        await expect(dark).toBeVisible();
        await expect(light).toBeHidden();
        await expect(dark).toHaveAttribute("href", image.darkSrc);
        await expect
            .poll(() =>
                dark
                    .locator("img")
                    .evaluate(
                        (node) => (node as HTMLImageElement).naturalWidth,
                    ),
            )
            .toBeGreaterThan(0);
        await figure.screenshot({
            path: testInfo.outputPath(
                path.startsWith("/guides/")
                    ? "public-guide-dark.png"
                    : "app-guide-dark.png",
            ),
        });
        await page.reload();
        await expect(dark).toBeVisible();
        await expect(dark).toHaveAttribute("href", image.darkSrc);
        await page.evaluate(() => localStorage.setItem("theme", "system"));
        await page.reload();
        await expect(dark).toBeVisible();
        await page.emulateMedia({ colorScheme: "light" });
        await expect(light).toBeVisible();
        await expect(dark).toBeHidden();
        // Reset for the next placement while the OS remains dark.
        await page.evaluate(() => localStorage.setItem("theme", "light"));
        await page.emulateMedia({ colorScheme: "dark" });
    }
});
