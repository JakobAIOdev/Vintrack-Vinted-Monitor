import { expect, test, type Page } from "@playwright/test";
import { resolve } from "node:path";

// Runs the extension's inline Vinted features in a real browser against
// synthetic pages that reuse Vinted's card and item-page anchors. Requests to
// the Vinted origin are fulfilled locally; nothing reaches the network.

const extensionDir = resolve(
    process.cwd(),
    "../vintrack-browser-sync-extension",
);
const NOW = new Date("2026-11-12T12:00:00.000Z");
const seconds = (iso: string) => Date.parse(iso) / 1000;

type Seed = {
    storage: Record<string, unknown>;
    index: unknown;
    feed: unknown[];
};

type TestWindow = {
    __vt: Seed & {
        messages: Array<{ type?: string; payload?: unknown }>;
        clicked: string[];
    };
    chrome: {
        storage: {
            local: {
                set: (values: Record<string, unknown>) => Promise<void>;
            };
        };
    };
};

const index = {
    monitors: [{ id: 4, name: "Nike Dunk under 40" }],
    finds: [["100", 4, seconds("2026-11-12T10:00:00Z")]],
    watches: [
        {
            id: "7",
            itemId: "200",
            status: "active",
            availability: "available",
            initialPriceMinor: "2000",
            currentPriceMinor: "1500",
            currencyCode: "EUR",
        },
        {
            id: "8",
            itemId: "700",
            status: "stopped",
            stateKey: "sold",
            stateLabel: "Sold",
            availability: "unavailable",
            initialPriceMinor: "15000",
            currentPriceMinor: "12000",
            currencyCode: "EUR",
        },
    ],
};

function card(id: string, title: string, brand: string, price: string) {
    const label = `${title}, Marke: ${brand}, Zustand: Gut, Größe: M, ${price}`;
    const prefix = `product-item-id-${id}`;
    return `
<div data-testid="grid-item">
  <div data-testid="${prefix}" style="width:220px">
    <div style="position:relative;width:220px;height:300px">
      <div data-testid="${prefix}--image">
        <img data-testid="${prefix}--image--img" alt="${label}" width="220" height="300" />
      </div>
      <a href="/items/${id}-listing?referrer=catalog" title="${label}"
         data-testid="${prefix}--overlay-link" style="position:absolute;inset:0"></a>
    </div>
    <div data-testid="${prefix}--summary">
      <p data-testid="${prefix}--description-title">${brand}</p>
      <p data-testid="${prefix}--description-subtitle">M · Gut</p>
      <p data-testid="${prefix}--price-text">${price}</p>
    </div>
  </div>
</div>`;
}

const catalogPage = `<!doctype html><html lang="de"><body>
<div style="display:flex;flex-wrap:wrap;gap:16px;padding:16px">
${card("100", "Nike Dunk Low", "Nike", "35,00 €")}
${card("200", "Carhartt Jacke", "Carhartt", "15,00 €")}
${card("300", "Wollmantel", "COS", "15,00 €")}
${card("400", "Trikot Replica", "Adidas", "20,00 €")}
${card("500", "Vintage Lederjacke", "Levi's", "60,00 €")}
${card("600", "Schal aus Wolle", "Acne", "9,00 €")}
${card("700", "Daunenjacke", "Moncler", "120,00 €")}
</div></body></html>`;

const itemPage = `<!doctype html><html lang="en-GB"><body>
<script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Product",
    name: "Wool coat",
    offers: {
        "@type": "Offer",
        url: "https://www.vinted.de/items/300-wool-coat",
        priceCurrency: "EUR",
        price: 15,
    },
})}</script>
<main class="item-information">
  <div data-testid="item-desktops-only-container">
    <div id="sidebar">
      <button data-vintrack-companion-button="item-desktop">Track price</button>
      <div data-testid="slot-container">Vinted sidebar</div>
    </div>
  </div>
</main></body></html>`;

