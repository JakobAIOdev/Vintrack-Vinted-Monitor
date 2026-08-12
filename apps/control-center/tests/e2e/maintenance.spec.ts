import { expect, test } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import {
    DEFAULT_MONITOR_MAINTENANCE,
    DEFAULT_MONITOR_MAINTENANCE_MESSAGE,
    MONITOR_MAINTENANCE_SETTING_KEY,
    MONITOR_WORKER_RUNTIME_SETTING_KEY,
    getMaintenanceAnnouncement,
    getMonitorMaintenanceStatus,
    parseMonitorMaintenance,
    parseMonitorWorkerRuntime,
    validateMonitorMaintenanceInput,
    type MonitorMaintenance,
} from "../../src/lib/monitor-maintenance";
import { MEMBER_ANNOUNCEMENT_SETTING_KEY } from "../../src/lib/member-announcement";

const db = new PrismaClient();

async function restoreSetting(
    key: string,
    previous: { key: string; value: string } | null,
) {
    if (!previous) {
        await db.app_settings.deleteMany({ where: { key } });
        return;
    }
    await db.app_settings.upsert({
        where: { key },
        create: previous,
        update: { value: previous.value },
    });
}

test.afterAll(async () => {
    await db.$disconnect();
});

test.describe("monitor maintenance", () => {
    test.describe.configure({ mode: "serial" });

    test("parses, validates, and evaluates worker acknowledgement", () => {
        expect(parseMonitorMaintenance(null)).toEqual(
            DEFAULT_MONITOR_MAINTENANCE,
        );
        expect(parseMonitorMaintenance("not-json")).toEqual(
            DEFAULT_MONITOR_MAINTENANCE,
        );
        expect(parseMonitorWorkerRuntime("not-json")).toBeNull();
        expect(() => validateMonitorMaintenanceInput({ message: "" })).toThrow(
            /required/,
        );
        expect(() =>
            validateMonitorMaintenanceInput({ message: "x".repeat(301) }),
        ).toThrow(/300 characters/);
        expect(() =>
            validateMonitorMaintenanceInput(
                {
                    message: "Maintenance",
                    estimatedEndAt: "2026-08-12T09:00:00.000Z",
                },
                { now: new Date("2026-08-12T10:00:00.000Z") },
            ),
        ).toThrow(/future/);

        const maintenance: MonitorMaintenance = {
            enabled: true,
            revision: "maintenance-test-v1",
            message: DEFAULT_MONITOR_MAINTENANCE_MESSAGE,
            estimatedEndAt: null,
            enabledAt: "2026-08-12T10:00:00.000Z",
            enabledBy: "admin",
            updatedAt: "2026-08-12T10:00:00.000Z",
        };
        const runtime = parseMonitorWorkerRuntime(
            JSON.stringify({
                heartbeatAt: "2026-08-12T10:00:05.000Z",
                maintenanceRevision: maintenance.revision,
                runningMonitorTasks: 1,
                runningDiscoveryTasks: 1,
            }),
        );
        expect(runtime).not.toBeNull();
        expect(
            getMonitorMaintenanceStatus(
                maintenance,
                runtime,
                new Date("2026-08-12T10:00:10.000Z"),
            ),
        ).toBe("draining");
        expect(
            getMonitorMaintenanceStatus(
                maintenance,
                runtime && {
                    ...runtime,
                    runningMonitorTasks: 0,
                    runningDiscoveryTasks: 0,
                },
                new Date("2026-08-12T10:00:10.000Z"),
            ),
        ).toBe("active");
        expect(
            getMonitorMaintenanceStatus(
                maintenance,
                runtime && {
                    ...runtime,
                    maintenanceRevision: "old-revision",
                },
                new Date("2026-08-12T10:00:10.000Z"),
            ),
        ).toBe("confirmation_pending");
        expect(
            getMonitorMaintenanceStatus(
                maintenance,
                runtime,
                new Date("2026-08-12T10:00:21.000Z"),
            ),
        ).toBe("confirmation_pending");

        const announcement = getMaintenanceAnnouncement(maintenance);
        expect(announcement.variant).toBe("critical");
        expect(announcement.dismissible).toBe(false);
        expect(announcement.title).toBe(
            "Vintrack is currently undergoing maintenance",
        );
    });

    test("blocks a stale manual create form after maintenance starts", async ({
        page,
        isMobile,
    }) => {
        test.skip(isMobile, "The shared create guard is tested once");
        const previousMaintenance = await db.app_settings.findUnique({
            where: { key: MONITOR_MAINTENANCE_SETTING_KEY },
        });
        const monitorName = `E2E stale maintenance create ${Date.now()}`;
        try {
            await db.app_settings.deleteMany({
                where: { key: MONITOR_MAINTENANCE_SETTING_KEY },
            });
            await page.goto("/monitors/new");
            await page.getByLabel("Monitor Name").fill(monitorName);
            await page
                .getByRole("textbox", {
                    name: "Search Queries (optional)",
                    exact: true,
                })
                .fill("nike");
            const proxySource = page.locator('select[name="proxy_group_id"]');
            await expect(proxySource).toBeEnabled();
            await expect(
                proxySource.locator('option[value="server"]'),
            ).toHaveCount(1);
            await proxySource.selectOption("server");

            const now = new Date().toISOString();
            await db.app_settings.create({
                data: {
                    key: MONITOR_MAINTENANCE_SETTING_KEY,
                    value: JSON.stringify({
                        enabled: true,
                        revision: `stale-create-${Date.now()}`,
                        message: DEFAULT_MONITOR_MAINTENANCE_MESSAGE,
                        estimatedEndAt: null,
                        enabledAt: now,
                        enabledBy: "e2e-user",
                        updatedAt: now,
                    }),
                },
            });

            await page.getByRole("button", { name: "Create Monitor" }).click();
            await expect(
                page.getByText(
                    "Monitor creation is paused while Vintrack is undergoing maintenance.",
                ),
            ).toBeVisible();
            expect(
                await db.monitors.count({ where: { name: monitorName } }),
            ).toBe(0);
        } finally {
            await db.monitors.deleteMany({ where: { name: monitorName } });
            await restoreSetting(
                MONITOR_MAINTENANCE_SETTING_KEY,
                previousMaintenance,
            );
        }
    });

    test("pauses safely, confirms drain, prioritizes the banner, updates, and resumes", async ({
        page,
        isMobile,
    }) => {
        test.skip(isMobile, "Global maintenance state is tested once");
        test.setTimeout(60_000);

        const [previousMaintenance, previousRuntime, previousAnnouncement] =
            await Promise.all([
                db.app_settings.findUnique({
                    where: { key: MONITOR_MAINTENANCE_SETTING_KEY },
                }),
                db.app_settings.findUnique({
                    where: { key: MONITOR_WORKER_RUNTIME_SETTING_KEY },
                }),
                db.app_settings.findUnique({
                    where: { key: MEMBER_ANNOUNCEMENT_SETTING_KEY },
                }),
            ]);
        const pausedMonitor = await db.monitors.create({
            data: {
                userId: "e2e-user",
                name: "E2E manually paused",
                query: "maintenance-paused-control",
                status: "paused",
                notifications_enabled: false,
            },
        });
        const monitorStates = await db.monitors.findMany({
            select: { id: true, status: true },
        });
        const auditStartedAt = new Date();

        try {
            await Promise.all([
                db.app_settings.deleteMany({
                    where: { key: MONITOR_MAINTENANCE_SETTING_KEY },
                }),
                db.app_settings.deleteMany({
                    where: { key: MONITOR_WORKER_RUNTIME_SETTING_KEY },
                }),
                db.app_settings.deleteMany({
                    where: { key: MEMBER_ANNOUNCEMENT_SETTING_KEY },
                }),
            ]);

            await page.goto("/admin?tab=monitors");
            const systemControl = page.getByTestId(
                "maintenance-system-control",
            );
            await expect(systemControl).toContainText("Normal operation");
            await systemControl
                .getByRole("button", { name: "Enable maintenance" })
                .click();
            const dialog = page.getByRole("dialog", {
                name: "Enable monitor maintenance?",
            });
            await dialog
                .getByLabel("Estimated completion (optional)")
                .fill("2020-01-01T00:00");
            await dialog
                .getByRole("button", {
                    name: /Pause \d+ monitors? & enable maintenance/,
                })
                .click();
            await expect(
                page.getByText(/must be in the future/i),
            ).toBeVisible();
            expect(
                await db.app_settings.findUnique({
                    where: { key: MONITOR_MAINTENANCE_SETTING_KEY },
                }),
            ).toBeNull();

            const message =
                "We are upgrading Vintrack infrastructure. Your monitors are safely paused.";
            await dialog.getByLabel("Member message").fill(message);
            await dialog.getByLabel("Estimated completion (optional)").fill("");
            await dialog
                .getByRole("button", {
                    name: /Pause \d+ monitors? & enable maintenance/,
                })
                .click();

            await expect(systemControl).toContainText(
                "Worker confirmation pending",
            );
            const enabledSetting = await expect
                .poll(async () =>
                    db.app_settings.findUnique({
                        where: { key: MONITOR_MAINTENANCE_SETTING_KEY },
                    }),
                )
                .not.toBeNull();
            void enabledSetting;
            const enabled = parseMonitorMaintenance(
                (
                    await db.app_settings.findUniqueOrThrow({
                        where: { key: MONITOR_MAINTENANCE_SETTING_KEY },
                    })
                ).value,
            );
            expect(enabled.enabled).toBe(true);
            expect(
                await db.monitors.count({ where: { status: "active" } }),
            ).toBe(0);
            expect(
                await db.monitors.findUniqueOrThrow({
                    where: { id: pausedMonitor.id },
                    select: { status: true },
                }),
            ).toEqual({ status: "paused" });

            const writeRuntime = async (
                revision: string,
                runningMonitorTasks: number,
                runningDiscoveryTasks: number,
            ) =>
                db.app_settings.upsert({
                    where: { key: MONITOR_WORKER_RUNTIME_SETTING_KEY },
                    create: {
                        key: MONITOR_WORKER_RUNTIME_SETTING_KEY,
                        value: JSON.stringify({
                            heartbeatAt: new Date().toISOString(),
                            maintenanceRevision: revision,
                            runningMonitorTasks,
                            runningDiscoveryTasks,
                        }),
                    },
                    update: {
                        value: JSON.stringify({
                            heartbeatAt: new Date().toISOString(),
                            maintenanceRevision: revision,
                            runningMonitorTasks,
                            runningDiscoveryTasks,
                        }),
                    },
                });
            await writeRuntime(enabled.revision, 1, 1);
            await expect(systemControl).toContainText("Draining", {
                timeout: 8_000,
            });
            await writeRuntime(enabled.revision, 0, 0);
            await expect(systemControl).toContainText("Maintenance active", {
                timeout: 8_000,
            });

            await page.goto("/dashboard");
            await page.evaluate(() => window.localStorage.clear());
            await page.reload();
            const maintenanceBanner = page.getByRole("status").filter({
                hasText: "Vintrack is currently undergoing maintenance",
            });
            await expect(maintenanceBanner).toBeVisible();
            await expect(maintenanceBanner).toContainText(message);
            await expect(
                maintenanceBanner.getByRole("button", {
                    name: /dismiss/i,
                }),
            ).toHaveCount(0);
            await expect(
                page.getByText(
                    "Help keep the free demo fast and accessible with as few limits as possible.",
                ),
            ).toHaveCount(0);
            await expect(
                page
                    .getByRole("button", {
                        name: "Paused for maintenance",
                    })
                    .first(),
            ).toBeDisabled();
            const disabledCreateLinks = page.locator(
                '[data-maintenance-disabled="true"]',
            );
            await expect(
                disabledCreateLinks.filter({ hasText: "New Monitor" }),
            ).toHaveCount(2);
            await expect(disabledCreateLinks.first()).toHaveAttribute(
                "title",
                "Monitor creation is paused during maintenance",
            );

            await page.goto("/guide");
            await expect(
                page
                    .locator('[data-maintenance-disabled="true"]')
                    .filter({ hasText: "Create monitor" }),
            ).toHaveCount(2);
            await page.goto("/proxies");
            await expect(
                page
                    .locator('[data-maintenance-disabled="true"]')
                    .filter({ hasText: "Create monitor" }),
            ).toBeVisible();

            await page.goto("/monitors/new");
            const creationBlocked = page.getByTestId(
                "monitor-creation-maintenance",
            );
            await expect(creationBlocked).toContainText(
                "Monitor creation is temporarily unavailable",
            );
            await expect(
                page.getByRole("button", { name: "Create Monitor" }),
            ).toHaveCount(0);

            await page.goto("/admin?tab=monitors");
            await systemControl
                .getByRole("button", { name: "Edit notice" })
                .click();
            const updateDialog = page.getByRole("dialog", {
                name: "Update maintenance notice",
            });
            const updatedMessage =
                "Infrastructure maintenance is almost complete. Monitors remain safely paused.";
            await updateDialog
                .getByLabel("Member message")
                .fill(updatedMessage);
            await updateDialog
                .getByLabel("Estimated completion (optional)")
                .fill("2099-01-01T12:00");
            await updateDialog
                .getByRole("button", { name: "Update maintenance notice" })
                .click();

            await expect
                .poll(
                    async () =>
                        parseMonitorMaintenance(
                            (
                                await db.app_settings.findUniqueOrThrow({
                                    where: {
                                        key: MONITOR_MAINTENANCE_SETTING_KEY,
                                    },
                                })
                            ).value,
                        ).revision,
                )
                .not.toBe(enabled.revision);
            const updated = parseMonitorMaintenance(
                (
                    await db.app_settings.findUniqueOrThrow({
                        where: { key: MONITOR_MAINTENANCE_SETTING_KEY },
                    })
                ).value,
            );
            expect(updated.estimatedEndAt).not.toBeNull();
            await expect(systemControl).toContainText(
                "Worker confirmation pending",
            );

            await page.goto("/dashboard");
            await expect(
                page.getByRole("status").filter({ hasText: updatedMessage }),
            ).toBeVisible();
            await expect(page.getByRole("status")).toContainText(
                "Estimated completion",
            );

            await page.goto("/admin?tab=monitors");
            await systemControl
                .getByRole("button", { name: "End maintenance" })
                .click();
            const endDialog = page.getByRole("dialog", {
                name: "End monitor maintenance?",
            });
            await endDialog
                .getByRole("button", {
                    name: /Resume \d+ monitors? & end maintenance/,
                })
                .click();
            await expect(systemControl).toContainText("Normal operation");

            for (const monitor of monitorStates) {
                if (monitor.status === "active") {
                    expect(
                        await db.monitors.findUniqueOrThrow({
                            where: { id: monitor.id },
                            select: { status: true },
                        }),
                    ).toEqual({ status: "active" });
                }
            }
            expect(
                await db.monitors.findUniqueOrThrow({
                    where: { id: pausedMonitor.id },
                    select: { status: true },
                }),
            ).toEqual({ status: "paused" });
            expect(
                await db.alert_notifications.count({
                    where: {
                        created_at: { gte: auditStartedAt },
                        NOT: { idempotency_key: { startsWith: "status:" } },
                    },
                }),
            ).toBe(0);

            const auditActions = await db.audit_events.findMany({
                where: {
                    created_at: { gte: auditStartedAt },
                    action: {
                        in: [
                            "admin.monitor_maintenance_enabled",
                            "admin.monitor_maintenance_updated",
                            "admin.monitor_maintenance_disabled",
                        ],
                    },
                },
                select: { action: true },
            });
            expect(auditActions.map((event) => event.action).sort()).toEqual([
                "admin.monitor_maintenance_disabled",
                "admin.monitor_maintenance_enabled",
                "admin.monitor_maintenance_updated",
            ]);

            await page.goto("/dashboard");
            await expect(
                page.getByText(
                    "Help keep the free demo fast and accessible with as few limits as possible.",
                ),
            ).toBeVisible();
            await expect(
                page.locator('[data-maintenance-disabled="true"]'),
            ).toHaveCount(0);
            await expect(
                page.getByRole("link", { name: "New Monitor" }).first(),
            ).toHaveAttribute("href", "/monitors/new");
        } finally {
            for (const monitor of monitorStates) {
                await db.monitors.updateMany({
                    where: { id: monitor.id },
                    data: { status: monitor.status },
                });
            }
            await db.monitors.deleteMany({ where: { id: pausedMonitor.id } });
            await Promise.all([
                restoreSetting(
                    MONITOR_MAINTENANCE_SETTING_KEY,
                    previousMaintenance,
                ),
                restoreSetting(
                    MONITOR_WORKER_RUNTIME_SETTING_KEY,
                    previousRuntime,
                ),
                restoreSetting(
                    MEMBER_ANNOUNCEMENT_SETTING_KEY,
                    previousAnnouncement,
                ),
            ]);
        }
    });

    test("serializes a parallel Start All request against maintenance activation", async ({
        page,
        context,
        isMobile,
    }) => {
        test.skip(isMobile, "The global race is tested once");
        const previousMaintenance = await db.app_settings.findUnique({
            where: { key: MONITOR_MAINTENANCE_SETTING_KEY },
        });
        const monitorStates = await db.monitors.findMany({
            select: { id: true, status: true },
        });

        try {
            await db.app_settings.deleteMany({
                where: { key: MONITOR_MAINTENANCE_SETTING_KEY },
            });
            await db.monitors.updateMany({ data: { status: "paused" } });

            await page.goto("/admin?tab=monitors");
            const systemControl = page.getByTestId(
                "maintenance-system-control",
            );
            await systemControl
                .getByRole("button", { name: "Enable maintenance" })
                .click();
            const confirmMaintenance = page
                .getByRole("dialog", { name: "Enable monitor maintenance?" })
                .getByRole("button", {
                    name: /Pause 0 monitors & enable maintenance/,
                });

            const dashboardPage = await context.newPage();
            await dashboardPage.goto("/dashboard");
            const startAll = dashboardPage.getByRole("button", {
                name: "Start All",
            });
            await expect(startAll).toBeVisible();

            await Promise.all([confirmMaintenance.click(), startAll.click()]);
            await expect
                .poll(async () => {
                    const setting = await db.app_settings.findUnique({
                        where: { key: MONITOR_MAINTENANCE_SETTING_KEY },
                    });
                    return parseMonitorMaintenance(setting?.value).enabled;
                })
                .toBe(true);
            expect(
                await db.monitors.count({ where: { status: "active" } }),
            ).toBe(0);
            await dashboardPage.close();
        } finally {
            for (const monitor of monitorStates) {
                await db.monitors.updateMany({
                    where: { id: monitor.id },
                    data: { status: monitor.status },
                });
            }
            await restoreSetting(
                MONITOR_MAINTENANCE_SETTING_KEY,
                previousMaintenance,
            );
        }
    });

    test("serializes monitor creation against maintenance activation", async ({
        page,
        context,
        isMobile,
    }) => {
        test.skip(isMobile, "The global create race is tested once");
        const previousMaintenance = await db.app_settings.findUnique({
            where: { key: MONITOR_MAINTENANCE_SETTING_KEY },
        });
        const monitorStates = await db.monitors.findMany({
            select: { id: true, status: true },
        });
        const monitorName = `E2E maintenance create race ${Date.now()}`;

        try {
            await db.app_settings.deleteMany({
                where: { key: MONITOR_MAINTENANCE_SETTING_KEY },
            });

            const createPage = await context.newPage();
            await createPage.goto("/monitors/new");
            await createPage.getByLabel("Monitor Name").fill(monitorName);
            await createPage
                .getByRole("textbox", {
                    name: "Search Queries (optional)",
                    exact: true,
                })
                .fill("nike");
            const proxySource = createPage.locator(
                'select[name="proxy_group_id"]',
            );
            await expect(proxySource).toBeEnabled();
            await expect(
                proxySource.locator('option[value="server"]'),
            ).toHaveCount(1);
            await proxySource.selectOption("server");
            const submitCreate = createPage.getByRole("button", {
                name: "Create Monitor",
            });
            await expect(submitCreate).toBeEnabled();

            await page.goto("/admin?tab=monitors");
            const systemControl = page.getByTestId(
                "maintenance-system-control",
            );
            await systemControl
                .getByRole("button", { name: "Enable maintenance" })
                .click();
            const confirmMaintenance = page
                .getByRole("dialog", { name: "Enable monitor maintenance?" })
                .getByRole("button", {
                    name: /Pause \d+ monitors? & enable maintenance/,
                });

            await Promise.all([
                confirmMaintenance.click(),
                submitCreate.click(),
            ]);
            await expect
                .poll(async () => {
                    const setting = await db.app_settings.findUnique({
                        where: { key: MONITOR_MAINTENANCE_SETTING_KEY },
                    });
                    return parseMonitorMaintenance(setting?.value).enabled;
                })
                .toBe(true);

            const created = await db.monitors.findMany({
                where: { name: monitorName },
                select: { status: true },
            });
            expect(created.length).toBeLessThanOrEqual(1);
            if (created.length === 1) {
                expect(created[0].status).toBe("maintenance_paused");
            }
            await createPage.close();
        } finally {
            await db.monitors.deleteMany({ where: { name: monitorName } });
            for (const monitor of monitorStates) {
                await db.monitors.updateMany({
                    where: { id: monitor.id },
                    data: { status: monitor.status },
                });
            }
            await restoreSetting(
                MONITOR_MAINTENANCE_SETTING_KEY,
                previousMaintenance,
            );
        }
    });
});
