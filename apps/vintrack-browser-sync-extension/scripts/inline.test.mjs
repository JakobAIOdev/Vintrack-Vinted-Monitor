import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

// Load the shared companion helpers and the inline script the way the
// manifest does, without a DOM: only the pure helpers are evaluated.
async function load() {
  const sandbox = { URL, Intl, console };
  vm.createContext(sandbox);
  for (const name of ["companion.js", "inline.js"]) {
    const source = await readFile(new URL(`../${name}`, import.meta.url), "utf8");
    vm.runInContext(source, sandbox, { filename: name });
  }
  return {
    companion: sandbox.VintrackCompanion,
    inline: sandbox.VintrackInline,
  };
}

const { companion, inline } = await load();
// Values created inside the vm context carry another realm's prototypes, so
// compare plain copies.
const plain = (value) => JSON.parse(JSON.stringify(value));
const at = (iso) => Date.parse(iso) / 1000;

test("inline settings default on and normalize keywords", () => {
  assert.deepEqual(plain(companion.inline.normalizeSettings(null)), {
    badges: true,
    seen: true,
    itemPanel: true,
    toasts: true,
    mutedKeywords: [],
    highlightKeywords: [],
  });
  assert.deepEqual(
    plain(
      companion.inline.normalizeSettings({
        toasts: false,
        badges: "yes",
        mutedKeywords: " Replica, FAKE\nreplica, x ,",
        highlightKeywords: ["Vintage", " vintage ", 12],
      }),
    ),
    {
      badges: true,
      seen: true,
      itemPanel: true,
      toasts: false,
      mutedKeywords: ["replica", "fake"],
      highlightKeywords: ["vintage", "12"],
    },
  );
  assert.equal(
    companion.inline.parseKeywords(
      Array.from({ length: 80 }, (_, index) => `word${index}`),
    ).length,
    40,
  );
});

test("only supported Vinted hosts are recognized", () => {
  for (const host of ["vinted.de", "www.vinted.de", "WWW.VINTED.CO.UK"]) {
    assert.equal(companion.isVintedHost(host), true, host);
  }
  for (const host of ["vinted.xyz", "evilvinted.de", "vinted.de.example.com", ""]) {
    assert.equal(companion.isVintedHost(host), false, host);
  }
});

test("localized prices parse to hundredths", () => {
  for (const [text, expected] of [
    ["15,00 €", 1500],
    ["15.00 €", 1500],
    ["£1,234.56", 123456],
    ["1.234,56 €", 123456],
    ["1 500 Kč", 150000],
    ["5 000 Ft", 500000],
    ["1.500 Kč", 150000],
    ["12,5 zł", 1250],
    ["0,50 €", 50],
    ["25 €.", 2500],
  ]) {
    assert.equal(inline.parsePriceMinor(text), expected, text);
  }
  for (const text of ["", null, "Free", "€"]) {
    assert.equal(inline.parsePriceMinor(text), null);
  }
});

test("keywords see the listing title and brand, not condition or price", () => {
  const label =
    "Nike Dunk, kaum getragen, Marke: Nike, Zustand: Gut, Größe: 37.5, 15.00 €, 16.45 €";
  assert.equal(inline.listingText(label, "Nike"), "Nike Dunk, kaum getragen Nike");
  assert.equal(inline.findKeyword(inline.listingText(label, "Nike"), ["gut"]), "");
  assert.equal(
    inline.findKeyword(inline.listingText(label, "Nike"), ["jordan", "dunk"]),
    "dunk",
  );
  // Without a recognizable brand the whole label stays searchable.
  assert.equal(inline.listingText(label, ""), label);
  assert.equal(inline.listingText("", "Nike"), "Nike");
  // Accents and case do not matter.
  assert.equal(inline.findKeyword("Veste d'ÉTÉ rétro", ["ete"]), "ete");
  assert.equal(inline.findKeyword("anything", []), "");
});

