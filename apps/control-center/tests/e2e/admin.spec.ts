import { expect, test } from "@playwright/test";

test.describe("admin running monitors", () => {
    test("groups active monitors by member and filters the list", async ({
        page,
    }) => {
        await page.goto("/admin?tab=monitors");

        await expect(
            page.getByRole("heading", { name: "Admin Panel" }),
        ).toBeVisible();
        await expect(
            page.getByRole("tab", { name: "Running Monitors" }),
        ).toHaveAttribute("aria-selected", "true");

        const memberSection = page
            .getByTestId("active-monitor-member")
            .filter({ hasText: "E2E User" });
        const memberToggle = memberSection.getByTestId(
            "active-monitor-member-toggle",
        );

        await expect(memberToggle).toHaveAttribute("aria-expanded", "false");
        await memberToggle.click();
        await expect(memberToggle).toHaveAttribute("aria-expanded", "true");
        await expect(memberSection).toContainText("E2E Mock Feed");
        await expect(memberSection).toContainText("Query: mock");
        await expect(memberSection).toContainText("Germany");

        await memberToggle.click();
        await expect(memberToggle).toHaveAttribute("aria-expanded", "false");

        const search = page.getByRole("textbox", {
            name: "Search running monitors",
        });
        await search.fill("E2E Mock Feed");
        await expect(memberToggle).toHaveAttribute("aria-expanded", "true");
        await expect(
            memberSection.getByTestId("active-monitor-row"),
        ).toHaveCount(1);

        await search.fill("monitor that does not exist");
        await expect(
            page.getByText("No running monitors match your search"),
        ).toBeVisible();
    });

    test("shows member growth and demo insights", async ({ page }) => {
        await page.goto("/admin?tab=insights");

        await expect(
            page.getByRole("tab", { name: "Member Insights" }),
        ).toHaveAttribute("aria-selected", "true");
        await expect(page.getByText("Member Growth")).toBeVisible();
        await expect(
            page.getByRole("img", {
                name: "Member growth over the last 90 days",
            }),
        ).toBeVisible();
        await expect(page.getByText("Demo Monitor Journey")).toBeVisible();
        await expect(page.getByText("Role Distribution")).toBeVisible();
        await expect(page.getByText("Newest Members")).toBeVisible();
        await expect(
            page.getByRole("main").getByText("E2E User"),
        ).toBeVisible();
    });
});
