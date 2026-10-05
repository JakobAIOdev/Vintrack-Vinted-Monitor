import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";
import test from "node:test";
import vm from "node:vm";

const bridgeSource = await readFile(
  new URL("../page-bridge.js", import.meta.url),
  "utf8",
);
const backgroundSource = await readFile(
  new URL("../background.js", import.meta.url),
  "utf8",
);
const domain = "www.vinted.de";
const target = { itemId: 123, sellerId: 456, expectedAccountId: 42, domain };
const checkoutUrl = `https://${domain}/checkout?purchase_id=synthetic&order_id=77&order_type=transaction`;

function bridge(accountId = 42, checkoutResponses = [], buildResponse = {}) {
  const requests = [];
  const window = {
    location: {
      origin: `https://${domain}`,
      hostname: domain,
      href: `https://${domain}/items/123`,
    },
    localStorage: { length: 0 },
    sessionStorage: { length: 0 },
    addEventListener() {},
    postMessage() {},
    setTimeout: (fn) => setTimeout(fn, 0),
  };
  const context = vm.createContext({
    window,
    document: {
      readyState: "complete",
      cookie: "",
      scripts: [],
      querySelector: () => null,
      documentElement: { innerHTML: "" },
    },
    navigator: { language: "de-DE" },
    Headers,
    URL,
    crypto: webcrypto,
    setTimeout,
    clearTimeout,
    fetch: async (url, init) => {
      requests.push({ url, init });
      const data =
        init.method === "GET"
          ? { user: { id: accountId } }
          : url.endsWith("/conversations")
            ? { conversation: { transaction: { id: 77 } } }
            : url.endsWith("/build")
              ? {
                  purchase: { id: "synthetic" },
                  checksum: "synthetic-checksum",
                  ...buildResponse,
                }
              : checkoutResponses.shift() || {};
      return new Response(JSON.stringify(data), { status: 200 });
    },
  });
  vm.runInContext(
    bridgeSource.replace(
      '  window.addEventListener("message",',
      '  window.testCheckout = runBrowserBuy;\n  window.addEventListener("message",',
    ),
    context,
  );
  return { requests, run: (payload) => window.testCheckout(payload) };
}

test("page checkout uses the linked account and stops before payment", async () => {
  const h = bridge();
  const result = await h.run(target);
  assert.equal(result.ok, true);
  assert.equal(result.checkoutUrl, checkoutUrl);
  assert.equal(result.incogniaRequestToken, undefined);
  assert.equal(result.checksum, undefined);
  assert.deepEqual(
    h.requests.map(({ init }) => init.method),
    ["GET", "POST", "POST", "PUT"],
  );
  assert.ok(h.requests.every(({ url }) => !url.includes("/payment")));
  const components = JSON.parse(h.requests[3].init.body).components;
  for (const field of [
    "payment_method",
    "shipping_address",
    "shipping_pickup_options",
    "shipping_pickup_details",
  ])
    assert.deepEqual(components[field], {});
});

function selectedCheckout(paypalAvailable = true, paymentSelected = false) {
  return { checkout: { components: {
    payment_method: {
      pay_in_methods: paypalAvailable ? [{ code: "MANGOPAY_PAYPAL" }] : [],
      selected_payment_method: paymentSelected ? { pay_in_method: { payment_method: "paypal" } } : null,
    },
    shipping_address: { address: { id: 55 } },
    shipping_pickup_options: { selected_pickup_option: 1 },
    shipping_pickup_details: { pickup_details: { selected_rate_uuid: "synthetic-rate" } },
    pay_button_v2: { payments_available: true },
  } } };
}

test("home delivery and available PayPal are selected without paying", async () => {
  const h = bridge(42, [selectedCheckout(), selectedCheckout(true, true)]);
  const result = await h.run({ ...target, preferences: { shipping: "home", payment: "paypal" } });
  assert.equal(result.status, "checkout_prepared");
  assert.equal(h.requests.length, 5);
  assert.deepEqual(JSON.parse(h.requests[3].init.body).components.shipping_pickup_options, { pickup_type: 1 });
  assert.deepEqual(JSON.parse(h.requests[4].init.body).components.payment_method, { card_id: null, payment_method: "paypal" });
  assert.ok(h.requests.every(({ url }) => !url.includes("/payment")));
});

test("PayPal offered by build is selected with delivery in one update", async () => {
  const h = bridge(42, [selectedCheckout(true, true)], selectedCheckout());
  const result = await h.run({ ...target, preferences: { shipping: "home", payment: "paypal" } });
  assert.equal(result.status, "checkout_prepared");
  assert.deepEqual(h.requests.map(({ init }) => init.method), ["GET", "POST", "POST", "PUT"]);
  const components = JSON.parse(h.requests[3].init.body).components;
  assert.deepEqual(components.payment_method, { card_id: null, payment_method: "paypal" });
  assert.deepEqual(components.shipping_pickup_options, { pickup_type: 1 });
});