test("seen history keeps the first visit, updates the price and stays bounded", () => {
  let seen = inline.rememberVisit({}, "10", 1000, 1800, "EUR");
  assert.deepEqual(plain(seen), { 10: [1000, 1000, 1800, "EUR"] });
  // A visit without a readable price keeps the remembered one.
  seen = inline.rememberVisit(seen, "10", 2000, null, "");
  assert.deepEqual(plain(seen), { 10: [1000, 2000, 1800, "EUR"] });
  seen = inline.rememberVisit(seen, "10", 3000, 1500, "EUR");
  assert.deepEqual(plain(seen), { 10: [1000, 3000, 1500, "EUR"] });

  seen = inline.rememberVisit(seen, "11", 3100, null, "", 2);
  seen = inline.rememberVisit(seen, "12", 3200, 900, "GBP", 2);
  assert.deepEqual(plain(Object.keys(seen).sort()), ["11", "12"]);

  assert.deepEqual(
    plain(
      inline.normalizeSeen({
        10: [1000, 3000, 1500, "EUR"],
        11: [500, 0, "12", "eur"],
        "0x": [1, 1, 1, "EUR"],
        12: "bad",
        13: [0, 0, null, ""],
      }),
    ),
    { 10: [1000, 3000, 1500, "EUR"], 11: [500, 500, null, ""] },
  );
});

const index = {
  monitors: [{ id: 4, name: "Nike Dunk under 40" }],
  finds: [
    ["100", 4, at("2026-11-12T10:00:00Z")],
    ["100", 9, at("2026-11-11T10:00:00Z")],
  ],
  watches: [
    {
      id: "7",
      itemId: "200",
      status: "active",
      initialPriceMinor: "2000",
      currentPriceMinor: "1500",
      currencyCode: "EUR",
    },
    {
      id: "8",
      itemId: "300",
      status: "paused",
      initialPriceMinor: null,
      currentPriceMinor: null,
      currencyCode: null,
    },
  ],
};
const baseContext = () => ({
  settings: companion.inline.normalizeSettings({
    mutedKeywords: "replica",
    highlightKeywords: "vintage",
  }),
  maps: inline.buildIndexMaps(index),
  seen: {},
  locale: "en-GB",
});

test("cards show monitor finds and Price Watches from the local index", () => {
  const context = baseContext();
  const found = inline.cardModel({ id: "100", text: "Nike Dunk", priceMinor: 1500 }, context);
  assert.deepEqual(
    plain(found.chips.map((chip) => [chip.kind, chip.label])),
    [["found", "Nike Dunk under 40"]],
  );
  assert.match(found.chips[0].title, /“Nike Dunk under 40”/);

  const watched = inline.cardModel({ id: "200", text: "Jacket", priceMinor: 1500 }, context);
  assert.deepEqual(
    plain(watched.chips.map((chip) => [chip.kind, chip.label])),
    [["drop", "Tracked ↓ €5.00"]],
  );
  assert.match(watched.chips[0].title, /started at €20\.00 · now €15\.00/);

  const paused = inline.cardModel({ id: "300", text: "Jacket", priceMinor: null }, context);
  assert.deepEqual(plain(paused.chips.map((chip) => chip.label)), ["Watch paused"]);

  // Titles name the state the server reported, or the status without one.
  assert.match(watched.chips[0].title, /^Vintrack Price Watch \(watching\)/);
  assert.match(paused.chips[0].title, /^Vintrack Price Watch \(paused\)/);

  const unknown = inline.cardModel({ id: "999", text: "Jacket", priceMinor: 100 }, context);
  assert.deepEqual(plain(unknown), { chips: [], muted: "", highlight: "", seen: false });
});

