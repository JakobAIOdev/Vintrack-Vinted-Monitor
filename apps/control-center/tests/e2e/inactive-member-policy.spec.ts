import { expect, test } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import {
    DEFAULT_INACTIVE_MEMBER_POLICY,
    inactivePolicyRuntimeStatus,
    normalizeInactiveDurationDays,
    parseInactiveMemberPolicy,
    parseInactiveMemberRuntime,
    validateInactiveMemberPolicyInput,
    type InactiveMemberPolicy,
} from "../../src/lib/inactive-member-policy";

const db = new PrismaClient();

test.afterAll(async () => db.$disconnect());

test.describe("inactive member monitor policy", () => {
    test.describe.configure({ mode: "serial" });
    test("parses defaults and validates duration, roles, and scope", () => {
        expect(parseInactiveMemberPolicy(null)).toEqual(
            DEFAULT_INACTIVE_MEMBER_POLICY,
        );
        expect(parseInactiveMemberPolicy("not-json")).toEqual(
            DEFAULT_INACTIVE_MEMBER_POLICY,
        );
        expect(normalizeInactiveDurationDays(2, "weeks")).toBe(14);
        expect(normalizeInactiveDurationDays(2, "months")).toBe(60);
        expect(() =>
            validateInactiveMemberPolicyInput({
                enabled: true,
                duration: 0,
                durationUnit: "days",
                monitorScope: "free_proxy",
                includePriceWatches: false,
                roles: ["free"],
            }),
        ).toThrow(/positive/);
        expect(() =>
            validateInactiveMemberPolicyInput({
                enabled: true,
                duration: 61,
                durationUnit: "months",
                monitorScope: "all",
                includePriceWatches: false,
                roles: ["premium"],
            }),
        ).toThrow(/5 years/);
        expect(() =>
            validateInactiveMemberPolicyInput({
                enabled: true,
                duration: 1,
                durationUnit: "weeks",
                monitorScope: "all",
                includePriceWatches: true,
                roles: [],
            }),
        ).toThrow(/role/);
    });

    test("requires a matching fresh worker revision", () => {
        const policy: InactiveMemberPolicy = {
            ...DEFAULT_INACTIVE_MEMBER_POLICY,
            enabled: true,
            revision: "policy-r2",
            enabledAt: "2026-08-12T10:00:00.000Z",
        };
        const runtime = parseInactiveMemberRuntime(
            JSON.stringify({
                heartbeatAt: "2026-08-12T10:01:00.000Z",
                policyRevision: "policy-r2",
                lastEvaluatedAt: "2026-08-12T10:01:00.000Z",
                pausedMemberCount: 2,
                pausedMonitorCount: 4,
            }),
        );
        expect(runtime).not.toBeNull();
        expect(
            inactivePolicyRuntimeStatus(
                policy,
                runtime,
                Date.parse("2026-08-12T10:02:00.000Z"),
            ),
        ).toBe("active");
        expect(
            inactivePolicyRuntimeStatus(
                policy,
                runtime && { ...runtime, policyRevision: "old" },
                Date.parse("2026-08-12T10:02:00.000Z"),
            ),
        ).toBe("confirmation_pending");
        expect(parseInactiveMemberRuntime("invalid")).toBeNull();
    });

    test("shows the admin policy editor", async ({ page }) => {
        await page.goto("/admin?tab=monitors");
        await expect(
            page.getByTestId("inactive-member-automation"),
        ).toBeVisible();
        await expect(
            page.getByText("Inactive Member Automation", { exact: true }),
        ).toBeVisible();
        await expect(
            page.getByRole("button", { name: "Preview impact" }),
        ).toBeVisible();
        await expect(
            page.getByRole("checkbox", { name: "Include Price Watches" }),
        ).toBeVisible();
    });

    test("saves and disables the policy with a new revision", async ({
        page,
        isMobile,
    }) => {
        test.skip(isMobile, "Shared policy mutation runs once on desktop");
        const previous = await db.app_settings.findUnique({
            where: { key: "inactive_member_monitor_policy" },
        });
        try {
            await page.goto("/admin?tab=monitors");
            const card = page.getByTestId("inactive-member-automation");
            const enabledCheckbox = card.getByRole("checkbox").first();
            await enabledCheckbox.check();
            await expect(enabledCheckbox).toBeChecked();
            await card.getByRole("button", { name: "Save automation" }).click();
            await expect(
                card.getByRole("button", { name: "Save automation" }),
            ).toBeEnabled();
            await expect(page.getByText("Confirmation pending")).toBeVisible();

            const enabled = parseInactiveMemberPolicy(
                (
                    await db.app_settings.findUniqueOrThrow({
                        where: { key: "inactive_member_monitor_policy" },
                    })
                ).value,
            );
            expect(enabled.enabled).toBe(true);
            expect(enabled.revision).not.toBe(
                DEFAULT_INACTIVE_MEMBER_POLICY.revision,
            );

            await enabledCheckbox.uncheck();
            await card.getByRole("button", { name: "Save automation" }).click();
            await expect(
                card.getByRole("button", { name: "Save automation" }),
            ).toBeEnabled();
            await expect(
                card.getByText("Disabled", { exact: true }),
            ).toBeVisible();
            const disabled = parseInactiveMemberPolicy(
                (
                    await db.app_settings.findUniqueOrThrow({
                        where: { key: "inactive_member_monitor_policy" },
                    })
                ).value,
            );
            expect(disabled.enabled).toBe(false);
            expect(disabled.revision).not.toBe(enabled.revision);
        } finally {
            if (previous) {
                await db.app_settings.upsert({
                    where: { key: previous.key },
                    create: { key: previous.key, value: previous.value },
                    update: { value: previous.value },
                });
            } else {
                await db.app_settings.deleteMany({
                    where: { key: "inactive_member_monitor_policy" },
                });
            }
        }
    });

    test("records activity when the protected dashboard becomes visible", async ({
        page,
        isMobile,
    }) => {
        test.skip(
            isMobile,
            "Shared user activity mutation runs once on desktop",
        );
        const previous = await db.user.findUniqueOrThrow({
            where: { id: "e2e-user" },
            select: { last_dashboard_seen_at: true },
        });
        try {
            await db.user.update({
                where: { id: "e2e-user" },
                data: { last_dashboard_seen_at: null },
            });
            await page.goto("/dashboard");
            await expect
                .poll(async () => {
                    const user = await db.user.findUniqueOrThrow({
                        where: { id: "e2e-user" },
                        select: { last_dashboard_seen_at: true },
                    });
                    return user.last_dashboard_seen_at?.getTime() ?? 0;
                })
                .toBeGreaterThan(0);
        } finally {
            await db.user.update({
                where: { id: "e2e-user" },
                data: {
                    last_dashboard_seen_at: previous.last_dashboard_seen_at,
                },
            });
        }
    });
});
