import { expect, test } from "@playwright/test";

test("authenticated home keeps redirecting to the dashboard", async ({
    request,
}) => {
    const response = await request.get("/", { maxRedirects: 0 });

    expect([307, 308]).toContain(response.status());
    expect(response.headers().location).toBe("/dashboard");
});
