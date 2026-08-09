import { expect, test } from "@playwright/test";

test.describe("admin running monitors", () => {
    test("shows global and role Free Proxy Pool monitor limits", async ({
        page,
    }) => {
        await page.goto("/admin?tab=roles");

        await expect(page.getByRole("tab", { name: "Roles" })).toHaveAttribute(
            "aria-selected",
            "true",
        );
        await expect(
            page.getByText("Running Free Proxy Monitor Limits"),
        ).toBeVisible();
        await expect(page.getByLabel("Global default").last()).toHaveValue("5");
        await expect(page.getByLabel("Free").last()).toHaveAttribute(
            "placeholder",
            "Global",
        );
        await expect(page.getByLabel("Premium").last()).toHaveAttribute(
            "placeholder",
            "Global",
        );
    });

    test("pauses the newest excess free proxy monitors for a user override", async ({
        page,
        isMobile,
    }) => {
        test.skip(
            isMobile,
            "The shared database mutation runs once on desktop",
        );
        await page.goto("/admin?tab=users");
        const search = page.getByPlaceholder(
            "Search by name, email or role...",
        );
        await search.fill("E2E Limit User");
        await page.getByRole("row", { name: /E2E Limit User/ }).click();

        const input = page.locator("#user-free-proxy-monitor-limit");
        await expect(input).toBeVisible();
        await input.fill("1");
        await input
            .locator("xpath=..")
            .getByRole("button", { name: "Save" })
            .click();

        await expect(page.getByText("Running Free Pool: 1")).toBeVisible();
        const runningSection = page
            .getByRole("dialog", { name: "User Details" })
            .getByText("Running Monitors", { exact: true })
            .locator("xpath=../../..");
        await expect(runningSection).toContainText("E2E Free Limit 1");
        await expect(runningSection).not.toContainText("E2E Free Limit 3");
    });

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
        await expect(page.getByText("Member growth")).toBeVisible();
        await expect(
            page.getByRole("img", {
                name: "Member signups over the last 90 days",
            }),
        ).toBeVisible();
        await expect(page.getByText("Activation funnel")).toBeVisible();
        await expect(page.getByText("Account mix")).toBeVisible();
        await expect(page.getByText("Newest members")).toBeVisible();
        await expect(
            page.getByRole("main").getByText("E2E User"),
        ).toBeVisible();
    });
});
