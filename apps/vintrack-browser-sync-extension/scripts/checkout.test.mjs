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
const contentSource = await readFile(new URL("../content-script.js", import.meta.url), "utf8");
const domain = "www.vinted.de";
const target = { itemId: 123, sellerId: 456, expectedAccountId: 42, domain };
const checkoutUrl = `https://${domain}/checkout?purchase_id=synthetic&order_id=77&order_type=transaction`;

test("content bridge remembers readiness when Vinted replaces root attributes", () => {
  let receive;
  let injected;
  const root = { dataset: {} };
  const window = { location: { origin: `https://${domain}`, hostname: domain }, addEventListener() {} };
  const document = { documentElement: root, head: { appendChild(script) { injected = script; } }, createElement() { return { dataset: {}, remove() {} }; } };
  const context = vm.createContext({ window, document, MutationObserver: class { observe() {} }, chrome: { runtime: { getURL: path => `chrome-extension://synthetic/${path}`, sendMessage: () => new Promise(() => {}), onMessage: { addListener(listener) { receive = listener; } } } } });
  vm.runInContext(contentSource, context);
  let response;
  receive({ type: "VINTRACK_TAB_PING" }, {}, value => { response = value; });
  assert.equal(response.pageBridgeReady, false);
  injected.onload();
  root.dataset = {};
  receive({ type: "VINTRACK_TAB_PING" }, {}, value => { response = value; });
  assert.equal(response.pageBridgeReady, true);
});

test("content bridge preserves checkout request IDs on synchronous, asynchronous and empty runtime failures", async () => {
  for (const failure of [() => { throw new Error("synthetic private context"); }, () => Promise.reject(new Error("synthetic private context")), () => undefined, () => ({ ok: false, error: "Unauthorized extension sender" })]) {
    const listeners = {};
    const posts = [];
    const window = { location: { origin: "http://localhost:3000", hostname: "localhost" }, addEventListener(type, listener) { listeners[type] = listener; }, postMessage(message) { posts.push(message); } };
    const context = vm.createContext({ window, document: { documentElement: { dataset: { vintrackThemeBridge: "ready" } } }, chrome: { runtime: { sendMessage(message) { return message.type === "VINTRACK_EXTENSION_BUY" ? failure() : { installed: true }; }, onMessage: { addListener() {} } } }, crypto: webcrypto });
    vm.runInContext(contentSource, context);
    listeners.message({ source: window, data: { type: "VINTRACK_EXTENSION_BUY", payload: { requestId: "synthetic-request" } } });
    await new Promise(resolve => setImmediate(resolve));
    const result = posts.find(message => message.type === "VINTRACK_EXTENSION_BUY_RESULT").payload;
    assert.equal(result.requestId, "synthetic-request");
    assert.equal(result.ok, false);
    assert.ok(!result.error?.includes("synthetic private"));
  }
});