test("already selected PayPal does not cause another checkout update", async () => {
  const h = bridge(42, [selectedCheckout(true, true)]);
  const result = await h.run({ ...target, preferences: { shipping: "home", payment: "paypal" } });
  assert.equal(result.status, "checkout_prepared");
  assert.equal(h.requests.length, 4);
});

test("wallet and unavailable PayPal never select a substitute payment method", async () => {
  for (const payment of ["wallet", "paypal"]) {
    const h = bridge(42, [selectedCheckout(false)]);
    const result = await h.run({ ...target, preferences: { shipping: "home", payment } });
    assert.equal(result.status, "checkout_review_required");
    assert.equal(h.requests.length, 4);
    assert.deepEqual(JSON.parse(h.requests[3].init.body).components.payment_method, {});
  }
});

test("invalid checkout preferences fail before any account request", async () => {
  const h = bridge();
  const result = await h.run({ ...target, preferences: { shipping: "home", payment: "arbitrary", token: "synthetic" } });
  assert.equal(result.code, "invalid_checkout_preferences");
  assert.equal(h.requests.length, 0);
});

test("regional provider preferences use the offered native method without paying", async () => {
  for (const provider of ["google_pay", "klarna", "tink", "bancontact", "ideal", "blik", "przelewy24", "card"]) {
    const offered = selectedCheckout(false);
    const native = provider === "card" ? "credit_card" : provider === "bancontact" ? "provider_bancontact" : provider;
    const method = { code: provider.toUpperCase(), payment_method: native };
    offered.checkout.components.payment_method.pay_in_methods = [method];
    if (provider === "card") offered.checkout.components.payment_method.cards = [{ id: 55 }];
    const selected = structuredClone(offered);
    selected.checkout.components.payment_method.selected_payment_method = { pay_in_method: method, ...(provider === "card" ? { card_id: 55 } : {}) };
    const h = bridge(42, [selected], offered);
    const result = await h.run({ ...target, preferences: { shipping: "home", payment: provider } });
    assert.equal(result.status, "checkout_prepared", provider);
    assert.equal(h.requests.length, 4);
    assert.deepEqual(JSON.parse(h.requests[3].init.body).components.payment_method, { card_id: provider === "card" ? 55 : null, payment_method: native });
    assert.ok(h.requests.every(({ url }) => !url.includes("/payment")));
  }
});

test("unavailable providers, disabled methods and ambiguous cards stay for review", async () => {
  for (const [provider, methods, cards] of [
    ["google_pay", [{ code: "MANGOPAY_PAYPAL" }], []],
    ["google_pay", [{ payment_method: "google_pay", read_only: true }], []],
    ["card", [{ payment_method: "card" }], []],
    ["card", [{ payment_method: "card" }], [{ id: 55 }, { id: 56 }]],
    ["klarna", [{ code: "KLARNA", payment_method: "klarna_now" }, { code: "KLARNA", payment_method: "klarna_later" }], []],
    ["ideal", [{ code: "IDEAL", payment_method: "https://evil.test" }], []],
  ]) {
    const response = selectedCheckout(false);
    response.checkout.components.payment_method.pay_in_methods = methods;
    response.checkout.components.payment_method.cards = cards;
    const h = bridge(42, [response], response);
    const result = await h.run({ ...target, preferences: { shipping: "home", payment: provider } });
    assert.equal(result.status, "checkout_review_required");
    assert.equal(h.requests.length, 4);
    assert.deepEqual(JSON.parse(h.requests[3].init.body).components.payment_method, {});
  }
});

test("page checkout rejects a different logged-in account before mutation", async () => {
  const h = bridge(99);
  const result = await h.run(target);
  assert.equal(result.code, "checkout_account_mismatch");
  assert.deepEqual(
    h.requests.map(({ init }) => init.method),
    ["GET"],
  );
});

