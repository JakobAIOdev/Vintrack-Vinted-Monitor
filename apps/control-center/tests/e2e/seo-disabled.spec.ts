import { expect, test } from "@playwright/test";

test("self-hosted defaults fail closed for search indexing", async ({
    page,
    request,
}) => {
    await page.goto("/vinted-alerts");
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
        "content",
        /noindex, nofollow/,
    );

    const robotsResponse = await request.get("/robots.txt");
    expect(robotsResponse.status()).toBe(200);
    const robots = await robotsResponse.text();
    expect(robots).toContain("Disallow: /");
    expect(robots).not.toContain("Sitemap:");

    const sitemapResponse = await request.get("/sitemap.xml");
    expect(sitemapResponse.status()).toBe(200);
    expect(await sitemapResponse.text()).not.toContain("<url>");
});