test("cards say when a watched listing was sold, removed or reserved", () => {
  const context = baseContext();
  const watch = (itemId, extra) => ({
    id: itemId,
    itemId,
    status: "active",
    initialPriceMinor: "2000",
    currentPriceMinor: "1500",
    currencyCode: "EUR",
    ...extra,
  });
  context.maps = inline.buildIndexMaps({
    monitors: [],
    finds: [],
    watches: [
      watch("1", { status: "stopped", stateKey: "sold", stateLabel: "Sold" }),
      watch("2", { status: "stopped", stateKey: "removed", stateLabel: "Removed" }),
      watch("3", { stateKey: "reserved", stateLabel: "Reserved" }),
      watch("4", { stateKey: "confirming", stateLabel: "Confirming" }),
      // An older server only knows the status.
      watch("5", { status: "stopped" }),
    ],
  });
  const chip = (id) => inline.cardModel({ id, text: "Coat", priceMinor: 1500 }, context).chips[0];

  assert.deepEqual([chip("1").kind, chip("1").label], ["ended", "Sold"]);
  assert.equal(
    chip("1").title,
    "Vintrack Price Watch ended: sold · started at €20.00 · last seen at €15.00",
  );
  assert.deepEqual([chip("2").kind, chip("2").label], ["ended", "Removed"]);
  // A reserved listing is still watched; its old drop is not advertised.
  assert.deepEqual([chip("3").kind, chip("3").label], ["watch", "Tracked · Reserved"]);
  assert.deepEqual([chip("4").kind, chip("4").label], ["drop", "Tracked ↓ €5.00"]);
  assert.deepEqual([chip("5").kind, chip("5").label], ["ended", "Stopped"]);

  const rows = inline.panelModel({ id: "1", previous: null, nowSeconds: 0 }, context);
  assert.equal(rows[0].kind, "ended");
  assert.equal(rows[0].value, "Sold · started at €20.00 · last seen at €15.00 (−25 %)");
  assert.equal(
    inline.panelModel({ id: "3", previous: null, nowSeconds: 0 }, context)[0].value,
    "Reserved · started at €20.00 · now €15.00 (−25 %)",
  );
});

test("cards flag seen listings, price drops and keywords", () => {
  const context = baseContext();
  context.seen = { 500: [at("2026-11-01T08:00:00Z"), at("2026-11-03T08:00:00Z"), 1800, "EUR"] };

  const dropped = inline.cardModel({ id: "500", text: "Coat", priceMinor: 1500 }, context);
  assert.equal(dropped.seen, true);
  assert.deepEqual(plain(dropped.chips.map((chip) => [chip.kind, chip.label])), [
    ["drop", "↓ was €18.00"],
  ]);

  const same = inline.cardModel({ id: "500", text: "Coat", priceMinor: 1800 }, context);
  assert.deepEqual(plain(same.chips.map((chip) => chip.label)), ["Seen"]);
  const dearer = inline.cardModel({ id: "500", text: "Coat", priceMinor: 2500 }, context);
  assert.deepEqual(plain(dearer.chips.map((chip) => chip.label)), ["Seen"]);

  // A watched listing that dropped reports the drop once, via the watch.
  context.seen[200] = [at("2026-11-01T08:00:00Z"), at("2026-11-03T08:00:00Z"), 2000, "EUR"];
  const watchedDrop = inline.cardModel({ id: "200", text: "Jacket", priceMinor: 1500 }, context);
  assert.equal(watchedDrop.seen, true);
  assert.deepEqual(plain(watchedDrop.chips.map((chip) => chip.label)), ["Tracked ↓ €5.00"]);

  const muted = inline.cardModel(
    { id: "1", text: "Vintage REPLICA coat", priceMinor: 100 },
    context,
  );
  assert.equal(muted.muted, "replica");
  assert.equal(muted.highlight, "", "a faded listing is not highlighted as well");
  assert.deepEqual(plain(muted.chips.map((chip) => chip.kind)), ["muted"]);

  const highlighted = inline.cardModel(
    { id: "2", text: "Vintage coat", priceMinor: 100 },
    context,
  );
  assert.equal(highlighted.highlight, "vintage");
  assert.deepEqual(plain(highlighted.chips.map((chip) => chip.label)), ["★ vintage"]);
});

test("each feature can be switched off, and popup-only mode shows nothing", () => {
  const context = baseContext();
  context.seen = { 100: [1000, 1000, 1800, "EUR"] };
  context.settings = companion.inline.normalizeSettings({ badges: false, seen: false });
  assert.deepEqual(
    plain(inline.cardModel({ id: "100", text: "Nike", priceMinor: 100 }, context).chips),
    [],
  );
  context.settings = null;
  assert.deepEqual(
    plain(inline.cardModel({ id: "100", text: "replica", priceMinor: 100 }, context)),
    { chips: [], muted: "", highlight: "", seen: false },
  );
  assert.deepEqual(plain(inline.panelModel({ id: "100" }, context)), []);
});

