import { expect, test } from "@playwright/test";

test.describe("admin running monitors", () => {
    test("shows the cached runtime snapshot without opening insights", async ({
        page,
    }) => {
        await page.goto("/admin?tab=overview");

        await expect(page.getByText("Runtime Snapshot")).toBeVisible();
        await expect(page.getByText("Total runtime")).toBeVisible();
        await expect(page.getByText("Active source mix")).toBeVisible();
    });

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
        await expect(page.getByText("Active Price Watch Limits")).toBeVisible();
        await expect(page.locator("#roles-global-price-watch-limit")).toHaveValue("3");
        await expect(page.getByLabel("Global default").last()).toHaveValue("");
        await expect(page.getByLabel("Global default").last()).toHaveAttribute(
            "placeholder",
            "Unlimited",
        );
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
        await expect(page.getByText("Monitor Runtime")).toBeVisible();
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

    test("updates Price Watch runtime floors and capacity without redeploy", async ({
        page,
        isMobile,
    }) => {
        test.skip(isMobile, "The shared setting mutation runs once on desktop");
        await page.goto("/admin?tab=price_watch");

        await expect(page.getByText("Runtime & capacity")).toBeVisible();
        await page.getByLabel("Shared minimum").selectOption("300");
        await page.getByLabel("Shared max RPM").fill("24");
        await page.getByRole("button", { name: "Save worker settings" }).click();
        await expect(page.getByLabel("Shared minimum")).toHaveValue("300");
        await expect(page.getByLabel("Shared max RPM")).toHaveValue("24");

        await page.getByLabel("Shared minimum").selectOption("120");
        await page.getByLabel("Shared max RPM").fill("30");
        await page.getByRole("button", { name: "Save worker settings" }).click();
        await expect(page.getByLabel("Shared max RPM")).toHaveValue("30");
    });

    test("shows member growth and demo insights", async ({ page }) => {
        await page.goto("/admin?tab=insights");

        await expect(
            page.getByRole("tab", { name: "Member Insights" }),
        ).toHaveAttribute("aria-selected", "true");
        await expect(
            page.getByText("Member growth", { exact: true }),
        ).toBeVisible();
        await expect(page.getByText("Runtime by proxy source")).toBeVisible();
        await expect(
            page.getByRole("img", {
                name: "Monitor runtime by proxy source over the last 30 days",
            }),
        ).toBeVisible();
        await expect(
            page.getByRole("img", {
                name: "Member signups over the last 90 days",
            }),
        ).toBeVisible();
        await expect(page.getByText("Activation funnel")).toBeVisible();
        await expect(page.getByText("Account mix")).toBeVisible();
        await expect(page.getByText("Newest members")).toBeVisible();
        await expect(
            page.getByRole("main").getByText("E2E User").last(),
        ).toBeVisible();
    });

    test("separates delivery health from important operations", async ({
        page,
    }) => {
        await page.goto("/admin?tab=overview");
        await page.getByRole("tab", { name: "Logs" }).click();

        await expect(page.getByText("Delivered (24h)")).toBeVisible();
        await expect(page.getByText("Pending / retrying")).toBeVisible();
        await expect(page.getByText("Deduplicated (24h)")).toBeVisible();
        await expect(page.getByText("Terminal failures only")).toBeVisible();
        await expect(
            page.getByText("Expected duplicate suppression"),
        ).toBeVisible();
        await expect(
            page.getByText("successful-delivery noise", { exact: false }),
        ).toBeVisible();
        await expect(page.getByText(/alert issues/i)).toHaveCount(0);
    });
});