async function openVinted(page: Page, path: string, html: string, seed: Seed) {
    await page.clock.install({ time: NOW });
    await page.route("https://www.vinted.de/**", (route) =>
        route.fulfill({ contentType: "text/html; charset=utf-8", body: html }),
    );
    await page.addInitScript((initial: Seed) => {
        const listeners: Array<
            (changes: Record<string, unknown>, area: string) => void
        > = [];
        const store: Record<string, unknown> = { ...initial.storage };
        const emit = (changes: Record<string, unknown>) => {
            for (const listener of listeners) listener(changes, "local");
        };
        const state = {
            ...initial,
            storage: store,
            messages: [] as Array<{ type?: string }>,
            clicked: [] as string[],
        };
        Object.assign(window, {
            __vt: state,
            chrome: {
                runtime: {
                    sendMessage: async (message: { type?: string }) => {
                        state.messages.push(message);
                        if (message.type === "VINTRACK_INLINE_INDEX") {
                            return {
                                ok: true,
                                configured: true,
                                index: state.index,
                            };
                        }
                        if (message.type === "VINTRACK_INLINE_FEED") {
                            return {
                                ok: true,
                                configured: true,
                                items: state.feed,
                            };
                        }
                        return { ok: true };
                    },
                },
                storage: {
                    local: {
                        get: async (keys: string | string[]) =>
                            Object.fromEntries(
                                (typeof keys === "string" ? [keys] : keys)
                                    .filter((key) => key in store)
                                    .map((key) => [key, store[key]]),
                            ),
                        set: async (values: Record<string, unknown>) => {
                            Object.assign(store, values);
                            emit(
                                Object.fromEntries(
                                    Object.entries(values).map(
                                        ([key, newValue]) => [
                                            key,
                                            { newValue },
                                        ],
                                    ),
                                ),
                            );
                        },
                        remove: async (keys: string | string[]) => {
                            const changes: Record<string, unknown> = {};
                            for (const key of typeof keys === "string"
                                ? [keys]
                                : keys) {
                                delete store[key];
                                changes[key] = {};
                            }
                            emit(changes);
                        },
                    },
                    onChanged: {
                        addListener: (
                            listener: (
                                changes: Record<string, unknown>,
                                area: string,
                            ) => void,
                        ) => listeners.push(listener),
                        removeListener: () => undefined,
                    },
                },
            },
        });
    }, seed);
    await page.goto(`https://www.vinted.de${path}`);
    await page.addStyleTag({ path: resolve(extensionDir, "inline.css") });
    // Same order as the manifest's content_scripts entry.
    await page.addScriptTag({ path: resolve(extensionDir, "companion.js") });
    await page.addScriptTag({ path: resolve(extensionDir, "inline.js") });
    await page.clock.runFor(500);
}

const chips = (page: Page, id: string) =>
    page.locator(`[data-testid="product-item-id-${id}"] .vtk-chip`);
const messages = (page: Page, type: string) =>
    page.evaluate(
        (wanted) =>
            (window as unknown as TestWindow).__vt.messages.filter(
                (message) => message.type === wanted,
            ),
        type,
    );
const setStorage = (page: Page, values: Record<string, unknown>) =>
    page.evaluate(
        (next) =>
            (window as unknown as TestWindow).chrome.storage.local.set(next),
        values,
    );