function background(options = {}) {
  const storage = options.storage || {};
  const mutations = [];
  const messages = [];
  const event = { addListener() {}, removeListener() {} };
  const chrome = {
    storage: {
      local: {
        async get(key) {
          return { [key]: structuredClone(storage[key]) };
        },
        async set(values) {
          Object.assign(storage, structuredClone(values));
        },
      },
    },
    runtime: {
      getManifest: () => ({ version: "synthetic", content_scripts: [] }),
      onStartup: event,
      onInstalled: event,
      onMessage: event,
    },
    cookies: { onChanged: event },
    alarms: { onAlarm: event },
    tabs: {
      onActivated: event,
      onUpdated: event,
      async query() { return options.tabs || []; },
      async update(id, changes) {
        mutations.push({ id, changes });
      },
      async sendMessage(_id, message) {
        messages.push(message);
        if (message.type === "VINTRACK_TAB_PING") return { ok: true };
        if (message.type === "VINTRACK_GET_BROWSER_ACCOUNT")
          return { ok: true, accountId: options.accountId || 42 };
        if (options.run) return options.run(message.payload);
        if (options.accountId && options.accountId !== 42)
          return { ok: false, code: "checkout_account_mismatch" };
        return {
          ok: true,
          checkoutUrl,
          transactionId: 77,
          purchaseId: "synthetic",
        };
      },
    },
  };
  const context = vm.createContext({
    chrome,
    URL,
    crypto: webcrypto,
    console,
    setTimeout,
    clearTimeout,
  });
  vm.runInContext(backgroundSource, context);
  if (!options.tabs) context.ensureVintedBuyTab = async () => ({ tabId: 1, created: false });
  return {
    storage,
    mutations,
    messages,
    run: (payload = target) => context.handleBrowserBuy(payload),
  };
}

test("concurrent clicks and repeated clicks reuse a single browser checkout", async () => {
  const h = background();
  const [a, b] = await Promise.all([
    h.run({ ...target, requestId: "a" }),
    h.run({ ...target, requestId: "b" }),
  ]);
  assert.equal(a.requestId, "a");
  assert.equal(b.requestId, "b");
  assert.equal(a.checkoutUrl, checkoutUrl);
  assert.equal(h.messages.filter((msg) => msg.type === "VINTRACK_GET_BROWSER_ACCOUNT").length, 0);
  const c = await h.run();
  assert.equal(c.checkoutUrl, checkoutUrl);
  assert.equal(h.messages.filter((msg) => msg.type === "VINTRACK_GET_BROWSER_ACCOUNT").length, 1);
  assert.equal(
    h.messages.filter((msg) => msg.type === "VINTRACK_RUN_BROWSER_BUY").length,
    1,
  );
});

test("lost responses survive extension restart without replay or cross-region fallback", async () => {
  const h = background({
    run: () => {
      throw new Error("response lost");
    },
  });
  const first = await h.run({ ...target, requestId: "first" });
  assert.equal(first.ok, false);
  assert.equal(first.requestId, "first");
  const restarted = background({ storage: h.storage });
  const result = await restarted.run({
    ...target,
    itemUrl: "https://www.vinted.fr/items/123",
  });
  assert.equal(result.code, "checkout_uncertain");
  assert.equal(
    restarted.messages.filter((msg) => msg.type === "VINTRACK_RUN_BROWSER_BUY")
      .length,
    0,
  );
});

test("browser account mismatch and hostile URLs never open a checkout", async () => {
  const mismatch = background({ accountId: 99 });
  assert.equal((await mismatch.run()).code, "checkout_account_mismatch");
  assert.equal(
    mismatch.messages.filter((msg) => msg.type === "VINTRACK_RUN_BROWSER_BUY")
      .length,
    1,
  );
  assert.equal(mismatch.storage.vintrackCheckoutAttempts.length, 0);
  assert.ok(mismatch.mutations.every(({ changes }) => !changes.url));
  const hostile = background({
    run: () => ({ ok: true, checkoutUrl: "https://evil.test/checkout" }),
  });
  assert.equal((await hostile.run()).code, "invalid_checkout_url");
  assert.ok(hostile.mutations.every(({ changes }) => !changes.url));
});

test("an existing same-region page runs requests without loading the item", async () => {
  const h = background({ tabs: [
    { id: 2, status: "loading", url: `https://${domain}/catalog` },
    { id: 1, status: "complete", url: `https://${domain}/member/42` },
  ] });
  assert.equal((await h.run()).ok, true);
  assert.equal(h.mutations.length, 1);
  assert.equal(h.mutations[0].changes.url, checkoutUrl);
  assert.equal(h.mutations[0].id, 1);
});

test("cached checkout checks the browser account before navigating", async () => {
  const first = background();
  await first.run();
  const changed = background({ storage: first.storage, accountId: 99 });
  assert.equal((await changed.run()).code, "checkout_account_mismatch");
  assert.ok(changed.mutations.every(({ changes }) => !changes.url));
});

test("parallel preparations for different items preserve all intent checkpoints", async () => {
  const h = background();
  await Promise.all([h.run(target), h.run({ ...target, itemId: 124 })]);
  const attempts = h.storage.vintrackCheckoutAttempts;
  assert.equal(attempts.length, 2);
  assert.deepEqual(
    attempts.map((attempt) => attempt.itemId).sort(),
    [123, 124],
  );
});
