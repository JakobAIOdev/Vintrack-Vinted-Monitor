import { expect, test } from "@playwright/test";

test.describe("auth boundaries", () => {
    test("protected dashboard routes redirect unauthenticated users", async ({
        page,
    }) => {
        await page.goto("/feed");

        await expect(page).toHaveURL(/\/login$/);
        await expect(
            page.getByRole("heading", { name: /Secure access/i }),
        ).toBeVisible();
    });

    test("protected feed API rejects unauthenticated users", async ({
        request,
    }) => {
        const response = await request.get("/api/feed");

        expect(response.status()).toBe(401);
        await expect(response.json()).resolves.toMatchObject({
            error: "Unauthorized",
        });
    });

    test("personal brand APIs reject unauthenticated users", async ({
        request,
    }) => {
        const responses = await Promise.all([
            request.get("/api/catalog/member-brands"),
            request.post("/api/catalog/member-brands", {
                data: {
                    brand_url: "https://www.vinted.cz/brand/23065-lip",
                    region: "cz",
                },
            }),
            request.delete("/api/catalog/member-brands/23065"),
        ]);

        for (const response of responses) {
            expect(response.status()).toBe(401);
            await expect(response.json()).resolves.toMatchObject({
                error: "Unauthorized",
            });
        }
    });
});