test("the item panel explains monitor, watch and price memory", () => {
  const context = baseContext();
  const now = at("2026-11-12T12:00:00Z");

  const found = inline.panelModel({ id: "100", previous: null, nowSeconds: now }, context);
  assert.equal(found.length, 1);
  assert.equal(found[0].label, "Found by your monitor");
  assert.match(found[0].value, /^Nike Dunk under 40 · /);
  assert.deepEqual(plain(found[0].action), {
    label: "Open monitor",
    destination: "monitor",
    id: 4,
  });

  const watched = inline.panelModel({ id: "200", previous: null, nowSeconds: now }, context);
  assert.equal(watched[0].kind, "drop");
  assert.equal(
    watched[0].value,
    "Active · started at €20.00 · now €15.00 (−25 %)",
  );
  assert.equal(watched[0].action.destination, "priceWatch");

  const previous = [at("2026-11-01T08:00:00Z"), at("2026-11-03T08:00:00Z"), 1800, "EUR"];
  const cheaper = inline.panelModel(
    { id: "900", previous, nowSeconds: now, priceMinor: 1500, currency: "EUR" },
    context,
  );
  assert.equal(cheaper[0].kind, "drop");
  assert.equal(cheaper[0].label, "Since your last look on 3 Nov");
  assert.equal(cheaper[0].value, "€18.00 → €15.00 (−€3.00)");

  const unchanged = inline.panelModel(
    { id: "900", previous, nowSeconds: now, priceMinor: 1800, currency: "EUR" },
    context,
  );
  assert.equal(unchanged[0].label, "You opened this before");
  assert.equal(unchanged[0].value, "First on 1 Nov · last on 3 Nov · price unchanged");

  // A reload a minute later is not worth a note, and a first visit has none.
  assert.deepEqual(
    plain(
      inline.panelModel(
        { id: "900", previous: [now - 60, now - 60, 1800, "EUR"], nowSeconds: now, priceMinor: 1800 },
        context,
      ),
    ),
    [],
  );
  assert.deepEqual(
    plain(inline.panelModel({ id: "900", previous: null, nowSeconds: now }, context)),
    [],
  );
});

test("toasts only cover finds newer than the cursor and never flood", () => {
  const now = Date.parse("2026-11-12T12:00:00Z");
  const item = (id, secondsAgo) => ({
    id,
    found_at: new Date(now - secondsAgo * 1000).toISOString(),
  });
  const items = [item("5", 10), item("4", 20), item("3", 30), item("2", 40), item("1", 3600)];

  // First run: remember the newest find, show nothing.
  const first = inline.selectToasts(items, 0, now);
  assert.deepEqual(plain(first), { cursor: now - 10_000, toasts: [] });

  const next = inline.selectToasts(items, now - 45_000, now);
  assert.equal(next.cursor, now - 10_000);
  assert.deepEqual(plain(next.toasts.map((toast) => toast.id)), ["3", "4", "5"]);

  // Finds that are already old when the browser wakes up are skipped.
  const stale = inline.selectToasts([item("9", 3600)], now - 7200_000, now);
  assert.deepEqual(plain(stale), { cursor: now - 3600_000, toasts: [] });

  assert.deepEqual(plain(inline.selectToasts([], 0, now)), { cursor: now, toasts: [] });
  assert.deepEqual(plain(inline.selectToasts([{ found_at: "nope" }], 5, now)), {
    cursor: 5,
    toasts: [],
  });
});

// ---- Background snapshots ---------------------------------------------------

const appOrigin = "https://vintrack.jakobaio.dev";
const backgroundSource = await readFile(
  new URL("../background.js", import.meta.url),
  "utf8",
);