function bridge(accountId = 42, checkoutResponses = [], buildResponse = {}, paymentResponse = {}, pageState = "complete") {
  const requests = [];
  const documentListeners = {};
  const document = {
    readyState: pageState,
    cookie: "",
    scripts: [],
    querySelector: () => null,
    documentElement: { innerHTML: "" },
    addEventListener(type, handler) { documentListeners[type] = handler; },
    removeEventListener(type) { delete documentListeners[type]; },
  };
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
    clearTimeout,
  };
  const context = vm.createContext({
    window,
    document,
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
          : url.endsWith("/payment")
            ? (typeof paymentResponse === "function" ? paymentResponse() : paymentResponse)
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
  return { requests, run: (payload) => window.testCheckout(payload), parsed() { document.readyState = "interactive"; documentListeners.DOMContentLoaded?.(); } };
}

test("checkout starts after HTML parsing without waiting for the page load event", async () => {
  const h = bridge(42, [], {}, {}, "loading");
  const checkout = h.run(target);
  assert.equal(h.requests.length, 0);
  h.parsed();
  const result = await checkout;
  assert.equal(result.ok, true);
  assert.deepEqual(h.requests.map(({ init })=>init.method), ["GET", "POST", "POST", "PUT"]);
  assert.ok(Object.values(result.timings).every(value=>Number.isFinite(value) && value >= 0));
});

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

const autoSetting = { warningVersion: 1, currency: "EUR", maxTotalMinor: 3000 };
const autoTarget = { ...target, preferences: { shipping: "home", payment: "paypal", autoCheckout: autoSetting } };
const syntheticPayPalUrl = "https://www.paypal.com/checkoutnow?token=synthetic";

function autoQuote() {
  const data = selectedCheckout(true, true);
  data.checksum = "synthetic-current-checksum";
  data.checkout.components.pay_button_v2.total = { price: { amount: "18.29", currency_code: "EUR" } };
  data.checkout.components.order_summary_v2 = { deductions: [] };
  return data;
}

test("opted-in PayPal starts once using the final quote and returns only a verified redirect", async () => {
  const h = bridge(42, [autoQuote()], selectedCheckout(), { action: { type: "redirect", parameters: { url: syntheticPayPalUrl } } });
  const result = await h.run(autoTarget);
  assert.equal(result.status, "paypal_redirect_ready");
  assert.equal(result.paymentUrl, syntheticPayPalUrl);
  assert.equal(h.requests.length, 5);
  const request = h.requests[4];
  assert.ok(request.url.endsWith("/checkout/payment"));
  assert.equal(request.init.redirect,"error");
  assert.equal(JSON.parse(request.init.body).checksum,"synthetic-current-checksum");
  assert.equal(result.checksum,undefined);
});

test("auto-checkout stops for wallet deductions, unknown quotes and exceeded limits", async () => {
  const changes = [
    data => { data.checkout.components.order_summary_v2.deductions = [{ type: "order-summary-wallet-deduction", price: { amount: "1.00", currency_code: "EUR" } }]; },
    data => { delete data.checkout.components.order_summary_v2.deductions; },
    data => { delete data.checkout.components.pay_button_v2.total; },
    data => { data.checkout.components.pay_button_v2.total.price.amount = "0"; },
    data => { data.checkout.components.pay_button_v2.total.price.amount = "30.01"; },
    data => { data.checkout.components.pay_button_v2.total.price.amount = "18.291"; },
    data => { data.checkout.components.pay_button_v2.total.price.currency_code = "USD"; },
    data => { data.checkout.components.order_summary_v2.currency_conversion = {}; },
    data => { delete data.checksum; },
    data => { data.checkout.components.payment_method.selected_payment_method.pay_in_method.payment_method = "card"; },
    data => { data.checkout.components.payment_method.pay_in_methods = [{payment_method:"paypal",enabled:false}]; },
  ];
  for (const change of changes) {
    const data = autoQuote(); change(data);
    const h = bridge(42,[data],selectedCheckout());
    const result = await h.run(autoTarget);
    assert.equal(result.status,"checkout_review_required");
    assert.ok(h.requests.every(r=>!r.url.includes("/payment")));
    assert.equal(result.paymentUrl,undefined);
  }
});

test("unknown payment outcomes and hostile redirects never trigger retries or expose raw responses", async () => {
  for (const response of [
    () => { throw new Error("response lost"); },
    { payment: { status: "success" } },
    { action: { type: "redirect", parameters: { url: "https://www.paypal.com.evil.test/checkoutnow" } } },
    { action: { type: "sca_required", parameters: { url: syntheticPayPalUrl } } },
  ]) {
    const h = bridge(42,[autoQuote()],selectedCheckout(),response);
    const result = await h.run(autoTarget);
    assert.equal(result.status,"payment_outcome_unknown");
    assert.equal(result.paymentUrl,undefined);
    assert.equal(result.raw,undefined);
    assert.equal(h.requests.filter(r=>r.url.endsWith("/payment")).length,1);
  }
});

test("invalid auto-checkout consent and limits fail before account lookup", async () => {
  for(const setting of [null, {...autoSetting,warningVersion:0}, {...autoSetting,maxTotalMinor:0}, {...autoSetting,currency:"USD"}, {...autoSetting,force:true}]) {
    const h=bridge();
    assert.equal((await h.run({...autoTarget,preferences:{...autoTarget.preferences,autoCheckout:setting}})).code,"invalid_checkout_preferences");
    assert.equal(h.requests.length,0);
  }
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
      async create(changes) { mutations.push({ created: true, changes }); return { id: 10, status: "loading" }; },
      async get() { throw new Error("waiting for full page load is unnecessary"); },
      async update(id, changes) {
        if (options.updateError) throw new Error("synthetic private navigation error");
        mutations.push({ id, changes });
      },
      async sendMessage(_id, message) {
        messages.push(message);
        if (options.ping && message.type === "VINTRACK_TAB_PING") return options.ping(_id, message);
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

test("disconnected complete tabs fail immediately without a checkout checkpoint or replay", async () => {
  const h = background({ tabs: [{ id: 1, status: "complete" }], ping: () => { throw new Error("synthetic connection unavailable"); } });
  const result = await h.run(autoTarget);
  assert.equal(result.code, "checkout_tab_reload_required");
  assert.ok(!h.storage.vintrackCheckoutAttempts);
  assert.ok(h.messages.every(m => m.type === "VINTRACK_TAB_PING"));
  assert.equal(h.mutations.length, 0);
  assert.ok(!result.error.includes("synthetic"));
});

test("readiness checks are local and do not consume a checkout attempt", async () => {
  const h = background();
  const result = await h.run({ ...autoTarget, readinessOnly: true });
  assert.equal(result.ready, true);
  assert.equal(h.messages.length, 0);
  assert.equal(h.mutations.length, 0);
  assert.ok(!h.storage.vintrackCheckoutAttempts);
});

test("a cold checkout starts as soon as the bridge attaches, before page load completes", async () => {
  const h = background({ tabs: [] });
  assert.equal((await h.run()).ok, true);
  assert.equal(h.mutations[0].created, true);
  assert.equal(h.mutations.at(-1).changes.url, checkoutUrl);
  assert.equal(h.messages.filter(m=>m.type==="VINTRACK_RUN_BROWSER_BUY").length, 1);
});

test("a stale tab does not block a ready same-region receiver", async () => {
  const h = background({ tabs: [{ id: 2, status: "complete", active: true }, { id: 1, status: "complete" }], ping: id => {
    if (id === 2) throw new Error("receiver disconnected");
    return { ok: true };
  } });
  assert.equal((await h.run()).ok, true);
  assert.equal(h.mutations.at(-1).id, 1);
  assert.equal(h.messages.filter(m=>m.type==="VINTRACK_RUN_BROWSER_BUY").length, 1);
});

test("a content receiver without a page bridge cannot consume auto-checkout readiness", async () => {
  const h = background({ tabs: [{ id: 1, status: "complete" }], ping: () => ({ ok: true, pageBridgeReady: false }) });
  const result = await h.run({ ...autoTarget, readinessOnly: true });
  assert.equal(result.code, "checkout_tab_reload_required");
  assert.equal(h.messages.length, 1);
  assert.ok(!h.storage.vintrackCheckoutAttempts);
});

test("navigation failures identify the failed stage and retain the completed checkpoint", async () => {
  const h = background({ updateError: true });
  const result = await h.run();
  assert.equal(result.code, "checkout_navigation_failed");
  assert.equal(h.storage.vintrackCheckoutAttempts[0].checkoutUrl, checkoutUrl);
  assert.ok(!result.error.includes("synthetic private"));
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

test("auto-checkout navigates to PayPal without persisting redirect tokens or replaying after cache expiry", async () => {
  let starts=0;
  const h=background({run:()=>{starts++;return {ok:true,checkoutUrl,transactionId:77,purchaseId:"synthetic",status:"paypal_redirect_ready",paymentUrl:syntheticPayPalUrl};}});
  const result=await h.run(autoTarget);
  assert.equal(result.paymentUrl,syntheticPayPalUrl);
  assert.equal(h.mutations.at(-1).changes.url,syntheticPayPalUrl);
  assert.ok(!JSON.stringify(h.storage).includes("token=synthetic"));
  h.storage.vintrackCheckoutAttempts[0].startedAt=Date.now()-86400000;
  const restarted=background({storage:h.storage});
  const repeated=await restarted.run(autoTarget);
  assert.equal(repeated.status,"checkout_review_required");
  assert.equal(repeated.paymentUrl,undefined);
  assert.equal(restarted.mutations.at(-1).changes.url,checkoutUrl);
  assert.equal(restarted.messages.filter(m=>m.type==="VINTRACK_RUN_BROWSER_BUY").length,0);
  assert.equal(starts,1);
});

const cardAutoTarget = { ...target, preferences: { shipping: "home", payment: "card", autoCheckout: { ...autoSetting, warningVersion: 2 } } };
function cardAutoQuote() {
  const quote = autoQuote();
  const payment = quote.checkout.components.payment_method;
  const method = { payment_method: "credit_card", enabled: true };
  payment.pay_in_methods = [method];
  payment.cards = [{ id: "synthetic-card", expired: false }];
  payment.selected_payment_method = { pay_in_method: method, credit_card: { external_code: "synthetic-card", expired: false } };
  return quote;
}
function cardBuild() {
  const build = cardAutoQuote();
  build.checkout.components.payment_method.selected_payment_method = null;
  return build;
}

test("card auto-checkout submits once with native saved-card references and resumes Vinted payment", async () => {
  for (const [response, status] of [
    [{ payment: { status: "success" } }, "card_payment_confirmed"],
    [{ payment: { status: "pending" } }, "card_payment_pending"],
    [{ payment: { status: "failure" } }, "card_payment_failed"],
    [{ payment: { status: "success" }, action: { type: "native_adyen_payment_3ds", parameters: { token: "synthetic-private-bank-data" } } }, "card_authentication_required"],
    [{ action: { type: "payrails_cvv_resubmission" } }, "card_authentication_required"],
    [{ action: { type: "redirect", parameters: { url: "https://evil.test/secret" } } }, "card_authentication_required"],
    [{ payment: { status: "unrecognized" } }, "payment_outcome_unknown"],
    [{ payment: { status: "success" }, errors: [] }, "payment_outcome_unknown"],
    [{ payment: { status: "success" }, action: {} }, "payment_outcome_unknown"],
    [() => { throw new Error("response lost"); }, "payment_outcome_unknown"],
  ]) {
    const h = bridge(42, [cardAutoQuote()], cardBuild(), response);
    const result = await h.run(cardAutoTarget);
    assert.equal(result.status, status);
    assert.equal(h.requests.length, 5);
    assert.equal(JSON.parse(h.requests[3].init.body).components.payment_method.card_id, "synthetic-card");
    assert.equal(JSON.parse(h.requests[4].init.body).checksum, "synthetic-current-checksum");
    assert.equal(h.requests[4].init.redirect, "error");
    assert.equal(new URL(result.checkoutUrl).searchParams.get("after_payment_redirect"), "true");
    assert.equal(result.paymentUrl, undefined);
    assert.ok(!JSON.stringify(result).includes("synthetic-private-bank-data"));
    assert.ok(!JSON.stringify(result).includes("evil.test"));
  }
});

test("card auto-checkout rejects old PayPal consent before requests and unsafe card quotes before payment", async () => {
  for (const warningVersion of [0, 1, 3]) {
    const h = bridge();
    const preferences = { ...cardAutoTarget.preferences, autoCheckout: { ...autoSetting, warningVersion } };
    assert.equal((await h.run({ ...target, preferences })).code, "invalid_checkout_preferences");
    assert.equal(h.requests.length, 0);
    const bg = background();
    assert.equal((await bg.run({ ...target, preferences })).code, "invalid_buy_payload");
    assert.equal(bg.messages.length, 0);
  }
  for (const change of [
    data => { data.checkout.components.payment_method.selected_payment_method.credit_card.expired = true; },
    data => { data.checkout.components.payment_method.cards[0].expired = true; },
    data => { data.checkout.components.payment_method.selected_payment_method.credit_card.external_code = 55.5; },
    data => { delete data.checkout.components.payment_method.selected_payment_method.credit_card; },
    data => { data.checkout.components.payment_method.selected_payment_method.credit_card.external_code = "different-card"; },
    data => { data.checkout.components.payment_method.pay_in_methods[0].enabled = false; },
    data => { data.checkout.adyen_protect_signals_enabled = true; },
    data => { data.checkout.components.pay_button_v2.total.price.currency_code = "PLN"; },
    data => { data.checkout.components.pay_button_v2.total.price.amount = "30.01"; },
    data => { data.checkout.components.order_summary_v2.deductions = [{ type: "order-summary-wallet-deduction", price: { amount: "1.00", currency_code: "EUR" } }]; },
  ]) {
    const quote = cardAutoQuote(); change(quote);
    const h = bridge(42, [quote], cardBuild());
    const result = await h.run(cardAutoTarget);
    assert.equal(result.status, "checkout_review_required");
    assert.equal(h.requests.filter(r => r.url.endsWith("/payment")).length, 0);
  }
});

test("card payment stays on Vinted and changing to PayPal cannot replay after restart", async () => {
  let starts = 0;
  const resumeUrl = `${checkoutUrl}&after_payment_redirect=true`;
  const h = background({ run: () => { starts++; return { ok: true, checkoutUrl: resumeUrl, transactionId: 77, purchaseId: "synthetic", status: "card_authentication_required", paymentUrl: syntheticPayPalUrl }; } });
  const result = await h.run(cardAutoTarget);
  assert.equal(result.paymentUrl, undefined);
  assert.equal(h.mutations.at(-1).changes.url, resumeUrl);
  const restarted = background({ storage: h.storage });
  await restarted.run(autoTarget);
  assert.equal(restarted.messages.filter(m => m.type === "VINTRACK_RUN_BROWSER_BUY").length, 0);
  assert.equal(starts, 1);
});

test("a ready checkout receiver wins without waiting for a silent tab", async () => {
  let releaseSilent;
  const silent = new Promise(resolve => { releaseSilent = resolve; });
  const h = background({
    tabs: [{ id: 2, status: "complete", active: true }, { id: 1, status: "complete" }],
    ping: id => id === 2 ? silent : { ok: true, pageBridgeReady: true },
  });
  const checkout = h.run();
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.messages.filter(message => message.type === "VINTRACK_RUN_BROWSER_BUY").length, 1);
    assert.equal(h.mutations.at(-1)?.id, 1);
    assert.equal((await checkout).ok, true);
  } finally {
    releaseSilent({ ok: false });
    await checkout;
  }
});

test("a fast unready tab cannot beat a slower ready receiver", async () => {
  let releaseReady;
  const ready = new Promise(resolve => { releaseReady = resolve; });
  const h = background({
    tabs: [{ id: 2, status: "complete", active: true }, { id: 1, status: "complete" }],
    ping: id => id === 2 ? { ok: true, pageBridgeReady: false } : ready,
  });
  const checkout = h.run({ ...autoTarget, readinessOnly: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.mutations.length, 0);
  assert.equal(h.messages.filter(message => message.type === "VINTRACK_RUN_BROWSER_BUY").length, 0);
  releaseReady({ ok: true, pageBridgeReady: true });
  assert.equal((await checkout).ready, true);
  assert.ok(!h.storage.vintrackCheckoutAttempts);
});