test("marks catalog listings from the local index, history and keywords", async ({
    page,
}) => {
    await openVinted(page, "/catalog?search_text=nike", catalogPage, {
        storage: {
            vintrackInlineSettings: {
                mutedKeywords: ["replica", "gut"],
                highlightKeywords: ["vintage"],
            },
            vintrackInlineSeen: {
                "300": [
                    seconds("2026-11-01T08:00:00Z"),
                    seconds("2026-11-03T08:00:00Z"),
                    1800,
                    "EUR",
                ],
            },
        },
        index,
        feed: [],
    });

    await expect(chips(page, "100")).toHaveText(["Nike Dunk under 40"]);
    await expect(chips(page, "100")).toHaveAttribute(
        "title",
        /Found by your Vintrack monitor “Nike Dunk under 40”/,
    );
    await expect(chips(page, "200")).toHaveText(["Tracked ↓ 5,00 €"]);
    await expect(chips(page, "300")).toHaveText(["↓ was 18,00 €"]);
    await expect(chips(page, "400")).toHaveText(["Faded · replica"]);
    await expect(chips(page, "500")).toHaveText(["★ vintage"]);
    // A watch that ended because the listing was sold says so.
    await expect(chips(page, "700")).toHaveText(["Sold"]);
    await expect(chips(page, "700")).toHaveAttribute(
        "title",
        /^Vintrack Price Watch ended: sold · started at 150,00\s€ · last seen at 120,00\s€$/,
    );
    // "gut" only appears in the condition part of the card label.
    await expect(chips(page, "600")).toHaveCount(0);

    const flagged = (id: string, name: string) =>
        page
            .locator(`[data-testid="product-item-id-${id}"]`)
            .getAttribute(name);
    expect(await flagged("300", "data-vtk-seen")).toBe("true");
    expect(await flagged("400", "data-vtk-muted")).toBe("true");
    expect(await flagged("500", "data-vtk-highlight")).toBe("true");
    expect(await flagged("600", "data-vtk-muted")).toBeNull();
    await expect(page.locator('[data-testid="product-item-id-400"]')).toHaveCSS(
        "opacity",
        "0.3",
    );

    // A chip sits above Vinted's overlay link and hands the click back to it.
    await page.evaluate(() => {
        for (const link of document.querySelectorAll("a[data-testid]")) {
            link.addEventListener("click", (event) => {
                event.preventDefault();
                (window as unknown as TestWindow).__vt.clicked.push(
                    link.getAttribute("href") || "",
                );
            });
        }
    });
    await chips(page, "100").click();
    expect(
        await page.evaluate(
            () => (window as unknown as TestWindow).__vt.clicked,
        ),
    ).toEqual(["/items/100-listing?referrer=catalog"]);

    // One snapshot request serves the whole page; nothing is sent per card.
    expect(await messages(page, "VINTRACK_INLINE_INDEX")).toHaveLength(1);

    await setStorage(page, {
        vintrackInlineSettings: {
            badges: false,
            seen: false,
            mutedKeywords: ["replica"],
        },
    });
    await page.clock.runFor(300);
    await expect(chips(page, "100")).toHaveCount(0);
    await expect(chips(page, "300")).toHaveCount(0);
    expect(await flagged("300", "data-vtk-seen")).toBeNull();
    await expect(chips(page, "400")).toHaveText(["Faded · replica"]);

    // Popup-only mode removes every inline trace.
    await setStorage(page, { vintrackCompanionMode: "popup" });
    await page.clock.runFor(300);
    await expect(page.locator("[data-vintrack-inline]")).toHaveCount(0);
    expect(await flagged("400", "data-vtk-muted")).toBeNull();
});

test("explains a listing on its item page and remembers the price locally", async ({
    page,
}) => {
    const firstSeen = seconds("2026-11-01T08:00:00Z");
    await openVinted(page, "/items/300-wool-coat", itemPage, {
        storage: {
            vintrackInlineSeen: {
                "300": [
                    firstSeen,
                    seconds("2026-11-03T08:00:00Z"),
                    1800,
                    "EUR",
                ],
            },
        },
        index: {
            ...index,
            finds: [["300", 4, seconds("2026-11-12T10:00:00Z")]],
            watches: [{ ...index.watches[0], itemId: "300" }],
        },
        feed: [],
    });

    const panel = page.locator(
        '#sidebar > [data-vintrack-inline="item-panel"]',
    );
    await expect(panel).toHaveCount(1);
    await expect(panel.locator(".vtk-row-copy span")).toHaveText([
        "Found by your monitor",
        "Price Watch",
        "Since your last look on 3 Nov",
    ]);
    await expect(panel.locator(".vtk-row-copy strong")).toHaveText([
        /^Nike Dunk under 40 · 12 Nov/,
        "Active · started at €20.00 · now €15.00 (−25 %)",
        "€18.00 → €15.00 (−€3.00)",
    ]);
    // The panel sits directly below the existing Track price button.
    expect(
        await page.evaluate(() =>
            document
                .querySelector(
                    '[data-vintrack-companion-button="item-desktop"]',
                )
                ?.nextElementSibling?.getAttribute("data-vintrack-inline"),
        ),
    ).toBe("item-panel");

    await panel.getByRole("button", { name: "Open monitor" }).click();
    expect(await messages(page, "VINTRACK_COMPANION_OPEN")).toEqual([
        {
            type: "VINTRACK_COMPANION_OPEN",
            payload: { destination: "monitor", id: "4" },
        },
    ]);

    const stored = await page.evaluate(
        () =>
            (window as unknown as TestWindow).__vt.storage
                .vintrackInlineSeen as Record<string, unknown[]>,
    );
    expect(stored["300"][0]).toBe(firstSeen);
    expect(stored["300"][1]).toBeGreaterThanOrEqual(NOW.getTime() / 1000);
    expect(stored["300"].slice(2)).toEqual([1500, "EUR"]);

    // Re-rendering keeps the comparison with the earlier visit stable.
    await page.evaluate(() =>
        document.body.appendChild(document.createElement("div")),
    );
    await page.clock.runFor(400);
    await expect(panel.locator(".vtk-row")).toHaveCount(3);
});