function background(options = {}) {
  let now = Date.parse("2026-11-12T12:00:00Z");
  const storage = options.storage || {
    browserLinkToken: "0123456789abcdef0123456789abcdef",
    vintrackAppOrigin: appOrigin,
  };
  const requests = [];
  const listeners = {};
  const event = (name) => ({
    addListener(fn) {
      listeners[name] = fn;
    },
  });
  const api = {
    storage: {
      local: {
        async get(keys) {
          return Object.fromEntries(
            (typeof keys === "string" ? [keys] : keys)
              .filter((key) => key in storage)
              .map((key) => [key, plain(storage[key])]),
          );
        },
        async set(values) {
          Object.assign(storage, plain(values));
        },
        async remove(keys) {
          for (const key of typeof keys === "string" ? [keys] : keys) {
            delete storage[key];
          }
        },
      },
    },
    cookies: { onChanged: event("cookie") },
    tabs: {
      async query() {
        return [];
      },
      onActivated: event("activated"),
      onUpdated: event("updated"),
    },
    alarms: { create() {}, onAlarm: event("alarm") },
    runtime: {
      getManifest: () => ({
        version: "0.4.3",
        content_scripts: [{ matches: [`${appOrigin}/*`] }],
      }),
      getURL: (path) => `chrome-extension://synthetic-own${path}`,
      onStartup: event("startup"),
      onInstalled: event("installed"),
      onMessage: event("message"),
    },
  };
  const context = vm.createContext({
    chrome: api,
    URL,
    AbortController,
    console,
    navigator: { userAgent: "Synthetic test browser" },
    Date: class extends Date {
      static now() {
        return now;
      }
    },
    setTimeout,
    clearTimeout,
    fetch: async (url, init = {}) => {
      requests.push({ url, authorization: init.headers?.Authorization });
      const reply = options.respond(url, requests.length);
      return new Response(JSON.stringify(reply.body ?? {}), {
        status: reply.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  vm.runInContext(backgroundSource, context, { filename: "background.js" });
  return {
    storage,
    requests,
    advance(ms) {
      now += ms;
    },
    send(type, sender = { url: "https://www.vinted.de/catalog", tab: { id: 1 } }) {
      return new Promise((resolveResponse) =>
        listeners.message({ type }, sender, (value) =>
          resolveResponse(plain(value)),
        ),
      );
    },
  };
}

const serverIndex = {
  generatedAt: "2026-11-12T12:00:00.000Z",
  monitors: [{ id: 4, name: "Nike Dunk under 40" }, { id: "x", name: "bad" }],
  finds: [
    ["100", 4, 1762941600],
    ["<img>", 4, 1],
    ["101", "4", 1],
    "nope",
  ],
  watches: [
    {
      id: "7",
      itemId: "200",
      status: "active",
      stateKey: "sold",
      stateLabel: "Sold",
      availability: "available",
      initialPriceMinor: "2000",
      currentPriceMinor: "15.5",
      currencyCode: "eur",
    },
    { id: "9", itemId: "300", stateKey: "<b>sold</b>", stateLabel: "x".repeat(80) },
    { id: "8", itemId: "javascript:alert(1)" },
  ],
};
const cleanIndex = {
  monitors: [{ id: 4, name: "Nike Dunk under 40" }],
  finds: [["100", 4, 1762941600]],
  watches: [
    {
      id: "7",
      itemId: "200",
      status: "active",
      stateKey: "sold",
      stateLabel: "Sold",
      availability: "available",
      initialPriceMinor: "2000",
      currentPriceMinor: null,
      currencyCode: null,
    },
    {
      id: "9",
      itemId: "300",
      status: "",
      stateKey: "",
      stateLabel: "x".repeat(30),
      availability: "",
      initialPriceMinor: null,
      currentPriceMinor: null,
      currencyCode: null,
    },
  ],
};

test("the background shares one sanitized index per minute and survives failures", async () => {
  let failing = 0;
  const h = background({
    respond: () =>
      failing ? { status: failing, body: { error: "down" } } : { body: serverIndex },
  });

  const first = await h.send("VINTRACK_INLINE_INDEX");
  assert.deepEqual(first, { ok: true, configured: true, index: cleanIndex });
  assert.deepEqual(h.requests, [
    {
      url: `${appOrigin}/api/extension/inline-index`,
      authorization: "Bearer 0123456789abcdef0123456789abcdef",
    },
  ]);

  // Other tabs and later passes reuse the stored snapshot.
  await Promise.all([h.send("VINTRACK_INLINE_INDEX"), h.send("VINTRACK_INLINE_INDEX")]);
  h.advance(59_000);
  await h.send("VINTRACK_INLINE_INDEX");
  assert.equal(h.requests.length, 1);

  // A failed refresh keeps the last good snapshot and backs off.
  h.advance(2_000);
  failing = 500;
  assert.deepEqual(await h.send("VINTRACK_INLINE_INDEX"), first);
  assert.equal(h.requests.length, 2);
  h.advance(119_000);
  assert.deepEqual(await h.send("VINTRACK_INLINE_INDEX"), first);
  assert.equal(h.requests.length, 2);

  // A rejected link must stop showing the previous member's data.
  h.advance(2_000);
  failing = 401;
  const rejected = await h.send("VINTRACK_INLINE_INDEX");
  assert.equal(rejected.ok, false);
  assert.equal(rejected.index, undefined);
  assert.equal(h.storage.vintrackInlineIndex.index, null);
});

test("inline snapshots are only served to the extension and Vinted tabs", async () => {
  const h = background({ respond: () => ({ body: serverIndex }) });
  for (const type of ["VINTRACK_INLINE_INDEX", "VINTRACK_INLINE_FEED"]) {
    for (const url of ["https://example.com/", "https://evilvinted.de/catalog", appOrigin]) {
      assert.deepEqual(await h.send(type, { url, tab: { id: 2, url } }), {
        ok: false,
        error: "Unauthorized extension sender",
      });
    }
  }
  assert.equal(h.requests.length, 0);

  const unlinked = background({ storage: {}, respond: () => ({ body: serverIndex }) });
  assert.deepEqual(await unlinked.send("VINTRACK_INLINE_INDEX"), {
    ok: true,
    configured: false,
    index: null,
  });
  assert.deepEqual(await unlinked.send("VINTRACK_INLINE_FEED"), {
    ok: true,
    configured: false,
    items: [],
  });
  assert.equal(unlinked.requests.length, 0);
});

test("toast polling from several tabs shares one feed request per window", async () => {
  let unavailable = false;
  const h = background({
    respond: () =>
      unavailable
        ? { status: 403, body: { code: "FEATURE_UNAVAILABLE" } }
        : { body: { items: [{ id: "1" }], updatedAt: "now" } },
  });
  const [left, right] = await Promise.all([
    h.send("VINTRACK_INLINE_FEED"),
    h.send("VINTRACK_INLINE_FEED"),
  ]);
  assert.deepEqual(left, { ok: true, configured: true, items: [{ id: "1" }] });
  assert.deepEqual(right, left);
  h.advance(14_000);
  await h.send("VINTRACK_INLINE_FEED");
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].url, `${appOrigin}/api/extension/feed`);

  h.advance(2_000);
  unavailable = true;
  const denied = await h.send("VINTRACK_INLINE_FEED");
  assert.equal(denied.ok, false);
  assert.equal(denied.status, 403);
  assert.equal(h.requests.length, 2);
});

test("clearing extension state removes inline history, settings and snapshots", async () => {
  const h = background({
    storage: {
      browserLinkToken: "0123456789abcdef0123456789abcdef",
      vintrackAppOrigin: appOrigin,
      vintrackInlineIndex: { fetchedAt: 1, index: cleanIndex },
      vintrackInlineSettings: { toasts: false },
      vintrackInlineSeen: { 100: [1, 1, 1500, "EUR"] },
      vintrackInlineToastCursor: 5,
    },
    respond: () => ({ body: {} }),
  });
  // Only an extension page may clear state; a web page cannot.
  const refused = await h.send("VINTRACK_EXTENSION_CLEAR_LOCAL_STATE", {
    url: `${appOrigin}/account`,
  });
  assert.equal(refused.ok, false);
  assert.ok("vintrackInlineSeen" in h.storage);

  const result = await h.send("VINTRACK_EXTENSION_CLEAR_LOCAL_STATE", {
    url: "chrome-extension://synthetic-own/popup.html",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(h.storage, {});
});
