import { expect, test } from "@playwright/test";

const marketingPages = [
    {
        route: "/",
        title: "Vintrack – Open-Source Vinted Monitor & Fast Alerts",
        h1: "The open-source Vinted monitor for faster finds.",
        structuredType: "WebSite",
        internalHref: "/vinted-alerts",
    },
    {
        route: "/vinted-alerts",
        title: "Vinted Alerts for New Listings | Vintrack",
        h1: "Get Vinted alerts when matching listings appear.",
        structuredType: "BreadcrumbList",
        internalHref: "/vinted-price-tracker",
    },
    {
        route: "/vinted-price-tracker",
        title: "Vinted Price Tracker & Price Drop Alerts | Vintrack",
        h1: "Track Vinted price drops without checking manually.",
        structuredType: "BreadcrumbList",
        internalHref: "/vinted-alerts",
    },
    {
        route: "/self-hosted-vinted-monitor",
        title: "Self-Hosted Open-Source Vinted Monitor | Vintrack",
        h1: "Run your own open-source Vinted monitor.",
        structuredType: "BreadcrumbList",
        internalHref: "/vinted-alerts",
    },
] as const;

test.describe("public pages", () => {
    for (const marketingPage of marketingPages) {
        test(`${marketingPage.route} exposes unique crawlable metadata`, async ({
            page,
        }) => {
            await page.goto(marketingPage.route);

            await expect(page).toHaveTitle(marketingPage.title);
            await expect(page.locator("h1")).toHaveCount(1);
            await expect(page.locator("h1")).toHaveText(marketingPage.h1);

            const expectedCanonical =
                marketingPage.route === "/"
                    ? new URL(page.url()).origin
                    : new URL(marketingPage.route, page.url()).toString();
            await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
                "href",
                expectedCanonical,
            );
            await expect(
                page.locator('meta[name="description"]'),
            ).toHaveAttribute("content", /.{40,}/);
            await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
                "content",
                /index, follow/,
            );
            await expect(
                page.locator('meta[property="og:title"]'),
            ).toHaveAttribute("content", marketingPage.title);
            await expect(
                page.locator('meta[property="og:url"]'),
            ).toHaveAttribute("content", expectedCanonical);
            await expect(
                page.locator('meta[name="twitter:card"]'),
            ).toHaveAttribute("content", "summary_large_image");

            const structuredData = await page
                .locator('script[type="application/ld+json"]')
                .allTextContents();
            const parsed = structuredData.map((value) => JSON.parse(value));
            expect(
                parsed.some(
                    (value) => value["@type"] === marketingPage.structuredType,
                ),
            ).toBe(true);

            await expect(
                page
                    .locator(`footer a[href="${marketingPage.internalHref}"]`)
                    .first(),
            ).toBeVisible();
        });
    }

    test("publishes robots and a four-page sitemap when indexing is enabled", async ({
        request,
    }) => {
        const robotsResponse = await request.get("/robots.txt");
        expect(robotsResponse.status()).toBe(200);
        const robots = await robotsResponse.text();
        expect(robots).toContain("Allow: /");
        expect(robots).toContain("Disallow: /api/");
        expect(robots).toContain("Sitemap:");

        const sitemapResponse = await request.get("/sitemap.xml");
        expect(sitemapResponse.status()).toBe(200);
        const sitemap = await sitemapResponse.text();
        for (const { route } of marketingPages) {
            expect(sitemap).toContain(
                route === "/" ? "/</loc>" : `${route}</loc>`,
            );
        }
        expect(sitemap.match(/<url>/g)).toHaveLength(4);
    });

    test("login stays public but explicitly noindex", async ({ page }) => {
        await page.goto("/login");

        await expect(page).toHaveTitle(/Login/i);
        await expect(
            page.getByRole("heading", { name: /Secure access/i }),
        ).toBeVisible();
        await expect(
            page.getByRole("button", { name: /Continue with/i }),
        ).toBeVisible();
        await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
            "content",
            /noindex, nofollow/,
        );
    });
});