test("announces only new monitor finds as toasts", async ({ page }) => {
    await openVinted(page, "/catalog", catalogPage, {
        storage: {},
        index,
        feed: [
            {
                id: "1",
                title: "Earlier find",
                monitor_name: "Nike Dunk under 40",
                found_at: "2026-11-12T11:59:00.000Z",
                url: "https://www.vinted.de/items/1-earlier-find",
            },
        ],
    });

    // The first poll only records where the feed currently stands.
    await expect
        .poll(() => messages(page, "VINTRACK_INLINE_FEED"))
        .toHaveLength(1);
    await expect(page.locator(".vtk-toast")).toHaveCount(0);

    await page.evaluate(() => {
        (window as unknown as TestWindow).__vt.feed.unshift(
            {
                id: "2",
                title: "Fresh Dunk Low",
                total_price: "38,45 €",
                monitor_name: "Nike Dunk under 40",
                found_at: "2026-11-12T12:00:05.000Z",
                url: "https://www.vinted.de/items/2-fresh-dunk-low",
            },
            {
                id: "3",
                title: "Foreign link",
                monitor_name: "Nike Dunk under 40",
                found_at: "2026-11-12T12:00:06.000Z",
                url: "https://example.com/items/3",
            },
        );
    });
    await page.clock.runFor(26_000);

    const toast = page.locator(".vtk-toast");
    await expect(toast).toHaveCount(1);
    await expect(toast.locator("small")).toHaveText(
        "New find · Nike Dunk under 40",
    );
    await expect(toast.locator("strong")).toHaveText("Fresh Dunk Low");
    await expect(toast.locator("a")).toHaveAttribute(
        "href",
        "https://www.vinted.de/items/2-fresh-dunk-low",
    );

    // The same find is not announced again, and it leaves on its own.
    await page.clock.runFor(26_000);
    await expect(page.locator(".vtk-toast")).toHaveCount(0);

    // Switching the feature off stops the polling.
    const before = (await messages(page, "VINTRACK_INLINE_FEED")).length;
    await setStorage(page, { vintrackInlineSettings: { toasts: false } });
    await page.clock.runFor(60_000);
    expect(await messages(page, "VINTRACK_INLINE_FEED")).toHaveLength(before);
});

test("lets the member tune the Vinted integration from the companion", async ({
    page,
}) => {
    await openVinted(page, "/catalog", "<!doctype html><main id=c></main>", {
        storage: {
            vintrackInlineSeen: { "300": [1, 1, 1800, "EUR"] },
        },
        index,
        feed: [],
    });
    await page.addStyleTag({ path: resolve(extensionDir, "companion.css") });
    await page.evaluate(() => {
        const mount = document.querySelector("#c") as HTMLElement;
        mount.style.cssText = "display:block;width:420px;height:600px";
        window.VintrackCompanion.mount(mount, { surface: "popup" });
    });

    await page.getByRole("tab", { name: "On Vinted", exact: true }).click();
    const toasts = page.getByRole("checkbox", { name: /Live find toasts/ });
    await expect(toasts).toBeChecked();
    await toasts.uncheck();

    const muted = page.getByRole("textbox", {
        name: "Fade out listings containing",
    });
    await muted.fill("Replica, damaged, replica");
    await muted.blur();
    await expect(page.locator(".vtc-notice")).toHaveText("Keywords saved.");
    await expect(
        page.getByRole("textbox", { name: "Fade out listings containing" }),
    ).toHaveValue("replica, damaged");

    const settings = () =>
        page.evaluate(
            () =>
                (window as unknown as TestWindow).__vt.storage
                    .vintrackInlineSettings,
        );
    expect(await settings()).toEqual({
        badges: true,
        seen: true,
        itemPanel: true,
        toasts: false,
        mutedKeywords: ["replica", "damaged"],
        highlightKeywords: [],
    });

    await expect(
        page.getByText("1 opened listing is remembered in this browser."),
    ).toBeVisible();
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Clear seen history" }).click();
    await expect(page.locator(".vtc-notice")).toHaveText(
        "Seen history cleared.",
    );
    expect(
        await page.evaluate(
            () =>
                "vintrackInlineSeen" in
                (window as unknown as TestWindow).__vt.storage,
        ),
    ).toBe(false);
    await expect(
        page.getByRole("button", { name: "Clear seen history" }),
    ).toBeDisabled();
});
