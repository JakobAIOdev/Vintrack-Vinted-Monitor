import { expect, test, type Page } from "@playwright/test";

function getAdminMain(page: Page) {
    return page.getByRole("main");
}

test.describe("admin running monitors", () => {
    test("reviews feature roles, dependencies, and job impact before apply", async ({
        page,
    }) => {
        await page.goto("/admin/features");
        const main = getAdminMain(page);
        await expect(
            main.getByRole("heading", { name: "Feature access", exact: true }),
        ).toBeVisible();
        await expect(
            main.getByText(
                "Master switch. Off means nobody can see or use the feature.",
            ),
        ).toBeVisible();
        await expect(
            main.getByText(
                "Hides Price Watch, blocks page and API access, stops new worker claims, and pauses affected active watches.",
            ),
        ).toBeVisible();
        await expect(main.getByText("Draft access:").first()).toBeVisible();
        await expect(
            main.getByLabel("Price Watch globally enabled"),
        ).toBeVisible();
        await expect(
            main.getByText("Requires Vinted Account").first(),
        ).toBeVisible();

        await main.getByLabel("Vinted Account globally enabled").uncheck();
        await main.getByRole("button", { name: "Review changes" }).click();
        const dialog = page.getByRole("dialog", {
            name: "Apply feature policy changes?",
        });
        await expect(dialog).toContainText("Dependencies affected");
        await expect(dialog).toContainText("Your Listings");
        await dialog.getByRole("button", { name: "Cancel" }).click();
        await main.getByRole("button", { name: "Discard" }).click();
    });

    test("shows low-cost monitor health without runtime history", async ({
        page,
    }) => {
        await page.goto("/admin/overview");

        await expect(
            getAdminMain(page).getByText("Live system overview"),
        ).toBeVisible();
        await expect(
            getAdminMain(page).getByText(/Refreshes every 10 seconds/),
        ).toBeVisible();
        await expect(
            getAdminMain(page).getByRole("button", { name: "Refresh now" }),
        ).toBeEnabled();
        await expect(
            getAdminMain(page).getByText("Monitor Health"),
        ).toBeVisible();
        await expect(
            getAdminMain(page).getByText("Canonical checks 24h").first(),
        ).toBeVisible();
        await expect(
            getAdminMain(page).getByText("Runtime Snapshot"),
        ).toHaveCount(0);
        await expect(
            getAdminMain(page).getByText("Member Growth & Conversion"),
        ).toBeVisible();
        await expect(
            getAdminMain(page).getByText("Demo conversion", { exact: true }),
        ).toBeVisible();
        await expect(
            getAdminMain(page).getByText("E2E Limit User", { exact: true }),
        ).toBeVisible();
    });

    test("shows global and role Free Proxy Pool monitor limits", async ({
        page,
        isMobile,
    }) => {
        await page.goto("/admin/roles-limits");

        if (isMobile) {
            await expect(
                getAdminMain(page).getByRole("combobox", {
                    name: "Admin section",
                }),
            ).toHaveValue("members");
        } else {
            await expect(page).toHaveURL(/\/admin\/members\?view=roles$/);
            await expect(
                getAdminMain(page).getByRole("button", {
                    name: "Roles",
                    exact: true,
                }),
            ).toBeVisible();
        }
        await expect(
            page
                .getByRole("main")
                .getByText("Running Free Proxy Monitor Limits"),
        ).toBeVisible();
        await expect(
            getAdminMain(page).getByText("Active Price Watch Limits"),
        ).toBeVisible();
        await expect(
            getAdminMain(page).locator("#roles-global-price-watch-limit"),
        ).toHaveValue("3");
        await expect(
            getAdminMain(page).getByLabel("Global default").last(),
        ).toHaveValue("");
        await expect(
            getAdminMain(page).getByLabel("Global default").last(),
        ).toHaveAttribute("placeholder", "Unlimited");
        await expect(
            getAdminMain(page).getByLabel("Free").last(),
        ).toHaveAttribute("placeholder", "Global");
        await expect(
            getAdminMain(page).getByLabel("Premium").last(),
        ).toHaveAttribute("placeholder", "Global");
    });

    test("pauses the newest excess free proxy monitors for a user override", async ({
        page,
        isMobile,
    }) => {
        test.skip(
            isMobile,
            "The shared database mutation runs once on desktop",
        );
        await page.goto("/admin/members");
        const search = getAdminMain(page).getByPlaceholder(
            "Search by name, email or role...",
        );
        await search.fill("E2E Limit User");
        await getAdminMain(page)
            .getByRole("row", { name: /E2E Limit User/ })
            .click();

        const dialog = page.getByRole("dialog", { name: "User Details" });
        await expect(dialog).toBeVisible();
        const input = dialog.locator("#user-free-proxy-monitor-limit");
        await expect(input).toBeVisible();
        await input.fill("1");
        await input
            .locator("xpath=..")
            .getByRole("button", { name: "Save" })
            .click();

        await expect(dialog.getByText("Running Free Pool: 1")).toBeVisible();
        await expect(dialog.getByText("New Items 24h")).toBeVisible();
        await expect(dialog.getByText("Monitor Runtime")).toHaveCount(0);
        const runningSection = dialog
            .getByText("Running Monitors", { exact: true })
            .locator("xpath=../../..");
        await expect(runningSection).toContainText("E2E Free Limit 1");
        await expect(runningSection).not.toContainText("E2E Free Limit 3");
    });

    test("groups active monitors by member and filters the list", async ({
        page,
        isMobile,
    }) => {
        await page.goto("/admin/operations");

        await expect(
            getAdminMain(page).getByRole("heading", { name: "Admin Panel" }),
        ).toBeVisible();
        if (isMobile) {
            await expect(
                getAdminMain(page).getByRole("combobox", {
                    name: "Admin section",
                }),
            ).toHaveValue("operations");
        } else {
            await expect(
                getAdminMain(page).getByRole("button", {
                    name: "Running Monitors",
                    exact: true,
                }),
            ).toBeVisible();
        }

        const memberSection = getAdminMain(page)
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

        const search = getAdminMain(page).getByRole("textbox", {
            name: "Search running monitors",
        });
        await search.fill("E2E Mock Feed");
        await expect(memberToggle).toHaveAttribute("aria-expanded", "true");
        await expect(
            memberSection.getByTestId("active-monitor-row"),
        ).toHaveCount(1);

        await search.fill("monitor that does not exist");
        await expect(
            getAdminMain(page).getByText(
                "No running monitors match your search",
            ),
        ).toBeVisible();
    });

    test("updates Price Watch runtime floors and capacity without redeploy", async ({
        page,
        isMobile,
    }) => {
        test.skip(isMobile, "The shared setting mutation runs once on desktop");
        await page.goto("/admin/operations?view=price_watch");

        await expect(
            getAdminMain(page).getByText("Runtime & capacity"),
        ).toBeVisible();
        await getAdminMain(page)
            .getByLabel("Shared minimum")
            .selectOption("300");
        await getAdminMain(page).getByLabel("Shared max RPM").fill("24");
        await expect(
            getAdminMain(page).getByLabel("Shared minimum"),
        ).toHaveValue("300");
        await expect(
            getAdminMain(page).getByLabel("Shared max RPM"),
        ).toHaveValue("24");
        await getAdminMain(page)
            .getByRole("button", { name: "Save worker settings" })
            .click();
        await expect(
            page.getByText("Price Watch worker configuration saved"),
        ).toBeVisible();
        await expect(
            getAdminMain(page).getByLabel("Shared minimum"),
        ).toHaveValue("300");
        await expect(
            getAdminMain(page).getByLabel("Shared max RPM"),
        ).toHaveValue("24");

        await getAdminMain(page)
            .getByLabel("Shared minimum")
            .selectOption("120");
        await getAdminMain(page).getByLabel("Shared max RPM").fill("30");
        await getAdminMain(page)
            .getByRole("button", { name: "Save worker settings" })
            .click();
        await expect(
            getAdminMain(page).getByLabel("Shared max RPM"),
        ).toHaveValue("30");
    });

    test("shows member growth and demo insights", async ({
        page,
        isMobile,
    }) => {
        await page.goto("/admin/members?view=insights");

        if (isMobile) {
            await expect(
                getAdminMain(page).getByRole("combobox", {
                    name: "Admin section",
                }),
            ).toHaveValue("members");
        } else {
            await expect(
                getAdminMain(page).getByRole("button", {
                    name: "Growth & Conversion",
                    exact: true,
                }),
            ).toBeVisible();
        }
        await expect(
            getAdminMain(page).getByText("Member growth", { exact: true }),
        ).toBeVisible();
        await expect(
            getAdminMain(page).getByText("Runtime by proxy source"),
        ).toHaveCount(0);
        await expect(
            getAdminMain(page).getByRole("img", {
                name: "Member signups over the last 90 days",
            }),
        ).toBeVisible();
        await expect(
            getAdminMain(page).getByText("Activation funnel"),
        ).toBeVisible();
        await expect(getAdminMain(page).getByText("Account mix")).toBeVisible();
        await expect(
            getAdminMain(page).getByText("Newest members"),
        ).toBeVisible();
        await expect(
            getAdminMain(page).getByText("E2E Limit User").last(),
        ).toBeVisible();
    });

    test("separates delivery health from important operations", async ({
        page,
        isMobile,
    }) => {
        await page.goto("/admin/overview");
        const operationsNavigation = page.waitForURL("**/admin/operations");
        if (isMobile) {
            await getAdminMain(page)
                .getByRole("combobox", { name: "Admin section" })
                .selectOption("operations");
        } else {
            await getAdminMain(page)
                .getByRole("tab", { name: "Operations", exact: true })
                .click();
        }
        await operationsNavigation;
        await getAdminMain(page)
            .getByRole("button", { name: "Logs", exact: true })
            .click();

        await expect(
            getAdminMain(page).getByText("Delivered (24h)"),
        ).toBeVisible();
        await expect(
            getAdminMain(page).getByText("Pending / retrying"),
        ).toBeVisible();
        await expect(
            getAdminMain(page).getByText("Deduplicated (24h)"),
        ).toBeVisible();
        await expect(
            getAdminMain(page).getByText("Terminal failures only"),
        ).toBeVisible();
        await expect(
            getAdminMain(page).getByText("Expected duplicate suppression"),
        ).toBeVisible();
        await expect(
            getAdminMain(page).getByText("Live operations log"),
        ).toBeVisible();
        await expect(
            getAdminMain(page).getByRole("textbox", {
                name: "Search operation logs",
            }),
        ).toBeVisible();
        await expect(
            getAdminMain(page).getByText(
                "Failures, incidents, monitor changes, and admin actions",
            ),
        ).toBeVisible();
        await getAdminMain(page)
            .getByRole("button", { name: "Delivery", exact: true })
            .click();
        await expect(
            getAdminMain(page).getByText(
                "Failed, retried, or cancelled alert deliveries",
            ),
        ).toBeVisible();
        await expect(getAdminMain(page).getByText(/alert issues/i)).toHaveCount(
            0,
        );
    });
});
