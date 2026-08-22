import { expect, test } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import {
    DEFAULT_MEMBER_ANNOUNCEMENT,
    MEMBER_ANNOUNCEMENT_SETTING_KEY,
    getAnnouncementPlacement,
    isMemberAnnouncementVisible,
    parseMemberAnnouncement,
    validateMemberAnnouncementInput,
    type MemberAnnouncement,
} from "../../src/lib/member-announcement";

const db = new PrismaClient();

test.afterAll(async () => {
    await db.$disconnect();
});

test.describe("member announcements", () => {
    test.describe.configure({ mode: "serial" });

    test("parses defaults and validates content, CTAs, and schedules", () => {
        expect(parseMemberAnnouncement(null)).toEqual(
            DEFAULT_MEMBER_ANNOUNCEMENT,
        );
        expect(parseMemberAnnouncement("not-json")).toEqual(
            DEFAULT_MEMBER_ANNOUNCEMENT,
        );

        for (const variant of [
            "support",
            "info",
            "warning",
            "critical",
        ] as const) {
            expect(
                validateMemberAnnouncementInput({
                    ...DEFAULT_MEMBER_ANNOUNCEMENT,
                    variant,
                }).variant,
            ).toBe(variant);
        }

        expect(() =>
            validateMemberAnnouncementInput({
                ...DEFAULT_MEMBER_ANNOUNCEMENT,
                cta: { label: "Unsafe", url: "http://example.com" },
            }),
        ).toThrow(/internal path or use HTTPS/);
        expect(() =>
            validateMemberAnnouncementInput({
                ...DEFAULT_MEMBER_ANNOUNCEMENT,
                cta: { label: "Unsafe", url: "/\\example.com" },
            }),
        ).toThrow(/internal path or use HTTPS/);
        expect(() =>
            validateMemberAnnouncementInput({
                ...DEFAULT_MEMBER_ANNOUNCEMENT,
                startsAt: "2026-08-12T10:00:00.000Z",
                endsAt: "2026-08-12T09:00:00.000Z",
            }),
        ).toThrow(/after the start time/);
        expect(() =>
            validateMemberAnnouncementInput({
                ...DEFAULT_MEMBER_ANNOUNCEMENT,
                audiences: [],
            }),
        ).toThrow(/at least one audience/);
    });

    test("maps routes and filters by role, placement, and schedule", () => {
        expect(getAnnouncementPlacement("/dashboard")).toBe("monitors");
        expect(getAnnouncementPlacement("/monitors/42")).toBe("monitors");
        expect(getAnnouncementPlacement("/feed")).toBe("live_feed");
        expect(getAnnouncementPlacement("/checkout-links")).toBe(
            "member_tools",
        );
        expect(getAnnouncementPlacement("/proxies")).toBe("proxy_groups");
        expect(getAnnouncementPlacement("/guide")).toBe("guide");
        expect(getAnnouncementPlacement("/admin")).toBe("admin");

        const announcement: MemberAnnouncement = {
            ...DEFAULT_MEMBER_ANNOUNCEMENT,
            audiences: ["premium"],
            placements: ["live_feed"],
            startsAt: "2026-08-11T10:00:00.000Z",
            endsAt: "2026-08-11T12:00:00.000Z",
        };
        expect(
            isMemberAnnouncementVisible(announcement, {
                pathname: "/feed",
                role: "premium",
                now: new Date("2026-08-11T11:00:00.000Z"),
            }),
        ).toBe(true);
        expect(
            isMemberAnnouncementVisible(announcement, {
                pathname: "/dashboard",
                role: "premium",
                now: new Date("2026-08-11T11:00:00.000Z"),
            }),
        ).toBe(false);
        expect(
            isMemberAnnouncementVisible(announcement, {
                pathname: "/feed",
                role: "free",
                now: new Date("2026-08-11T11:00:00.000Z"),
            }),
        ).toBe(false);
        expect(
            isMemberAnnouncementVisible(announcement, {
                pathname: "/feed",
                role: "premium",
                now: new Date("2026-08-11T12:00:00.000Z"),
            }),
        ).toBe(false);
    });

    test("renders, dismisses, resurfaces, targets, schedules, and edits announcements", async ({
        page,
        isMobile,
    }) => {
        test.skip(isMobile, "Global announcement setting is tested once");

        const previous = await db.app_settings.findUnique({
            where: { key: MEMBER_ANNOUNCEMENT_SETTING_KEY },
        });
        const save = async (announcement: MemberAnnouncement) => {
            await db.app_settings.upsert({
                where: { key: MEMBER_ANNOUNCEMENT_SETTING_KEY },
                create: {
                    key: MEMBER_ANNOUNCEMENT_SETTING_KEY,
                    value: JSON.stringify(announcement),
                },
                update: { value: JSON.stringify(announcement) },
            });
        };

        try {
            await db.app_settings.deleteMany({
                where: { key: MEMBER_ANNOUNCEMENT_SETTING_KEY },
            });
            await page.goto("/dashboard");
            await page.evaluate(() => window.localStorage.clear());
            await page.reload();
            const sponsor = page.getByRole("status").filter({
                hasText:
                    "Help keep the free demo fast and accessible with as few limits as possible.",
            });
            await expect(sponsor).toBeVisible();
            await expect(
                sponsor.getByRole("link", { name: "Sponsor on GitHub" }),
            ).toHaveAttribute(
                "href",
                "https://github.com/sponsors/JakobAIOdev",
            );

            const firstRevision: MemberAnnouncement = {
                ...DEFAULT_MEMBER_ANNOUNCEMENT,
                revision: "e2e-announcement-v1",
                variant: "warning",
                title: "E2E service notice",
                message: "A controlled announcement test is active.",
                cta: null,
                audiences: ["admin"],
                placements: ["monitors"],
            };
            await save(firstRevision);
            await page.reload();
            const firstBanner = page
                .getByRole("status")
                .filter({ hasText: firstRevision.title });
            await expect(firstBanner).toBeVisible();
            await firstBanner
                .getByRole("button", { name: "Dismiss announcement" })
                .click();
            await page.reload();
            await expect(firstBanner).toBeHidden();

            await save({
                ...firstRevision,
                revision: "e2e-announcement-v2",
                message: "This revision should appear again.",
                dismissible: false,
            });
            await page.reload();
            const persistentBanner = page
                .getByRole("status")
                .filter({ hasText: firstRevision.title });
            await expect(persistentBanner).toBeVisible();
            await expect(
                persistentBanner.getByRole("button", {
                    name: "Dismiss announcement",
                }),
            ).toHaveCount(0);

            await save({
                ...firstRevision,
                revision: "e2e-feed-only",
                dismissible: false,
                placements: ["live_feed"],
            });
            await page.reload();
            await expect(
                page.getByRole("status").filter({
                    hasText: firstRevision.title,
                }),
            ).toHaveCount(0);
            await page.goto("/feed");
            await expect(
                page.getByRole("status").filter({
                    hasText: firstRevision.title,
                }),
            ).toBeVisible();

            await save({
                ...firstRevision,
                revision: "e2e-future",
                dismissible: false,
                startsAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
            });
            await page.goto("/dashboard");
            await expect(
                page.getByRole("status").filter({
                    hasText: firstRevision.title,
                }),
            ).toHaveCount(0);

            await save({
                ...firstRevision,
                revision: "e2e-admin-editor",
                dismissible: false,
                placements: ["admin", "monitors"],
                startsAt: null,
            });
            await page.goto("/admin/announcements");
            const admin = page.getByRole("main");
            await expect(
                admin.getByText("Member Announcement", { exact: true }),
            ).toBeVisible();
            await admin.getByLabel("Title").fill("");
            await admin
                .getByRole("button", { name: "Publish Announcement" })
                .click();
            await expect(page.getByText("Title is required")).toBeVisible();

            await admin.getByLabel("Title").fill("E2E edited announcement");
            await admin.getByLabel("Message").fill("Saved from the admin UI.");
            await admin.getByLabel("Variant").selectOption("critical");
            await admin
                .getByRole("button", { name: "Publish Announcement" })
                .click();
            await expect(
                page.getByText("Member announcement published"),
            ).toBeVisible();

            const stored = parseMemberAnnouncement(
                (
                    await db.app_settings.findUniqueOrThrow({
                        where: { key: MEMBER_ANNOUNCEMENT_SETTING_KEY },
                    })
                ).value,
            );
            expect(stored.title).toBe("E2E edited announcement");
            expect(stored.variant).toBe("critical");
            expect(stored.revision).not.toBe("e2e-admin-editor");

            await admin.getByLabel("Enable member announcement").uncheck();
            await admin
                .getByRole("button", { name: "Publish Announcement" })
                .click();
            await expect(
                page.getByText("Member announcement published"),
            ).toBeVisible();
            await page.goto("/dashboard");
            await expect(
                page.getByRole("status").filter({
                    hasText: "E2E edited announcement",
                }),
            ).toHaveCount(0);
        } finally {
            if (previous) {
                await db.app_settings.upsert({
                    where: { key: MEMBER_ANNOUNCEMENT_SETTING_KEY },
                    create: previous,
                    update: { value: previous.value },
                });
            } else {
                await db.app_settings.deleteMany({
                    where: { key: MEMBER_ANNOUNCEMENT_SETTING_KEY },
                });
            }
        }
    });
});
